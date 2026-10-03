"use client";

/**
 * A playbook as a ladder you can read down. Each step shows where the keeper has
 * got to: done steps keep their hash, the step being waited on is marked as the
 * live one, and everything after it is plainly still ahead. The cursor is the
 * point of the whole feature, so it is drawn rather than described.
 *
 * A screened event step carries the validators' reasoning inline, because a step
 * that cleared the screen and a step that was never screened look otherwise
 * identical and mean very different things.
 *
 * Arming is where a draft becomes a commitment, so it is also where the vault has
 * to be able to pay for the whole ladder. The button is unavailable until it can,
 * with the shortfall named underneath: the server refuses the same plan for the
 * same reason, and being told before the click is strictly better.
 */

import {
  Ban,
  Check,
  Clock,
  ExternalLink,
  Loader2,
  Pencil,
  Radar,
  Rocket,
  ShieldCheck,
  TrendingDown,
  TrendingUp,
  Zap,
} from "lucide-react";
import type { Playbook, PlaybookStep, PlaybookTrigger } from "@/lib/types";
import { ShareButton } from "./ShareButton";
import { TokenIcon } from "./TokenIcon";
import { formatAmount, timeAgo } from "@/lib/format";
import { vaultShortfall } from "@/lib/funding";
import { useAppData } from "@/providers/AppData";

const EXPLORER = "https://sepolia.etherscan.io/tx/";

const STATUS_TONE: Record<Playbook["status"], string> = {
  draft: "tone-neutral",
  armed: "tone-live",
  completed: "tone-live",
  cancelled: "tone-bad",
  failed: "tone-bad",
};

const STATUS_LABEL: Record<Playbook["status"], string> = {
  draft: "Draft",
  armed: "Running",
  completed: "Finished",
  cancelled: "Cancelled",
  failed: "Failed",
};

function triggerIcon(t: PlaybookTrigger) {
  switch (t.kind) {
    case "price":
      return t.direction === "above" ? <TrendingUp size={13} /> : <TrendingDown size={13} />;
    case "event":
      return <Radar size={13} />;
    case "delay":
      return <Clock size={13} />;
    default:
      return <Zap size={13} />;
  }
}

function stepIcon(s: PlaybookStep, isCursor: boolean) {
  if (s.status === "done") return <Check size={13} />;
  if (s.status === "failed") return <Ban size={13} />;
  if (s.status === "firing") return <Loader2 size={13} className="is-spinning" />;
  if (isCursor) return <Radar size={13} />;
  return <Clock size={13} />;
}

export function PlaybookCard({
  playbook,
  onArm,
  onEdit,
  onCancel,
  busy,
  editing,
}: {
  playbook: Playbook;
  onArm: (id: string) => void;
  onEdit: (playbook: Playbook) => void;
  onCancel: (id: string) => void;
  busy: string | null;
  /** True when this is the draft currently loaded into the builder. */
  editing?: boolean;
}) {
  const { vault } = useAppData();
  const working = busy === playbook.id;
  const live = playbook.status === "armed";
  const done = playbook.steps.filter((s) => s.status === "done").length;

  // Only a draft can be armed, so only a draft is worth costing out.
  const shortfall =
    playbook.status === "draft"
      ? vaultShortfall(
          playbook.steps.map((s, i) => ({
            tokenIn: s.action.tokenIn,
            tokenOut: s.action.tokenOut,
            amount: s.action.amount,
            amountIsPercent: s.action.amountIsPercent,
            where: `Step ${i + 1}`,
          })),
          vault.data?.availableRaw,
        )
      : null;

  return (
        <article className="card playbook-card animate-rise">
      <header className="playbook-card-head">
        <div className="playbook-card-titles">
          <h3 className="playbook-card-name">{playbook.name}</h3>
          {playbook.note ? <p className="playbook-card-note">{playbook.note}</p> : null}
        </div>
        <span className={`event-status ${STATUS_TONE[playbook.status]}`}>
          {STATUS_LABEL[playbook.status]}
        </span>
      </header>

      <p className="playbook-progress">
        {done} of {playbook.steps.length} step{playbook.steps.length === 1 ? "" : "s"} fired
        {playbook.sourceSlug ? " · forked from a link" : ""}
        {playbook.lastCheckedAt && live ? ` · looked ${timeAgo(playbook.lastCheckedAt)}` : ""}
      </p>

      <ol className="playbook-ladder">
        {playbook.steps.map((s, i) => {
          const isCursor = live && i === playbook.stepCursor;
          const ahead = i > playbook.stepCursor && playbook.status !== "completed";
          const size = s.action.amountIsPercent
            ? `${s.action.amount}% of ${s.action.tokenIn}`
            : `${formatAmount(s.action.amount)} ${s.action.tokenIn}`;
          return (
            <li
              key={s.id}
              className={`playbook-rung status-${s.status} ${isCursor ? "is-cursor" : ""} ${
                ahead ? "is-ahead" : ""
              }`}
            >
              <span className="playbook-rung-mark">{stepIcon(s, isCursor)}</span>
              <div className="playbook-rung-body">
                <p className="playbook-rung-label">
                  <span className="playbook-rung-trigger">{triggerIcon(s.trigger)}</span>
                  {s.label}
                </p>
                <p className="playbook-rung-trade">
                  <TokenIcon symbol={s.action.tokenIn} size={14} />
                  {size}
                  <span className="event-flow-arrow">&rarr;</span>
                  <TokenIcon symbol={s.action.tokenOut} size={14} />
                  {s.action.tokenOut}
                </p>
                {s.screen ? (
                  <p className="playbook-rung-screen">
                    <ShieldCheck size={12} />
                    {s.screen.reason}
                  </p>
                ) : null}
                {s.verdict ? (
                  <p className="playbook-rung-verdict">{s.verdict.rationale}</p>
                ) : null}
                {s.error ? <p className="playbook-rung-error">{s.error}</p> : null}
                {s.txHash ? (
                  <a
                    className="event-tx"
                    href={`${EXPLORER}${s.txHash}`}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    View the fill <ExternalLink size={11} />
                  </a>
                ) : null}
                {isCursor ? <p className="playbook-rung-now">Waiting on this one now</p> : null}
              </div>
            </li>
          );
        })}
      </ol>

      {playbook.error ? <p className="event-error">{playbook.error}</p> : null}

      {shortfall ? <p className="playbook-fund-warn">{shortfall}</p> : null}

      <footer className="event-card-foot">
        <span className="event-foot-spacer" />
        {/* Editing is offered before arming, and only on a draft, which is the
            only state where changing the plan is still free. An armed plan has
            money held against its rungs; the way to change that is to cancel. */}
        {playbook.status === "draft" ? (
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => onEdit(playbook)}
            disabled={working}
            title="Change the steps while this is still a draft"
          >
            <Pencil size={14} />
            {editing ? "Editing" : "Edit"}
          </button>
        ) : null}
        {playbook.status === "draft" ? (
          <button
            className="btn btn-primary btn-sm"
            onClick={() => onArm(playbook.id)}
            disabled={working || shortfall !== null}
            title={shortfall ?? undefined}
          >
            {working ? <span className="spinner" /> : <Rocket size={14} />}
            Arm it
          </button>
        ) : null}
        {playbook.status === "armed" || playbook.status === "completed" ? (
          <ShareButton kind="playbook" id={playbook.id} defaultTitle={playbook.name} />
        ) : null}
        {playbook.status === "draft" || live ? (
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => onCancel(playbook.id)}
            disabled={working}
          >
            Cancel
          </button>
        ) : null}
      </footer>
    </article>
  );
}
