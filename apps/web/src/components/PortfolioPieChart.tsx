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

  return (
    <div className="portfolio-pie">
      <ResponsiveContainer width="100%" height={160}>
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
            formatter={(value: number | undefined, name: string) => [
              formatUsd(value ?? 0),
              name,
            ]}
          />
        </PieChart>
      </ResponsiveContainer>
      <div className="portfolio-pie-legend">
        {data.slice(0, 6).map((s, i) => (
          <span key={s.symbol} className="portfolio-pie-legend-item">
            <span
              className="portfolio-pie-dot"
              style={{ background: COLORS[i % COLORS.length] }}
            />
            {s.symbol}
          </span>
        ))}
      </div>
    </div>
  );
}