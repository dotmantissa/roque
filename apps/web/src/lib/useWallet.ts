"use client";

/**
 * One friendly surface over Privy for the rest of the app. Components should not
 * need to know how a wallet gets connected or how a viem client gets built; they
 * ask this hook for an address, a way to sign in, and a client when they need to
 * send something. The client is made fresh from the connected wallet's provider
 * and pointed at Sepolia first, so a write never fires at the wrong chain.
 *
 * A note on what counts as "connected", because it caused a real bug: we read
 * the address from the authenticated user's linked wallet, not from the live
 * `useWallets()` list. That list is a snapshot of live connections and Privy
 * empties it for a beat while it re-pings a wallet, which on a page that polls
 * every few seconds made the header flicker between connected and not. The user
 * session is steady, so we lean on that for identity and only reach into the
 * live list when we actually need a provider to sign with.
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
  /** Disconnect the wallet for real: drop the connector, then end the session. */
  logout: () => Promise<void>;
  /** Build a Sepolia wallet client from the active wallet, or throw if none. */
  getClient: () => Promise<{ client: WalletClient; address: `0x${string}` }>;
}

export function useWallet(): RoqueWallet {
  const { ready, authenticated, user, login, logout } = usePrivy();
  const { wallets } = useWallets();

  // Identity comes from the session, which does not flinch when Privy re-pings a
  // wallet in the background. An external wallet lands here as user.wallet.
  const linked = user?.wallet;
  const address = linked?.address as `0x${string}` | undefined;

  const getClient = useCallback(async () => {
    if (!address) throw new Error("Connect a wallet first.");
    // The provider has to come from the live list. Match it to the session
    // address so a second connected wallet can never sign for the first, and
    // fall back to the only wallet on the list when the match is momentarily gone.
    const active =
      wallets.find((w) => w.address?.toLowerCase() === address.toLowerCase()) ?? wallets[0];
    if (!active) throw new Error("Reconnect your wallet to sign this.");
    // Privy's provider type carries a looser event signature than viem's
    // EIP1193Provider; they are the same object at runtime, so we narrow it here
    // at the single boundary rather than loosening the chain helpers everywhere.
    const provider = (await active.getEthereumProvider()) as unknown as EIP1193Provider;
    await ensureSepolia(provider);
    const acct = active.address as `0x${string}`;
    return { client: walletClientFrom(provider, acct), address: acct };
  }, [address, wallets]);

  // Disconnecting only through logout left the injected wallet still connected,
  // so Privy would quietly re-authenticate and it looked like the button did
  // nothing. Drop every live connector first, then end the session for good.
  const disconnect = useCallback(async () => {
    for (const w of wallets) {
      try {
        w.disconnect();
      } catch {
        // A wallet that is already gone throws; that is the state we wanted.
      }
    }
    await logout();
  }, [wallets, logout]);

  return useMemo(
    () => ({
      ready,
      connected: ready && authenticated && Boolean(address),
      address,
      walletLabel: linked?.walletClientType,
      login,
      logout: disconnect,
      getClient,
    }),
    [ready, authenticated, address, linked?.walletClientType, login, disconnect, getClient],
  );
}
