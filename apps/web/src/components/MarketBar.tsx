"use client";

/**
 * The market strip that sits above everything. It reads the same Chainlink price
 * the contracts settle against and the live pool reserves, so what a person sees
 * here is exactly what a swap will price against. The oracle age ticks in real
 * time; if it ever goes stale the dot goes amber, because a price you cannot
 * trust is worse than no price at all.
 */

import { Activity, Droplets } from "lucide-react";
import type { PriceResult } from "@/lib/types";
import { formatPrice, formatAmount } from "@/lib/format";
import { TokenIcon } from "./TokenIcon";

export function MarketBar({
  data,
  loading,
}: {
  data: PriceResult | null;
  loading: boolean;
}) {
  const fresh = data ? data.ageSeconds < 3600 : true;

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

      <div className="market-cell">
        <div className="market-label">
          <Droplets size={14} />
          Pool liquidity
        </div>
        <div className="market-reserves">
          <span className="reserve">
            <TokenIcon symbol="USDC" size={17} />
            <span className="tabular">{data ? formatAmount(data.reserves.usdc) : "—"}</span>
          </span>
          <span className="reserve">
            <TokenIcon symbol="WETH" size={17} />
            <span className="tabular">{data ? formatAmount(data.reserves.weth) : "—"}</span>
          </span>
        </div>
        <div className="market-sub">what your trade prices against</div>
      </div>
    </div>
  );
}
