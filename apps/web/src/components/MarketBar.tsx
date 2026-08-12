"use client";

/**
 * The market strip that sits above everything. It reads the same Chainlink prices
 * the contracts settle against, so what a person sees here is exactly what a swap
 * will price against. Ether leads on the left and stays put, because it is the
 * asset the resting book watches, and its oracle age ticks in real time; if the
 * feed ever goes stale the dot turns amber, because a price you cannot trust is
 * worse than no price at all.
 *
 * The rest of the assets share one slot on the right. Each drops in from the top,
 * holds for five seconds, and is pushed off by the next, so a person catches every
 * price without the strip turning into a wall of tickers.
 */

import { useEffect, useState } from "react";
import { Activity } from "lucide-react";
import { tokenList } from "@roque/shared";
import type { PriceResult } from "@/lib/types";
import { formatPrice } from "@/lib/format";
import { TokenIcon } from "./TokenIcon";

// The assets that take turns in the rotating slot: everything that is not a dollar
// stable and not ether itself. Order follows the deploy roster.
const ROTATION = tokenList.filter((t) => !t.isStable && t.symbol !== "rWETH");

const HOLD_MS = 5000;

export function MarketBar({
  data,
  loading,
}: {
  data: PriceResult | null;
  loading: boolean;
}) {
  const fresh = data ? data.ageSeconds < 3600 : true;
  const prices = data?.prices ?? {};
  const [idx, setIdx] = useState(0);

  // Advance the slot on a fixed beat. The key on the token wrapper changes with
  // the index, so React remounts it and the drop-in animation plays every turn.
  useEffect(() => {
    if (ROTATION.length <= 1) return;
    const timer = setInterval(() => {
      setIdx((i) => (i + 1) % ROTATION.length);
    }, HOLD_MS);
    return () => clearInterval(timer);
  }, []);

  const token = ROTATION[idx];
  const price = token ? prices[token.symbol] : undefined;

  return (
    <div className="market-bar card">
      <div className="market-cell market-price">
        <div className="market-label">
          <Activity size={14} />
          ETH price
        </div>
        {loading && !data ? (
          <div className="skeleton" style={{ width: 120, height: 30 }} />
        ) : (
          <div className="market-value tabular">
            <span className="market-dollar">$</span>
            {formatPrice(data?.ethUsd ?? 0)}
          </div>
        )}
        <div className={`market-sub ${fresh ? "" : "is-stale"}`}>
          <span className="freshness-dot" />
          {data ? `oracle updated ${data.ageSeconds}s ago` : "reading oracle"}
        </div>
      </div>

      <div className="market-divider" />

      <div className="market-cell market-ticker-cell">
        <div className="market-label">Live prices</div>
        <div className="market-rotator">
          {token ? (
            <div key={token.symbol} className="rotator-item">
              <TokenIcon symbol={token.symbol} size={22} />
              <span className="rotator-name">{token.name.replace(/^Roque\s+/u, "")}</span>
              <span className="rotator-sep">|</span>
              <span className="tabular rotator-price">
                {loading && !data ? "—" : price ? `$${formatPrice(price)}` : "—"}
              </span>
            </div>
          ) : null}
        </div>
        <div className="market-sub">what your trades price against</div>
      </div>
    </div>
  );
}
