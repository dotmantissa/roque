"use client";

/**
 * The trading surface, shared by both modes because the shape is the same: the
 * market up top, a slippage control, then the conversation with your own coins
 * beside it. What changes is the trust. Copilot keeps your hand on every trade and
 * shows only your wallet. Autonomous adds the vault Roque may spend from and the
 * permission that lets it, because that is the extra machinery of trading on your
 * behalf. The mode also picks which console memory this screen reads, so the two
 * conversations never mix.
 */

import { useState } from "react";
import { Settings2, ShieldCheck, Zap, AlertTriangle, X } from "lucide-react";
import type { Mode } from "@/lib/types";
import { useAppData } from "@/providers/AppData";
import { MarketBar } from "./MarketBar";
import { CommandConsole } from "./CommandConsole";
import { WalletPanel } from "./WalletPanel";
import { CapabilityPanel } from "./CapabilityPanel";
import { VaultPanel } from "./VaultPanel";

const SLIPPAGE_PRESETS = [
  { bps: 50, label: "0.5%" },
  { bps: 100, label: "1%" },
  { bps: 200, label: "2%" },
];

const COPY: Record<Mode, { title: string; sub: string }> = {
  copilot: {
    title: "You call it, you sign it",
    sub: "Say what you want in plain words. Roque reads it, quotes it against the live pool, and hands you a trade to approve. Nothing moves until you sign.",
  },
  autonomous: {
    title: "Let Roque take the wheel",
    sub: "Set the limits once and Roque trades on your words without a popup every time. It spends only from the vault, only within your caps, and you can pull the plug in one tap.",
  },
};

export function TradeScreen({ mode }: { mode: Mode }) {
  const {
    price,
    agent,
    balances,
    claims,
    vault,
    capability,
    ethUsd,
    prices,
    canAutonomous,
    slippageBps,
    setSlippageBps,
    execMode,
    setExecMode,
    refreshAll,
  } = useAppData();

  // Turning direct execution on is a deliberate, warned choice; turning it back
  // off is not, so only the on-switch passes through this confirmation.
  const [warnDirect, setWarnDirect] = useState(false);

  const copy = COPY[mode];
  const isAutonomous = mode === "autonomous";
  const directOn = isAutonomous && execMode === "direct";

  return (
    <div className="trade-screen">
      <MarketBar data={price.data} loading={price.loading} />

      <section className="trade-intro">
        <div className="trade-intro-copy">
          <h1 className="trade-title">{copy.title}</h1>
          <p className="trade-sub">{copy.sub}</p>
        </div>

        <div className="trade-controls">
          {isAutonomous ? (
            <div className="exec-mode">
              <span className="exec-mode-label">
                {directOn ? <Zap size={13} /> : <ShieldCheck size={13} />}
                Execution
              </span>
              <div className="seg">
                <button
                  className={`seg-btn ${execMode === "confirm" ? "is-active" : ""}`}
                  onClick={() => setExecMode("confirm")}
                >
                  Confirm
                </button>
                <button
                  className={`seg-btn seg-btn-danger ${execMode === "direct" ? "is-active" : ""}`}
                  onClick={() => {
                    if (execMode !== "direct") setWarnDirect(true);
                  }}
                >
                  Direct
                </button>
              </div>
            </div>
          ) : null}

          <div className="slippage">
            <span className="slippage-label">
              <Settings2 size={13} />
              Slippage
            </span>
            <div className="seg">
              {SLIPPAGE_PRESETS.map((p) => (
                <button
                  key={p.bps}
                  className={`seg-btn ${slippageBps === p.bps ? "is-active" : ""}`}
                  onClick={() => setSlippageBps(p.bps)}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      </section>

      {directOn ? (
        <div className="exec-danger-banner animate-rise" role="status" aria-live="polite">
          <AlertTriangle size={15} />
          <span>
            <strong>Direct execution is on.</strong> Roque trades the moment it reads your message,
            with no card to review and no tap to confirm. Switch to Confirm to check each trade first.
          </span>
        </div>
      ) : null}

      <div className={`workbench workbench-mode-${mode}`}>
        <div className="workbench-main">
          <CommandConsole
            mode={mode}
            ethUsd={ethUsd}
            balances={balances.data}
            prices={prices}
            canAutonomous={canAutonomous}
            slippageBps={slippageBps}
            onSettled={refreshAll}
          />
        </div>

        <aside className="workbench-wallet">
          <WalletPanel
            balances={balances.data}
            claims={claims.data}
            loading={balances.loading}
            onRefresh={refreshAll}
          />
        </aside>

        {mode === "autonomous" ? (
          <div className="autonomous-panels">
            <CapabilityPanel
              capability={capability.data}
              agentSigner={agent.data?.agentSigner ?? null}
              loading={capability.loading}
              onChanged={refreshAll}
            />
            <VaultPanel vault={vault.data} loading={vault.loading} onSettled={refreshAll} />
          </div>
        ) : null}
      </div>

      {warnDirect ? (
        <div className="modal-overlay" role="presentation">
          <div
            className="modal-dialog animate-scale-in"
            role="dialog"
            aria-modal="true"
            aria-labelledby="direct-title"
          >
            <button className="modal-x" onClick={() => setWarnDirect(false)} aria-label="Close">
              <X size={16} />
            </button>
            <div className="modal-danger-icon">
              <AlertTriangle size={22} />
            </div>
            <h3 id="direct-title" className="modal-title">
              Turn on direct execution?
            </h3>
            <p className="modal-body">
              In direct execution, Roque acts the instant it reads your message as a trade. There is
              no card to review and no tap to confirm; it signs and sends from your vault straight
              away, inside the caps you set.
              <br />
              <br />
              This is faster, and more dangerous. A misread instruction becomes a real trade before
              you can catch it. Roque still cannot spend past your capability or touch anything
              outside the vault, but within those limits it will not wait for you.
            </p>
            <div className="modal-actions">
              <button className="btn btn-ghost" onClick={() => setWarnDirect(false)}>
                Keep confirming
              </button>
              <button
                className="btn btn-danger"
                onClick={() => {
                  setExecMode("direct");
                  setWarnDirect(false);
                }}
              >
                I understand, turn it on
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
