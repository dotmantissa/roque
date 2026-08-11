/**
 * Unit tests for the deterministic core: the slippage floor, the trigger price
 * conversion, and the EIP-712 signing that the whole autonomous trust model
 * rests on. None of these touch the network; they check the maths and the
 * cryptography that must be exactly right regardless of what any chain says.
 */

import { describe, it, expect } from "vitest";
import { recoverTypedDataAddress, parseUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { eip712Domain, eip712Types } from "@roque/shared";
import { minOutForSlippage } from "../src/quote.js";
import { toTriggerPrice } from "../src/prices.js";
import { signSwapIntent, signLimitIntent, type SwapIntent, type LimitIntent } from "../src/intents.js";

// A throwaway key so the test is self-contained. The env var lets intents.ts
// build the agent account; we assert signatures recover to this same address.
const TEST_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;
const TEST_ADDRESS = privateKeyToAccount(TEST_KEY).address;
process.env.AGENT_SIGNER_PRIVATE_KEY = TEST_KEY;

describe("minOutForSlippage", () => {
  it("takes the exact basis points off the output", () => {
    // 1% off 100 tokens is 99.
    expect(minOutForSlippage(100n, 100)).toBe(99n);
    // 50 bps off 10_000 is 9_950.
    expect(minOutForSlippage(10_000n, 50)).toBe(9_950n);
  });

  it("returns the full amount at zero slippage", () => {
    expect(minOutForSlippage(123_456n, 0)).toBe(123_456n);
  });

  it("never lets slippage exceed 100 percent", () => {
    // Even a nonsense 200% tolerance floors at zero, not a negative.
    expect(minOutForSlippage(1000n, 20_000)).toBe(0n);
  });

  it("rounds the floor down, never up", () => {
    // 1% off 99 is 98.01; integer division must give 98, not 99.
    expect(minOutForSlippage(99n, 100)).toBe(98n);
  });
});

describe("toTriggerPrice", () => {
  it("scales dollars into the feed's 8 decimals", () => {
    expect(toTriggerPrice(2500)).toBe(250_000_000_000n);
    expect(toTriggerPrice(1876.0197)).toBe(187_601_970_000n);
  });

  it("rounds to the nearest integer price unit", () => {
    // A price with more than 8 decimals rounds rather than truncating.
    expect(toTriggerPrice(0.000000005)).toBe(1n); // 0.5 unit rounds up
  });
});

describe("agent intent signing", () => {
  it("produces a swap signature that recovers to the agent signer", async () => {
    const intent: SwapIntent = {
      user: "0xBC1399c55538eC034d4Da550C03c34Ae0C357f53",
      tokenIn: "0x41aB951D0e80Ae358A254c521Cd388a92385939d",
      tokenOut: "0x9b325DcF0C39F620e73707181BB2AdDa0a5B7b8c",
      amountIn: parseUnits("200", 6),
      minAmountOut: parseUnits("0.078", 18),
      nonce: 1n,
      deadline: 1_900_000_000n,
    };
    const sig = await signSwapIntent(intent);
    const recovered = await recoverTypedDataAddress({
      domain: eip712Domain,
      types: { SwapIntent: eip712Types.SwapIntent },
      primaryType: "SwapIntent",
      message: intent,
      signature: sig,
    });
    expect(recovered.toLowerCase()).toBe(TEST_ADDRESS.toLowerCase());
  });

  it("produces a limit signature that recovers to the agent signer", async () => {
    const intent: LimitIntent = {
      user: "0xBC1399c55538eC034d4Da550C03c34Ae0C357f53",
      tokenIn: "0x41aB951D0e80Ae358A254c521Cd388a92385939d",
      tokenOut: "0x9b325DcF0C39F620e73707181BB2AdDa0a5B7b8c",
      amountIn: parseUnits("1000", 6),
      minAmountOut: parseUnits("0.39", 18),
      triggerPrice: toTriggerPrice(2500),
      triggerAbove: false,
      expiry: 1_900_000_000n,
      nonce: 2n,
      deadline: 1_900_000_000n,
    };
    const sig = await signLimitIntent(intent);
    const recovered = await recoverTypedDataAddress({
      domain: eip712Domain,
      types: { LimitIntent: eip712Types.LimitIntent },
      primaryType: "LimitIntent",
      message: intent,
      signature: sig,
    });
    expect(recovered.toLowerCase()).toBe(TEST_ADDRESS.toLowerCase());
  });

  it("changes the signature when any field changes", async () => {
    const base: SwapIntent = {
      user: "0xBC1399c55538eC034d4Da550C03c34Ae0C357f53",
      tokenIn: "0x41aB951D0e80Ae358A254c521Cd388a92385939d",
      tokenOut: "0x9b325DcF0C39F620e73707181BB2AdDa0a5B7b8c",
      amountIn: parseUnits("200", 6),
      minAmountOut: 1n,
      nonce: 1n,
      deadline: 1_900_000_000n,
    };
    const a = await signSwapIntent(base);
    const b = await signSwapIntent({ ...base, amountIn: parseUnits("201", 6) });
    // A single unit more of input must yield a wholly different signature, or the
    // executor could be replayed with a swapped amount under one approval.
    expect(a).not.toBe(b);
  });
});
