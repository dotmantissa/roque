"use client";

/**
 * One proposal from the agent. Title, what it noticed, and the part that earns
 * the interruption: why. A suggestion without its reasoning is just noise, so
 * the rationale is never collapsed.
 *
 * Two buttons and no third option: take it, which builds the thing and hands you
 * the page it landed on, or clear it. Accepting never signs and never spends; it
 * only creates the order or the draft, and arming stays a separate decision.
 */

import { Check, X, ArrowUpRight } from "lucide-react";
import type { Proposal } from "@/lib/types";
import { timeAgo } from "@/lib/format";

const KIND_LABEL: Record<string, string> = {
  capability_expiring: "Permission",
  rejected_condition: "Refused order",
  far_trigger: "Stale order",
  drawdown_ladder: "Market",
  rally_trim: "Market",
  idle_vault: "Vault",
};

export function ProposalCard({
  proposal,
  onAccept,
  onDismiss,
  busy,
}: {
  proposal: Proposal;
  onAccept: (id: string) => void;
  onDismiss: (id: string) => void;
  busy: string | null;
}) {
  const working = busy === proposal.id;
  const verb =
    proposal.action.type === "open"
      ? proposal.action.label
      : proposal.action.type === "cancel_event_order"
        ? "Cancel it"
        : proposal.action.type === "playbook"
          ? "Draft the playbook"
          : "Write the order";

  return (
        <article className="card proposal-card animate-rise">
      <header className="proposal-head">
        <span className="proposal-kind">{KIND_LABEL[proposal.kind] ?? "Note"}</span>
        <span className="event-card-time">{timeAgo(proposal.createdAt)}</span>
      </header>

      <h3 className="proposal-title">{proposal.title}</h3>
      <p className="proposal-detail">{proposal.detail}</p>

      {proposal.rationale ? (
        <p className="proposal-why">
          <span className="proposal-why-label">Why</span>
          {proposal.rationale}
        </p>
      ) : null}

      <footer className="event-card-foot">
        <span className="event-foot-spacer" />
        <button
          className="btn btn-ghost btn-sm"
          onClick={() => onDismiss(proposal.id)}
          disabled={working}
        >
          <X size={14} />
          Clear
        </button>
        <button
          className="btn btn-primary btn-sm"
          onClick={() => onAccept(proposal.id)}
          disabled={working}
        >
          {working ? (
            <span className="spinner" />
          ) : proposal.action.type === "open" ? (
            <ArrowUpRight size={14} />
          ) : (
            <Check size={14} />
          )}
          {verb}
        </button>
      </footer>
    </article>
  );
}
