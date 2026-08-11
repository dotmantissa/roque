"use client";

/**
 * The heart of the app: a place to say what you want in plain words and watch
 * Roque read it back as a trade you can act on. Each thing you type becomes a
 * turn. The turn shows your words, a beat of the agent thinking, then the
 * structured intent as an IntentCard. Nothing here decides anything on its own;
 * it interprets and quotes, and the card is where a signature happens.
 */

import { useEffect, useRef, useState } from "react";
import { ArrowUp, Wand2 } from "lucide-react";
import type { InterpretResult, Mode } from "@/lib/types";
import { useWallet } from "@/lib/useWallet";
import { api } from "@/lib/api";
import { IntentCard } from "./IntentCard";
import { RoqueMark } from "./RoqueMark";

interface Turn {
  id: number;
  command: string;
  result?: InterpretResult;
  error?: string;
  pending: boolean;
}

const SUGGESTIONS = [
  "Swap 250 USDC into ETH",
  "Move 500 USDC into WBTC",
  "Trade 300 DAI for LINK",
  "Sell half my WETH if ETH hits 4,200",
];

let turnSeq = 0;

export function CommandConsole({
  mode,
  ethUsd,
  balances,
  prices,
  canAutonomous,
  slippageBps,
  onSettled,
}: {
  mode: Mode;
  ethUsd: number;
  balances: Record<string, number> | null;
  prices: Record<string, number>;
  canAutonomous: boolean;
  slippageBps: number;
  onSettled?: () => void;
}) {
  const wallet = useWallet();
  const [value, setValue] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [busy, setBusy] = useState(false);
  const streamRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Keep the newest turn in view as the conversation grows.
  useEffect(() => {
    streamRef.current?.scrollTo({ top: streamRef.current.scrollHeight, behavior: "smooth" });
  }, [turns]);

  const send = async (raw: string) => {
    const command = raw.trim();
    if (!command || busy) return;
    setBusy(true);
    setValue("");

    const id = ++turnSeq;
    setTurns((list) => [...list, { id, command, pending: true }]);

    try {
      const result = await api.interpret(command, mode, wallet.address);
      setTurns((list) =>
        list.map((t) => (t.id === id ? { ...t, result, pending: false } : t)),
      );
    } catch (err) {
      setTurns((list) =>
        list.map((t) =>
          t.id === id ? { ...t, error: (err as Error).message, pending: false } : t,
        ),
      );
    } finally {
      setBusy(false);
      inputRef.current?.focus();
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send(value);
    }
  };

  const empty = turns.length === 0;

  return (
    <div className="console card">
      <div className="console-stream" ref={streamRef}>
        {empty ? (
          <div className="console-empty animate-fade">
            <div className="console-empty-mark">
              <RoqueMark size={40} gradient title="Roque" />
            </div>
            <h2 className="console-empty-title">Tell Roque what you want to do</h2>
            <p className="console-empty-sub">
              No order tickets, no dropdowns. Say it the way you would to a broker who
              actually listens, and Roque turns it into a trade you approve.
            </p>
            <div className="console-suggests">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  className="suggest-chip"
                  onClick={() => void send(s)}
                  disabled={busy}
                >
                  <Wand2 size={13} />
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="console-turns">
            {turns.map((turn) => (
              <div key={turn.id} className="turn">
                <div className="turn-user animate-rise">
                  <span className="turn-user-bubble">{turn.command}</span>
                </div>

                {turn.pending ? (
                  <div className="turn-thinking animate-fade">
                    <RoqueMark size={20} gradient />
                    <span className="thinking-dots">
                      <span />
                      <span />
                      <span />
                    </span>
                    <span className="thinking-label">reading that as a trade</span>
                  </div>
                ) : turn.error ? (
                  <div className="turn-error animate-rise">{turn.error}</div>
                ) : turn.result ? (
                  <IntentCard
                    result={turn.result}
                    mode={mode}
                    ethUsd={ethUsd}
                    balances={balances}
                    prices={prices}
                    canAutonomous={canAutonomous}
                    slippageBps={slippageBps}
                    onSettled={onSettled}
                  />
                ) : null}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="console-input">
        <textarea
          ref={inputRef}
          className="console-textarea"
          placeholder="Swap 250 USDC into ETH…"
          value={value}
          rows={1}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={onKeyDown}
          disabled={busy}
        />
        <button
          className="console-send"
          onClick={() => void send(value)}
          disabled={busy || value.trim().length === 0}
          aria-label="Send"
        >
          {busy ? <span className="spinner" /> : <ArrowUp size={18} />}
        </button>
      </div>
    </div>
  );
}
