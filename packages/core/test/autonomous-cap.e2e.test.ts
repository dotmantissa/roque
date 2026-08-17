/**
 * The server-side preflight must use the executor's exact fixed-point value.
 * Otherwise a value just over the cap can round to the same JavaScript number
 * and still reach the contract, losing the clear user-facing refusal.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

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

const user = "0x1111111111111111111111111111111111111111" as const;
const agent = "0x3333333333333333333333333333333333333333" as const;
const cap = 500n * 10n ** 18n;

beforeEach(() => {
  vi.clearAllMocks();
  state.q.mockImplementation(async (text: string) => {
    if (text.includes("SELECT * FROM intents")) {
      return [
        {
          id: "cap-boundary",
          user_address: user,
          mode: "autonomous",
          status: "ready",
          interpretation: {
            ok: true,
            kind: "swap",
            tokenIn: "rUSDC",
            tokenOut: "rWETH",
            amount: "500",
            amountIsPercent: false,
          },
        },
      ];
    }
    if (text.includes("SET status='signed'")) return [{ id: "cap-boundary" }];
    if (text.includes("UPDATE intents SET status=$2")) return [];
    throw new Error(`Unhandled test query: ${text}`);
  });
  state.getCapability.mockResolvedValue({
    agentSigner: agent,
    maxPerTradeUsd: cap,
    maxDailyUsd: 2_000n * 10n ** 18n,
    maxSlippageBps: 100n,
    validUntil: 4_000_000_000n,
    revoked: false,
    exists: true,
  });
  state.agentSignerAddress.mockReturnValue(agent);
  state.vaultBalance.mockResolvedValue(1_000_000_000n);
  state.quoteSwap.mockResolvedValue({ amountOutRaw: 1_000n });
  state.minOutForSlippage.mockReturnValue(990n);
  state.freshNonce.mockResolvedValue(1n);
  state.signSwapIntent.mockResolvedValue("0xsigned");
  state.submitSwap.mockResolvedValue(
    "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  );
});

describe("autonomous per-trade cap preflight", () => {
  it("allows a trade exactly at the cap", async () => {
    state.usdValueRaw.mockResolvedValue(cap);

    await expect(
      executeAutonomous({ id: "cap-boundary", user, slippageBps: 100 }),
    ).resolves.toMatchObject({ kind: "swap" });
    expect(state.signSwapIntent).toHaveBeenCalledTimes(1);
  });

  it("rejects a trade even one fixed-point unit over the cap", async () => {
    state.usdValueRaw.mockResolvedValue(cap + 1n);

    await expect(
      executeAutonomous({ id: "cap-boundary", user, slippageBps: 100 }),
    ).rejects.toThrow(
      "This trade ($500.00) exceeds your per-trade limit of $500.00.",
    );
    expect(state.quoteSwap).not.toHaveBeenCalled();
    expect(state.signSwapIntent).not.toHaveBeenCalled();
  });
});
