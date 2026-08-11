"use client";

/**
 * The one choice that changes how much Roque may do on its own. Copilot keeps a
 * person's hand on every trade: the agent reads and quotes, they sign. Autonomous
 * lets the agent act inside limits they set once. The switch says plainly which
 * world you are in, because the difference is the whole trust story of the app
 * and it should never be a surprise.
 */

import { Hand, Sparkles } from "lucide-react";
import type { Mode } from "@/lib/types";

const OPTIONS: Array<{ key: Mode; label: string; icon: React.ReactNode; blurb: string }> = [
  {
    key: "copilot",
    label: "Copilot",
    icon: <Hand size={15} />,
    blurb: "You sign every trade",
  },
  {
    key: "autonomous",
    label: "Autonomous",
    icon: <Sparkles size={15} />,
    blurb: "Roque trades within your limits",
  },
];

export function ModeSwitch({ mode, onChange }: { mode: Mode; onChange: (m: Mode) => void }) {
  return (
    <div className="mode-switch" role="tablist" aria-label="Trading mode">
      <span className="mode-glider" data-mode={mode} aria-hidden="true" />
      {OPTIONS.map((o) => (
        <button
          key={o.key}
          role="tab"
          aria-selected={mode === o.key}
          className={`mode-option ${mode === o.key ? "is-active" : ""}`}
          onClick={() => onChange(o.key)}
        >
          <span className="mode-option-top">
            {o.icon}
            {o.label}
          </span>
          <span className="mode-option-blurb">{o.blurb}</span>
        </button>
      ))}
    </div>
  );
}
