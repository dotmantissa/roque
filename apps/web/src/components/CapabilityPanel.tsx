"use client";

/**
 * The permission a person hands the agent, spelled out and revocable in one tap.
 * This is the one signature in the whole app that lets Roque act without asking
 * again, so it never hides what it grants: a ceiling per trade, a ceiling per
 * day, a slippage bound, and a date the whole thing lapses on its own. The caps
 * are enforced on-chain by the executor, not by trust in the agent, and the
 * revoke button tears the permission up the moment it mines. When a grant is
 * live, this panel becomes a status card counting down the window that is left.
 */

import { useState } from "react";
import { ShieldCheck, ShieldOff, ShieldPlus, Clock, Gauge } from "lucide-react";
import type { CapabilityResult } from "@/lib/types";
import { useWallet } from "@/lib/useWallet";
import { useToast } from "./Toaster";
import { api } from "@/lib/api";
import { signGrant, revokeCapability } from "@/lib/chain";
import { useNow } from "@/lib/hooks";
import { formatUsd, formatDuration } from "@/lib/format";

const PRESETS = [
  { days: 1, label: "1 day" },
  { days: 7, label: "1 week" },
  { days: 30, label: "1 month" },
];

const EXPLORER = "https://sepolia.etherscan.io/tx/";

export function CapabilityPanel({
  capability,
  agentSigner,
  loading,
  onChanged,
}: {
  capability: CapabilityResult | null;
  agentSigner: `0x${string}` | null;
  loading: boolean;
  onChanged: () => void;
}) {
  const wallet = useWallet();
  const toast = useToast();
  const now = useNow();

  const [perTrade, setPerTrade] = useState("250");
  const [daily, setDaily] = useState("1000");
  const [slippage, setSlippage] = useState("1.0");
  const [days, setDays] = useState(7);
  const [busy, setBusy] = useState<"grant" | "revoke" | null>(null);

  if (!wallet.connected) {
    return (
      <section className="panel card">
        <header className="panel-head">
          <span className="panel-title-icon">
            <ShieldCheck size={15} />
            <h3 className="panel-title">Agent permission</h3>
          </span>
        </header>
        <p className="panel-empty">Connect a wallet to grant or review the agent&apos;s permission.</p>
      </section>
    );
  }

  const live = capability?.granted && !capability.revoked && (capability.validUntil ?? 0) > now;

  const grant = async () => {
    if (!agentSigner) {
      toast.error("Agent is not ready", "Could not read the agent signer address.");
      return;
    }
    setBusy("grant");
    const pending = toast.push({
      kind: "pending",
      title: "Sign the permission",
      detail: "This one signature sets the agent's limits. Approve it in your wallet.",
    });
    try {
      const { client, address } = await wallet.getClient();
      const validUntil = now + days * 86400;
      const maxSlippageBps = Math.round(Number(slippage) * 100);
      const { signature, message } = await signGrant(client, address, {
        maxPerTradeUsd: perTrade,
        maxDailyUsd: daily,
        maxSlippageBps,
        validUntil,
        grantNonce: capability?.grantNonce ?? "0",
      });

      toast.dismiss(pending);
      const relaying = toast.push({
        kind: "pending",
        title: "Putting it on-chain",
        detail: "Roque is relaying your signed permission to Sepolia.",
      });
      // The relayer submits these values verbatim and the executor rehashes the
      // Grant struct over them to recover the signer, so they MUST be byte for
      // byte what was signed. signGrant already scaled the dollar caps to 1e18;
      // send those scaled strings back, never the raw "250" the field held, or
      // the recovered signer will not match and the grant reverts.
      const { txHash } = await api.grant({
        user: address,
        agentSigner,
        maxPerTradeUsd: message.maxPerTradeUsd,
        maxDailyUsd: message.maxDailyUsd,
        maxSlippageBps: message.maxSlippageBps,
        validUntil: message.validUntil,
        signature,
      });
      toast.dismiss(relaying);
      toast.success("Roque is cleared to trade", "Within the limits you just set, and not a cent past them.", {
        href: `${EXPLORER}${txHash}`,
      });
      onChanged();
    } catch (err) {
      toast.dismiss(pending);
      const message = (err as Error).message || "The grant did not go through.";
      if (/rejected|denied/iu.test(message)) {
        toast.info("Permission not signed", "Nothing changed. The agent still cannot act.");
      } else {
        toast.error("The grant did not go through", message);
      }
    } finally {
      setBusy(null);
    }
  };

  const revoke = async () => {
    setBusy("revoke");
    const pending = toast.push({
      kind: "pending",
      title: "Revoking the permission",
      detail: "Approve it in your wallet. Takes effect the moment it mines.",
    });
    try {
      const { client, address } = await wallet.getClient();
      const hash = await revokeCapability(client, address);
      toast.dismiss(pending);
      toast.success("Permission torn up", "Roque cannot act for you until you grant it again.", {
        href: `${EXPLORER}${hash}`,
      });
      onChanged();
    } catch (err) {
      toast.dismiss(pending);
      const message = (err as Error).message || "The revoke did not go through.";
      if (/rejected|denied/iu.test(message)) {
        toast.info("Left as is", "You turned that down; the permission still stands.");
      } else {
        toast.error("The revoke did not go through", message);
      }
    } finally {
      setBusy(null);
    }
  };

  if (live && capability) {
    const remaining = (capability.validUntil ?? 0) - now;
    return (
      <section className="panel card cap-live">
        <header className="panel-head">
          <span className="panel-title-icon">
            <ShieldCheck size={15} className="cap-live-icon" />
            <h3 className="panel-title">Agent is cleared</h3>
          </span>
          <span className="cap-window">
            <Clock size={13} />
            {formatDuration(remaining)} left
          </span>
        </header>

        <div className="cap-stats">
          <div className="cap-stat">
            <span className="cap-stat-label">Per trade</span>
            <span className="cap-stat-value tabular">{formatUsd(capability.maxPerTradeUsd ?? "0")}</span>
          </div>
          <div className="cap-stat">
            <span className="cap-stat-label">Left today</span>
            <span className="cap-stat-value tabular">
              {formatUsd(capability.remainingDailyUsd ?? "0")}
              <span className="cap-stat-of"> of {formatUsd(capability.maxDailyUsd ?? "0")}</span>
            </span>
          </div>
          <div className="cap-stat">
            <span className="cap-stat-label">Max slippage</span>
            <span className="cap-stat-value tabular">
              {((capability.maxSlippageBps ?? 0) / 100).toFixed(2)}%
            </span>
          </div>
        </div>

        <button className="btn cap-revoke" onClick={() => void revoke()} disabled={busy !== null}>
          {busy === "revoke" ? <span className="spinner" /> : <ShieldOff size={16} />}
          Revoke access
        </button>
      </section>
    );
  }

  return (
    <section className="panel card">
      <header className="panel-head">
        <span className="panel-title-icon">
          <ShieldPlus size={15} />
          <h3 className="panel-title">Let Roque trade for you</h3>
        </span>
      </header>

      <p className="cap-intro">
        Set the limits once and Roque can act on your words without a wallet popup each time.
        Every cap is held by the contract, not the agent&apos;s good manners.
      </p>

      <div className="cap-fields">
        <label className="cap-field">
          <span className="cap-field-label">Most per trade</span>
          <span className="cap-input-wrap">
            <span className="cap-input-prefix">$</span>
            <input
              className="cap-input tabular"
              inputMode="decimal"
              value={perTrade}
              onChange={(e) => setPerTrade(e.target.value.replace(/[^0-9.]/gu, ""))}
            />
          </span>
        </label>

        <label className="cap-field">
          <span className="cap-field-label">Most per day</span>
          <span className="cap-input-wrap">
            <span className="cap-input-prefix">$</span>
            <input
              className="cap-input tabular"
              inputMode="decimal"
              value={daily}
              onChange={(e) => setDaily(e.target.value.replace(/[^0-9.]/gu, ""))}
            />
          </span>
        </label>

        <label className="cap-field">
          <span className="cap-field-label">
            <Gauge size={12} /> Max slippage
          </span>
          <span className="cap-input-wrap">
            <input
              className="cap-input tabular"
              inputMode="decimal"
              value={slippage}
              onChange={(e) => setSlippage(e.target.value.replace(/[^0-9.]/gu, ""))}
            />
            <span className="cap-input-suffix">%</span>
          </span>
        </label>
      </div>

      <div className="cap-window-pick">
        <span className="cap-field-label">Expires in</span>
        <div className="seg">
          {PRESETS.map((p) => (
            <button
              key={p.days}
              className={`seg-btn ${days === p.days ? "is-active" : ""}`}
              onClick={() => setDays(p.days)}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      <button className="btn btn-primary cap-grant" onClick={() => void grant()} disabled={busy !== null || loading}>
        {busy === "grant" ? <span className="spinner" /> : <ShieldCheck size={16} />}
        Grant permission
      </button>
    </section>
  );
}
