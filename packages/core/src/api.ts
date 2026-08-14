/**
 * One set of request handlers, shaped as plain functions from a validated input
 * to a plain result. Neither Fastify nor Next.js appears here on purpose: the
 * standalone relayer and the web app's serverless routes both call these, so the
 * behaviour of every endpoint is defined once and cannot drift between the two
 * deployments. Each handler validates its own input with zod and returns data or
 * throws an ApiError the transport layer turns into a status code.
 */

import { z } from "zod";
import { formatUnits } from "viem";
import { tokenList, tokenSymbols, addresses } from "@roque/shared";
import {
  interpretCommand,
  prepareCopilotSwap,
  executeAutonomous,
  attachTxHash,
  intentHistory,
  tradeHistory,
} from "./services.js";
import { openOrders } from "./orders.js";
import { quoteSwap, poolReserves } from "./quote.js";
import { ethUsd, allTokenUsd, tokenUsd } from "./prices.js";
import {
  submitGrant,
  getCapability,
  vaultBalance,
  remainingDailyUsd,
  grantNonce,
  agentSignerAddress,
} from "./intents.js";
import { keeperTick } from "./keeper.js";
import { indexToHead } from "./indexer.js";
import { q as dbQuery } from "./db/index.js";
import {
  authenticatedOwner,
  completeWalletChallenge,
  issueWalletChallenge,
} from "./auth.js";

/** An error carrying the HTTP status the transport should answer with. */
export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "ApiError";
  }
}

const address = z
  .string()
  .regex(/^0x[a-fA-F0-9]{40}$/u, "That does not look like an Ethereum address.")
  .transform((s) => s as `0x${string}`);

const signature = z
  .string()
  .regex(/^0x[a-fA-F0-9]+$/u, "That is not a signature.")
  .transform((s) => s as `0x${string}`);

// Any of our ten tradable tokens, named by its on-chain symbol. Validated
// against the live registry so a typo is a clean 400, not a downstream revert.
const symbol = z
  .string()
  .refine((s) => tokenSymbols.includes(s), "That is not a token Roque trades.");

/** Fold a zod failure into a clean 400 rather than leaking the whole issue tree. */
function parse<S extends z.ZodTypeAny>(schema: S, body: unknown): z.infer<S> {
  const result = schema.safeParse(body);
  if (!result.success) {
    const first = result.error.issues[0];
    throw new ApiError(400, first ? first.message : "That request was not shaped right.");
  }
  return result.data;
}

async function requireAutonomousOwner(
  sessionToken: string | undefined,
  requestedOwner?: `0x${string}`,
): Promise<`0x${string}`> {
  const owner = await authenticatedOwner(sessionToken);
  if (!owner) {
    throw new ApiError(401, "Authenticate this autonomous request with your wallet.");
  }
  if (requestedOwner && owner.toLowerCase() !== requestedOwner.toLowerCase()) {
    throw new ApiError(403, "This wallet session does not own the requested vault.");
  }
  return owner;
}

// ─────────────────────────────────────────────────────────────
// Wallet authentication for autonomous requests
// ─────────────────────────────────────────────────────────────

const authChallengeSchema = z.object({ owner: address });

export async function handleAuthChallenge(body: unknown) {
  const input = parse(authChallengeSchema, body);
  return issueWalletChallenge(input.owner);
}

const authSessionSchema = z.object({
  challengeId: z.string().uuid("That is not a valid challenge."),
  owner: address,
  signature,
});

export async function handleAuthSession(body: unknown) {
  const input = parse(authSessionSchema, body);
  const session = await completeWalletChallenge(input);
  if (!session) {
    throw new ApiError(401, "That wallet challenge is invalid or expired.");
  }
  return session;
}

// ─────────────────────────────────────────────────────────────
// Judgment: read a command into a structured, quoted intent
// ─────────────────────────────────────────────────────────────

const interpretSchema = z.object({
  command: z.string().min(1, "Type what you would like to do.").max(500),
  mode: z.enum(["copilot", "autonomous"]).default("copilot"),
  user: address.optional(),
});

export async function handleInterpret(body: unknown, sessionToken?: string) {
  const input = parse(interpretSchema, body);
  if (input.mode === "autonomous") {
    const owner = await requireAutonomousOwner(sessionToken, input.user);
    return interpretCommand({ user: owner, mode: input.mode, command: input.command });
  }
  return interpretCommand({ user: input.user, mode: input.mode, command: input.command });
}

// ─────────────────────────────────────────────────────────────
// Market: quotes, price, pool depth
// ─────────────────────────────────────────────────────────────

const quoteSchema = z.object({
  from: symbol,
  to: symbol,
  amount: z
    .string()
    .min(1)
    .refine((s) => Number(s) > 0, "Amount must be a positive number."),
});

