/**
 * Small, honest number formatting. Money and token amounts show up all over the
 * app and they should read the same everywhere, so the rules live here once. No
 * library, because the rules are simple and a dependency would be heavier than
 * the problem.
 */

/** A token amount, trimmed to a sensible number of places for its size. */
export function formatAmount(value: number | string, maxDp = 6): string {
  const n = typeof value === "string" ? Number(value) : value;
  if (!Number.isFinite(n)) return "0";
  if (n === 0) return "0";
  // Big numbers do not need six decimals; tiny ones do. Scale the precision.
  const abs = Math.abs(n);
  let dp = maxDp;
  if (abs >= 1000) dp = 2;
  else if (abs >= 1) dp = 4;
  const fixed = n.toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: dp,
  });
  return fixed;
}

/** A dollar figure, always two places, with the sign where it belongs. */
export function formatUsd(value: number | string): string {
  const n = typeof value === "string" ? Number(value) : value;
  if (!Number.isFinite(n)) return "$0.00";
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/** A price like 3,412.55 with no currency glyph, for tickers and axes. */
export function formatPrice(value: number): string {
  if (!Number.isFinite(value)) return "0.00";
  return value.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/** 0xabcd...1234, for addresses and tx hashes. */
export function shorten(hex: string, lead = 6, tail = 4): string {
  if (!hex) return "";
  if (hex.length <= lead + tail + 2) return hex;
  return `${hex.slice(0, lead)}…${hex.slice(-tail)}`;
}

/** A friendly relative time, past tense, for a feed. */
export function timeAgo(input: string | number | Date): string {
  const then = new Date(input).getTime();
  if (!Number.isFinite(then)) return "";
  const secs = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (secs < 45) return "just now";
  if (secs < 90) return "a minute ago";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins} minutes ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} ${hours === 1 ? "hour" : "hours"} ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} ${days === 1 ? "day" : "days"} ago`;
  return new Date(input).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** Seconds into a compact "3h 20m" style duration, for capability windows. */
export function formatDuration(seconds: number): string {
  if (seconds <= 0) return "expired";
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}
