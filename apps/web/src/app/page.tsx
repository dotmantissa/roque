"use client";

/**
 * The whole app on one screen, the way a trading surface should be: the market up
 * top, the conversation in the middle, and the things a person reaches for down
 * the side. Everything that ticks is polled here, once, and handed down, so the
 * price the console quotes against is the same price the market strip shows and
 * the balances a trade checks are the same ones the wallet panel prints. There is
 * one source of truth per fact, and it lives here.
 */

import { useEffect, useMemo, useState } from "react";
import { Settings2 } from "lucide-react";
import type { Mode } from "@/lib/types";
import { api } from "@/lib/api";
import { walletBalances } from "@/lib/chain";
import { usePoll } from "@/lib/hooks";
import { useWallet } from "@/lib/useWallet";
import { Header } from "@/components/Header";
import { MarketBar } from "@/components/MarketBar";
import { ModeSwitch } from "@/components/ModeSwitch";
import { CommandConsole } from "@/components/CommandConsole";
import { WalletPanel } from "@/components/WalletPanel";
import { VaultPanel } from "@/components/VaultPanel";
import { CapabilityPanel } from "@/components/CapabilityPanel";
import { ActivityFeed } from "@/components/ActivityFeed";

const SLIPPAGE_PRESETS = [
  { bps: 50, label: "0.5%" },
  { bps: 100, label: "1%" },
  { bps: 200, label: "2%" },
];

const MODE_KEY = "roque-mode";

export default function Home() {
  const wallet = useWallet();
  const address = wallet.address;

  const [mode, setMode] = useState<Mode>("copilot");
  const [slippageBps, setSlippageBps] = useState(100);

  // Remember the mode a person last traded in, so the app opens the way they left it.
  useEffect(() => {
    const saved = typeof window !== "undefined" ? window.localStorage.getItem(MODE_KEY) : null;
    if (saved === "copilot" || saved === "autonomous") setMode(saved);
  }, []);

  const chooseMode = (m: Mode) => {
    setMode(m);
    try {
      window.localStorage.setItem(MODE_KEY, m);
    } catch {
      // A blocked storage just means the choice is not remembered next visit.
    }
  };

  const price = usePoll(() => api.price(), 12_000, []);
  const agent = usePoll(() => api.agent(), 600_000, []);
  const balances = usePoll(
    address ? () => walletBalances(address) : null,
    15_000,
    [address],
  );
  const vault = usePoll(address ? () => api.vault(address) : null, 20_000, [address]);
  const capability = usePoll(address ? () => api.capability(address) : null, 20_000, [address]);
  const activity = usePoll(address ? () => api.activity(address) : null, 15_000, [address]);

  const ethUsd = price.data?.ethUsd ?? 0;

  const canAutonomous = useMemo(() => {
    const cap = capability.data;
    if (!cap || !cap.granted || cap.revoked) return false;
    return (cap.validUntil ?? 0) > Math.floor(Date.now() / 1000);
  }, [capability.data]);

  // After anything that moves money or permission, pull the affected reads fresh
  // so the side panels catch up without waiting on the next poll tick.
  const refreshAll = () => {
    balances.refresh();
    vault.refresh();
    capability.refresh();
    activity.refresh();
  };
  return (
    <>
      <Header />
      <main className="page">
        <div className="page-inner">
          <MarketBar data={price.data} loading={price.loading} />

          <section className="hero">
            <div className="hero-copy">
              <h1 className="hero-title">
                Trade the way you&apos;d say it
              </h1>
              <p className="hero-sub">
                Tell Roque what you want in plain words. A judgment layer reads it, the
                contracts on Sepolia decide, and your keys never leave your hands.
              </p>
            </div>
            <div className="hero-controls">
              <ModeSwitch mode={mode} onChange={chooseMode} />
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

          <div className="workbench">
            <div className="workbench-main">
              <CommandConsole
                mode={mode}
                ethUsd={ethUsd}
                balances={balances.data}
                canAutonomous={canAutonomous}
                slippageBps={slippageBps}
                onSettled={refreshAll}
              />
            </div>

            <aside className="workbench-side">
              <WalletPanel
                balances={balances.data}
                loading={balances.loading}
                onRefresh={balances.refresh}
              />

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

              <ActivityFeed activity={activity.data} loading={activity.loading} />
            </aside>
          </div>
        </div>

        <footer className="site-footer">
          <span>Roque runs on Sepolia test money. Nothing here is financial advice, just a demo with real signatures.</span>
        </footer>
      </main>
    </>
  );
}
