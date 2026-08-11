/**
 * The Roque mark. A rook, rendered as a single geometric tower, because the name
 * is the castling move and the rook is the piece that guards while it acts. The
 * crenellations double as a small bar chart, a quiet nod to the market underneath.
 *
 * Everything is drawn on a 32 by 32 grid and inherits `currentColor` unless a
 * gradient is switched on, so the mark sits correctly in a heading, a button, or
 * the browser tab without a second set of assets.
 */

interface LogoProps {
  size?: number;
  className?: string;
  /** Fill with the brand gradient rather than the surrounding text colour. */
  gradient?: boolean;
  title?: string;
}

export function RoqueMark({ size = 32, className, gradient = false, title }: LogoProps) {
  const fill = gradient ? "url(#roque-grad)" : "currentColor";
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      role={title ? "img" : "presentation"}
      aria-hidden={title ? undefined : true}
    >
      {title ? <title>{title}</title> : null}
      {gradient ? (
        <defs>
          <linearGradient id="roque-grad" x1="6" y1="4" x2="26" y2="28" gradientUnits="userSpaceOnUse">
            <stop stopColor="#2f6bff" />
            <stop offset="1" stopColor="#003dad" />
          </linearGradient>
        </defs>
      ) : null}
      {/* The tower: crenellated top, a waisted body, a broad base. One path so it
          reads as a solid piece at any size, down to a 16px favicon. */}
      <path
        d="M7 4h3.4v2.6h3.9V4h3.4v2.6h3.9V4H25v7.2l-2.6 2.4v6.8L25 22.8V28H7v-5.2l2.6-2.4v-6.8L7 11.2V4Z"
        fill={fill}
      />
      {/* A negative-space slit down the middle keeps the tower from reading as a
          plain block and echoes an arrow, the swap motion. */}
      <path d="M15 14.6h2v9.2h-2z" fill="var(--surface, #ffffff)" opacity="0.28" />
    </svg>
  );
}

/** The wordmark: the rook next to the name, for the header and footer. */
export function RoqueLogo({ size = 28 }: { size?: number }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
      <RoqueMark size={size} gradient title="Roque" />
      <span
        style={{
          fontWeight: 680,
          fontSize: size * 0.72,
          letterSpacing: "-0.02em",
        }}
      >
        Roque
      </span>
    </span>
  );
}
