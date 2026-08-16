"use client";
/**
 * A secondary row of section links shown only on small screens, right under
 * the top navbar. The top navbar hides its own text labels on mobile to make
 * room for the theme toggle and wallet button; this row exists so section
 * navigation is not lost in that trade.
 */
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Hand, Sparkles, Droplets } from "lucide-react";

const NAV = [
  { href: "/copilot", label: "Copilot", icon: <Hand size={16} /> },
  { href: "/autonomous", label: "Autonomous", icon: <Sparkles size={16} /> },
  { href: "/faucet", label: "Faucet", icon: <Droplets size={16} /> },
];

export function MobileNav() {
  const pathname = usePathname();
  return (
    <nav className="mobile-nav" aria-label="Sections">
      {NAV.map((item) => {
        const active = pathname === item.href;
        return (
          <Link
            key={item.href}
            href={item.href}
            className={`mobile-nav-link ${active ? "is-active" : ""}`}
            aria-current={active ? "page" : undefined}
          >
            {item.icon}
            <span>{item.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}