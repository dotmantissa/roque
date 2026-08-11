"use client";

/**
 * One friendly surface over Privy for the rest of the app. Components should not
 * need to know how a wallet gets connected or how a viem client gets built; they
 * ask this hook for an address, a way to sign in, and a client when they need to
 * send something. The client is made fresh from the connected wallet's provider
 * and pointed at Sepolia first, so a write never fires at the wrong chain.
 */

import { useCallback, useMemo } from "react";
import { usePrivy, useWallets } from "@privy-io/react-auth";
import type { EIP1193Provider, WalletClient } from "viem";
import { ensureSepolia, walletClientFrom } from "./chain";

export interface RoqueWallet {
  ready: boolean;
  connected: boolean;
  address: `0x${string}` | undefined;
  walletLabel: string | undefined;
  login: () => void;
  logout: () => Promise<void>;
  /** Build a Sepolia wallet client from the active wallet, or throw if none. */
  getClient: () => Promise<{ client: WalletClient; address: `0x${string}` }>;
}

export function useWallet(): RoqueWallet {
  const { ready, authenticated, login, logout } = usePrivy();
  const { wallets } = useWallets();

  const active = wallets[0];
  const address = active?.address as `0x${string}` | undefined;

  const getClient = useCallback(async () => {
    if (!active) throw new Error("Connect a wallet first.");
    // Privy's provider type carries a looser event signature than viem's
    // EIP1193Provider; they are the same object at runtime, so we narrow it here
    // at the single boundary rather than loosening the chain helpers everywhere.
    const provider = (await active.getEthereumProvider()) as unknown as EIP1193Provider;
    await ensureSepolia(provider);
    const acct = active.address as `0x${string}`;
    return { client: walletClientFrom(provider, acct), address: acct };
  }, [active]);

  return useMemo(
    () => ({
      ready,
      connected: authenticated && Boolean(address),
      address,
      walletLabel: active?.walletClientType,
      login,
      logout,
      getClient,
    }),
    [ready, authenticated, address, active?.walletClientType, login, logout, getClient],
  );
}
