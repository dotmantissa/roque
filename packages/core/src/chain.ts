/**
 * The Sepolia connection, built once and shared. A public client for reading the
 * chain, and a lazily built wallet client for the two occasions the backend
 * actually signs a Sepolia transaction: submitting a user's capability grant and
 * filling a triggered limit order. Everything else the backend does is a read.
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  type PublicClient,
  type WalletClient,
  type Chain,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { publicEnv, serverEnv } from "./env.js";

let _public: PublicClient | undefined;

/** The read side of Sepolia. Safe to build anywhere, including serverless. */
export function publicClient(): PublicClient {
  if (!_public) {
    _public = createPublicClient({
      chain: sepolia as Chain,
      transport: http(publicEnv.sepoliaRpcUrl),
    });
  }
  return _public;
}

let _wallet: WalletClient | undefined;

/**
 * The write side of Sepolia, keyed by the relayer wallet. Only ever called from
 * server code; it reads a secret and will throw if one is missing, which keeps
 * it from being pulled into a browser bundle by mistake.
 */
export function relayerWallet(): WalletClient {
  if (!_wallet) {
    const env = serverEnv();
    const account = privateKeyToAccount(env.relayerKey);
    _wallet = createWalletClient({
      account,
      chain: sepolia as Chain,
      transport: http(env.sepoliaRpcUrl),
    });
  }
  return _wallet;
}

/** The relayer's own address, handy for logging and balance checks. */
export function relayerAddress(): `0x${string}` {
  return privateKeyToAccount(serverEnv().relayerKey).address;
}
