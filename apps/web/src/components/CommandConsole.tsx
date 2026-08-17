"use client";

/**
 * The heart of the app: a place to say what you want in plain words and watch
 * Roque read it back as a trade you can act on. Each thing you type becomes a
 * turn. The turn shows your words, a beat of the agent thinking, then the
 * structured intent as an IntentCard. Nothing here decides anything on its own;
 * it interprets and quotes, and the card is where a signature happens.
 *
 * The conversation itself is not kept here. It lives in the shared app data,
 * above the routes, so switching between copilot and autonomous never drops an
 * in-flight reply or forgets a signed trade. This component is the window onto
 * one mode's turns: it renders them, scrolls them, jumps to one when the activity
 * rail asks, and guards the clear button behind a confirmation.
 */

import { useEffect, useRef, useState } from "react";
import { ArrowUp, ArrowDown, Wand2, Trash2, X } from "lucide-react";
import type { Mode } from "@/lib/types";
import { useAppData } from "@/providers/AppData";
import { IntentCard } from "./IntentCard";
import { RoqueMark } from "./RoqueMark";

const SUGGESTIONS = [
  "Swap 250 USDC into ETH",
  "Move 500 USDC into WBTC",
  "Trade 300 DAI for LINK",
  "Sell half my WETH if ETH hits 4,200",
];

export function CommandConsole({
  mode,
  ethUsd,
  balances,
  vaultBalances,
  prices,
  canAutonomous,
  slippageBps,
  onSettled,
}: {
  mode: Mode;
  ethUsd: number;
  balances: Record<string, number> | null;
  vaultBalances: Record<string, number> | null;
  prices: Record<string, number>;
  canAutonomous: boolean;
  slippageBps: number;
  onSettled?: () => void;
}) {
  const {
    conversations,
    chatBusy,
    sendCommand,
    clearConversation,
    settleTurn,
    chatFocus,
    clearChatFocus,
  } = useAppData();
  const turns = conversations[mode];
  const busy = chatBusy[mode];

  const [value, setValue] = useState("");
  const [confirmClear, setConfirmClear] = useState(false);
  const [showJump, setShowJump] = useState(false);
  const streamRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // True while the reader is parked at the bottom. Only then does a new turn pull
  // the view down; if they have scrolled up to reread, we leave them where they are.
  const stickRef = useRef(true);

  useEffect(() => {
    if (stickRef.current) {
      streamRef.current?.scrollTo({ top: streamRef.current.scrollHeight, behavior: "smooth" });
    }
  }, [turns]);

  // When the activity rail asks to jump to a turn in this mode, scroll it to the
  // middle and flash it, then let go of the request so navigating back later does
  // not silently re-scroll. The small delay lets a freshly mounted route lay out.
  useEffect(() => {
    if (!chatFocus || chatFocus.mode !== mode) return;
    const stream = streamRef.current;
    if (!stream) return;
    const timer = window.setTimeout(() => {
      const el = stream.querySelector<HTMLElement>(`[data-turn-id="${chatFocus.turnId}"]`);
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        el.classList.add("turn-highlight");
        window.setTimeout(() => el.classList.remove("turn-highlight"), 2000);
      }
      clearChatFocus();
    }, 80);
    return () => window.clearTimeout(timer);
  }, [chatFocus, mode, clearChatFocus]);

  const onStreamScroll = () => {
    const el = streamRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickRef.current = distance < 80;
    setShowJump(distance > 160);
  };

  const scrollToBottom = () => {
    const el = streamRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    stickRef.current = true;
    setShowJump(false);
  };

  const send = (raw: string) => {
    if (!raw.trim() || busy) return;
    stickRef.current = true;
    setValue("");
    sendCommand(mode, raw);
    window.setTimeout(() => inputRef.current?.focus(), 0);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send(value);
    }
  };

  const empty = turns.length === 0;

  return (
    <>
      <div className="console card">
        {!empty ? (
          <div className="console-head">
            <span className="console-head-label">Conversation</span>
            <button
              className="console-clear"
              onClick={() => setConfirmClear(true)}
              title="Clear this conversation"
            >
              <Trash2 size={14} />
              Clear history
            </button>
          </div>
        ) : null}

        <div className="console-stream" ref={streamRef} onScroll={onStreamScroll}>
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
                    onClick={() => send(s)}
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
                <div key={turn.id} className="turn" data-turn-id={turn.id}>
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
                      vaultBalances={vaultBalances}
                      prices={prices}
                      canAutonomous={canAutonomous}
                      slippageBps={slippageBps}
                      settleState={turn.settleState}
                      txHash={turn.txHash}
                      onSettle={(patch) => settleTurn(mode, turn.id, patch)}
                      onSettled={onSettled}
                    />
                  ) : null}
                </div>
              ))}
            </div>
          )}
        </div>

        {showJump && !empty ? (
          <button className="console-jump animate-fade" onClick={scrollToBottom} aria-label="Jump to the latest messages">
            <ArrowDown size={18} />
          </button>
        ) : null}

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
            onClick={() => send(value)}
            disabled={busy || value.trim().length === 0}
            aria-label="Send"
          >
            {busy ? <span className="spinner" /> : <ArrowUp size={18} />}
          </button>
        </div>
      </div>

      {confirmClear ? (
        <div className="modal-overlay" role="presentation">
          <div className="modal-dialog animate-scale-in" role="dialog" aria-modal="true" aria-labelledby="clear-title">
            <button
              className="modal-x"
              onClick={() => setConfirmClear(false)}
              aria-label="Close"
            >
              <X size={16} />
            </button>
            <h3 id="clear-title" className="modal-title">Clear this conversation?</h3>
            <p className="modal-body">
              This erases every message in {mode} mode from this device. It does not touch your
              on-chain trades or the activity rail, and it cannot be undone.
            </p>
            <div className="modal-actions">
              <button className="btn btn-ghost" onClick={() => setConfirmClear(false)}>
                No, keep it
              </button>
              <button
                className="btn btn-danger"
                onClick={() => {
                  clearConversation(mode);
                  setConfirmClear(false);
                }}
              >
                Yes, clear it
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
