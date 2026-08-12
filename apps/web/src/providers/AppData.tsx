"use client";

/**
 * One brain for the whole app, so every screen reads from the same source. The
 * old single page polled the chain once and handed the numbers down its own tree;
 * now that the app is spread across a navbar, a sidebar, and a few routes, that
 * job moves here. Mount this once around the app shell and any screen can ask for
 * the price, a balance, the vault, the capability, or the activity feed and get
 * the exact same value the screen beside it is showing. One poll per fact, shared
 * by everyone, paused when the tab is hidden.
 *
 * It also holds the conversation itself. Copilot and autonomous are separate
 * routes, so their console components unmount the moment you switch tabs. If the
 * turns lived in the console, an in-flight reply would die on that unmount and a
 * signed trade would forget it was signed. Keeping both conversations here, above
 * the routes, means a request you fired in copilot keeps running while you glance
 * at autonomous, and a trade stays done because the turn that remembers it never
 * left the tree.
 */

import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import type {
  AgentInfo,
  ActivityResult,
  CapabilityResult,
  ChatTurn,
  Mode,
  PriceResult,
  SettleState,
  VaultResult,
} from "@/lib/types";
import { api } from "@/lib/api";
import { walletBalances, faucetClaimsRemaining } from "@/lib/chain";
import { usePoll, type PollState } from "@/lib/hooks";
import { useWallet, type RoqueWallet } from "@/lib/useWallet";

const CHAT_KEYS: Record<Mode, string> = {
  copilot: "roque-chat-copilot",
  autonomous: "roque-chat-autonomous",
};

const MODES: Mode[] = ["copilot", "autonomous"];

type SettlePatch = { settleState?: SettleState; txHash?: string | null };
type ChatFocus = { mode: Mode; turnId: number; nonce: number };

interface AppDataValue {
  wallet: RoqueWallet;
  address: `0x${string}` | undefined;
  price: PollState<PriceResult>;
  agent: PollState<AgentInfo>;
  balances: PollState<Record<string, number>>;
  claims: PollState<Record<string, number>>;
  vault: PollState<VaultResult>;
  capability: PollState<CapabilityResult>;
  activity: PollState<ActivityResult>;
  ethUsd: number;
  prices: Record<string, number>;
  canAutonomous: boolean;
  slippageBps: number;
  setSlippageBps: (bps: number) => void;
  refreshAll: () => void;
  // Conversation, lifted so it survives a route change mid-request.
  conversations: Record<Mode, ChatTurn[]>;
  chatBusy: Record<Mode, boolean>;
  sendCommand: (mode: Mode, command: string) => void;
  clearConversation: (mode: Mode) => void;
  settleTurn: (mode: Mode, turnId: number, patch: SettlePatch) => void;
  chatFocus: ChatFocus | null;
  focusActivity: (target: { intentId?: string; txHash?: string | null }) => void;
  clearChatFocus: () => void;
}

const AppDataContext = createContext<AppDataValue | null>(null);

