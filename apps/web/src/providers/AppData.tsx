"use client";

/**
 * One brain for the whole app, so every screen reads from the same source. The
 * old single page polled the chain once and handed the numbers down its own tree;
 * now that the app is spread across a navbar, a sidebar, and a few routes, that
 * job moves here. Mount this once around the app shell and any screen can ask for
 * the price, a balance, the vault, the capability, or the activity feed and get
 * the exact same value the screen beside it is showing. One poll per fact, shared
 * by everyone, paused when the tab is hidden.
 */

import { createContext, useContext, useMemo, useState } from "react";
import type { AgentInfo, ActivityResult, CapabilityResult, PriceResult, VaultResult } from "@/lib/types";
import { api } from "@/lib/api";
import { walletBalances, faucetClaimsRemaining } from "@/lib/chain";
import { usePoll, type PollState } from "@/lib/hooks";
import { useWallet, type RoqueWallet } from "@/lib/useWallet";

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
}

const AppDataContext = createContext<AppDataValue | null>(null);

export function AppDataProvider({ children }: { children: React.ReactNode }) {
  const wallet = useWallet();
  const address = wallet.address;
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
  };

  return <AppDataContext.Provider value={value}>{children}</AppDataContext.Provider>;
}

export function useAppData(): AppDataValue {
  const ctx = useContext(AppDataContext);
  if (!ctx) throw new Error("useAppData must be used inside AppDataProvider");
  return ctx;
}
