/**
 * Little coin glyphs for the two assets, drawn rather than pulled from a sprite
 * sheet so they inherit size cleanly and never 404. USDC keeps its familiar blue
 * disc with a dollar cut into it; WETH gets the ether diamond. Both sit on a
 * 20 by 20 grid and scale from a label chip up to a balance row without going
 * fuzzy.
 */

export function TokenIcon({ symbol, size = 20 }: { symbol: string; size?: number }) {
  if (symbol === "USDC") {
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
  // WETH and anything else falls back to the ether diamond.
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" aria-hidden="true">
      <circle cx="10" cy="10" r="10" fill="#454a75" />
      <path d="M10 3.2 6.2 10 10 12.3 13.8 10 10 3.2Z" fill="#fff" fillOpacity="0.85" />
      <path d="M10 3.2 6.2 10 10 8.3V3.2Z" fill="#fff" fillOpacity="0.65" />
      <path d="M10 13.1 6.2 10.8 10 16l3.8-5.2L10 13.1Z" fill="#fff" fillOpacity="0.85" />
      <path d="M10 16v-2.9L6.2 10.8 10 16Z" fill="#fff" fillOpacity="0.65" />
    </svg>
  );
}
