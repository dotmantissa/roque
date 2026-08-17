/**
 * The final server-side guard is tested against the real executeAutonomous
 * service: even a caller that reaches it with a valid session owner cannot make
 * the agent sign an intent whose stored owner is different.
 */

import { describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  q: vi.fn(),
  getCapability: vi.fn(),
  signSwapIntent: vi.fn(),
  signLimitIntent: vi.fn(),
  submitSwap: vi.fn(),
  submitLimitOrder: vi.fn(),
  freshNonce: vi.fn(),
  agentSignerAddress: vi.fn(),
  vaultBalance: vi.fn(),
  quoteSwap: vi.fn(),
  minOutForSlippage: vi.fn(),
  usdValueRaw: vi.fn(),
}));

vi.mock("../src/db/index.js", () => ({ q: state.q }));
vi.mock("../src/intents.js", () => ({
  getCapability: state.getCapability,
  signSwapIntent: state.signSwapIntent,
  signLimitIntent: state.signLimitIntent,
  submitSwap: state.submitSwap,
  submitLimitOrder: state.submitLimitOrder,
  freshNonce: state.freshNonce,
  agentSignerAddress: state.agentSignerAddress,
  vaultBalance: state.vaultBalance,
}));
vi.mock("../src/genlayer.js", () => ({ interpret: vi.fn() }));
vi.mock("../src/quote.js", () => ({
  quoteSwap: state.quoteSwap,
  minOutForSlippage: state.minOutForSlippage,
}));
vi.mock("../src/prices.js", () => ({
  ethUsd: vi.fn(),
  tokenUsd: vi.fn(),
  toTriggerPrice: vi.fn(),
  usdValueRaw: state.usdValueRaw,
}));

const { executeAutonomous } = await import("../src/services.js");

const victim = "0x1111111111111111111111111111111111111111" as const;
const other = "0x2222222222222222222222222222222222222222" as const;

describe("stored autonomous intent ownership", () => {
  it("refuses before capability reads or agent signing", async () => {
    state.q.mockResolvedValueOnce([
      {
        user_address: victim,
        mode: "autonomous",
        interpretation: {
          ok: true,
          kind: "swap",
          tokenIn: "USDC",
          tokenOut: "rWETH",
          amount: "1",
          amountIsPercent: false,
        },
      },
    ]);

    await expect(
      executeAutonomous({ id: "victim-intent", user: other, slippageBps: 100 }),
    ).rejects.toThrow("does not belong to this vault owner");
    expect(state.getCapability).not.toHaveBeenCalled();
    expect(state.signSwapIntent).not.toHaveBeenCalled();
    expect(state.signLimitIntent).not.toHaveBeenCalled();
  });

  it("claims a stored intent once so repeated requests cannot sign it again", async () => {
    let status = "ready";
    const record = {
      id: "one-shot",
      user_address: victim,
      mode: "autonomous",
      interpretation: {
        ok: true,
        kind: "swap",
        tokenIn: "rUSDC",
        tokenOut: "rWETH",
        amount: "1",
        amountIsPercent: false,
      },
    };
    state.q.mockImplementation(async (text: string) => {
      if (text.includes("SELECT * FROM intents")) return [{ ...record, status }];
      if (text.includes("SET status='signed'")) {
        if (status !== "ready") return [];
        status = "signed";
        return [{ id: record.id }];
      }
      if (text.includes("UPDATE intents SET status=$2")) {
        status = "submitted";
        return [];
      }
      throw new Error(`Unhandled test query: ${text}`);
    });
    state.getCapability.mockResolvedValue({
      agentSigner: "0x3333333333333333333333333333333333333333",
      maxPerTradeUsd: 500n * 10n ** 18n,
      maxDailyUsd: 2_000n * 10n ** 18n,
      maxSlippageBps: 100n,
      validUntil: 4_000_000_000n,
      revoked: false,
      exists: true,
    });
    state.agentSignerAddress.mockReturnValue(
      "0x3333333333333333333333333333333333333333",
    );
    state.vaultBalance.mockResolvedValue(10_000_000n);
    state.usdValueRaw.mockResolvedValue(1n * 10n ** 18n);
    state.quoteSwap.mockResolvedValue({ amountOutRaw: 1_000n });
    state.minOutForSlippage.mockReturnValue(990n);
    state.freshNonce.mockResolvedValue(1n);
    state.signSwapIntent.mockResolvedValue("0xsigned");
    state.submitSwap.mockResolvedValue(
      "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    );

    await expect(
      executeAutonomous({ id: record.id, user: victim, slippageBps: 100 }),
    ).resolves.toMatchObject({ kind: "swap" });
    await expect(
      executeAutonomous({ id: record.id, user: victim, slippageBps: 100 }),
    ).rejects.toThrow("already been executed or is being processed");

    expect(state.signSwapIntent).toHaveBeenCalledTimes(1);
    expect(state.submitSwap).toHaveBeenCalledTimes(1);
  });
});
