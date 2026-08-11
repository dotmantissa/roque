"use client";

/**
 * The market strip that sits above everything. It reads the same Chainlink prices
 * the contracts settle against, so what a person sees here is exactly what a swap
 * will price against. Ether leads, because it is the asset the resting book
 * watches, and the other assets tick along beside it. The oracle age updates in
 * real time; if it ever goes stale the dot goes amber, because a price you cannot
 * trust is worse than no price at all.
 */

import { Activity } from "lucide-react";
import { tokenList } from "@roque/shared";
import type { PriceResult } from "@/lib/types";
import { formatPrice } from "@/lib/format";
import { TokenIcon } from "./TokenIcon";

// The assets worth a live number beside ether: everything that is not a dollar
// stable and not ether itself. Order follows the deploy roster.
const TICKER_SYMBOLS = tokenList
  .filter((t) => !t.isStable && t.symbol !== "rWETH")
  .map((t) => t.symbol);

export function MarketBar({
  data,
  loading,
}: {
  data: PriceResult | null;
  loading: boolean;
}) {
  const fresh = data ? data.ageSeconds < 3600 : true;
  const prices = data?.prices ?? {};

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
        <div className="market-ticker">
          {TICKER_SYMBOLS.map((symbol) => {
            const price = prices[symbol];
            return (
              <span key={symbol} className="ticker-item">
                <TokenIcon symbol={symbol} size={17} />
                <span className="tabular ticker-price">
                  {loading && !data ? "—" : price ? `$${formatPrice(price)}` : "—"}
                </span>
              </span>
            );
          })}
        </div>
        <div className="market-sub">what your trades price against</div>
      </div>
    </div>
  );
}
