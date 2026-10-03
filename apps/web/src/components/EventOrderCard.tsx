"use client";

/**
 * One event order, told as a story with a beginning. The condition sits at the
 * top in the person's own words, then whatever Roque has learned about it: first
 * whether the validators think it is checkable at all, then what they last found
 * when they looked, then the trade it settles into.
 *
 * The screen verdict gets real room because it is the honest part. A condition
 * this system cannot source evidence for is refused with the reasoning attached,
 * rather than accepted and left to sit forever pretending it might fill.
 */

import { useState } from "react";
import {
  Ban,
  CalendarClock,
  Zap,
  Check,
  ChevronDown,
  ExternalLink,
  Hourglass,
  Loader2,
  Newspaper,
  Rocket,
  ShieldAlert,
  ShieldCheck,
  Radar,
} from "lucide-react";
import type { EventOrder } from "@/lib/types";
import { TokenIcon } from "./TokenIcon";
import { ShareButton } from "./ShareButton";
import { formatAmount, timeAgo, timeUntil, exactTime } from "@/lib/format";

const EXPLORER = "https://sepolia.etherscan.io/tx/";

const STATUS: Record<
  EventOrder["status"],
  { label: string; tone: string; icon: React.ReactNode }
> = {
  // Not "Screening": nothing is happening yet. The order sits here until the
  // person asks for the screen, and a spinner on a card that is doing nothing
  // reads as work in progress that never finishes.
  screening: { label: "Awaiting screen", tone: "tone-neutral", icon: <Hourglass size={13} /> },
  screened: { label: "Ready to arm", tone: "tone-warn", icon: <ShieldCheck size={13} /> },
  rejected: { label: "Refused", tone: "tone-bad", icon: <ShieldAlert size={13} /> },
  armed: { label: "Watching", tone: "tone-live", icon: <Radar size={13} /> },
  // The condition came true and the trade is in the air. Seconds, usually, but
  // it is a real state and a card with no label on it looks broken.
  firing: { label: "Trading now", tone: "tone-live", icon: <Zap size={13} /> },
  filled: { label: "Filled", tone: "tone-live", icon: <Check size={13} /> },
  failed: { label: "Failed", tone: "tone-bad", icon: <Ban size={13} /> },
  expired: { label: "Expired", tone: "tone-warn", icon: <CalendarClock size={13} /> },
  cancelled: { label: "Cancelled", tone: "tone-bad", icon: <Ban size={13} /> },
};

