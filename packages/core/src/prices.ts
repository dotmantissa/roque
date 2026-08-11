/**
 * The ETH price, read from the exact Chainlink feed the contracts trust. Showing
 * the same price the AgentExecutor uses to value trades and the OrderBook uses to
 * decide fills means the dollar numbers a user sees are the dollar numbers the
 * chain will act on, not a second opinion from somewhere else.
 */

import { addresses, abis } from "@roque/shared";
import { publicClient } from "./chain.js";

// The Sepolia ETH/USD aggregator answers in 8 decimals. We read the decimals off
// the feed rather than hardcoding, so a feed swap never silently mangles a price.
const AGGREGATOR_ABI = [
  {
    type: "function",
    name: "latestRoundData",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "roundId", type: "uint80" },
      { name: "answer", type: "int256" },
      { name: "startedAt", type: "uint256" },
      { name: "updatedAt", type: "uint256" },
      { name: "answeredInRound", type: "uint80" },
    ],
  },
  {
    type: "function",
    name: "decimals",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
  },
] as const;

export interface EthPrice {
  usd: number;
  updatedAt: number; // unix seconds
  ageSeconds: number;
}

/** Current ETH/USD, straight from Chainlink, with how stale the answer is. */
export async function ethUsd(): Promise<EthPrice> {
  const client = publicClient();
  const [round, decimals] = await Promise.all([
    client.readContract({
      address: addresses.priceFeed,
      abi: AGGREGATOR_ABI,
      functionName: "latestRoundData",
      args: [],
    }),
    client.readContract({
      address: addresses.priceFeed,
      abi: AGGREGATOR_ABI,
      functionName: "decimals",
      args: [],
    }),
  ]);

  const answer = round[1] as bigint;
  const updatedAt = Number(round[3] as bigint);
  const usd = Number(answer) / 10 ** Number(decimals);
  const now = Math.floor(Date.now() / 1000);

  return { usd, updatedAt, ageSeconds: Math.max(0, now - updatedAt) };
}

/**
 * Value an amount of a token in dollars the same way the AgentExecutor does, so a
 * preview of "this trade is worth $X" matches the per-trade cap check on-chain.
 * Reads the executor's own `usdValue` view rather than reimplementing the maths.
 */
export async function usdValue(token: `0x${string}`, amountRaw: bigint): Promise<number> {
  const value = (await publicClient().readContract({
    address: addresses.agentExecutor,
    abi: abis.agentExecutor,
    functionName: "usdValue",
    args: [token, amountRaw],
  })) as bigint;
  // The executor returns 1e18 fixed point dollars.
  return Number(value) / 1e18;
}

/** Convert the feed's integer price into the 8-decimal trigger the OrderBook wants. */
export function toTriggerPrice(usd: number): bigint {
  return BigInt(Math.round(usd * 1e8));
}
