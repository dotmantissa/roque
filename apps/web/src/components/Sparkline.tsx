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

  useEffect(() => {
    let cancelled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;

    // Record one trusted observation when the sparkline mounts, then poll only
    // history. Recording on an interval in every browser would multiply oracle
    // and database writes by the number of visitors.
    const load = async (record: boolean) => {
      try {
        if (record) {
          await fetch("/api/record-price", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ pair }),
          });
        }
        const res = await fetch(
          `/api/price-history?pair=${encodeURIComponent(pair)}&hours=1`,
        );
        if (!res.ok) return;
        const data = (await res.json()) as { points?: Point[] };
        if (!cancelled) {
          setHistory(
            Array.isArray(data.points)
              ? data.points.filter(
                  (point) => Number.isFinite(point.t) && Number.isFinite(point.price),
                )
              : [],
          );
        }
      } catch {
        // A missing sparkline is not worth surfacing; the price itself still
        // reads fine without it.
      } finally {
        if (!cancelled) timeout = setTimeout(() => void load(false), 30000);
      }
    };
    void load(true);
    return () => {
      cancelled = true;
      if (timeout) clearTimeout(timeout);
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
