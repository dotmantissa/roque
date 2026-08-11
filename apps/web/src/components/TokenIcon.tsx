/**
 * Little coin glyphs for the ten assets, drawn rather than pulled from a sprite
 * sheet so they inherit size cleanly and never 404. USDC keeps its familiar blue
 * disc with a dollar cut into it and WETH gets the ether diamond; the rest sit on
 * a brand-coloured disc with a short monogram. Everything lives on a 20 by 20
 * grid and scales from a label chip up to a balance row without going fuzzy.
 */

import { tokenBySymbol } from "@roque/shared";

// Brand-ish colour and a short monogram per token. Keyed by the canonical symbol
// the rest of the app speaks, with the loose ticker mapped on so an "ETH" or a
// "USDC" from anywhere still lands on the right disc.
const LOOK: Record<string, { fill: string; label: string }> = {
  rUSDC: { fill: "#2775ca", label: "USDC" },
  rUSDT: { fill: "#26a17b", label: "USDT" },
  rDAI: { fill: "#f5ac37", label: "DAI" },
  rWETH: { fill: "#627eea", label: "ETH" },
  rWBTC: { fill: "#f7931a", label: "BTC" },
  rLINK: { fill: "#2a5ada", label: "LINK" },
  rSNX: { fill: "#00b6de", label: "SNX" },
  rFORTH: { fill: "#d94b3f", label: "FTH" },
  rEURC: { fill: "#1667d6", label: "EUR" },
  rPAXG: { fill: "#c9a227", label: "AU" },
};

function resolve(symbol: string): { fill: string; label: string } {
  if (LOOK[symbol]) return LOOK[symbol];
  const canonical = tokenBySymbol(symbol)?.symbol;
  if (canonical && LOOK[canonical]) return LOOK[canonical];
  // A last-ditch neutral disc so an unexpected symbol still renders as a coin
  // rather than a blank. The label is the symbol with any leading r trimmed.
  const label = symbol.replace(/^r/u, "").slice(0, 4).toUpperCase() || "?";
  return { fill: "#5b6470", label };
}

export function TokenIcon({ symbol, size = 20 }: { symbol: string; size?: number }) {
  const canonical = tokenBySymbol(symbol)?.symbol ?? symbol;

  // USDC keeps the dollar-in-a-disc it is known by.
  if (canonical === "rUSDC") {
    return (
      <svg width={size} height={size} viewBox="0 0 20 20" aria-hidden="true">
        <circle cx="10" cy="10" r="10" fill="#2775ca" />
        <path
          d="M10 4.4c.4 0 .7.3.7.7v.5c1.5.2 2.5 1 2.7 2.2 0 .4-.3.7-.7.7-.3 0-.6-.2-.7-.5-.1-.6-.6-1-1.3-1.1v2.3c1.6.3 2.7.9 2.7 2.5 0 1.4-1 2.3-2.7 2.5v.6c0 .4-.3.7-.7.7s-.7-.3-.7-.7v-.6c-1.6-.2-2.6-1.1-2.8-2.4 0-.4.3-.7.7-.7.3 0 .6.2.7.6.1.6.6 1 1.4 1.2v-2.5c-1.5-.3-2.7-.8-2.7-2.4 0-1.4 1.1-2.2 2.7-2.4v-.5c0-.4.3-.7.7-.7Zm-.7 2.5c-.7.1-1.2.5-1.2 1 0 .6.4.8 1.2 1V6.9Zm1.4 4v2.2c.8-.1 1.3-.5 1.3-1.1 0-.6-.5-.9-1.3-1.1Z"
          fill="#fff"
        />
      </svg>
    );
  }

  // WETH keeps the ether diamond.
  if (canonical === "rWETH") {
    return (
      <svg width={size} height={size} viewBox="0 0 20 20" aria-hidden="true">
        <circle cx="10" cy="10" r="10" fill="#627eea" />
        <path d="M10 3.2 6.2 10 10 12.3 13.8 10 10 3.2Z" fill="#fff" fillOpacity="0.9" />
        <path d="M10 3.2 6.2 10 10 8.3V3.2Z" fill="#fff" fillOpacity="0.65" />
        <path d="M10 13.1 6.2 10.8 10 16l3.8-5.2L10 13.1Z" fill="#fff" fillOpacity="0.9" />
        <path d="M10 16v-2.9L6.2 10.8 10 16Z" fill="#fff" fillOpacity="0.65" />
      </svg>
    );
  }

  // Everything else: a brand-coloured disc with a short monogram.
  const { fill, label } = resolve(symbol);
  const fontSize = label.length >= 4 ? 5.6 : label.length === 3 ? 6.6 : 8;
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" aria-hidden="true">
      <circle cx="10" cy="10" r="10" fill={fill} />
      <text
        x="10"
        y="10"
        textAnchor="middle"
        dominantBaseline="central"
        fontSize={fontSize}
        fontWeight="700"
        fontFamily="var(--font-display), system-ui, sans-serif"
        fill="#fff"
        letterSpacing="-0.2"
      >
        {label}
      </text>
    </svg>
  );
}
