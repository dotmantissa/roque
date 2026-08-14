"use client";

/**
 * The record of what actually happened, pulled from the indexer that watches
 * Sepolia rather than from anything the app hopes is true. Two views: the
 * conversation, every command and where it landed, and the settled trades the
 * chain confirmed. A person can always cross a row here against Etherscan,
 * because the tx hash is right there and it is the same one the contract emitted.
 */

import { useMemo, useState } from "react";
import { MessageSquare, Receipt, ExternalLink } from "lucide-react";
import { tokenByAddress, tokenBySymbol } from "@roque/shared";
import type { ActivityResult, IntentRow, TradeRow } from "@/lib/types";
import { useAppData } from "@/providers/AppData";
import { formatAmount, timeAgo, shorten } from "@/lib/format";

const EXPLORER_TX = "https://sepolia.etherscan.io/tx/";

function symbolOf(address: string | null): string {
  if (!address) return "";
  return tokenByAddress(address)?.symbol ?? shorten(address, 4, 4);
}

const STATUS_TONE: Record<string, string> = {
  submitted: "tone-live",
  ready: "tone-neutral",
  interpreting: "tone-neutral",
  rejected: "tone-warn",
  failed: "tone-bad",
};

const TRADE_LABEL: Record<string, string> = {
  swap: "Swap",
  limit_created: "Order placed",
  limit_filled: "Order filled",
  limit_cancelled: "Order cancelled",
};

/**
 * A single line in the Settled view, whether it came from the indexer or from a
 * trade we just broadcast. The indexer writes token addresses; a provisional row
 * built from an intent carries the same, resolved from the symbol the intent
 * stored, so both render through one path. `pending` marks the provisional kind.
 */
interface SettledRow {
  key: string;
  kind: string;
  tokenIn: string | null;
  tokenOut: string | null;
  amountIn: string | null;
  amountOut: string | null;
  txHash: string;
  timeMs: number | null;
  blockNumber: string | null;
  pending: boolean;
  ts: number;
}

/**
 * Fold the trades the indexer has confirmed together with the ones a person has
 * just sent but that have not been indexed yet, so a completed trade lands in
 * Settled the instant it is broadcast rather than whenever the indexer next runs.
 * The provisional rows come from intents that carry a tx hash, which is true for
 * both an autonomous submission and a copilot swap that reported its hash back,
 * so both modes show up here. Keying on the tx hash means the real indexed row
 * supersedes its provisional twin the moment the indexer catches up.
 */
function mergeSettled(intents: IntentRow[], trades: TradeRow[]): SettledRow[] {
  const indexed = new Set(trades.map((t) => t.tx_hash.toLowerCase()));

  const provisional: SettledRow[] = intents
    .filter((i) => i.status === "submitted" && !!i.tx_hash && !indexed.has(i.tx_hash!.toLowerCase()))
    .map((i) => ({
      key: `intent-${i.id}`,
      kind: i.kind === "limit" ? "limit_created" : "swap",
      // The indexer keys trades by address; an intent kept the symbol, so resolve
      // it back to an address to render through the very same symbol lookup.
      tokenIn: i.token_in ? tokenBySymbol(i.token_in)?.address ?? null : null,
      tokenOut: i.token_out ? tokenBySymbol(i.token_out)?.address ?? null : null,
      // The output is only known once the trade settles on-chain, so a fresh swap
      // shows just its input leg. A percent amount has no concrete figure here.
      amountIn: i.amount_is_percent ? null : i.amount,
      amountOut: null,
      txHash: i.tx_hash!,
      timeMs: Date.parse(i.created_at) || null,
      blockNumber: null,
      pending: true,
      ts: Date.parse(i.created_at) || 0,
    }));

  const confirmed: SettledRow[] = trades.map((t, idx) => ({
    key: `trade-${t.tx_hash}-${idx}`,
    kind: t.kind,
    tokenIn: t.token_in,
    tokenOut: t.token_out,
    amountIn: t.amount_in,
    amountOut: t.amount_out,
    txHash: t.tx_hash,
    timeMs: t.block_time ? Number(t.block_time) * 1000 : null,
    blockNumber: t.block_number,
    pending: false,
    ts: t.block_time ? Number(t.block_time) * 1000 : 0,
  }));

  return [...provisional, ...confirmed].sort((a, b) => b.ts - a.ts);
}

