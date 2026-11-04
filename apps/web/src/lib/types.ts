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
  unavailableTokens?: string[];
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
  /**
   * What resting orders have already promised, and what is left after them.
   * A vault balance on its own overstates what can be spent: an armed event
   * order or a running playbook has claimed part of it, and that part cannot
   * back a second order or be withdrawn while the first is still live.
   */
  heldRaw: Record<string, string>;
  availableRaw: Record<string, string>;
  /** How many live orders are holding each token, for the sentence in the UI. */
  claims: Record<string, number>;
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
  amount_is_percent: boolean;
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

/**
 * A limit order still resting on-chain, read live from the OrderBook. Amounts and
 * the trigger price arrive in human units; `mode` is the surface that placed it,
 * recovered from the intent that created it, or null when that could not be matched.
 */
export interface OpenOrder {
  id: string;
  mode: Mode | null;
  tokenIn: string;
  tokenOut: string;
  tokenInSymbol: string;
  tokenOutSymbol: string;
  amountIn: string;
  minAmountOut: string;
  triggerPrice: string;
  triggerAbove: boolean;
  expiry: number;
  expired: boolean;
}

export interface OrdersResult {
  orders: OpenOrder[];
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

// ─────────────────────────────────────────────────────────────
// Event orders: a limit order whose trigger is a fact about the world
// ─────────────────────────────────────────────────────────────

export type EventOrderStatus =
  | "screening"
  /** Cleared by the validators, waiting for the person to arm it. */
  | "screened"
  | "rejected"
  | "armed"
  /** Mid-trade. Brief, and nothing else may touch the order while it lasts. */
  | "firing"
  | "filled"
  | "failed"
  | "expired"
  | "cancelled";

export interface EvidenceItem {
  source: string;
  title: string;
  published: string | null;
  url: string | null;
}

export interface Evidence {
  query: string;
  fetchedAt: string;
  items: EvidenceItem[];
  market: { ethUsd: number } | null;
  notes: string[];
}

export interface EventOrder {
  id: string;
  user: string;
  condition: string;
  tokenIn: string;
  tokenOut: string;
  amount: string;
  amountIsPercent: boolean;
  slippageBps: number;
  status: EventOrderStatus;
  /** Whether the validators judged the condition checkable at all. */
  screenVerdict: "verifiable" | "unverifiable" | null;
  screenReason: string | null;
  screenConfidence: string | null;
  screenSources: string[] | null;
  checks: number;
  lastCheckedAt: string | null;
  verdictMet: boolean | null;
  verdictConfidence: string | null;
  verdictRationale: string | null;
  evidence: Evidence | null;
  expiresAt: string | null;
  txHash: string | null;
  error: string | null;
  sourceSlug: string | null;
  createdAt: string;
  updatedAt: string;
}

// ─────────────────────────────────────────────────────────────
// Playbooks: a plan the keeper walks one step at a time
// ─────────────────────────────────────────────────────────────

export type PlaybookTrigger =
  | { kind: "immediate" }
  | { kind: "price"; direction: "above" | "below"; usd: number }
  | { kind: "event"; condition: string }
  | { kind: "delay"; minutes: number };

export interface PlaybookAction {
  tokenIn: string;
  tokenOut: string;
  amount: string;
  amountIsPercent?: boolean;
}

export type StepStatus = "waiting" | "firing" | "done" | "failed" | "skipped";

export interface PlaybookStep {
  id: string;
  label: string;
  trigger: PlaybookTrigger;
  action: PlaybookAction;
  status: StepStatus;
  screen?: { verifiable: boolean; reason: string } | null;
  txHash?: string | null;
  error?: string | null;
  armedAt?: string | null;
  firedAt?: string | null;
  checks?: number;
  lastCheckedAt?: string | null;
  verdict?: { met: boolean; confidence: string; rationale: string } | null;
}

export type PlaybookStatus = "draft" | "armed" | "completed" | "cancelled" | "failed";

export interface Playbook {
  id: string;
  user: string;
  name: string;
  note: string | null;
  status: PlaybookStatus;
  steps: PlaybookStep[];
  stepCursor: number;
  slippageBps: number;
  lastCheckedAt: string | null;
  error: string | null;
  sourceSlug: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PlaybookLogEntry {
  id: string;
  stepIndex: number;
  kind: string;
  detail: string | null;
  txHash: string | null;
  createdAt: string;
}

// ─────────────────────────────────────────────────────────────
// Shares: a thesis that travels without the position
// ─────────────────────────────────────────────────────────────

export type ShareKind = "event_order" | "playbook";

export interface EventOrderPayload {
  condition: string;
  tokenIn: string;
  tokenOut: string;
  amount: string;
  amountIsPercent: boolean;
  slippageBps: number;
}

export interface PlaybookPayload {
  name: string;
  note: string | null;
  steps: PlaybookStep[];
  slippageBps: number;
}

export interface Share {
  slug: string;
  kind: ShareKind;
  author: string;
  title: string;
  note: string | null;
  payload: EventOrderPayload | PlaybookPayload;
  forks: number;
  views: number;
  createdAt: string;
  /** Plain-English lines describing what forking this would set up. */
  summary: string[];
}

export type ForkResult =
  | { kind: "event_order"; order: EventOrder }
  | { kind: "playbook"; playbook: Playbook };

// ─────────────────────────────────────────────────────────────
// Proposals: the agent speaking first
// ─────────────────────────────────────────────────────────────

export type ProposalStatus = "new" | "accepted" | "dismissed" | "expired";

export type ProposalAction =
  | {
      type: "event_order";
      condition: string;
      tokenIn: string;
      tokenOut: string;
      amount: string;
      amountIsPercent?: boolean;
    }
  | { type: "playbook"; name: string; note?: string; steps: unknown[] }
  | { type: "cancel_event_order"; id: string }
  | { type: "open"; href: string; label: string };

export interface Proposal {
  id: string;
  user: string;
  kind: string;
  title: string;
  detail: string;
  rationale: string | null;
  action: ProposalAction;
  status: ProposalStatus;
  dedupeKey: string;
  actedAt: string | null;
  resultRef: string | null;
  createdAt: string;
}

export interface AcceptResult {
  proposal: Proposal;
  created: { kind: "event_order" | "playbook"; id: string } | null;
  href: string | null;
}