export function AppDataProvider({ children }: { children: React.ReactNode }) {
  const wallet = useWallet();
  const address = wallet.address;
  const router = useRouter();
  const pathname = usePathname();
  const [slippageBps, setSlippageBps] = useState(100);

  const price = usePoll(() => api.price(), 12_000, []);
  const agent = usePoll(() => api.agent(), 600_000, []);
  const balances = usePoll(address ? () => walletBalances(address) : null, 15_000, [address]);
  const claims = usePoll(address ? () => faucetClaimsRemaining(address) : null, 30_000, [address]);
  const vault = usePoll(address ? () => api.vault(address) : null, 20_000, [address]);
  const capability = usePoll(address ? () => api.capability(address) : null, 20_000, [address]);
  const activity = usePoll(address ? () => api.activity(address) : null, 15_000, [address]);

  const ethUsd = price.data?.ethUsd ?? 0;
  const prices = price.data?.prices ?? {};

  const canAutonomous = useMemo(() => {
    const cap = capability.data;
    if (!cap || !cap.granted || cap.revoked) return false;
    return (cap.validUntil ?? 0) > Math.floor(Date.now() / 1000);
  }, [capability.data]);

  // After anything that moves money or permission, pull the affected reads fresh
  // so every panel catches up without waiting on the next tick.
  const refreshAll = () => {
    balances.refresh();
    claims.refresh();
    vault.refresh();
    capability.refresh();
    activity.refresh();
  };

  // ── Conversation state ──────────────────────────────────────────
  const [conversations, setConversations] = useState<Record<Mode, ChatTurn[]>>({
    copilot: [],
    autonomous: [],
  });
  const [chatBusy, setChatBusy] = useState<Record<Mode, boolean>>({
    copilot: false,
    autonomous: false,
  });
  const [chatFocus, setChatFocus] = useState<ChatFocus | null>(null);
  const [chatHydrated, setChatHydrated] = useState(false);
  const idRef = useRef(0);
  const focusNonceRef = useRef(0);

  // Pull both saved conversations in once on mount. A turn still marked pending
  // when it was saved never got its reply, so we drop it; a turn mid-signature
  // (working/failed) is reset to idle so it can be tried again, but a turn that
  // actually settled keeps its done state and hash so it can never be re-signed.
  useEffect(() => {
    const next: Record<Mode, ChatTurn[]> = { copilot: [], autonomous: [] };
    let maxId = 0;
    for (const mode of MODES) {
      try {
        const raw = window.localStorage.getItem(CHAT_KEYS[mode]);
        if (!raw) continue;
        const parsed = JSON.parse(raw) as ChatTurn[];
        if (!Array.isArray(parsed)) continue;
        next[mode] = parsed
          .filter((t) => t && typeof t.command === "string" && !t.pending)
          .map((t) => {
            maxId = Math.max(maxId, t.id ?? 0);
            const done = t.settleState === "done";
            return {
              ...t,
              pending: false,
              settleState: done ? "done" : "idle",
              txHash: done ? t.txHash ?? null : null,
            } as ChatTurn;
          });
      } catch {
        // A bad or blocked store just means that mode starts empty.
      }
    }
    idRef.current = maxId;
    setConversations(next);
    setChatHydrated(true);
  }, []);

  // Persist the settled turns whenever they change, once past hydration so the
  // first render cannot stomp saved history with the empty seed state.
  useEffect(() => {
    if (!chatHydrated) return;
    for (const mode of MODES) {
      try {
        const keep = conversations[mode].filter((t) => !t.pending);
        window.localStorage.setItem(CHAT_KEYS[mode], JSON.stringify(keep));
      } catch {
        // Storage full or blocked; the conversation just will not survive a reload.
      }
    }
  }, [conversations, chatHydrated]);

  const sendCommand = (mode: Mode, raw: string) => {
    const command = raw.trim();
    if (!command || chatBusy[mode]) return;
    setChatBusy((b) => ({ ...b, [mode]: true }));
    const id = ++idRef.current;
    setConversations((c) => ({
      ...c,
      [mode]: [...c[mode], { id, command, pending: true, settleState: "idle", txHash: null }],
    }));
    api
      .interpret(command, mode, address)
      .then((result) =>
        setConversations((c) => ({
          ...c,
          [mode]: c[mode].map((t) => (t.id === id ? { ...t, result, pending: false } : t)),
        })),
      )
      .catch((err: unknown) =>
        setConversations((c) => ({
          ...c,
          [mode]: c[mode].map((t) =>
            t.id === id ? { ...t, error: (err as Error).message, pending: false } : t,
          ),
        })),
      )
      .finally(() => setChatBusy((b) => ({ ...b, [mode]: false })));
  };

  const clearConversation = (mode: Mode) => {
    setConversations((c) => ({ ...c, [mode]: [] }));
    try {
      window.localStorage.removeItem(CHAT_KEYS[mode]);
    } catch {
      // The persistence effect will write an empty list on the next tick anyway.
    }
  };

  const settleTurn = (mode: Mode, turnId: number, patch: SettlePatch) => {
    setConversations((c) => ({
      ...c,
      [mode]: c[mode].map((t) => (t.id === turnId ? { ...t, ...patch } : t)),
    }));
  };

  // Find the chat turn an activity row belongs to and ask its console to jump
  // there. Intents match on the server intent id the card carries; trades match
  // on the hash the card recorded when it settled. If nothing matches (a keeper
  // fill, say, that never had a card), this is a quiet no-op.
  const focusActivity = (target: { intentId?: string; txHash?: string | null }) => {
    for (const mode of MODES) {
      const found = conversations[mode].find(
        (t) =>
          (target.intentId && t.result?.id === target.intentId) ||
          (target.txHash && t.txHash && t.txHash.toLowerCase() === target.txHash.toLowerCase()),
      );
      if (found) {
        setChatFocus({ mode, turnId: found.id, nonce: ++focusNonceRef.current });
        if (pathname !== `/${mode}`) router.push(`/${mode}`);
        return;
      }
    }
  };

  const clearChatFocus = () => setChatFocus(null);

  const value: AppDataValue = {
    wallet,
    address,
    price,
    agent,
    balances,
    claims,
    vault,
    capability,
    activity,
    ethUsd,
    prices,
    canAutonomous,
    slippageBps,
    setSlippageBps,
    refreshAll,
    conversations,
    chatBusy,
    sendCommand,
    clearConversation,
    settleTurn,
    chatFocus,
    focusActivity,
    clearChatFocus,
  };

  return <AppDataContext.Provider value={value}>{children}</AppDataContext.Provider>;
}

export function useAppData(): AppDataValue {
  const ctx = useContext(AppDataContext);
  if (!ctx) throw new Error("useAppData must be used inside AppDataProvider");
  return ctx;
}
