/**
 * Turning an interpretation into the exact arguments a contract call wants. The
 * server does this for autonomous mode; copilot mode does it here, in the
 * browser, because the person signs and sends from their own wallet. Keeping the
 * arithmetic in one small place means the two paths agree on what a trade means.
 */

import { parseUnits } from "viem";
import { tokens, type TokenMeta } from "@roque/shared";
import type { Interpretation } from "./types";

export function tokenBySymbol(symbol: string): TokenMeta {
  if (symbol === "USDC" || symbol === "WETH") return tokens[symbol];
  throw new Error(`Roque does not trade ${symbol}.`);
}

/**
 * A percent amount only means something against a balance. In copilot mode the
 * balance is the connected wallet's, so we resolve it here to a concrete human
 * figure before anything gets prepared or signed.
 */
export function resolveConcreteAmount(
  interp: Interpretation,
  walletBalances: { USDC: number; WETH: number },
): string {
  if (!interp.amountIsPercent) return interp.amount;
  const percent = Number(interp.amount);
  if (!Number.isFinite(percent) || percent <= 0) {
    throw new Error("That percentage did not read as a positive number.");
  }
  const symbol = interp.tokenIn as "USDC" | "WETH";
  const base = walletBalances[symbol] ?? 0;
  const amount = (base * percent) / 100;
  if (amount <= 0) {
    throw new Error(`You do not hold any ${symbol} to take a percentage of.`);
  }
  // Trim to the token's precision so parseUnits never chokes on a long float.
  return amount.toFixed(tokenBySymbol(symbol).decimals);
}

/** Scale a USD price to the 1e8 fixed point the order book stores. */
export function toTriggerPrice(usd: number): bigint {
  return BigInt(Math.round(usd * 1e8));
}

export interface LimitOrderArgs {
  tokenIn: `0x${string}`;
  tokenOut: `0x${string}`;
  amountInRaw: bigint;
  minAmountOutRaw: bigint;
  triggerPrice: bigint;
  triggerAbove: boolean;
  expiry: bigint;
}

const LIMIT_EXPIRY_SECONDS = 7 * 24 * 60 * 60;

/**
 * Build the order the book will hold until its trigger is met. The floor on the
 * output is derived from the trigger price the order fires at, discounted by the
 * slippage the person allowed, so a fill can never come in worse than they said.
 */
export function buildLimitOrder(
  interp: Interpretation,
  concreteAmount: string,
  fallbackPrice: number,
  slippageBps: number,
): LimitOrderArgs {
  const tokenIn = tokenBySymbol(interp.tokenIn);
  const tokenOut = tokenBySymbol(interp.tokenOut);
  const amountInRaw = parseUnits(concreteAmount, tokenIn.decimals);

  const price = interp.triggerPrice ? Number(interp.triggerPrice) : fallbackPrice;
  if (!Number.isFinite(price) || price <= 0) {
    throw new Error("That order needs a price to trigger at.");
  }

  const amountHuman = Number(concreteAmount);
  // Selling WETH gives USDC at the price; spending USDC gives WETH at 1/price.
  const expectedOut =
    tokenOut.key === "USDC" ? amountHuman * price : amountHuman / price;
  const minOutHuman = expectedOut * (1 - slippageBps / 10_000);
  const minAmountOutRaw = parseUnits(
    minOutHuman.toFixed(tokenOut.decimals),
    tokenOut.decimals,
  );

  return {
    tokenIn: tokenIn.address,
    tokenOut: tokenOut.address,
    amountInRaw,
    minAmountOutRaw,
    triggerPrice: toTriggerPrice(price),
    triggerAbove: interp.triggerAbove,
    expiry: BigInt(Math.floor(Date.now() / 1000) + LIMIT_EXPIRY_SECONDS),
  };
}
