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
 *
 * If a Latch proxy is configured, the wallet's egress is pointed at it and every
 * transaction the relayer submits carries the scoped `lat_` token instead of the
 * raw RPC key. Latch injects the real credential, rate limits the channel and
 * audits it. With Latch unset we talk to the RPC directly, unchanged.
 */
export function relayerWallet(): WalletClient {
  if (!_wallet) {
    const env = serverEnv();
    const account = privateKeyToAccount(env.relayerKey);
    const useLatch = env.latchRpcUrl !== "" && env.latchToken !== "";
    const transport = useLatch
      ? http(env.latchRpcUrl, {
          fetchOptions: {
            headers: { Authorization: `Bearer ${env.latchToken}` },
          },
        })
      : http(env.sepoliaRpcUrl);
    _wallet = createWalletClient({
      account,
      chain: sepolia as Chain,
      transport,
    });
  }
  return _wallet;
}

/** The relayer's own address, handy for logging and balance checks. */
export function relayerAddress(): `0x${string}` {
  return privateKeyToAccount(serverEnv().relayerKey).address;
}
