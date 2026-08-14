"use client";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { X, Maximize2, Minimize2 } from "lucide-react";
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from "recharts";

type Point = { t: number; price: number };
const TIMEFRAMES = [
  { label: "1H", hours: 1 },
  { label: "1D", hours: 24 },
  { label: "1W", hours: 168 },
];

export function ChartModal({
  pair,
  price,
  usdPrice,
  onClose,
}: {
  pair: string;
  price: number;
  usdPrice?: number;
  onClose: () => void;
}) {
  const [history, setHistory] = useState<Point[]>([]);
  const [timeframe, setTimeframe] = useState(TIMEFRAMES[0]);
  const [fullscreen, setFullscreen] = useState(false);
  const [loading, setLoading] = useState(true);

  const recordValue = usdPrice ?? price;

  // Record the current price once when the chart opens, so real traffic
  // slowly builds a genuine history for this pair.
  useEffect(() => {
    fetch("/api/record-price", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pair, price: recordValue }),
    }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pair, recordValue]);

  // Fetch stored history whenever the pair or timeframe changes, then poll
  // for fresh points every 15 seconds while the modal stays open.
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch(
          `/api/price-history?pair=${encodeURIComponent(pair)}&hours=${timeframe.hours}`,
        );
        if (!res.ok) return;
        const data = await res.json();
        if (!cancelled) {
          setHistory(data.points ?? []);
          setLoading(false);
        }
      } catch {
        if (!cancelled) setLoading(false);
      }
    };
    load();
    const id = setInterval(load, 15000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [pair, timeframe]);

  return createPortal(
    <div className="chart-modal-overlay" onClick={onClose}>
      <div
        className={`chart-modal ${fullscreen ? "chart-modal-fullscreen" : ""}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="chart-modal-head">
          <div className="chart-modal-title-group">
            <span className="chart-modal-title">{pair}</span>
            {usdPrice ? (
              <span className="chart-modal-usd">${usdPrice.toFixed(2)}</span>
            ) : null}
          </div>
          <div className="chart-modal-actions">
            {TIMEFRAMES.map((tf) => (
              <button
                key={tf.label}
                className={`chart-modal-tf ${tf.label === timeframe.label ? "active" : ""}`}
                onClick={() => setTimeframe(tf)}
              >
                {tf.label}
              </button>
            ))}
            <button className="chart-modal-icon-btn" onClick={() => setFullscreen((f) => !f)}>
              {fullscreen ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
            </button>
            <button className="chart-modal-icon-btn" onClick={onClose}>
              <X size={16} />
            </button>
          </div>
        </div>
        <div className="chart-modal-body">
          {loading ? (
            <p className="chart-modal-empty">Loading price history…</p>
          ) : history.length < 2 ? (
            <p className="chart-modal-empty">
              Not enough history yet for this pair. Roque records a point each time this
              chart is opened, so it fills in with real use.
            </p>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={history}>
                <defs>
                  <linearGradient id="chartFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#6366f1" stopOpacity={0.35} />
                    <stop offset="100%" stopColor="#6366f1" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke="rgba(255,255,255,0.06)" vertical={false} />
                <XAxis
                  dataKey="t"
                  tickFormatter={(t) => new Date(t).toLocaleTimeString()}
                  minTickGap={40}
                />
                <YAxis domain={["auto", "auto"]} tickFormatter={(v) => `$${v.toFixed(2)}`} width={70} />
                <Tooltip
                  labelFormatter={(t) => new Date(t as number).toLocaleString()}
                  formatter={(v: number) => [`$${v.toFixed(2)}`, "Price"]}
                />
                <Area
                  type="monotone"
                  dataKey="price"
                  stroke="#6366f1"
                  strokeWidth={2}
                  fill="url(#chartFill)"
                />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}