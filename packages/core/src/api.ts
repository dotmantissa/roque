/**
 * One set of request handlers, shaped as plain functions from a validated input
 * to a plain result. Neither Fastify nor Next.js appears here on purpose: the
 * standalone relayer and the web app's serverless routes both call these, so the
 * behaviour of every endpoint is defined once and cannot drift between the two
 * deployments. Each handler validates its own input with zod and returns data or
 * throws an ApiError the transport layer turns into a status code.
 */

import { admit, costlyAdmission } from "./admission.js";
import { decimal, rawAmount } from "./validation.js";
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
import { openOrders, openOrdersPage } from "./orders.js";
import { heldByToken } from "./reservations.js";
import { quoteSwap, poolReserves } from "./quote.js";
import { ethUsd, allTokenUsd, tokenUsd } from "./prices.js";
import {
  submitGrant,
  getCapability,
  vaultBalance,
  vaultSnapshot,
  remainingDailyUsd,
  grantNonce,
  agentSignerAddress,
} from "./intents.js";
import { keeperTick } from "./keeper.js";
import {
  createEventOrder,
  screenEventOrder,
  listEventOrders,
  getEventOrder,
  cancelEventOrder,
  armEventOrder,
  eventTick,
} from "./events.js";
import {
  createPlaybook,
  updatePlaybook,
  armPlaybook,
  listPlaybooks,
  getPlaybook,
  playbookLog,
  cancelPlaybook,
  playbookTick,
} from "./playbooks.js";
import {
  shareEventOrder,
  sharePlaybook,
  readShare,
  listShares,
  recentShares,
  forkShare,
} from "./shares.js";
import {
  listProposals,
  acceptProposal,
  dismissProposal,
  generateProposals,
  proposalTick,
} from "./proposals.js";
import { indexToHead } from "./indexer.js";
import { q as dbQuery } from "./db/index.js";
import {
  authenticatedOwner,
  completeWalletChallenge,
  issueWalletChallenge,
  revokeSession,
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

function refusal(err:unknown):ApiError {
 const message=err instanceof Error?err.message:"";
 if(!(err instanceof Error)||err.name!=="Error"||message.length>500||/https?:|postgres|rpc|fetch failed|column .* relation|syntax error|connection|timeout|0x[a-fA-F0-9]{64}/iu.test(message))
   return new ApiError(503,"Request could not be completed. Check transaction status before retrying.");
 return new ApiError(400,message);
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
  await admit("global:private-api",600);
  await admit(`owner:${owner}`,120);
  return owner;
}

// ─────────────────────────────────────────────────────────────
// Wallet authentication for autonomous requests
// ─────────────────────────────────────────────────────────────

const authChallengeSchema = z.object({ owner: address });

export async function handleAuthChallenge(body: unknown) {
  const input = parse(authChallengeSchema, body);
  await admit("global:auth-challenge",100);
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
  const owner = await requireAutonomousOwner(sessionToken, input.user);
  await costlyAdmission(`interpret:${owner}`);
  return interpretCommand({ user: owner, mode: input.mode, command: input.command });
}

// ─────────────────────────────────────────────────────────────
// Market: quotes, price, pool depth
// ─────────────────────────────────────────────────────────────

const quoteSchema = z.object({
  from: symbol,
  to: symbol,
  amount: decimal.refine((s) => Number(s) > 0, "Amount must be positive."),
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
    unavailableTokens: tokenList.filter((token) => prices[token.symbol] === undefined).map((token) => token.symbol),
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
  amount: decimal,
  slippageBps: z.number().int().min(0).max(5000).default(100),
});

export async function handlePrepareSwap(body: unknown, sessionToken?: string) {
  const input = parse(prepareSchema, body);
  if (input.from === input.to) {
    throw new ApiError(400, "Pick two different tokens to trade between.");
  }
  const owner = await requireAutonomousOwner(sessionToken);
  const prepared = await prepareCopilotSwap({
    user: owner,
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

export async function handlePrepareLimit(body:unknown,sessionToken?:string) {
 const input=parse(z.object({id:z.string().min(1).max(128),tokenIn:address,tokenOut:address,
   amountInRaw:rawAmount,minAmountOutRaw:rawAmount,triggerPrice:rawAmount,triggerAbove:z.boolean(),expiry:rawAmount}).strict(),body);
 const owner=await requireAutonomousOwner(sessionToken);
 const rows=await dbQuery<{interpretation:unknown}>("SELECT interpretation FROM intents WHERE id=$1 AND LOWER(user_address)=LOWER($2) AND mode='copilot' AND kind='limit' AND status='ready'",[input.id,owner]);
 const {interpretationSchema}=await import("./validation.js");const interp=interpretationSchema.parse(rows[0]?.interpretation);
 const {requireToken}=await import("@roque/shared");const {parseUnits}=await import("viem");
 if(!interp.ok||interp.kind!=="limit"||requireToken(interp.tokenIn).address.toLowerCase()!==input.tokenIn.toLowerCase()||requireToken(interp.tokenOut).address.toLowerCase()!==input.tokenOut.toLowerCase()||
   parseUnits(interp.triggerPrice,8)!==BigInt(input.triggerPrice)||interp.triggerAbove!==input.triggerAbove||BigInt(input.amountInRaw)<=0n||BigInt(input.minAmountOutRaw)<=0n||
   (!interp.amountIsPercent&&parseUnits(interp.amount,requireToken(interp.tokenIn).decimals)!==BigInt(input.amountInRaw))||
   BigInt(input.expiry)<=BigInt(Math.floor(Date.now()/1000))||BigInt(input.expiry)>BigInt(Math.floor(Date.now()/1000)+7*86400+60)) throw new ApiError(400,"Limit differs from its interpretation.");
 const {id,...fields}=input;
 const saved=await dbQuery("UPDATE intents SET prepared_plan=$3::jsonb WHERE id=$1 AND LOWER(user_address)=LOWER($2) AND status='ready' RETURNING id",[id,owner,JSON.stringify({...fields,kind:"limit",recipient:owner})]);
 if(saved.length!==1) throw new ApiError(409,"Intent is no longer ready.");
 return {ok:true};
}

const confirmSchema = z.object({
  id: z.string().min(1),
  txHash: z.string().regex(/^0x[a-fA-F0-9]{64}$/u, "That is not a transaction hash."),
});

export async function handleConfirmSwap(body: unknown, sessionToken?: string) {
  const input = parse(confirmSchema, body);
  const owner = await requireAutonomousOwner(sessionToken);
  await attachTxHash(input.id, input.txHash, owner);
  return { ok: true };
}

// ─────────────────────────────────────────────────────────────
// Autonomous: grants, the executor, and reading a user's agent state
// ─────────────────────────────────────────────────────────────

const grantSchema = z.object({
  user: address,
  agentSigner: address,
  maxPerTradeUsd: rawAmount,
  maxDailyUsd: rawAmount,
  maxSlippageBps: rawAmount,
  validUntil: rawAmount,
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
    throw refusal(err);
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
  // Every token's balance and hold in one multicall, and the open claims in one
  // query, so the panel can say "600 of 1,000 free" instead of quietly offering
  // money the chain will refuse to move.
  //
  // Held is the executor's own lockedBalance, so the figure on screen is the
  // one a withdrawal is actually measured against rather than an app-side guess
  // at it. Claims come from the reservations table and are only an explanation:
  // they say which orders are behind a number, and a missing row makes the
  // sentence vaguer without ever making the number wrong.
  const [snapshot, held] = await Promise.all([vaultSnapshot(user), heldByToken(user)]);
  const balances: Record<string, string> = {};
  const raw: Record<string, string> = {};
  const heldRaw: Record<string, string> = {};
  const availableRaw: Record<string, string> = {};
  const claims: Record<string, number> = {};
  for (const t of tokenList) {
    const state = snapshot.get(t.symbol) ?? { balance: 0n, locked: 0n, available: 0n };
    balances[t.symbol] = formatUnits(state.balance, t.decimals);
    raw[t.symbol] = state.balance.toString();
    heldRaw[t.symbol] = state.locked.toString();
    availableRaw[t.symbol] = state.available.toString();
    claims[t.symbol] = held.get(t.symbol)?.claims ?? 0;
  }
  return { balances, raw, heldRaw, availableRaw, claims };
}

export async function handleActivity(userRaw: string, limit = 25, sessionToken?: string) {
  const user = parse(address, userRaw);
  const bounded = parse(z.number().int().min(1).max(100), limit);
  const owner = await authenticatedOwner(sessionToken);
  if (owner && owner.toLowerCase() !== user.toLowerCase()) throw new ApiError(403, "This session belongs to another wallet.");
  const [intents, trades] = await Promise.all([
    owner ? intentHistory(user, bounded) : Promise.resolve([]),
    tradeHistory(user, bounded),
  ]);
  return { intents, trades };
}

/** Every limit order the user still has resting on-chain, tagged by mode. */
export async function handleOpenOrders(userRaw: string, before?:string) {
  const user = parse(address, userRaw);
  if(before!==undefined)parse(z.string().regex(/^\d{1,10}$/u),before);
  return openOrdersPage(user,before);
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

// ─────────────────────────────────────────────────────────────
// Event orders
// ─────────────────────────────────────────────────────────────
//
// Anything below that can end in a trade is gated on the same wallet session the
// autonomous path uses, because an event order is an autonomous instruction with
// a longer fuse. The user-scoped reads are gated too: the conditions somebody
// chooses to trade on are their business, not a public record like a vault
// balance on-chain.

const eventOrderSchema = z.object({
  user: address,
  condition: z.string().min(12, "Describe the event in a little more detail.").max(500),
  tokenIn: symbol,
  tokenOut: symbol,
  amount: z.string().regex(/^\d+(\.\d+)?$/u, "The amount has to be a number."),
  amountIsPercent: z.boolean().default(false),
  slippageBps: z.number().int().min(1).max(5_000).default(100),
  expiresInDays: z.number().int().min(1).max(90).optional(),
});

/**
 * Record the order. Screening is deliberately not done here: a consensus round
 * takes half a minute, far past what a request should hold open, so the order
 * lands inert and the screen is its own call. Nothing can fill until it passes.
 */
export async function handleCreateEventOrder(body: unknown, sessionToken?: string) {
  const input = parse(eventOrderSchema, body);
  const owner = await requireAutonomousOwner(sessionToken, input.user);
  try {
    return { order: await createEventOrder({ ...input, user: owner }) };
  } catch (err) {
    throw refusal(err);
  }
}

const idSchema = z.object({ id: z.string().uuid("That is not an order I recognise.") });

/** Run the verifiability screen. Slow by nature; the caller must allow for it. */
export async function handleScreenEventOrder(body: unknown, sessionToken?: string) {
  const { id } = parse(idSchema, body);
  const owner = await requireAutonomousOwner(sessionToken);
  const existing = await getEventOrder(id);
  if (!existing) throw new ApiError(404, "No such order.");
  if (existing.user.toLowerCase() !== owner.toLowerCase()) {
    throw new ApiError(403, "That order is not yours.");
  }
  return { order: await screenEventOrder(id) };
}

export async function handleEventOrders(userRaw: string, sessionToken?: string) {
  const user = parse(address, userRaw);
  const owner = await requireAutonomousOwner(sessionToken, user);
  return { orders: await listEventOrders(owner) };
}

/**
 * Arm a screened order. Separate from screening on purpose: the screen answers
 * whether the condition could be checked, and this is the person deciding to put
 * money behind it. It is also where the vault is claimed.
 */
export async function handleArmEventOrder(body: unknown, sessionToken?: string) {
  const { id } = parse(idSchema, body);
  const owner = await requireAutonomousOwner(sessionToken);
  try {
    return { order: await armEventOrder(id, owner) };
  } catch (err) {
    throw refusal(err);
  }
}

export async function handleCancelEventOrder(body: unknown, sessionToken?: string) {
  const { id } = parse(idSchema, body);
  const owner = await requireAutonomousOwner(sessionToken);
  try {
    return { order: await cancelEventOrder(id, owner) };
  } catch (err) {
    throw refusal(err);
  }
}

// ─────────────────────────────────────────────────────────────
// Playbooks
// ─────────────────────────────────────────────────────────────

const playbookSchema = z.object({
  user: address,
  name: z.string().min(1, "Give the playbook a name.").max(120),
  note: z.string().max(500).optional(),
  // Steps are validated in depth by normaliseStep, which knows the trigger
  // shapes; zod only insists there is a bounded list of objects to validate.
  steps: z.array(z.record(z.string(), z.unknown())).min(1, "A playbook needs at least one step.").max(10),
  slippageBps: z.number().int().min(1).max(5_000).default(100),
});

export async function handleCreatePlaybook(body: unknown, sessionToken?: string) {
  const input = parse(playbookSchema, body);
  const owner = await requireAutonomousOwner(sessionToken, input.user);
  try {
    return { playbook: await createPlaybook({ ...input, user: owner }) };
  } catch (err) {
    throw refusal(err);
  }
}

const updatePlaybookSchema = z.object({
  id: z.string().uuid("That is not a playbook I recognise."),
  name: z.string().min(1, "Give the playbook a name.").max(120).optional(),
  note: z.string().max(500).optional(),
  steps: z
    .array(z.record(z.string(), z.unknown()))
    .min(1, "A playbook needs at least one step.")
    .max(10)
    .optional(),
  slippageBps: z.number().int().min(1).max(5_000).optional(),
});

/**
 * Edit a draft. Owner-scoped like every other write here, and draft-scoped in
 * the statement underneath, so an armed plan with money held against its rungs
 * cannot be rewritten from under the hold.
 */
export async function handleUpdatePlaybook(body: unknown, sessionToken?: string) {
  const input = parse(updatePlaybookSchema, body);
  const owner = await requireAutonomousOwner(sessionToken);
  try {
    const { id, ...patch } = input;
    return { playbook: await updatePlaybook(id, owner, patch) };
  } catch (err) {
    throw refusal(err);
  }
}

/** Arming screens every event trigger, so this is as slow as a screen. */
export async function handleArmPlaybook(body: unknown, sessionToken?: string) {
  const { id } = parse(idSchema, body);
  const owner = await requireAutonomousOwner(sessionToken);
  try {
    return { playbook: await armPlaybook(id, owner) };
  } catch (err) {
    throw refusal(err);
  }
}

export async function handlePlaybooks(userRaw: string, sessionToken?: string) {
  const user = parse(address, userRaw);
  const owner = await requireAutonomousOwner(sessionToken, user);
  return { playbooks: await listPlaybooks(owner) };
}

export async function handlePlaybook(idRaw: string, sessionToken?: string) {
  const { id } = parse(idSchema, { id: idRaw });
  const owner = await requireAutonomousOwner(sessionToken);
  const playbook = await getPlaybook(id);
  if (!playbook) throw new ApiError(404, "No such playbook.");
  if (playbook.user.toLowerCase() !== owner.toLowerCase()) {
    throw new ApiError(403, "That playbook is not yours.");
  }
  return { playbook, log: await playbookLog(id) };
}

export async function handleCancelPlaybook(body: unknown, sessionToken?: string) {
  const { id } = parse(idSchema, body);
  const owner = await requireAutonomousOwner(sessionToken);
  try {
    return { playbook: await cancelPlaybook(id, owner) };
  } catch (err) {
    throw refusal(err);
  }
}

// ─────────────────────────────────────────────────────────────
// Shares
// ─────────────────────────────────────────────────────────────
//
// Reading a share is open on purpose: a link nobody can open is not a link.
// Publishing and forking are not, because both act on somebody's own account.

const slugSchema = z.object({
  slug: z.string().regex(/^[A-Za-z0-9-]{4,64}$/u, "That is not a link I recognise."),
});

export async function handleReadShare(slugRaw: string) {
  const { slug } = parse(slugSchema, { slug: slugRaw });
  const share = await readShare(slug);
  if (!share) throw new ApiError(404, "No such link.");
  return { share };
}

export async function handleRecentShares() {
  return { shares: await recentShares(20) };
}

export async function handleMyShares(userRaw: string, sessionToken?: string) {
  const user = parse(address, userRaw);
  const owner = await requireAutonomousOwner(sessionToken, user);
  return { shares: await listShares(owner) };
}

const publishSchema = z.object({
  kind: z.enum(["event_order", "playbook"]),
  id: z.string().uuid(),
  title: z.string().min(1).max(140).optional(),
  note: z.string().max(500).optional(),
});

export async function handlePublishShare(body: unknown, sessionToken?: string) {
  const input = parse(publishSchema, body);
  const owner = await requireAutonomousOwner(sessionToken);
  try {
    const share =
      input.kind === "event_order"
        ? await shareEventOrder(input.id, owner, { title: input.title, note: input.note })
        : await sharePlaybook(input.id, owner, { title: input.title, note: input.note });
    return { share };
  } catch (err) {
    throw refusal(err);
  }
}

const forkSchema = z.object({
  slug: z.string().regex(/^[A-Za-z0-9-]{4,64}$/u),
  user: address,
  amount: z.string().regex(/^\d+(\.\d+)?$/u).optional(),
  amountIsPercent: z.boolean().optional(),
  slippageBps: z.number().int().min(1).max(5_000).optional(),
  expiresInDays: z.number().int().min(1).max(90).optional(),
});

export async function handleForkShare(body: unknown, sessionToken?: string) {
  const input = parse(forkSchema, body);
  const owner = await requireAutonomousOwner(sessionToken, input.user);
  try {
    return await forkShare(input.slug, owner, {
      amount: input.amount,
      amountIsPercent: input.amountIsPercent,
      slippageBps: input.slippageBps,
      expiresInDays: input.expiresInDays,
    });
  } catch (err) {
    throw refusal(err);
  }
}

// ─────────────────────────────────────────────────────────────
// Proposals
// ─────────────────────────────────────────────────────────────

export async function handleProposals(userRaw: string, sessionToken?: string) {
  const user = parse(address, userRaw);
  const owner = await requireAutonomousOwner(sessionToken, user);
  return { proposals: await listProposals(owner, "new") };
}

/** Refresh on demand, so the inbox is not hostage to the next cron tick. */
export async function handleRefreshProposals(body: unknown, sessionToken?: string) {
  const input = parse(z.object({ user: address }), body);
  const owner = await requireAutonomousOwner(sessionToken, input.user);
  const filed = await generateProposals(owner);
  return { filed: filed.length, proposals: await listProposals(owner, "new") };
}

export async function handleAcceptProposal(body: unknown, sessionToken?: string) {
  const { id } = parse(idSchema, body);
  const owner = await requireAutonomousOwner(sessionToken);
  try {
    return await acceptProposal(id, owner);
  } catch (err) {
    throw refusal(err);
  }
}

export async function handleDismissProposal(body: unknown, sessionToken?: string) {
  const { id } = parse(idSchema, body);
  const owner = await requireAutonomousOwner(sessionToken);
  try {
    return { proposal: await dismissProposal(id, owner) };
  } catch (err) {
    throw refusal(err);
  }
}

// ─────────────────────────────────────────────────────────────
// The judgment tick, alongside the existing keeper and indexer
// ─────────────────────────────────────────────────────────────

/**
 * Screen, adjudicate and advance in one pass, then refile proposals. Each part is
 * caught on its own so a GenLayer outage cannot stop playbook price steps from
 * running, nor either of them stop the inbox from refreshing.
 */
export async function handleJudgmentTick() {
  const [events, playbooks, proposals] = await Promise.all([
    eventTick().catch((err) => ({ error: (err as Error).message })),
    playbookTick().catch((err) => ({ error: (err as Error).message })),
    proposalTick().catch((err) => ({ error: (err as Error).message })),
  ]);
  return { events, playbooks, proposals };
}

export async function handleRevokeSession(sessionToken?: string) {
  await requireAutonomousOwner(sessionToken);
  await revokeSession(sessionToken!);
  return {ok:true};
}
