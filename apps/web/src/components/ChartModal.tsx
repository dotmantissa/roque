"use client";

import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Maximize2, Minimize2, X } from "lucide-react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

type Point = { t: number; price: number };

const TIMEFRAMES = [
  { label: "1H", hours: 1 },
  { label: "1D", hours: 24 },
  { label: "1W", hours: 168 },
] as const;

function formatChartPrice(value: unknown): string {
  const price = Number(value);
  if (!Number.isFinite(price)) return "$0.00";
  return price.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: price < 1 ? 6 : 2,
  });
}

export function ChartModal({
  pair,
  price,
  onClose,
}: {
  pair: string;
  price: number;
  onClose: () => void;
}) {
  const [history, setHistory] = useState<Point[]>([]);
  const [timeframe, setTimeframe] =
    useState<(typeof TIMEFRAMES)[number]>(TIMEFRAMES[0]);
  const [fullscreen, setFullscreen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [currentPrice, setCurrentPrice] = useState(price);
  const titleId = useId();
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  const recordedPairRef = useRef<string | null>(null);
  onCloseRef.current = onClose;

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeButtonRef.current?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCloseRef.current();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, []);

  // Record one trusted observation when this pair opens, then poll only the
  // history. This keeps a long-open chart from manufacturing dense duplicate data.
  useEffect(() => {
    let cancelled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    setLoading(true);
    setError(false);

    const load = async (record: boolean) => {
      try {
        if (record) {
          const recordResponse = await fetch("/api/record-price", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ pair }),
          });
          if (recordResponse.ok) {
            const recorded = (await recordResponse.json()) as { price?: number };
            if (!cancelled && Number.isFinite(recorded.price)) {
              setCurrentPrice(Number(recorded.price));
            }
          }
        }

        const res = await fetch(
          `/api/price-history?pair=${encodeURIComponent(pair)}&hours=${timeframe.hours}`,
        );
        if (!res.ok) throw new Error("Price history request failed.");
        const data = (await res.json()) as { points?: Point[] };
        if (!cancelled) {
          const points = Array.isArray(data.points)
            ? data.points.filter(
                (point) => Number.isFinite(point.t) && Number.isFinite(point.price),
              )
            : [];
          setHistory(points);
          setError(false);
          setLoading(false);
        }
      } catch {
        if (!cancelled) {
          setError(true);
          setLoading(false);
        }
      } finally {
        if (!cancelled) timeout = setTimeout(() => void load(false), 15000);
      }
    };
    const shouldRecord = recordedPairRef.current !== pair;
    recordedPairRef.current = pair;
    void load(shouldRecord);
    return () => {
      cancelled = true;
      if (timeout) clearTimeout(timeout);
    };
  }, [pair, timeframe]);

  return createPortal(
    <div className="chart-modal-overlay" onClick={onClose}>
      <div
        className={`chart-modal ${fullscreen ? "chart-modal-fullscreen" : ""}`}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <div className="chart-modal-head">
          <div className="chart-modal-title-group">
            <span id={titleId} className="chart-modal-title">{pair}</span>
            {currentPrice > 0 ? (
              <span className="chart-modal-usd">{formatChartPrice(currentPrice)}</span>
            ) : null}
          </div>
          <div className="chart-modal-actions">
            {TIMEFRAMES.map((tf) => (
              <button
                key={tf.label}
                type="button"
                className={`chart-modal-tf ${tf.label === timeframe.label ? "active" : ""}`}
                onClick={() => setTimeframe(tf)}
                aria-pressed={tf.label === timeframe.label}
              >
                {tf.label}
              </button>
            ))}
            <button
              type="button"
              className="chart-modal-icon-btn"
              onClick={() => setFullscreen((value) => !value)}
              aria-label={fullscreen ? "Exit fullscreen chart" : "View chart fullscreen"}
              title={fullscreen ? "Exit fullscreen" : "Fullscreen"}
            >
              {fullscreen ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
            </button>
            <button
              ref={closeButtonRef}
              type="button"
              className="chart-modal-icon-btn"
              onClick={onClose}
              aria-label="Close price chart"
              title="Close"
            >
              <X size={16} />
            </button>
          </div>
        </div>
        <div className="chart-modal-body">
          {loading ? (
            <p className="chart-modal-empty">Loading price history…</p>
          ) : error ? (
            <p className="chart-modal-empty" role="status">
              Price history is unavailable right now.
            </p>
          ) : history.length < 2 ? (
            <p className="chart-modal-empty">
              Not enough history yet for this pair. Roque records trusted feed values
              while the chart is open.
            </p>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={history}>
                <defs>
                  <linearGradient id="chartFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="var(--accent)" stopOpacity={0.35} />
                    <stop offset="100%" stopColor="var(--accent)" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke="var(--border)" vertical={false} />
                <XAxis
                  dataKey="t"
                  tickFormatter={(t) => new Date(t).toLocaleTimeString()}
                  minTickGap={40}
                />
                <YAxis
                  domain={["auto", "auto"]}
                  tickFormatter={formatChartPrice}
                  width={84}
                />
                <Tooltip
                  labelFormatter={(t) => new Date(t as number).toLocaleString()}
                  formatter={(value) => [formatChartPrice(value), "Price"]}
                />
                <Area
                  type="monotone"
                  dataKey="price"
                  stroke="var(--accent)"
                  strokeWidth={2}
                  fill="url(#chartFill)"
                />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
