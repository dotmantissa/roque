"use client";

/**
 * The faucet, given its own room. Every token gets a card: what you hold, how many
 * pulls you have left drawn as little pips, and one button to claim more. The
 * header carries the single signature that tops up everything at once. It is all
 * testnet play money and every pull is signed by the person, so there is nothing
 * to gate and nothing to lose; grab what you need and go trade.
 */

import { useState } from "react";
import { Droplet, Droplets } from "lucide-react";
import { tokenList, requireToken } from "@roque/shared";
import { TokenIcon } from "@/components/TokenIcon";
import { useToast } from "@/components/Toaster";
import { useAppData } from "@/providers/AppData";
import { claimFaucet, claimAllFaucets } from "@/lib/chain";
import { formatAmount } from "@/lib/format";

const EXPLORER = "https://sepolia.etherscan.io/tx/";
const ALL = "__all__";
const MAX_CLAIMS = 5;

export default function FaucetPage() {
  const { wallet, balances, claims, refreshAll } = useAppData();
  const toast = useToast();
  const [claiming, setClaiming] = useState<string | null>(null);

  const claimOne = async (symbol: string) => {
    setClaiming(symbol);
    const pending = toast.push({
      kind: "pending",
      title: `Sending you some ${symbol}`,
      detail: "Approve the faucet call in your wallet.",
    });
    try {
      const { client, address: addr } = await wallet.getClient();
      const hash = await claimFaucet(client, addr, requireToken(symbol).address);
      toast.dismiss(pending);
      toast.success(`Fresh ${symbol} landed`, "Have at it.", { href: `${EXPLORER}${hash}` });
      refreshAll();
    } catch (err) {
      toast.dismiss(pending);
      const message = (err as Error).message || "The faucet did not run.";
      if (/rejected|denied/iu.test(message)) toast.info("Faucet waved off", "You turned that one down.");
      else toast.error("Faucet did not run", message);
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
      const { client, address: addr } = await wallet.getClient();
      const hash = await claimAllFaucets(client, addr);
      toast.dismiss(pending);
      toast.success("Your wallet is stocked", "Every token you can still claim just landed.", {
        href: `${EXPLORER}${hash}`,
      });
      refreshAll();
    } catch (err) {
      toast.dismiss(pending);
      const message = (err as Error).message || "The faucet did not run.";
      if (/rejected|denied/iu.test(message)) toast.info("Faucet waved off", "You turned that one down.");
      else toast.error("Faucet did not run", message);
    } finally {
      setClaiming(null);
    }
  };

  const busy = claiming !== null;

  return (
    <div className="faucet-screen">
      <section className="faucet-hero">
        <div>
          <h1 className="faucet-title">Fund your wallet</h1>
          <p className="faucet-sub">
            Ten test tokens, each pull worth about a thousand dollars, priced off the same
            Chainlink feeds the pools were seeded at. Grab a few and go put them to work. Gas is
            plain Sepolia ETH, so keep a little of that around too.
          </p>
        </div>
        {wallet.connected ? (
          <div className="faucet-hero-side">
            <button
              className="btn btn-primary faucet-claimall"
              onClick={() => void claimEverything()}
              disabled={busy}
            >
              {claiming === ALL ? <span className="spinner" /> : <Droplets size={16} />}
              Claim all ten
            </button>
            <span className="faucet-note">One signature, whatever you can still claim.</span>
          </div>
        ) : null}
      </section>

      {!wallet.connected ? (
        <section className="card faucet-connect">
          <Droplets size={30} />
          <p>Connect a wallet to see your balances and pull the faucet. Nothing here spends, it only tops you up.</p>
          <button className="btn btn-primary" onClick={() => wallet.login()}>
            Connect wallet
          </button>
        </section>
      ) : (
        <div className="faucet-grid">
          {tokenList.map((t, i) => {
            const remaining = claims.data?.[t.symbol] ?? MAX_CLAIMS;
            const used = MAX_CLAIMS - remaining;
            const tappedOut = remaining === 0;
            return (
              <div key={t.symbol} className="card faucet-card" style={{ animationDelay: `${i * 0.03}s` }}>
                <div className="faucet-card-head">
                  <TokenIcon symbol={t.symbol} size={38} />
                  <div className="faucet-card-names">
                    <span className="faucet-card-sym">{t.symbol}</span>
                    <span className="faucet-card-name">{t.name}</span>
                  </div>
                </div>

                <div className="faucet-card-bal">
                  <span className="faucet-card-bal-label">You hold</span>
                  <span className="faucet-card-bal-num tabular">
                    {balances.loading && !balances.data ? "—" : formatAmount(balances.data?.[t.symbol] ?? 0)}
                  </span>
                </div>

                <div className="faucet-claims">
                  <span className="faucet-pips">
                    {Array.from({ length: MAX_CLAIMS }).map((_, p) => (
                      <span key={p} className={`faucet-pip ${p < used ? "is-used" : ""}`} />
                    ))}
                  </span>
                  <span className="faucet-claims-label">
                    {tappedOut ? "all claimed" : `${remaining} left`}
                  </span>
                </div>

                <button
                  className="btn btn-primary faucet-card-btn"
                  onClick={() => void claimOne(t.symbol)}
                  disabled={busy || tappedOut}
                >
                  {claiming === t.symbol ? <span className="spinner" /> : <Droplet size={15} />}
                  {tappedOut ? "Maxed out" : "Claim"}
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
