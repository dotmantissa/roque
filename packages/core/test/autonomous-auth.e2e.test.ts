/**
 * End-to-end authorization coverage for the autonomous HTTP handlers. These
 * tests use the real challenge signature verification and session ownership
 * checks, while replacing the chain/GenLayer boundary with small fakes.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { privateKeyToAccount } from "viem/accounts";

const state = vi.hoisted(() => ({
  challenges: new Map<string, {
    owner_address: string;
    message: string;
    expires_at: string;
    consumed_at: string | null;
  }>(),
  sessions: new Map<string, { owner_address: string; expires_at: string }>(),
  interpretCommand: vi.fn(),
  executeAutonomous: vi.fn(),
}));

vi.mock("../src/db/index.js", () => ({
  q: vi.fn(async (text: string, params: unknown[] = []) => {
    if (text.includes("INSERT INTO auth_challenges")) {
      state.challenges.set(String(params[0]), {
        owner_address: String(params[1]),
        message: String(params[3]),
        expires_at: String(params[4]),
        consumed_at: null,
      });
      return [];
    }
    if (text.includes("SELECT owner_address, message, expires_at, consumed_at")) {
      const row = state.challenges.get(String(params[0]));
      return row ? [row] : [];
    }
    if (text.includes("UPDATE auth_challenges")) {
      const row = state.challenges.get(String(params[0]));
      if (!row || row.consumed_at || new Date(row.expires_at).getTime() <= Date.now()) {
        return [];
      }
      row.consumed_at = new Date().toISOString();
      return [{ owner_address: row.owner_address }];
    }
    if (text.includes("INSERT INTO auth_sessions")) {
      state.sessions.set(String(params[0]), {
        owner_address: String(params[1]),
        expires_at: String(params[2]),
      });
      return [];
    }
    if (text.includes("SELECT owner_address FROM auth_sessions")) {
      const row = state.sessions.get(String(params[0]));
      return row && new Date(row.expires_at).getTime() > Date.now() ? [row] : [];
    }
    throw new Error(`Unhandled test query: ${text}`);
  }),
  sql: vi.fn(),
}));

vi.mock("../src/services.js", () => ({
  interpretCommand: state.interpretCommand,
  executeAutonomous: state.executeAutonomous,
}));

const { handleAuthChallenge, handleAuthSession, handleInterpret, handleExecute } =
  await import("../src/api.js");

const owner = privateKeyToAccount(
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
);
const other = privateKeyToAccount(
  "0x8b3a350cf5d2f6f5a4e4a6c9a8e1f7f4c1d3e5a7b9c0d2e4f6a8b0c2d4e6f8a0",
);

async function sessionFor(account: typeof owner) {
  const challenge = await handleAuthChallenge({ owner: account.address });
  const signature = await account.signMessage({ message: challenge.message });
  return handleAuthSession({
    challengeId: challenge.challengeId,
    owner: account.address,
    signature,
  });
}

beforeEach(() => {
  state.challenges.clear();
  state.sessions.clear();
  state.interpretCommand.mockReset();
  state.executeAutonomous.mockReset();
  state.interpretCommand.mockResolvedValue({
    id: "intent-owner",
    interpretation: {
      ok: true,
      kind: "swap",
      tokenIn: "USDC",
      tokenOut: "rWETH",
      amount: "1",
      amountIsPercent: false,
      triggerPrice: "",
      triggerAbove: false,
      confidence: "high",
      reason: "",
      error: "",
    },
    message: "Ready.",
  });
});

describe("autonomous owner sessions", () => {
  it("prevents another wallet from creating an intent for the vault owner", async () => {
    const victimSession = await sessionFor(owner);
    const attackerSession = await sessionFor(other);

    await expect(
      handleInterpret(
        {
          command: "swap 1 USDC for ETH",
          mode: "autonomous",
          user: owner.address,
        },
        attackerSession.token,
      ),
    ).rejects.toMatchObject({ status: 403 });

    expect(state.interpretCommand).not.toHaveBeenCalled();

    await handleInterpret(
      {
        command: "swap 1 USDC for ETH",
        mode: "autonomous",
        user: owner.address,
      },
      victimSession.token,
    );
    expect(state.interpretCommand).toHaveBeenCalledWith({
      user: owner.address.toLowerCase(),
      mode: "autonomous",
      command: "swap 1 USDC for ETH",
    });
  });

  it("prevents another wallet from executing an intent for the vault owner", async () => {
    const victimSession = await sessionFor(owner);
    const attackerSession = await sessionFor(other);

    await expect(
      handleExecute(
        { id: "intent-owner", user: owner.address, slippageBps: 100 },
        attackerSession.token,
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect(state.executeAutonomous).not.toHaveBeenCalled();

    state.executeAutonomous.mockResolvedValue({ txHash: "0xabc", kind: "swap" });
    await handleExecute(
      { id: "intent-owner", user: owner.address, slippageBps: 100 },
      victimSession.token,
    );
    expect(state.executeAutonomous).toHaveBeenCalledWith({
      id: "intent-owner",
      user: owner.address.toLowerCase(),
      slippageBps: 100,
    });
  });
});
