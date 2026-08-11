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

import { encodeFunctionData, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { addresses, abis, eip712Domain, eip712Types } from "@roque/shared";
import { agentSignerKey } from "./env.js";
import { publicClient, relayerWallet } from "./chain.js";

export interface SwapIntent {
  user: `0x${string}`;
  tokenIn: `0x${string}`;
  tokenOut: `0x${string}`;
  amountIn: bigint;
  minAmountOut: bigint;
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
  nonce: bigint;
  deadline: bigint;
}

function agentAccount() {
  return privateKeyToAccount(agentSignerKey());
}

/** The address the on-chain capability must name as its agent signer. */
export function agentSignerAddress(): `0x${string}` {
  return agentAccount().address;
}

/**
 * A nonce no one has spent for this user yet. Nonces are per user and the
 * executor simply marks each one used, so we pick a value keyed to the current
 * time and confirm it is free. Practically this never collides; if it somehow
 * did, the on-chain check would reject the second use rather than double spend.
 */
export async function freshNonce(user: `0x${string}`): Promise<bigint> {
  let candidate = BigInt(Date.now());
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
    message: intent,
  });
}

/** Sign a limit intent as the agent. */
export async function signLimitIntent(intent: LimitIntent): Promise<Hex> {
  return agentAccount().signTypedData({
    domain: eip712Domain,
    types: { LimitIntent: eip712Types.LimitIntent },
    primaryType: "LimitIntent",
    message: intent,
  });
}

/**
 * Submit a signed swap to Sepolia and return the transaction hash. We encode and
 * send with the relayer wallet, which pays the gas; the intent still moves only
 * the user's vaulted funds and only within their capability.
 */
export async function submitSwap(intent: SwapIntent, signature: Hex): Promise<Hex> {
  const data = encodeFunctionData({
    abi: abis.agentExecutor,
    functionName: "executeSwap",
    args: [intent, signature],
  });
  return sendFromRelayer(data);
}

/** Submit a signed limit order to Sepolia and return the transaction hash. */
export async function submitLimitOrder(intent: LimitIntent, signature: Hex): Promise<Hex> {
  const data = encodeFunctionData({
    abi: abis.agentExecutor,
    functionName: "createLimitOrder",
    args: [intent, signature],
  });
  return sendFromRelayer(data);
}

async function sendFromRelayer(data: Hex): Promise<Hex> {
  const wallet = relayerWallet();
  return wallet.sendTransaction({
    account: wallet.account!,
    chain: wallet.chain,
    to: addresses.agentExecutor,
    data,
  });
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
