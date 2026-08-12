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

import { Settings2 } from "lucide-react";
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

const CHAT_KEYS: Record<Mode, string> = {
  copilot: "roque-chat-copilot",
  autonomous: "roque-chat-autonomous",
};

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
    refreshAll,
  } = useAppData();

  const copy = COPY[mode];

  return (
    <div className="trade-screen">
      <MarketBar data={price.data} loading={price.loading} />

      <section className="trade-intro">
        <div className="trade-intro-copy">
          <h1 className="trade-title">{copy.title}</h1>
          <p className="trade-sub">{copy.sub}</p>
        </div>
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
      </section>

      <div className="workbench">
        <div className="workbench-main">
          <CommandConsole
            mode={mode}
            storageKey={CHAT_KEYS[mode]}
            ethUsd={ethUsd}
            balances={balances.data}
            prices={prices}
            canAutonomous={canAutonomous}
            slippageBps={slippageBps}
            onSettled={refreshAll}
          />
        </div>

        <aside className="workbench-side">
          {mode === "autonomous" ? (
            <>
              <CapabilityPanel
                capability={capability.data}
                agentSigner={agent.data?.agentSigner ?? null}
                loading={capability.loading}
                onChanged={refreshAll}
              />
              <VaultPanel vault={vault.data} loading={vault.loading} onSettled={refreshAll} />
            </>
          ) : null}

          <WalletPanel
            balances={balances.data}
            claims={claims.data}
            loading={balances.loading}
            onRefresh={refreshAll}
          />
        </aside>
      </div>
    </div>
  );
}
