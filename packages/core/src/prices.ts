/**
 * Prices, read from the exact Chainlink feeds the contracts trust. Showing the
 * same price the AgentExecutor uses to value trades and the OrderBook uses to
 * decide fills means the dollar numbers a user sees are the dollar numbers the
 * chain will act on, not a second opinion from somewhere else.
 */

import { addresses, abis, requireToken, tokenList } from "@roque/shared";
import { publicClient } from "./chain.js";

// A Chainlink aggregator answers in its own decimals (8 on the Sepolia USD
// feeds). We read the decimals off the feed rather than hardcoding, so a feed
// swap never silently mangles a price.
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

export interface FeedPrice {
  usd: number;
  updatedAt: number; // unix seconds
  ageSeconds: number;
}

/** Read any Chainlink USD feed, with how stale the answer is. */
export async function feedUsd(feed: `0x${string}`): Promise<FeedPrice> {
  const client = publicClient();
  const [round, decimals] = await Promise.all([
    client.readContract({
      address: feed,
      abi: AGGREGATOR_ABI,
      functionName: "latestRoundData",
      args: [],
    }),
    client.readContract({
      address: feed,
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

export type EthPrice = FeedPrice;

/** Current ETH/USD, straight from Chainlink. The order book still speaks ETH. */
export async function ethUsd(): Promise<EthPrice> {
  return feedUsd(addresses.priceFeed);
}

/**
 * The USD price of one of our tokens. A stable is a flat dollar; everything else
 * is read live from its own feed. This is the general form the ten-token UI and
 * the interpreter context lean on.
 */
export async function tokenUsd(symbol: string): Promise<number> {
  const token = requireToken(symbol);
  if (token.isStable) return 1;
  const { usd } = await feedUsd(token.feed);
  return usd;
}

/**
 * Every token's USD price at once, as a symbol → price map. Stables resolve
 * instantly; the rest are read from their feeds in parallel. A single feed that
 * is momentarily unreadable falls back to its deploy-time price rather than
 * sinking the whole map.
 */
export async function allTokenUsd(): Promise<Record<string, number>> {
  const entries = await Promise.all(
    tokenList.map(async (t) => {
      if (t.isStable) return [t.symbol, 1] as const;
      try {
        const { usd } = await feedUsd(t.feed);
        return [t.symbol, usd] as const;
      } catch {
        return [t.symbol, Number(t.initialPrice8) / 1e8] as const;
      }
    }),
  );
  return Object.fromEntries(entries);
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

/** Convert a dollar price into the 8-decimal trigger the OrderBook wants. */
export function toTriggerPrice(usd: number): bigint {
  return BigInt(Math.round(usd * 1e8));
}
