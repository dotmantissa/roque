"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";
import styles from "@/app/dev/page.module.css";

export function CodeExample({ label, code }: { label: string; code: string }) {
  const [copied, setCopied] = useState(false);
  const [message, setMessage] = useState("");

  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setMessage("Copied to clipboard.");
    } catch {
      setMessage("Select the code below to copy it.");
    }
  }

  return (
    <figure className={styles.example}>
      <figcaption className={styles.exampleHead}>
        <span>{label}</span>
        <button type="button" onClick={copy} aria-label={`Copy ${label}`}>
          {copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
          {copied ? "Copied" : "Copy"}
        </button>
      </figcaption>
      <pre tabIndex={0} aria-label={label}><code>{code}</code></pre>
      <span className={styles.copyStatus} role="status">{message}</span>
    </figure>
  );
}
