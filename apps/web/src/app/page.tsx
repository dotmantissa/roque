"use client";

/**
 * The front door. A person lands here before anything is connected, so it stays
 * quiet on purpose: the name, the one-line pitch, and a single thing to do. Before
 * a wallet is on, that thing is Connect. The moment one is, the button flips to
 * Enter app and walks them straight into the copilot. The market line underneath
 * pulls a real ether price so even the landing is reading the same chain the app
 * trades on, not a screenshot.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowRight, Wallet } from "lucide-react";
import { RoqueLogo, RoqueMark } from "@/components/RoqueMark";
import { ThemeToggle } from "@/components/ThemeToggle";
import { useWallet } from "@/lib/useWallet";
import { api } from "@/lib/api";
import { formatPrice } from "@/lib/format";

const POINTS = [
  {
    title: "Say it in plain words",
    body: "No order tickets or dropdowns. Tell Roque what you want and it reads your words into a trade you can check before it moves.",
  },
  {
    title: "The chain has the final say",
    body: "A judgment layer reads intent, but deterministic contracts on Sepolia hold the money and settle the trade. No numbers are taken on faith.",
  },
  {
    title: "Your keys, start to finish",
    body: "Sign every trade yourself in copilot, or hand Roque limits it cannot cross in autonomous. Either way, you hold the only gate.",
  },
];

export default function Landing() {
  const wallet = useWallet();
  const [ethUsd, setEthUsd] = useState<number | null>(null);

  // A single read for the hero line. It is fine if this never lands; the pitch
  // stands on its own and the number is a garnish, not a promise.
  useEffect(() => {
    let alive = true;
    api
      .price()
      .then((p) => {
        if (alive) setEthUsd(p.ethUsd);
      })
      .catch(() => {
        // No price line on the landing; the app itself will show it in full.
      });
    return () => {
      alive = false;
    };
  }, []);

  return (
    <div className="landing">
      <header className="landing-nav">
        <Link href="/" className="site-brand" aria-label="Roque home">
          <RoqueLogo size={26} />
        </Link>
        <div className="landing-nav-right">
          <ThemeToggle />
          {wallet.connected ? (
            <Link href="/copilot" className="btn btn-primary">
              Enter app
              <ArrowRight size={17} />
            </Link>
          ) : (
            <button className="btn btn-primary" onClick={() => wallet.login()} disabled={!wallet.ready}>
              <Wallet size={17} />
              Connect wallet
            </button>
          )}
        </div>
      </header>

      <main className="landing-main">
        <section className="landing-hero">
          <span className="landing-eyebrow">
            <RoqueMark size={15} gradient />
            Agent native exchange
          </span>
          <h1 className="landing-title">Trade the way you&apos;d say it.</h1>
          <p className="landing-lede">
            Roque listens, reads your words into a real trade, and lets the chain decide. You keep
            your keys, your limits, and the last word on every move.
          </p>

          <div className="landing-cta">
            {wallet.connected ? (
              <Link href="/copilot" className="btn btn-primary landing-cta-btn">
                Enter app
                <ArrowRight size={18} />
              </Link>
            ) : (
              <button
                className="btn btn-primary landing-cta-btn"
                onClick={() => wallet.login()}
                disabled={!wallet.ready}
              >
                <Wallet size={18} />
                Connect wallet
              </button>
            )}
            <span className="landing-cta-note">
              {wallet.connected
                ? "Wallet on. Step inside whenever you are ready."
                : "Bring a wallet you already trust. Nothing else to sign up for."}
            </span>
          </div>

          {ethUsd ? (
            <div className="landing-ticker">
              <span className="landing-ticker-dot" />
              Live on Sepolia · ETH at <span className="tabular">${formatPrice(ethUsd)}</span>
            </div>
          ) : null}
        </section>

        <section className="landing-points">
          {POINTS.map((p) => (
            <div key={p.title} className="card landing-point">
              <h2 className="landing-point-title">{p.title}</h2>
              <p className="landing-point-body">{p.body}</p>
            </div>
          ))}
        </section>
      </main>

      <footer className="landing-footer">
        Roque runs on Sepolia test money. Nothing here is financial advice, just a demo with real
        signatures.
      </footer>
    </div>
  );
}
