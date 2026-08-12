"use client";

/**
 * The record of what actually happened, pulled from the indexer that watches
 * Sepolia rather than from anything the app hopes is true. Two views: the
 * conversation, every command and where it landed, and the settled trades the
 * chain confirmed. A person can always cross a row here against Etherscan,
 * because the tx hash is right there and it is the same one the contract emitted.
 */

import { useState } from "react";
import { MessageSquare, Receipt, ExternalLink } from "lucide-react";
import { tokenByAddress } from "@roque/shared";
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
        ) : trades.length === 0 ? (
          <p className="feed-empty">No settled trades yet. Once one fills, it lands here.</p>
        ) : (
          <ul className="feed-list">
            {trades.map((row: TradeRow, i: number) => (
              <li key={`${row.tx_hash}-${i}`} className="feed-row animate-fade">
                <button
                  className="feed-row-main feed-row-btn"
                  onClick={() => focusActivity({ txHash: row.tx_hash })}
                  title="Jump to this trade in chat"
                >
                  <span className="feed-trade">
                    <span className="feed-trade-kind">{TRADE_LABEL[row.kind] ?? row.kind}</span>
                    <span className="feed-trade-legs tabular">
                      {formatAmount(row.amount_in)} {symbolOf(row.token_in)}
                      {row.amount_out ? (
                        <>
                          {" → "}
                          {formatAmount(row.amount_out)} {symbolOf(row.token_out)}
                        </>
                      ) : null}
                    </span>
                  </span>
                  <span className="feed-time">
                    {row.block_time ? timeAgo(Number(row.block_time) * 1000) : `block ${row.block_number}`}
                  </span>
                </button>
                <a
                  className="feed-link"
                  href={`${EXPLORER_TX}${row.tx_hash}`}
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
