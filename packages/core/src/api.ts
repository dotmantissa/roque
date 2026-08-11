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
import { tokens, addresses } from "@roque/shared";
import {
  interpretCommand,
  prepareCopilotSwap,
  executeAutonomous,
  attachTxHash,
  intentHistory,
  tradeHistory,
} from "./services.js";
import { quoteSwap, poolReserves } from "./quote.js";
import { ethUsd } from "./prices.js";
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

const symbol = z.enum(["USDC", "WETH"]);

/** Fold a zod failure into a clean 400 rather than leaking the whole issue tree. */
function parse<S extends z.ZodTypeAny>(schema: S, body: unknown): z.infer<S> {
  const result = schema.safeParse(body);
  if (!result.success) {
    const first = result.error.issues[0];
    throw new ApiError(400, first ? first.message : "That request was not shaped right.");
  }
  return result.data;
}

// ─────────────────────────────────────────────────────────────
// Judgment: read a command into a structured, quoted intent
// ─────────────────────────────────────────────────────────────

const interpretSchema = z.object({
  command: z.string().min(1, "Type what you would like to do.").max(500),
  mode: z.enum(["copilot", "autonomous"]).default("copilot"),
  user: address.optional(),
});

export async function handleInterpret(body: unknown) {
  const input = parse(interpretSchema, body);
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
  const [price, reserves] = await Promise.all([ethUsd(), poolReserves()]);
  return {
    ethUsd: price.usd,
    updatedAt: price.updatedAt,
    ageSeconds: price.ageSeconds,
    reserves,
  };
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
  signature: z.string().regex(/^0x[a-fA-F0-9]+$/u, "That is not a signature."),
});

export async function handleGrant(body: unknown) {
  const input = parse(grantSchema, body);
  const txHash = await submitGrant({
    user: input.user,
    agentSigner: input.agentSigner,
    maxPerTradeUsd: BigInt(input.maxPerTradeUsd),
    maxDailyUsd: BigInt(input.maxDailyUsd),
    maxSlippageBps: BigInt(input.maxSlippageBps),
    validUntil: BigInt(input.validUntil),
    signature: input.signature as `0x${string}`,
  });
  return { txHash };
}

const executeSchema = z.object({
  id: z.string().min(1),
  user: address,
  slippageBps: z.number().int().min(0).max(5000).default(100),
});

export async function handleExecute(body: unknown) {
  const input = parse(executeSchema, body);
  try {
    return await executeAutonomous({
      id: input.id,
      user: input.user,
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
  const [usdc, weth] = await Promise.all([
    vaultBalance(user, tokens.USDC.address),
    vaultBalance(user, tokens.WETH.address),
  ]);
  return {
    USDC: formatUnits(usdc, tokens.USDC.decimals),
    WETH: formatUnits(weth, tokens.WETH.decimals),
    raw: { USDC: usdc.toString(), WETH: weth.toString() },
  };
}

export async function handleActivity(userRaw: string, limit = 25) {
  const user = parse(address, userRaw);
  const [intents, trades] = await Promise.all([
    intentHistory(user, limit),
    tradeHistory(user, limit),
  ]);
  return { intents, trades };
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
      usdc: addresses.usdc,
      weth: addresses.weth,
    },
    agentSigner: agentSignerAddress(),
  };
}