export function EventOrderCard({
  order,
  onScreen,
  onArm,
  onCancel,
  busy,
}: {
  order: EventOrder;
  onScreen: (id: string) => void;
  onArm: (id: string) => void;
  onCancel: (id: string) => void;
  busy: string | null;
}) {
  const [openEvidence, setOpenEvidence] = useState(false);
  const status = STATUS[order.status];
  const working = busy === order.id;
  const size = order.amountIsPercent
    ? `${order.amount}% of ${order.tokenIn}`
    : `${formatAmount(order.amount)} ${order.tokenIn}`;
  // What can still be called off. 'firing' is deliberately out: the swap is
  // already in the air, and offering a button that the server will turn down is
  // worse than not offering one for the few seconds it lasts.
  const live =
    order.status === "armed" || order.status === "screening" || order.status === "screened";
  const items = order.evidence?.items ?? [];

  return (
        <article className={`card event-card animate-rise ${order.status === "rejected" ? "is-refused" : ""}`}>
      <header className="event-card-head">
        <span className={`event-status ${status.tone}`}>
          {/* The spinner belongs to the request, not the status. It shows while
              this card is the one waiting on the server and nowhere else. */}
          {working ? <Loader2 size={13} className="is-spinning" /> : status.icon}
          {working && order.status === "screening" ? "Screening" : status.label}
        </span>
        <span className="event-card-time">{timeAgo(order.createdAt)}</span>
      </header>

      <p className="event-condition">
        <span className="event-condition-if">If</span> {order.condition}
      </p>

      <div className="event-flow">
        <span className="event-leg">
          <TokenIcon symbol={order.tokenIn} size={18} />
          <span className="event-leg-text">{size}</span>
        </span>
        <span className="event-flow-arrow">&rarr;</span>
        <span className="event-leg">
          <TokenIcon symbol={order.tokenOut} size={18} />
          <span className="event-leg-text">{order.tokenOut}</span>
        </span>
      </div>

      {/* The screen. This is the part that makes the feature honest, so it is
          never hidden behind a disclosure. */}
      {order.screenVerdict ? (
        <div
          className={`event-screen ${order.screenVerdict === "verifiable" ? "is-ok" : "is-refused"}`}
        >
          {order.screenVerdict === "verifiable" ? (
            <ShieldCheck size={15} />
          ) : (
            <ShieldAlert size={15} />
          )}
          <div>
            <p className="event-screen-title">
              {order.screenVerdict === "verifiable"
                ? "The validators can check this"
                : "The validators cannot check this"}
              {order.screenConfidence ? (
                <span className={`event-conf conf-${order.screenConfidence}`}>
                  {order.screenConfidence} confidence
                </span>
              ) : null}
            </p>
            {order.screenReason ? <p className="event-screen-reason">{order.screenReason}</p> : null}
            {order.screenSources?.length ? (
              <p className="event-screen-sources">
                Evidence would come from {order.screenSources.slice(0, 3).join(", ")}
              </p>
            ) : null}
          </div>
        </div>
      ) : order.status === "screening" ? (
        <div className="event-screen is-pending">
          {working ? <Loader2 size={15} className="is-spinning" /> : <Hourglass size={15} />}
          <div>
            <p className="event-screen-title">
              {working ? "Asking the validators" : "Not yet screened"}
            </p>
            <p className="event-screen-reason">
              {working
                ? "A consensus round across validators. It takes about half a minute."
                : "Press Screen it to ask the validators whether this is checkable. It takes about half a minute, and nothing can fill until it passes."}
            </p>
          </div>
        </div>
      ) : null}

      {order.verdictRationale ? (
        <div className="event-verdict">
          <p className="event-verdict-head">
            Last look{order.lastCheckedAt ? ` · ${timeAgo(order.lastCheckedAt)}` : ""}
            {order.verdictConfidence ? (
              <span className={`event-conf conf-${order.verdictConfidence}`}>
                {order.verdictConfidence}
              </span>
            ) : null}
          </p>
          <p className="event-verdict-body">{order.verdictRationale}</p>
        </div>
      ) : null}

      {items.length ? (
        <div className="event-evidence">
          <button
            type="button"
            className="event-evidence-toggle"
            onClick={() => setOpenEvidence((v) => !v)}
            aria-expanded={openEvidence}
          >
            <Newspaper size={13} />
            {items.length} source{items.length === 1 ? "" : "s"} the validators read
            <ChevronDown size={13} className={openEvidence ? "is-flipped" : ""} />
          </button>
          {openEvidence ? (
            <ul className="event-evidence-list">
              {items.map((it, i) => (
                <li key={`${it.url ?? it.title}-${i}`}>
                  {it.url ? (
                    <a href={it.url} target="_blank" rel="noopener noreferrer">
                      {it.title}
                      <ExternalLink size={11} />
                    </a>
                  ) : (
                    <span>{it.title}</span>
                  )}
                  <span className="event-evidence-src">{it.source}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {order.error ? <p className="event-error">{order.error}</p> : null}

      <footer className="event-card-foot">
        {order.txHash ? (
          <a
            className="event-tx"
            href={`${EXPLORER}${order.txHash}`}
            target="_blank"
            rel="noopener noreferrer"
          >
            View the fill <ExternalLink size={12} />
          </a>
        ) : null}
        {order.expiresAt && live ? (
          <span className="event-expiry" title={exactTime(order.expiresAt)}>
            Expires {timeUntil(order.expiresAt)}
          </span>
        ) : null}
        {order.expiresAt && order.status === "expired" ? (
          <span className="event-expiry" title={exactTime(order.expiresAt)}>
            Expired {timeAgo(order.expiresAt)}
          </span>
        ) : null}
        <span className="event-foot-spacer" />
        {order.status === "screening" ? (
          <button
            className="btn btn-primary btn-sm"
            onClick={() => onScreen(order.id)}
            disabled={working}
          >
            {working ? <span className="spinner" /> : <ShieldCheck size={14} />}
            Screen it
          </button>
        ) : null}
        {order.status === "screened" ? (
          <button
            className="btn btn-primary btn-sm"
            onClick={() => onArm(order.id)}
            disabled={working}
            title="Put this order live and set aside the money it will spend"
          >
            {working ? <span className="spinner" /> : <Rocket size={14} />}
            Arm it
          </button>
        ) : null}
        {order.status === "armed" || order.status === "screened" ? (
          <ShareButton kind="event_order" id={order.id} defaultTitle={order.condition} />
        ) : null}
        {live ? (
          <button className="btn btn-ghost btn-sm" onClick={() => onCancel(order.id)} disabled={working}>
            Cancel
          </button>
        ) : null}
      </footer>
    </article>
  );
}
