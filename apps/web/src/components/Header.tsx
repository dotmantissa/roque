"use client";

/**
 * The top bar. Logo on the left, a quiet reminder that this is testnet money in
 * the middle so nobody expects to get rich, and the two controls a person reaches
 * for most on the right: the light switch and their wallet. It stays stuck to the
 * top on scroll and grows a faint border once you have moved down the page, so the
 * content underneath never looks like it is bleeding into the chrome.
 */

import { useEffect, useState } from "react";
import { RoqueLogo } from "./RoqueMark";
import { ThemeToggle } from "./ThemeToggle";
import { WalletButton } from "./WalletButton";

export function Header() {
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <header className={`site-header ${scrolled ? "is-scrolled" : ""}`}>
      <div className="site-header-inner">
        <a href="/" className="site-brand" aria-label="Roque home">
          <RoqueLogo size={26} />
        </a>

        <div className="site-header-right">
          <span className="pill testnet-pill">
            <span className="testnet-dot" />
            Sepolia testnet
          </span>
          <ThemeToggle />
          <WalletButton />
        </div>
      </div>
    </header>
  );
}