export function ActivityFeed({
  activity,
  loading,
}: {
  activity: ActivityResult | null;
  loading: boolean;
}) {
  const [tab, setTab] = useState<"intents" | "trades">("intents");
  const { focusActivity } = useAppData();

  const intents = activity?.intents ?? [];
  const trades = activity?.trades ?? [];
  const settled = useMemo(() => mergeSettled(intents, trades), [intents, trades]);

  return (
    <section className="panel card feed">
      <header className="panel-head">
        <h3 className="panel-title">Activity</h3>
        <div className="feed-tabs">
          <button
            className={`feed-tab ${tab === "intents" ? "is-active" : ""}`}
            onClick={() => setTab("intents")}
          >
            <MessageSquare size={13} />
            Conversation
          </button>
          <button
            className={`feed-tab ${tab === "trades" ? "is-active" : ""}`}
            onClick={() => setTab("trades")}
          >
            <Receipt size={13} />
            Settled
          </button>
        </div>
      </header>

      <div className="feed-body">
        {loading && !activity ? (
          <div className="feed-loading">
            {[0, 1, 2].map((i) => (
              <div key={i} className="skeleton" style={{ height: 44 }} />
            ))}
          </div>
        ) : tab === "intents" ? (
          intents.length === 0 ? (
            <p className="feed-empty">Nothing yet. Your commands will show up here as you make them.</p>
          ) : (
            <ul className="feed-list">
              {intents.map((row: IntentRow) => (
                <li key={row.id} className="feed-row animate-fade">
                  <button
                    className="feed-row-main feed-row-btn"
                    onClick={() => focusActivity({ intentId: row.id })}
                    title="Jump to this message in chat"
                  >
                    <span className="feed-command">{row.command}</span>
                    <span className="feed-meta">
                      <span className={`feed-status ${STATUS_TONE[row.status] ?? "tone-neutral"}`}>
                        {row.status}
                      </span>
                      <span className="feed-time">{timeAgo(row.created_at)}</span>
                    </span>
                  </button>
                  {row.tx_hash ? (
                    <a
                      className="feed-link"
                      href={`${EXPLORER_TX}${row.tx_hash}`}
                      target="_blank"
                      rel="noreferrer"
                      aria-label="View transaction"
                    >
                      <ExternalLink size={14} />
                    </a>
                  ) : null}
                </li>
              ))}
            </ul>
          )
        ) : settled.length === 0 ? (
          <p className="feed-empty">No settled trades yet. Once one fills, it lands here.</p>
        ) : (
          <ul className="feed-list">
            {settled.map((row: SettledRow) => (
              <li key={row.key} className="feed-row animate-fade">
                <button
                  className="feed-row-main feed-row-btn"
                  onClick={() => focusActivity({ txHash: row.txHash })}
                  title="Jump to this trade in chat"
                >
                  <span className="feed-trade">
                    <span className="feed-trade-head">
                      <span className="feed-trade-kind">{TRADE_LABEL[row.kind] ?? row.kind}</span>
                      {row.pending ? (
                        <span className="feed-pending" title="Broadcast on-chain, confirming in the feed">
                          pending
                        </span>
                      ) : null}
                    </span>
                    <span className="feed-trade-legs tabular">
                      {row.amountIn ? `${formatAmount(row.amountIn)} ` : ""}
                      {symbolOf(row.tokenIn)}
                      {row.tokenOut ? (
                        <>
                          {" → "}
                          {row.amountOut ? `${formatAmount(row.amountOut)} ` : ""}
                          {symbolOf(row.tokenOut)}
                        </>
                      ) : null}
                    </span>
                  </span>
                  <span className="feed-time">
                    {row.timeMs
                      ? timeAgo(row.timeMs)
                      : row.blockNumber
                        ? `block ${row.blockNumber}`
                        : ""}
                  </span>
                </button>
                <a
                  className="feed-link"
                  href={`${EXPLORER_TX}${row.txHash}`}
                  target="_blank"
                  rel="noreferrer"
                  aria-label="View transaction"
                >
                  <ExternalLink size={14} />
                </a>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
