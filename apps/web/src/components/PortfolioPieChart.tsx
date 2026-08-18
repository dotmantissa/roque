"use client";
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer } from "recharts";
import { formatUsd } from "@/lib/format";

const COLORS = [
  "#6366f1", "#22c55e", "#f59e0b", "#ef4444", "#06b6d4",
  "#a855f7", "#ec4899", "#84cc16", "#f97316",
];

type Slice = { symbol: string; usd: number };

export function PortfolioPieChart({ slices }: { slices: Slice[] }) {
  const data = slices.filter((s) => s.usd > 0).sort((a, b) => b.usd - a.usd);

  if (data.length === 0) return null;
  const totalUsd = data.reduce((sum, slice) => sum + slice.usd, 0);

  return (
    <div className="portfolio-pie">
      <div className="portfolio-pie-chart">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={data}
              dataKey="usd"
              nameKey="symbol"
              innerRadius={40}
              outerRadius={64}
              paddingAngle={2}
            >
              {data.map((_, i) => (
                <Cell key={i} fill={COLORS[i % COLORS.length]} stroke="none" />
              ))}
            </Pie>
            <Tooltip
              formatter={(value, name) => [formatUsd(Number(value) || 0), String(name)]}
            />
          </PieChart>
        </ResponsiveContainer>
      </div>
      <div className="portfolio-pie-legend">
        {data.map((s, i) => (
          <span key={s.symbol} className="portfolio-pie-legend-item">
            <span
              className="portfolio-pie-dot"
              style={{ background: COLORS[i % COLORS.length] }}
            />
            <span className="portfolio-pie-legend-symbol">{s.symbol}</span>
            <span className="portfolio-pie-legend-value">
              {totalUsd > 0 ? `${((s.usd / totalUsd) * 100).toFixed(1)}%` : "0.0%"}
            </span>
          </span>
        ))}
      </div>
    </div>
  );
}
