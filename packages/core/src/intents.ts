/**
 * Autonomous mode, on the signing side. When a user has granted a capability,
 * the agent may act inside it without another click. "Act" means: the agent
 * signer produces one EIP-712 signature per intent, and the relayer submits that
 * intent to the AgentExecutor, which re-checks every bound on-chain before a
 * token moves. This module owns the signing and the submitting; it never decides
 * whether an action is wise, only that it is well formed and within the grant.
 *
 * The signature the agent produces is worthless on its own. It authorises
 * nothing the user has not already allowed, because the executor values the
 * trade in dollars from Chainlink and rejects anything over the per-trade or
 * daily cap, past the slippage floor, after expiry, or replayed on a used nonce.
 * That is the deal: the agent gets to be fast, the user keeps the hard limits.
 */

import { randomInt } from "node:crypto";
import { encodeFunctionData, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { addresses, abis, eip712Domain, eip712Types, tokenList } from "@roque/shared";
import { agentSignerKey } from "./env.js";
import { confirmTx, publicClient, sendRelayerTx } from "./chain.js";

/** No commitment: an ordinary trade, which may only reach free vault money. */
export const NO_COMMITMENT =
  "0x0000000000000000000000000000000000000000000000000000000000000000" as const;

export interface SwapIntent {
  user: `0x${string}`;
  tokenIn: `0x${string}`;
  tokenOut: `0x${string}`;
  amountIn: bigint;
  minAmountOut: bigint;
  /** The commitment this trade fulfils, or NO_COMMITMENT for a plain trade. */
  commitmentId: `0x${string}`;
  nonce: bigint;
  deadline: bigint;
}

export interface LimitIntent {
  user: `0x${string}`;
  tokenIn: `0x${string}`;
  tokenOut: `0x${string}`;
  amountIn: bigint;
  minAmountOut: bigint;
  triggerPrice: bigint;
  triggerAbove: boolean;
  expiry: bigint;
  commitmentId: `0x${string}`;
  nonce: bigint;
  deadline: bigint;
}

/** Setting vault money aside. Moves nothing; narrows what the vault may do. */
export interface CommitIntent {
  user: `0x${string}`;
  token: `0x${string}`;
  amount: bigint;
  unlockAt: bigint;
  commitmentId: `0x${string}`;
  nonce: bigint;
  deadline: bigint;
}

/** Handing it back. The epoch pins this to one particular lock of that id. */
export interface ReleaseIntent {
  user: `0x${string}`;
  commitmentId: `0x${string}`;
  epoch: number;
  deadline: bigint;
}

/** One commitment as the executor holds it. */
export interface Commitment {
  user: `0x${string}`;
  token: `0x${string}`;
  amount: bigint;
  unlockAt: bigint;
  epoch: number;
  active: boolean;
}

/** How long a signed intent stays valid. Short: the relayer submits at once. */
const INTENT_TTL_SECONDS = 300;

function agentAccount() {
  return privateKeyToAccount(agentSignerKey());
}

/** The address the on-chain capability must name as its agent signer. */
export function agentSignerAddress(): `0x${string}` {
  return agentAccount().address;
}

/**
 * A nonce no one has spent for this user yet. Nonces are per user and the
 * executor simply marks each one used, so we pick a value and confirm it is
 * free.
 *
 * The value used to be the millisecond clock alone, which collides more often
 * than it sounds: two workers reaching this in the same millisecond both read
 * the nonce as unused, because neither transaction has landed yet, and the
 * second one reverts on arrival. Not a double spend -- the contract is the one
 * saying no -- but a fill that failed for a reason nobody can read. A random
 * tail under the clock makes a same-millisecond collision a one-in-a-million
 * event rather than a certainty, and the loop below still checks.
 */
export async function freshNonce(user: `0x${string}`): Promise<bigint> {
  let candidate = BigInt(Date.now()) * 1_000_000n + BigInt(randomInt(1_000_000));
  for (let i = 0; i < 8; i++) {
    const used = (await publicClient().readContract({
      address: addresses.agentExecutor,
      abi: abis.agentExecutor,
      functionName: "usedNonce",
      args: [user, candidate],
    })) as boolean;
    if (!used) return candidate;
    candidate += 1n;
  }
  throw new Error("Could not find an unused nonce; this should never happen.");
}

/** Sign a swap intent as the agent. The signature is the agent's whole say. */
export async function signSwapIntent(intent: SwapIntent): Promise<Hex> {
  return agentAccount().signTypedData({
    domain: eip712Domain,
    types: { SwapIntent: eip712Types.SwapIntent },
    primaryType: "SwapIntent",
    message: { ...intent, capabilityGeneration: await capabilityGeneration(intent.user) },
  });
}

/** Sign a limit intent as the agent. */
export async function signLimitIntent(intent: LimitIntent): Promise<Hex> {
  return agentAccount().signTypedData({
    domain: eip712Domain,
    types: { LimitIntent: eip712Types.LimitIntent },
    primaryType: "LimitIntent",
    message: { ...intent, capabilityGeneration: await capabilityGeneration(intent.user) },
  });
}

/** Sign a commitment as the agent. */
export async function signCommitIntent(intent: CommitIntent): Promise<Hex> {
  return agentAccount().signTypedData({
    domain: eip712Domain,
    types: { CommitIntent: eip712Types.CommitIntent },
    primaryType: "CommitIntent",
    message: { ...intent, capabilityGeneration: await capabilityGeneration(intent.user) },
  });
}

/** Sign a release as the agent. */
export async function signReleaseIntent(intent: ReleaseIntent): Promise<Hex> {
  return agentAccount().signTypedData({
    domain: eip712Domain,
    types: { ReleaseIntent: eip712Types.ReleaseIntent },
    primaryType: "ReleaseIntent",
    message: { ...intent, capabilityGeneration: await capabilityGeneration(intent.user) },
  });
}

/**
 * Submit a signed swap to Sepolia and return the transaction hash. We encode and
 * send with the relayer wallet, which pays the gas; the intent still moves only
 * the user's vaulted funds and only within their capability.
 */
export async function submitSwap(intent: SwapIntent, signature: Hex, operationId?:string): Promise<Hex> {
  const data = encodeFunctionData({
    abi: abis.agentExecutor,
    functionName: "executeSwap",
    args: [intent, signature],
  });
  return sendFromRelayer(data,operationId);
}

/** Submit a signed limit order to Sepolia and return the transaction hash. */
export async function submitLimitOrder(intent: LimitIntent, signature: Hex, operationId?:string): Promise<Hex> {
  const data = encodeFunctionData({
    abi: abis.agentExecutor,
    functionName: "createLimitOrder",
    args: [intent, signature],
  });
  return sendFromRelayer(data,operationId);
}

async function sendFromRelayer(data: Hex, operationId?:string): Promise<Hex> {
  return sendRelayerTx({ to: addresses.agentExecutor, data, operationId });
}

// ─────────────────────────────────────────────────────────────
// Commitments: holding vault money for a trade that has not happened yet
// ─────────────────────────────────────────────────────────────

/**
 * Set money aside, and wait for it to actually be set aside.
 *
 * The waiting is the point. A caller asks for this while turning a screened
 * order into an armed one, and an armed order with an unconfirmed hold behind it
 * is the old bug wearing a new hat: the funding gate would read a lock that is
 * not there yet and let the next order promise the same money. So this returns
 * only once the chain agrees, and throws if the chain refused, which is how a
 * vault that cannot cover the commitment turns into a sentence the person reads
 * rather than an order that quietly cannot fill.
 *
 * Every leg goes in one transaction, all or nothing, so a playbook is never
 * half funded.
 */
export async function lockCommitments(intents: CommitIntent[], operationId?:string): Promise<Hex | null> {
  if (intents.length === 0) return null;
  const signatures = await Promise.all(intents.map(signCommitIntent));
  const data =
    intents.length === 1
      ? encodeFunctionData({
          abi: abis.agentExecutor,
          functionName: "lockForCommitment",
          args: [intents[0], signatures[0]],
        })
      : encodeFunctionData({
          abi: abis.agentExecutor,
          functionName: "lockForCommitments",
          args: [intents, signatures],
        });
  const hash = await sendFromRelayer(data,operationId);
  await confirmTx(hash, "Holding the vault money for this order");
  return hash;
}

/**
 * Hand commitments back. Skips the ones the chain has already let go, which is
 * most of them most of the time: a release sweep runs on every exit an order
 * has, and several of those paths overlap. Returns null when there was nothing
 * left to release, so a caller can tell "done" from "nothing to do".
 */
export async function releaseCommitments(
  commitmentIds: `0x${string}`[],
): Promise<Hex | null> {
  if (commitmentIds.length === 0) return null;
  // The owner comes off the commitment rather than from the caller. It is the
  // chain's answer either way, and taking it from here means a release does not
  // need a database row to have survived in order to work.
  const live = await Promise.all(
    commitmentIds.map(async (id) => {
      const c = await getCommitment(id);
      return c.active ? { id, epoch: c.epoch, user: c.user } : null;
    }),
  );
  const open = live.filter(
    (c): c is { id: `0x${string}`; epoch: number; user: `0x${string}` } => c !== null,
  );
  if (open.length === 0) return null;

  const deadline = BigInt(Math.floor(Date.now() / 1000) + INTENT_TTL_SECONDS);
  const intents: ReleaseIntent[] = open.map((c) => ({
    user: c.user,
    commitmentId: c.id,
    epoch: c.epoch,
    deadline,
  }));
  const signatures = await Promise.all(intents.map(signReleaseIntent));
  const data =
    intents.length === 1
      ? encodeFunctionData({
          abi: abis.agentExecutor,
          functionName: "releaseCommitment",
          args: [intents[0], signatures[0]],
        })
      : encodeFunctionData({
          abi: abis.agentExecutor,
          functionName: "releaseCommitments",
          args: [intents, signatures],
        });
  const hash = await sendFromRelayer(data);
  await confirmTx(hash, "Releasing the hold on this order");
  return hash;
}

/** One commitment as the executor currently holds it. */
export async function getCommitment(commitmentId: `0x${string}`): Promise<Commitment> {
  return (await publicClient().readContract({
    address: addresses.agentExecutor,
    abi: abis.agentExecutor,
    functionName: "getCommitment",
    args: [commitmentId],
  })) as Commitment;
}

/** One token's two figures, as the executor holds them. */
export interface VaultTokenState {
  balance: bigint;
  locked: bigint;
  available: bigint;
}

/**
 * Every token's balance and hold in one request.
 *
 * Twenty reads, batched through Multicall3 into a single round trip. The vault
 * panel polls this every twenty seconds per connected wallet, and it was ten
 * reads before holds existed; sending twenty separate calls at that cadence is
 * how you get rate limited off a public RPC on a busy afternoon. A failed
 * sub-call reads as zero rather than taking the whole snapshot down, which is
 * the safe direction for a balance: under-reporting what is free refuses a
 * withdrawal the person could have made, and the chain is the one that decides
 * anyway.
 */
export async function vaultSnapshot(
  user: `0x${string}`,
): Promise<Map<string, VaultTokenState>> {
  const owner = user.toLowerCase() as `0x${string}`;
  const calls = tokenList.flatMap((t) => [
    {
      address: addresses.agentExecutor,
      abi: abis.agentExecutor,
      functionName: "vaultBalance",
      args: [owner, t.address],
    },
    {
      address: addresses.agentExecutor,
      abi: abis.agentExecutor,
      functionName: "lockedBalance",
      args: [owner, t.address],
    },
  ]);
  // The ABIs here are plain JSON rather than `as const`, so viem cannot infer
  // the result shape of a built call list. The cast is named once, right where
  // the answers are read back, instead of being spread across the reads.
  const results = (await publicClient().multicall({
    contracts: calls as never,
    allowFailure: true,
  })) as Array<{ status: "success" | "failure"; result?: unknown }>;

  const read = (i: number): bigint => {
    const r = results[i];
    return r?.status === "success" ? (r.result as bigint) : 0n;
  };

  const snapshot = new Map<string, VaultTokenState>();
  tokenList.forEach((t, i) => {
    const balance = read(i * 2);
    const locked = read(i * 2 + 1);
    snapshot.set(t.symbol, {
      balance,
      locked,
      available: balance > locked ? balance - locked : 0n,
    });
  });
  return snapshot;
}

/** How much of a token the executor is holding for this user's commitments. */
export async function lockedBalance(
  user: `0x${string}`,
  token: `0x${string}`,
): Promise<bigint> {
  return (await publicClient().readContract({
    address: addresses.agentExecutor,
    abi: abis.agentExecutor,
    functionName: "lockedBalance",
    args: [user, token],
  })) as bigint;
}

// ─────────────────────────────────────────────────────────────
// Reading the user's autonomous state, so the relayer can refuse early
// ─────────────────────────────────────────────────────────────

export interface Capability {
  agentSigner: `0x${string}`;
  maxPerTradeUsd: bigint;
  maxDailyUsd: bigint;
  maxSlippageBps: bigint;
  validUntil: bigint;
  revoked: boolean;
  exists: boolean;
}

/** The user's current capability, or null if they have never granted one. */
export async function getCapability(user: `0x${string}`): Promise<Capability | null> {
  const c = (await publicClient().readContract({
    address: addresses.agentExecutor,
    abi: abis.agentExecutor,
    functionName: "getCapability",
    args: [user],
  })) as Capability;
  return c.exists ? c : null;
}

/** How much of a token the user has sitting in their agent vault, raw units. */
export async function vaultBalance(
  user: `0x${string}`,
  token: `0x${string}`,
): Promise<bigint> {
  return (await publicClient().readContract({
    address: addresses.agentExecutor,
    abi: abis.agentExecutor,
    functionName: "vaultBalance",
    args: [user, token],
  })) as bigint;
}

/** The user's remaining daily dollar headroom, 1e18 fixed point. */
export async function remainingDailyUsd(user: `0x${string}`): Promise<bigint> {
  return (await publicClient().readContract({
    address: addresses.agentExecutor,
    abi: abis.agentExecutor,
    functionName: "remainingDailyUsd",
    args: [user],
  })) as bigint;
}

/** The grant nonce a user's next capability signature must carry. */
export async function grantNonce(user: `0x${string}`): Promise<bigint> {
  return (await publicClient().readContract({
    address: addresses.agentExecutor,
    abi: abis.agentExecutor,
    functionName: "grantNonce",
    args: [user],
  })) as bigint;
}

/**
 * Submit a user-signed capability grant so they never pay gas to turn autonomous
 * mode on. The signature must be the user's; the executor recovers it and
 * rejects anyone else, so the relayer cannot grant itself power here.
 */
export async function submitGrant(params: {
  user: `0x${string}`;
  agentSigner: `0x${string}`;
  maxPerTradeUsd: bigint;
  maxDailyUsd: bigint;
  maxSlippageBps: bigint;
  validUntil: bigint;
  signature: Hex;
}): Promise<Hex> {
  const data = encodeFunctionData({
    abi: abis.agentExecutor,
    functionName: "grantCapabilityWithSig",
    args: [
      params.user,
      params.agentSigner,
      params.maxPerTradeUsd,
      params.maxDailyUsd,
      params.maxSlippageBps,
      params.validUntil,
      params.signature,
    ],
  });
  return sendFromRelayer(data);
}

/** Only executor v2 supports generation-bound authority; old deployments fail closed. */
export async function capabilityGeneration(user: `0x${string}`): Promise<bigint> {
  return publicClient().readContract({ address: addresses.agentExecutor,
    abi: [{type: "function",name: "capabilityGeneration",stateMutability: "view",inputs:[{name:"user",type:"address"}],outputs:[{name:"",type:"uint256"}]}],
    functionName: "capabilityGeneration", args: [user] }) as Promise<bigint>;
}
