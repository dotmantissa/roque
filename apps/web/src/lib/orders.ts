/**
 * Turning an interpretation into the exact arguments a contract call wants. The
 * server does this for autonomous mode; copilot mode does it here, in the
 * browser, because the person signs and sends from their own wallet. Keeping the
 * arithmetic in one small place means the two paths agree on what a trade means.
 */

import { parseUnits } from "viem";
import { requireToken } from "@roque/shared";
import type { Interpretation } from "./types";

/**
 * A percent amount only means something against a balance. In copilot mode the
 * balance is the connected wallet's, so we resolve it here to a concrete human
 * figure before anything gets prepared or signed.
 */
export function resolveConcreteAmount(
  interp: Interpretation,
  walletBalances: Record<string, number>,
): string {
  if (!interp.amountIsPercent) return interp.amount;
  const percent = Number(interp.amount);
  if (!Number.isFinite(percent) || percent <= 0) {
    throw new Error("That percentage did not read as a positive number.");
  }
  const token = requireToken(interp.tokenIn);
  const base = walletBalances[token.symbol] ?? 0;
  const amount = (base * percent) / 100;
  if (amount <= 0) {
    throw new Error(`You do not hold any ${token.symbol} to take a percentage of.`);
  }
  // Trim to the token's precision so parseUnits never chokes on a long float.
  return amount.toFixed(token.decimals);
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

// The one asset the order book actually watches. A resting order tracks ether's
// dollar price, so every limit must have rWETH on one side; the other leg is
// valued at its live oracle price when we compute the output floor.
const WETH_SYMBOL = "rWETH";

/**
 * Build the order the book will hold until its trigger is met. The floor on the
 * output is derived by valuing both legs in dollars, the ether leg at the price
 * the order fires at and the other leg at its live oracle price, then discounting
 * by the slippage the person allowed. A fill can never come in worse than that.
 */
export function buildLimitOrder(
  interp: Interpretation,
  concreteAmount: string,
  triggerFallback: number,
  prices: Record<string, number>,
  slippageBps: number,
): LimitOrderArgs {
  const tokenIn = requireToken(interp.tokenIn);
  const tokenOut = requireToken(interp.tokenOut);
  const amountInRaw = parseUnits(concreteAmount, tokenIn.decimals);

  const triggerPrice = interp.triggerPrice ? Number(interp.triggerPrice) : triggerFallback;
  if (!Number.isFinite(triggerPrice) || triggerPrice <= 0) {
    throw new Error("That order needs a price to trigger at.");
  }

  if (tokenIn.symbol !== WETH_SYMBOL && tokenOut.symbol !== WETH_SYMBOL) {
    throw new Error(
      "A resting order only tracks ether's price, so a limit needs rWETH on one side. Try a market swap for this pair.",
    );
  }

  const usdPerUnit = (symbol: string): number =>
    symbol === WETH_SYMBOL ? triggerPrice : prices[symbol] ?? 0;
  const usdIn = usdPerUnit(tokenIn.symbol);
  const usdOut = usdPerUnit(tokenOut.symbol);
  if (usdIn <= 0 || usdOut <= 0) {
    throw new Error("Roque could not price that pair just now. Give it a moment and try again.");
  }

  const amountHuman = Number(concreteAmount);
  const expectedOut = (amountHuman * usdIn) / usdOut;
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
    triggerPrice: toTriggerPrice(triggerPrice),
    triggerAbove: interp.triggerAbove,
    expiry: BigInt(Math.floor(Date.now() / 1000) + LIMIT_EXPIRY_SECONDS),
  };
}
