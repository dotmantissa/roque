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
  reserves: { usdc: number; weth: number };
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
  USDC: string;
  WETH: string;
  raw: { USDC: string; WETH: string };
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

export interface AgentInfo {
  agentSigner: `0x${string}`;
}
