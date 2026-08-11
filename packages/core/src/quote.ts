/**
 * Reading the live market off Sepolia. Quotes come straight from the deployed
 * router, which reads the constant product pool, so a number the UI shows is the
 * same number the swap will honour, give or take the moves between the two
 * blocks. The ETH price comes from the same Chainlink feed the contracts trust,
 * so the dollar figures on screen match the dollar caps enforced on-chain.
 */

import { formatUnits, parseUnits } from "viem";
import { addresses, abis, tokens, type TokenMeta } from "@roque/shared";
import { publicClient } from "./chain.js";

export interface Quote {
  tokenIn: TokenMeta;
  tokenOut: TokenMeta;
  amountIn: string; // human units
  amountInRaw: bigint;
  amountOut: string; // human units
  amountOutRaw: bigint;
  /** Price of one tokenIn expressed in tokenOut, purely informational. */
  price: number;
}

function tokenFor(symbol: "USDC" | "WETH"): TokenMeta {
  return tokens[symbol];
}

/**
 * Quote an exact-input swap. `amountIn` is in human units ("100", "0.5"); we
 * convert to the token's own decimals, ask the router, and convert back. A pool
 * with no liquidity or a nonexistent pair makes the router revert, which we let
 * bubble up rather than paper over with a fake zero.
 */
export async function quoteSwap(
  fromSymbol: "USDC" | "WETH",
  toSymbol: "USDC" | "WETH",
  amountIn: string,
): Promise<Quote> {
  const tokenIn = tokenFor(fromSymbol);
  const tokenOut = tokenFor(toSymbol);
  const amountInRaw = parseUnits(amountIn, tokenIn.decimals);

  const amountOutRaw = (await publicClient().readContract({
    address: addresses.router,
    abi: abis.router,
    functionName: "quoteSwap",
    args: [tokenIn.address, tokenOut.address, amountInRaw],
  })) as bigint;

  const amountOut = formatUnits(amountOutRaw, tokenOut.decimals);
  const inNum = Number(amountIn);
  const outNum = Number(amountOut);
  const price = inNum > 0 ? outNum / inNum : 0;

  return { tokenIn, tokenOut, amountIn, amountInRaw, amountOut, amountOutRaw, price };
}

/**
 * The pool's current reserves, in human units, labelled by token. Useful for a
 * depth readout and for sanity checking a quote against how much is actually in
 * the pool.
 */
export async function poolReserves(): Promise<{ usdc: number; weth: number }> {
  const [r0, r1] = (await publicClient().readContract({
    address: addresses.pool,
    abi: abis.liquidityPool,
    functionName: "getReserves",
    args: [],
  })) as [bigint, bigint];

  // The pool sorts its tokens by address; ask which reserve is which rather than
  // assuming an order.
  const token0 = (await publicClient().readContract({
    address: addresses.pool,
    abi: abis.liquidityPool,
    functionName: "token0",
    args: [],
  })) as `0x${string}`;

  const usdcIsToken0 = token0.toLowerCase() === tokens.USDC.address.toLowerCase();
  const usdcRaw = usdcIsToken0 ? r0 : r1;
  const wethRaw = usdcIsToken0 ? r1 : r0;

  return {
    usdc: Number(formatUnits(usdcRaw, tokens.USDC.decimals)),
    weth: Number(formatUnits(wethRaw, tokens.WETH.decimals)),
  };
}

/**
 * Turn a slippage tolerance in basis points into the minAmountOut a swap should
 * carry. Kept here so the relayer, the UI preview and the intent signer all
 * compute the floor the same way.
 */
export function minOutForSlippage(amountOutRaw: bigint, slippageBps: number): bigint {
  const bps = BigInt(Math.max(0, Math.min(10_000, Math.floor(slippageBps))));
  return (amountOutRaw * (10_000n - bps)) / 10_000n;
}
