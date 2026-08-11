/**
 * Reading the live market off Sepolia. Quotes come straight from the deployed
 * router, which reads the constant product pool, so a number the UI shows is the
 * same number the swap will honour, give or take the moves between the two
 * blocks. Prices come from the same Chainlink feeds the contracts trust, so the
 * dollar figures on screen match the dollar caps enforced on-chain.
 */

import { formatUnits, parseUnits } from "viem";
import { addresses, abis, requireToken, poolAddressFor, type TokenMeta } from "@roque/shared";
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

/**
 * Quote an exact-input swap between any two of our tokens, named by symbol.
 * `amountIn` is in human units ("100", "0.5"); we convert to the token's own
 * decimals, ask the router, and convert back. The router finds the single pool
 * for the pair itself; a missing pair or a dry pool makes it revert, which we let
 * bubble up rather than paper over with a fake zero.
 */
export async function quoteSwap(
  fromSymbol: string,
  toSymbol: string,
  amountIn: string,
): Promise<Quote> {
  const tokenIn = requireToken(fromSymbol);
  const tokenOut = requireToken(toSymbol);
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

export interface PoolReserves {
  a: string; // token symbol
  b: string; // token symbol
  reserveA: number; // human units of token a
  reserveB: number; // human units of token b
}

/**
 * The current reserves of one pool in the mesh, in human units and labelled by
 * symbol. Useful for a depth readout and for sanity checking a quote against how
 * much is actually in that pair's pool.
 */
export async function poolReserves(symbolA: string, symbolB: string): Promise<PoolReserves> {
  const tokenA = requireToken(symbolA);
  const tokenB = requireToken(symbolB);
  const poolAddress = poolAddressFor(symbolA, symbolB);
  const client = publicClient();

  const [[r0, r1], token0] = await Promise.all([
    client.readContract({
      address: poolAddress,
      abi: abis.liquidityPool,
      functionName: "getReserves",
      args: [],
    }) as Promise<[bigint, bigint]>,
    client.readContract({
      address: poolAddress,
      abi: abis.liquidityPool,
      functionName: "token0",
      args: [],
    }) as Promise<`0x${string}`>,
  ]);

  // The pool sorts its tokens by address; ask which reserve is which rather than
  // assuming an order.
  const aIsToken0 = token0.toLowerCase() === tokenA.address.toLowerCase();
  const rawA = aIsToken0 ? r0 : r1;
  const rawB = aIsToken0 ? r1 : r0;

  return {
    a: tokenA.symbol,
    b: tokenB.symbol,
    reserveA: Number(formatUnits(rawA, tokenA.decimals)),
    reserveB: Number(formatUnits(rawB, tokenB.decimals)),
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
