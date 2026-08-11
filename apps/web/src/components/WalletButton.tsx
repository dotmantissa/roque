"use client";

/**
 * The connect control. When nobody is connected it is a plain call to action;
 * once a wallet is on, it shows the short address with a live green dot and opens
 * a small menu to copy the address, view it on Etherscan, or disconnect. It never
 * asks for a password or an email because Roque only ever talks to a wallet the
 * person already has.
 */

import { useEffect, useRef, useState } from "react";
import { Wallet, Copy, ExternalLink, LogOut, Check, ChevronDown } from "lucide-react";
import { useWallet } from "@/lib/useWallet";
import { shorten } from "@/lib/format";

export function WalletButton() {
  const { ready, connected, address, login, logout } = useWallet();
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  if (!ready) {
    return <div className="skeleton" style={{ width: 132, height: 40, borderRadius: 12 }} />;
  }

  if (!connected || !address) {
    return (
      <button className="btn btn-primary" onClick={login}>
        <Wallet size={17} />
        Connect wallet
      </button>
    );
  }

  const copy = async () => {
    await navigator.clipboard.writeText(address);
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  };

  return (
    <div className="wallet-menu" ref={ref}>
      <button className="wallet-chip" onClick={() => setOpen((v) => !v)}>
        <span className="wallet-dot" />
        <span className="mono">{shorten(address, 5, 4)}</span>
        <ChevronDown size={15} className={`wallet-caret ${open ? "is-open" : ""}`} />
      </button>

      {open ? (
        <div className="wallet-dropdown animate-scale-in">
          <button className="wallet-item" onClick={copy}>
            {copied ? <Check size={15} /> : <Copy size={15} />}
            {copied ? "Copied" : "Copy address"}
          </button>
          <a
            className="wallet-item"
            href={`https://sepolia.etherscan.io/address/${address}`}
            target="_blank"
            rel="noreferrer"
          >
            <ExternalLink size={15} />
            View on Etherscan
          </a>
          <div className="wallet-sep" />
          <button className="wallet-item wallet-item-danger" onClick={() => logout()}>
            <LogOut size={15} />
            Disconnect
          </button>
        </div>
      ) : null}
    </div>
  );
}
