/**
 * The shapes the browser sees. These mirror what the server handlers in
 * @roque/core return, described here so the UI stays honestly typed without
 * pulling server only modules into the bundle. When a handler changes, this
 * changes with it; there is no third source of truth.
 */

export type Mode = "copilot" | "autonomous";

export interface Interpretation {
  ok: boolean;
  kind: "swap" | "limit" | "unknown";
  tokenIn: string;
  tokenOut: string;
  amount: string;
  amountIsPercent: boolean;
  triggerPrice: string;
  triggerAbove: boolean;
  confidence: "high" | "medium" | "low";
  reason: string;
  error: string;
}

export interface InterpretQuote {
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  amountOut: string;
  price: number;
  usdValue: number;
}

export interface InterpretResult {
  id: string;
  interpretation: Interpretation;
  quote?: InterpretQuote;
  message: string;
}

export interface PrepareResult {
  router: `0x${string}`;
  tokenIn: `0x${string}`;
  tokenOut: `0x${string}`;
  tokenInSymbol: string;
  tokenOutSymbol: string;
  amountInRaw: string;
  minAmountOutRaw: string;
  amountOut: string;
}

export interface PriceResult {
  ethUsd: number;
  updatedAt: number;
  ageSeconds: number;
  // Every tradable token's live USD price, keyed by on-chain symbol.
  prices: Record<string, number>;
}

export interface CapabilityResult {
  granted: boolean;
  agentSigner?: `0x${string}`;
  maxPerTradeUsd?: string;
  maxDailyUsd?: string;
  maxSlippageBps?: number;
  validUntil?: number;
  revoked?: boolean;
  remainingDailyUsd?: string;
  grantNonce: string;
}

export interface VaultResult {
  // Human-unit balances and exact raw strings, both keyed by token symbol.
  balances: Record<string, string>;
  raw: Record<string, string>;
}

/** A single pool's reserves, mirroring PoolReserves from the quote layer. */
export interface ReservesResult {
  a: string;
  b: string;
  reserveA: number;
  reserveB: number;
}

export interface IntentRow {
  id: string;
  mode: Mode;
  command: string;
  status: string;
  kind: string | null;
  token_in: string | null;
  token_out: string | null;
  amount: string | null;
  reason: string | null;
  error: string | null;
  tx_hash: string | null;
  created_at: string;
}

export interface TradeRow {
  kind: string;
  token_in: string;
  token_out: string;
  amount_in: string;
  amount_out: string;
  usd_value: string | null;
  order_id: string | null;
  price: string | null;
  tx_hash: string;
  block_number: string;
  block_time: string | null;
}

export interface ActivityResult {
  intents: IntentRow[];
  trades: TradeRow[];
}

/** How far a card's on-chain action has got. Persisted with the turn so a signed,
 * settled trade can never present itself as signable again after a remount. */
export type SettleState = "idle" | "working" | "done" | "failed";

/** One turn of a mode's conversation, as the app keeps it in memory and storage. */
export interface ChatTurn {
  id: number;
  command: string;
  result?: InterpretResult;
  error?: string;
  pending: boolean;
  settleState: SettleState;
  txHash: string | null;
}

export interface AgentInfo {
  agentSigner: `0x${string}`;
}