export async function handleQuote(body: unknown) {
  const input = parse(quoteSchema, body);
  if (input.from === input.to) {
    throw new ApiError(400, "Pick two different tokens to trade between.");
  }
  const q = await quoteSwap(input.from, input.to, input.amount);
  return {
    tokenIn: q.tokenIn.symbol,
    tokenOut: q.tokenOut.symbol,
    amountIn: q.amountIn,
    amountInRaw: q.amountInRaw.toString(),
    amountOut: q.amountOut,
    amountOutRaw: q.amountOutRaw.toString(),
    price: q.price,
  };
}

export async function handlePrice() {
  const [price, prices] = await Promise.all([ethUsd(), allTokenUsd()]);
  return {
    ethUsd: price.usd,
    updatedAt: price.updatedAt,
    ageSeconds: price.ageSeconds,
    // Every token's live USD price, keyed by symbol, so the UI can value any
    // balance or pair without a round trip per token.
    prices,
  };
}

// Depth for a specific pair in the mesh, on demand. The market view asks for the
// pair the user is actually looking at rather than one privileged pool.
const reservesSchema = z.object({ a: symbol, b: symbol });

export async function handleReserves(body: unknown) {
  const input = parse(reservesSchema, body);
  if (input.a === input.b) {
    throw new ApiError(400, "Pick two different tokens to see a pool.");
  }
  return poolReserves(input.a, input.b);
}

// ─────────────────────────────────────────────────────────────
// Copilot: prepare a swap the user signs themselves
// ─────────────────────────────────────────────────────────────

const prepareSchema = z.object({
  id: z.string().optional(),
  from: symbol,
  to: symbol,
  amount: z.string().min(1),
  slippageBps: z.number().int().min(0).max(5000).default(100),
});

export async function handlePrepareSwap(body: unknown) {
  const input = parse(prepareSchema, body);
  if (input.from === input.to) {
    throw new ApiError(400, "Pick two different tokens to trade between.");
  }
  const prepared = await prepareCopilotSwap({
    id: input.id,
    fromSymbol: input.from,
    toSymbol: input.to,
    amount: input.amount,
    slippageBps: input.slippageBps,
  });
  return {
    router: prepared.router,
    tokenIn: prepared.tokenIn.address,
    tokenOut: prepared.tokenOut.address,
    tokenInSymbol: prepared.tokenIn.symbol,
    tokenOutSymbol: prepared.tokenOut.symbol,
    amountInRaw: prepared.amountInRaw,
    minAmountOutRaw: prepared.minAmountOutRaw,
    amountOut: prepared.amountOut,
  };
}

const confirmSchema = z.object({
  id: z.string().min(1),
  txHash: z.string().regex(/^0x[a-fA-F0-9]{64}$/u, "That is not a transaction hash."),
});

export async function handleConfirmSwap(body: unknown) {
  const input = parse(confirmSchema, body);
  await attachTxHash(input.id, input.txHash);
  return { ok: true };
}

// ─────────────────────────────────────────────────────────────
// Autonomous: grants, the executor, and reading a user's agent state
// ─────────────────────────────────────────────────────────────

const grantSchema = z.object({
  user: address,
  agentSigner: address,
  maxPerTradeUsd: z.string().min(1),
  maxDailyUsd: z.string().min(1),
  maxSlippageBps: z.string().min(1),
  validUntil: z.string().min(1),
  signature,
});

export async function handleGrant(body: unknown, sessionToken?: string) {
  const input = parse(grantSchema, body);
  await requireAutonomousOwner(sessionToken, input.user);
  const txHash = await submitGrant({
    user: input.user,
    agentSigner: input.agentSigner,
    maxPerTradeUsd: BigInt(input.maxPerTradeUsd),
    maxDailyUsd: BigInt(input.maxDailyUsd),
    maxSlippageBps: BigInt(input.maxSlippageBps),
    validUntil: BigInt(input.validUntil),
    signature: input.signature,
  });
  return { txHash };
}

const executeSchema = z.object({
  id: z.string().min(1),
  user: address,
  slippageBps: z.number().int().min(0).max(5000).default(100),
});

export async function handleExecute(body: unknown, sessionToken?: string) {
  const input = parse(executeSchema, body);
  const owner = await requireAutonomousOwner(sessionToken, input.user);
  try {
    return await executeAutonomous({
      id: input.id,
      user: owner,
      slippageBps: input.slippageBps,
    });
  } catch (err) {
    // These are the friendly, user-facing refusals executeAutonomous raises
    // before it ever touches the chain; surface them as a 400, not a 500.
    throw new ApiError(400, (err as Error).message);
  }
}

/** The agent signer address a grant must name. Public, read by the grant UI. */
export function handleAgentInfo() {
  return { agentSigner: agentSignerAddress() };
}

// ─────────────────────────────────────────────────────────────
// Reads for the dashboard: capability, vault, history
// ─────────────────────────────────────────────────────────────

