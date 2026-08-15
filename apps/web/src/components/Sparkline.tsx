"use client";
import { useEffect, useState } from "react";

type Point = { t: number; price: number };

export function Sparkline({
  pair,
  width = 70,
  height = 26,
}: {
  pair: string;
  width?: number;
  height?: number;
}) {
  const [history, setHistory] = useState<Point[]>([]);

  // Record a point when the sparkline mounts, then keep recording every 45
  // seconds while it stays mounted, so the line fills in with real movement
  // instead of waiting on someone opening the big chart. The backend resolves
  // the price itself from Chainlink, so no price is sent here.
  useEffect(() => {
    const record = () => {
      fetch("/api/record-price", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pair }),
      }).catch(() => {});
    };
    record();
    const id = setInterval(record, 45000);
    return () => clearInterval(id);
  }, [pair]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch(
          `/api/price-history?pair=${encodeURIComponent(pair)}&hours=1`,
        );
        if (!res.ok) return;
        const data = await res.json();
        if (!cancelled) setHistory(data.points ?? []);
      } catch {
        // A missing sparkline is not worth surfacing; the price itself still
        // reads fine without it.
      }
    };
    load();
    const id = setInterval(load, 30000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [pair]);

  if (history.length < 2) return null;

  const values = history.map((p) => p.price);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const up = values[values.length - 1] >= values[0];

  const points = history
    .map((p, i) => {
      const x = (i / (history.length - 1)) * width;
      const y = height - ((p.price - min) / span) * height;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className="sparkline"
      aria-hidden="true"
    >
      <polyline
        points={points}
        fill="none"
        stroke={up ? "#22c55e" : "#ef4444"}
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}