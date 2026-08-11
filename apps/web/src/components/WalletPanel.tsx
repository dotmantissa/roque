"use client";

/**
 * A person's own coins, the ones that never leave their wallet. This panel reads
 * the two balances straight off Sepolia and, because it is all testnet play
 * money, offers a faucet so a fresh wallet has something to trade in the first
 * minute. Nothing here can spend; it reads, and it asks the chain for a top up
 * the person signs for themselves.
 */

import { useState } from "react";
import { Droplet, RefreshCw } from "lucide-react";
import { tokens } from "@roque/shared";
import { useWallet } from "@/lib/useWallet";
import { useToast } from "./Toaster";
import { claimFaucet } from "@/lib/chain";
import { formatAmount } from "@/lib/format";
import { TokenIcon } from "./TokenIcon";

export function WalletPanel({
  balances,
  loading,
  onRefresh,
}: {
  balances: { USDC: number; WETH: number } | null;
  loading: boolean;
  onRefresh: () => void;
}) {
  const wallet = useWallet();
  const toast = useToast();
  const [claiming, setClaiming] = useState<"USDC" | "WETH" | null>(null);

  if (!wallet.connected) {
    return (
      <section className="panel card">
        <header className="panel-head">
          <h3 className="panel-title">Your wallet</h3>
        </header>
        <p className="panel-empty">Connect a wallet to see your balances and grab test funds.</p>
      </section>
    );
  }

  const faucet = async (key: "USDC" | "WETH") => {
    setClaiming(key);
    const pending = toast.push({
      kind: "pending",
      title: `Sending you some ${key}`,
      detail: "Approve the faucet call in your wallet.",
    });
    try {
      const { client, address } = await wallet.getClient();
      const hash = await claimFaucet(client, address, tokens[key].address);
      toast.dismiss(pending);
      toast.success(`Fresh ${key} landed`, "Have at it.", {
        href: `https://sepolia.etherscan.io/tx/${hash}`,
      });
      onRefresh();
    } catch (err) {
      toast.dismiss(pending);
      const message = (err as Error).message || "The faucet did not run.";
      if (/rejected|denied/iu.test(message)) {
        toast.info("Faucet waved off", "You turned that one down.");
      } else {
        toast.error("Faucet did not run", message);
      }
    } finally {
      setClaiming(null);
    }
  };

  const rows: Array<{ key: "USDC" | "WETH"; label: string }> = [
    { key: "USDC", label: "USDC" },
    { key: "WETH", label: "WETH" },
  ];

  return (
    <section className="panel card">
      <header className="panel-head">
        <h3 className="panel-title">Your wallet</h3>
        <button
          className="panel-refresh"
          onClick={onRefresh}
          aria-label="Refresh balances"
          title="Refresh"
        >
          <RefreshCw size={14} className={loading ? "is-spinning" : ""} />
        </button>
      </header>

      <div className="balance-list">
        {rows.map(({ key, label }) => (
          <div key={key} className="balance-row">
            <span className="balance-token">
              <TokenIcon symbol={key} size={26} />
              <span className="balance-symbol">{label}</span>
            </span>
            <span className="balance-amount tabular">
              {loading && !balances ? (
                <span className="skeleton" style={{ width: 68, height: 18, display: "inline-block" }} />
              ) : (
                formatAmount(balances?.[key] ?? 0)
              )}
            </span>
            <button
              className="balance-faucet"
              onClick={() => void faucet(key)}
              disabled={claiming !== null}
            >
              {claiming === key ? <span className="spinner" /> : <Droplet size={13} />}
              Faucet
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}