export async function handleCapability(userRaw: string) {
  const user = parse(address, userRaw);
  const [cap, remaining] = await Promise.all([
    getCapability(user),
    remainingDailyUsd(user).catch(() => 0n),
  ]);
  const nonce = await grantNonce(user).catch(() => 0n);
  if (!cap) {
    return { granted: false, grantNonce: nonce.toString() };
  }
  return {
    granted: true,
    agentSigner: cap.agentSigner,
    maxPerTradeUsd: formatUnits(cap.maxPerTradeUsd, 18),
    maxDailyUsd: formatUnits(cap.maxDailyUsd, 18),
    maxSlippageBps: Number(cap.maxSlippageBps),
    validUntil: Number(cap.validUntil),
    revoked: cap.revoked,
    remainingDailyUsd: formatUnits(remaining, 18),
    grantNonce: nonce.toString(),
  };
}

export async function handleVault(userRaw: string) {
  const user = parse(address, userRaw);
  // Read every token's vaulted balance in parallel and return two symbol-keyed
  // maps: human units for display, raw strings for exact math on the client.
  const raws = await Promise.all(
    tokenList.map((t) => vaultBalance(user, t.address)),
  );
  const balances: Record<string, string> = {};
  const raw: Record<string, string> = {};
  tokenList.forEach((t, i) => {
    balances[t.symbol] = formatUnits(raws[i], t.decimals);
    raw[t.symbol] = raws[i].toString();
  });
  return { balances, raw };
}

export async function handleActivity(userRaw: string, limit = 25) {
  const user = parse(address, userRaw);
  const [intents, trades] = await Promise.all([
    intentHistory(user, limit),
    tradeHistory(user, limit),
  ]);
  return { intents, trades };
}

/** Every limit order the user still has resting on-chain, tagged by mode. */
export async function handleOpenOrders(userRaw: string) {
  const user = parse(address, userRaw);
  return { orders: await openOrders(user) };
}

// ─────────────────────────────────────────────────────────────
// Workers, exposed so a cron route or the standalone loop can drive them
// ─────────────────────────────────────────────────────────────

export async function handleKeeperTick() {
  return keeperTick();
}

export async function handleIndex() {
  const rows = await indexToHead();
  return { indexed: rows };
}

/** A cheap liveness answer plus the addresses the frontend should be talking to. */
export function handleHealth() {
  return {
    ok: true,
    chainId: 11155111,
    contracts: {
      router: addresses.router,
      orderBook: addresses.orderBook,
      agentExecutor: addresses.agentExecutor,
      faucetRouter: addresses.faucetRouter,
    },
    tokens: Object.fromEntries(tokenList.map((t) => [t.symbol, t.address])),
    agentSigner: agentSignerAddress(),
  };
}

// ─────────────────────────────────────────────────────────────
// Price history: a lightweight, self-building record for the chart
// ─────────────────────────────────────────────────────────────

const pricePair = z.string().max(64).refine((value) => {
  const [base, quote, extra] = value.split("/");
  return (
    typeof base === "string" &&
    extra === undefined &&
    quote === "USD" &&
    tokenSymbols.includes(base)
  );
}, "That is not a supported USD price pair.");

const recordPriceSchema = z.object({ pair: pricePair });

export async function handleRecordPrice(body: unknown) {
  const input = parse(recordPriceSchema, body);
  const symbol = input.pair.split("/")[0]!;
  const price = await tokenUsd(symbol);
  await dbQuery(
    `INSERT INTO price_history (pair, price)
     SELECT $1, $2
     WHERE NOT EXISTS (
       SELECT 1
       FROM price_history
       WHERE pair = $1 AND recorded_at >= now() - interval '10 seconds'
     )`,
    [input.pair, price],
  );
  return { ok: true, price };
}

const priceHistorySchema = z.object({
  pair: pricePair,
  hours: z.union([z.literal(1), z.literal(24), z.literal(168)]).default(24),
});

export async function handlePriceHistory(searchParams: URLSearchParams) {
  const input = parse(priceHistorySchema, {
    pair: searchParams.get("pair"),
    hours: searchParams.get("hours") ? Number(searchParams.get("hours")) : undefined,
  });
  const rows = await dbQuery<{ price: string; recorded_at: string }>(
    `SELECT price, recorded_at
     FROM (
       SELECT price, recorded_at
       FROM price_history
       WHERE pair = $1 AND recorded_at >= now() - ($2 || ' hours')::interval
       ORDER BY recorded_at DESC
       LIMIT 2000
     ) recent
     ORDER BY recorded_at ASC`,
    [input.pair, input.hours],
  );
  return {
    pair: input.pair,
    points: rows.map((r) => ({ t: new Date(r.recorded_at).getTime(), price: Number(r.price) })),
  };
}
