"use client";

/**
 * A person's own coins, the ones that never leave their wallet. This panel reads
 * every balance straight off Sepolia and, because it is all testnet play money,
 * offers a faucet so a fresh wallet has something to trade in the first minute.
 * One button tops up everything at once; each row can also be pulled on its own.
 * Nothing here can spend; it reads, and it asks the chain for a top up the person
 * signs for themselves.
 */

import { useState } from "react";
import Link from "next/link";
import { Droplet, Droplets, RefreshCw } from "lucide-react";
import { tokenList, requireToken } from "@roque/shared";
import { useWallet } from "@/lib/useWallet";
import { useAppData } from "@/providers/AppData";
import { useToast } from "./Toaster";
import { claimFaucet, claimAllFaucets } from "@/lib/chain";
import { formatAmount, formatUsd } from "@/lib/format";
import { TokenIcon } from "./TokenIcon";
import { PortfolioPieChart } from "./PortfolioPieChart";

const EXPLORER = "https://sepolia.etherscan.io/tx/";
const ALL = "__all__";

export function WalletPanel({
  balances,
  claims,
  loading,
  onRefresh,
}: {
  balances: Record<string, number> | null;
  claims: Record<string, number> | null;
  loading: boolean;
  onRefresh: () => void;
}) {
  const wallet = useWallet();
  const toast = useToast();
  const { prices } = useAppData();
  const [claiming, setClaiming] = useState<string | null>(null);

  const totalUsd = balances
    ? tokenList.reduce((sum, t) => sum + (balances[t.symbol] ?? 0) * (prices[t.symbol] ?? 0), 0)
    : 0;

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

  const claimOne = async (symbol: string) => {
    setClaiming(symbol);
    const pending = toast.push({
      kind: "pending",
      title: `Sending you some ${symbol}`,
      detail: "Approve the faucet call in your wallet.",
    });
    try {
      const { client, address } = await wallet.getClient();
      const hash = await claimFaucet(client, address, requireToken(symbol).address);
      toast.dismiss(pending);
      toast.success(`Fresh ${symbol} landed`, "Have at it.", { href: `${EXPLORER}${hash}` });
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

  const claimEverything = async () => {
    setClaiming(ALL);
    const pending = toast.push({
      kind: "pending",
      title: "Topping up every token",
      detail: "One signature covers the whole set.",
    });
    try {
      const { client, address } = await wallet.getClient();
      const hash = await claimAllFaucets(client, address);
      toast.dismiss(pending);
      toast.success("Your wallet is stocked", "Every token you can still claim just landed.", {
        href: `${EXPLORER}${hash}`,
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

  const busy = claiming !== null;

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

      {balances ? (
        <div className="wallet-total">
          <span className="wallet-total-label">Total value</span>
          <span className="wallet-total-value tabular">{formatUsd(totalUsd)}</span>
        </div>
      ) : null}
      {balances ? (
        <PortfolioPieChart
          slices={tokenList.map((t) => ({
            symbol: t.symbol,
            usd: (balances[t.symbol] ?? 0) * (prices[t.symbol] ?? 0),
          }))}
        />
      ) : null}

      <button className="btn btn-primary claim-all" onClick={() => void claimEverything()} disabled={busy}>
        {claiming === ALL ? <span className="spinner" /> : <Droplets size={15} />}
        Claim all test tokens
      </button>

      <div className="balance-list">
        {tokenList.map((t) => {
          const remaining = claims?.[t.symbol];
          const tappedOut = remaining === 0;
          return (
            <div key={t.symbol} className="balance-row">
              <span className="balance-token">
                <TokenIcon symbol={t.symbol} size={26} />
                <span className="balance-symbol">{t.symbol}</span>
              </span>
              <span className="balance-amount tabular">
                {loading && !balances ? (
                  <span className="skeleton" style={{ width: 68, height: 18, display: "inline-block" }} />
                ) : (
                  formatAmount(balances?.[t.symbol] ?? 0)
                )}
              </span>
              <button
                className="balance-faucet"
                onClick={() => void claimOne(t.symbol)}
                disabled={busy || tappedOut}
                title={tappedOut ? "You have used every claim for this token" : "Claim more"}
              >
                {claiming === t.symbol ? <span className="spinner" /> : <Droplet size={13} />}
                {tappedOut ? "Maxed" : "Faucet"}
              </button>
            </div>
          );
        })}
      </div>

      <Link href="/faucet" className="panel-foot-link">
        Open the full faucet
      </Link>
    </section>
  );
}