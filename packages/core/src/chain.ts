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
  type Hex,
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

// ─────────────────────────────────────────────────────────────
// One queue in front of the relayer wallet
// ─────────────────────────────────────────────────────────────

/**
 * Every Sepolia write Roque makes leaves from one address, and there are now
 * several things that want to send at once: the keeper filling a triggered
 * order, the judgment loop filling an event order, a playbook advancing a rung,
 * somebody arming an order and locking the money behind it. Fired off in
 * parallel they each ask the node for the next nonce, all get the same answer,
 * and all but one come back "replacement transaction underpriced" or "already
 * known". Nothing is lost, but the work is: a fill that reverts on a nonce
 * collision looks exactly like a fill the contract refused.
 *
 * So sends queue. One at a time, in the order they were asked for, with the
 * nonce tracked locally rather than re-read per send, because the node's pending
 * count lags its own txpool by just enough to matter. A send that fails for any
 * reason drops the local count so the next one re-reads from the chain, which
 * costs one extra round trip and cannot leave a permanent gap.
 */
let pending: Promise<unknown> = Promise.resolve();
export async function sendRelayerTx(params: {to: `0x${string}`;data: Hex;operationId?:string}):Promise<Hex> {
  const run=async()=>{const {durableSend}=await import("./sender.js");return durableSend(params);};
  const queued=pending.then(run,run);
  pending=queued.then(()=>undefined,()=>undefined);
  return queued;
}

/** Wait for a transaction and throw a readable error if the chain refused it. */
export class SubmissionPendingError extends Error {constructor(public hash:Hex){super("Transaction outcome is pending; check status before retrying.");}}

export async function confirmTx(hash: Hex, what: string): Promise<void> {
  const receipt = await publicClient().waitForTransactionReceipt({ hash, timeout: 120_000, confirmations:3 }).catch(()=>{throw new SubmissionPendingError(hash);});
  if (receipt.status !== "success") {
    throw new Error(`${what} was rejected on-chain (${hash}).`);
  }
}
