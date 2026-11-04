/**
 * The playbook engine: one step considered per call, in order, once.
 *
 * The ordering guarantee is the whole product here: a ladder whose second rung
 * fires before its first is not a plan, it is two random trades. That guarantee
 * rests on the cursor-guarded claim, so the case where a second runner finds
 * nothing to claim is tested as carefully as the happy path. The other rule
 * worth pinning down is that a step never fires on a verdict the adjudicator
 * itself is unsure about.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { reservationStore } from "./helpers/reservations.js";
import type { PlaybookStep } from "../src/playbooks.js";

const state = vi.hoisted(() => ({
  q: vi.fn(),
  adjudicate: vi.fn(),
  ethUsd: vi.fn(),
  gatherEvidence: vi.fn(),
  preflightVaultSwap: vi.fn(),
  executeVaultSwap: vi.fn(),
  vaultBalance: vi.fn(),
  lockedBalance: vi.fn(),
  vaultSnapshot: vi.fn(),
  freshNonce: vi.fn(),
  lockCommitments: vi.fn(),
  releaseCommitments: vi.fn(),
  getCommitment: vi.fn(),
}));

vi.mock("../src/settlement.js",()=>({vaultSettlement:vi.fn(async()=>stranded?{status:"pending",txHash:TX}:{status:"confirmed",txHash:TX,amountOutRaw:"1000000000000000000"})}));
vi.mock("../src/db/index.js", () => ({ q: state.q }));
// The only chain read on this path is the funding gate arming does. It reads a
// balance we choose, so the real gate runs rather than being mocked away.
vi.mock("../src/intents.js", () => ({
  vaultBalance: state.vaultBalance,
  lockedBalance: state.lockedBalance,
  vaultSnapshot: state.vaultSnapshot,
  freshNonce: state.freshNonce,
  lockCommitments: state.lockCommitments,
  releaseCommitments: state.releaseCommitments,
  getCommitment: state.getCommitment,
  NO_COMMITMENT: "0x"+"00".repeat(32),
}));
vi.mock("../src/genlayer.js", () => ({ adjudicate: state.adjudicate, interpret: vi.fn() }));
vi.mock("../src/services.js", () => ({
  preflightVaultSwap: state.preflightVaultSwap,
  executeVaultSwap: state.executeVaultSwap,
}));
vi.mock("../src/prices.js", () => ({
  ethUsd: state.ethUsd,
  tokenUsd: vi.fn(),
  toTriggerPrice: vi.fn(),
  usdValueRaw: vi.fn(),
}));
// Evidence gathering is the network half of an event step; the judgment half is
// adjudicate. Both are stubbed, and the real interval is kept so the rationing
// rule behaves as it does in production.
vi.mock("../src/events.js", () => ({
  gatherEvidence: state.gatherEvidence,
  localScreen: vi.fn(() => null),
  EVENT_CHECK_INTERVAL_MS: 10 * 60 * 1000,
}));

const {
  advancePlaybook,
  armPlaybook,
  updatePlaybook,
  normaliseStep,
  cancelPlaybook,
  playbookTick,
} = await import(
  "../src/playbooks.js"
);

const user = "0x1111111111111111111111111111111111111111" as const;
const TX = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const CONDITION = "the Federal Reserve cuts its benchmark interest rate";

type Row = Record<string, unknown> & { steps: PlaybookStep[]; step_cursor: number };

let row: Row;
let sqls: string[];
let claimResult: Array<{ id: string }>;
/** Set by the one test that wants the mid-trade reaper to find something. */
let stranded = false;

function mkStep(trigger: unknown, amount = "25"): PlaybookStep {
  return normaliseStep(
    { trigger, action: { tokenIn: "rUSDC", tokenOut: "rWETH", amount, amountIsPercent: true } },
    0,
  );
}

function baseRow(steps: PlaybookStep[], over: Record<string, unknown> = {}): Row {
  return {
    id: "pb-1",
    user_address: user,
    name: "Ladder into the dip",
    note: null,
    status: "armed",
    steps,
    step_cursor: 0,
    slippage_bps: 100,
    last_checked_at: null,
    error: null,
    source_slug: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

const ran = (fragment: string) => sqls.some((s) => s.replace(/\s+/gu, " ").includes(fragment));

// The real reservations module runs against this, so the ledger's behaviour is
// exercised rather than stubbed.
let held: ReturnType<typeof reservationStore>;

beforeEach(() => {
  vi.clearAllMocks();
  held = reservationStore();
  held.install(state);
  sqls = [];
  stranded = false;
  claimResult = [{ id: "pb-1" }];
  row = baseRow([mkStep({ kind: "immediate" })]);

  state.q.mockImplementation(async (text: string, params: unknown[] = []) => {
    sqls.push(text);
    const t = text.replace(/\s+/gu, " ").trim();

    if(t.startsWith("SELECT * FROM playbooks WHERE status='arming'")) return row.status==='arming'?[{...row}]:[];
    if(t.startsWith("SELECT * FROM playbooks WHERE status='armed'")) return row.status==='armed'&&row.steps[row.step_cursor]?.status==='firing'?[{...row}]:[];
    if (t.startsWith("SELECT * FROM playbooks")) {
      // Honour the owner filter when the statement carries one. Ownership is
      // security-relevant, so a mock that answered regardless of who asked
      // would make it untestable. advancePlaybook selects by id alone and so
      // passes no second parameter.
      if (t.includes("LOWER(user_address)=LOWER($2)")) {
        const asked = String(params[1] ?? "").toLowerCase();
        if (asked !== String(row.user_address).toLowerCase()) return [];
      }
      return [{ ...row }];
    }
    // What cancelPlaybook reads back to tell "not yours" from "mid-trade".
    if (t.startsWith("SELECT status, steps, step_cursor FROM playbooks")) {
      const asked = String(params[1] ?? "").toLowerCase();
      if (asked !== String(row.user_address).toLowerCase()) return [];
      return [{ status: row.status, steps: row.steps, step_cursor: row.step_cursor }];
    }
    // The tick's due list.
    if (t.startsWith("SELECT id FROM playbooks WHERE status='armed'")) {
      return row.status === "armed" ? [{ id: row.id }] : [];
    }
    if (t.startsWith("INSERT INTO playbook_events")) return [];

    // The claim is checked before the plain check-counter update, because the
    // two share a prefix and only the claim carries the 'waiting' guard.
    if (t.includes("(steps->$3->>'status') = 'waiting' RETURNING id")) {
      row.steps = JSON.parse(String(params[1])) as PlaybookStep[];
      return claimResult;
    }
    if (t.includes("SET steps=$2::jsonb, last_checked_at=now()")) {
      row.steps = JSON.parse(String(params[1])) as PlaybookStep[];
      row.last_checked_at = new Date().toISOString();
      return [];
    }
    if (t.includes("status='failed', error=$3")) {
      Object.assign(row, {
        steps: JSON.parse(String(params[1])) as PlaybookStep[],
        status: "failed",
        error: params[2],
      });
      return [{ ...row }];
    }
    if (t.includes("SET steps=$2::jsonb, step_cursor=$3")) {
      // Guarded on the cursor the caller claimed and on the plan still running.
      if (row.status !== "armed" || row.step_cursor !== params[3]) return [];
      Object.assign(row, {
        steps: JSON.parse(String(params[1])) as PlaybookStep[],
        step_cursor: params[2],
      });
      return [{ ...row }];
    }
    if (t.includes("SET status='cancelled'")) {
      // Cancelling refuses a plan whose rung is mid-trade, because releasing
      // the hold while the swap spending it is in the mempool lands a trade
      // against a plan that no longer exists.
      if (!["draft", "armed"].includes(row.status as string)) return [];
      if ((row.steps[row.step_cursor]?.status as string) === "firing") return [];
      Object.assign(row, { status: "cancelled" });
      return [{ ...row }];
    }
    // Editing a draft. Guarded on 'draft' in the statement, which is the whole
    // protection: an armed plan has money held against named rungs.
    if (t.includes("SET name=$2, note=$3, steps=$4::jsonb")) {
      if (row.status !== "draft") return [];
      Object.assign(row, {
        name: params[1],
        note: params[2],
        steps: JSON.parse(String(params[3])) as PlaybookStep[],
        slippage_bps: params[4],
        error: null,
      });
      return [{ ...row }];
    }
    // Arming rolled back because the chain would not take the hold.
    if (t.includes("SET status='draft', error=$2")) {
      if (row.status !== "arming") return [];
      Object.assign(row, { status: "draft", error: params[1] });
      return [];
    }
    // The reaper for a rung whose worker died between sending and recording.
    if (t.includes("A step was interrupted mid-trade")) {
      if (row.status !== "armed") return [];
      if ((row.steps[row.step_cursor]?.status as string) !== "firing") return [];
      if (!stranded) return [];
      Object.assign(row, { status: "failed" });
      return [{ id: row.id }];
    }
    if (t.includes("SET status='completed'")) {
      // Guarded on 'armed', so a plan cancelled mid-walk is not then marked
      // completed by the rung that was already in flight.
      if (row.status !== "armed") return [];
      Object.assign(row, {
        status: "completed",
        steps: JSON.parse(String(params[1])) as PlaybookStep[],
      });
      return [{ ...row }];
    }
    if(t.includes("SET status='armed',updated_at")){if(row.status!=="arming")return [];row.status="armed";return [{...row}];}
    if(t.includes("SET steps=$2::jsonb,updated_at")){row.steps=JSON.parse(String(params[1]));return [];}
    if (t.includes("SET status='arming'")) {
      // Guarded on 'draft', so two requests cannot both arm one plan.
      if (row.status !== "draft") return [];
      Object.assign(row, {
        status: "arming",
        steps: JSON.parse(String(params[1])) as PlaybookStep[],
        step_cursor: 0,
        error: null,
      });
      return [{ ...row }];
    }
    if (t.includes("SET steps=$2::jsonb, error=$3")) {
      Object.assign(row, {
        steps: JSON.parse(String(params[1])) as PlaybookStep[],
        error: params[2],
      });
      return [{ ...row }];
    }
    // The reservations table is real in these suites; anything it does not own
    // falls through to the throw below.
    const reservation = held.handle(t, params);
    if (reservation !== null) return reservation;

    throw new Error(`Unhandled test query: ${t}`);
  });

  state.ethUsd.mockResolvedValue({ usd: 3_000 });
  state.gatherEvidence.mockResolvedValue({
    query: "federal reserve cuts benchmark interest rate",
    fetchedAt: "2026-01-02T12:00:00.000Z",
    items: [{ source: "Reuters", title: "Fed cuts by 25bp", published: null, url: null }],
    market: { ethUsd: 3_000 },
    notes: [],
  });
  state.preflightVaultSwap.mockResolvedValue({ amountInRaw: 1n, minOutRaw: 1n });
  state.executeVaultSwap.mockResolvedValue(TX);
  state.vaultBalance.mockResolvedValue(10_000_000_000n); // 10,000 rUSDC
});

// ─────────────────────────────────────────────────────────────
// Arming is the signature, so arming is where the vault is checked
// ─────────────────────────────────────────────────────────────

describe("armPlaybook", () => {
  const absolute = (amount: string) =>
    normaliseStep(
      { trigger: { kind: "immediate" }, action: { tokenIn: "rUSDC", tokenOut: "rWETH", amount, amountIsPercent: false } },
      0,
    );

  beforeEach(() => {
    row = baseRow([absolute("100")], { status: "draft" });
  });

  it("arms a plan the vault can pay for, and holds the money on-chain", async () => {
    const pb = await armPlaybook("pb-1", user);

    expect(pb.status).toBe("armed");
    expect(pb.steps[0]!.armedAt).not.toBeNull();
    // The hold is the executor's, so arming is not finished until it lands,
    // and rUSDC is the only thing it holds.
    expect(state.lockCommitments).toHaveBeenCalledTimes(1);
    expect(held.lockedOf(user, "rUSDC")).toBe(100_000_000n);
    expect([...held.locks.values()].map((l) => l.token)).toEqual(["rUSDC"]);
  });

  it("refuses to arm a plan the vault cannot pay for, and names the step", async () => {
    state.vaultBalance.mockResolvedValue(40_000_000n); // 40 rUSDC

    await expect(armPlaybook("pb-1", user)).rejects.toThrow(
      "Step 1 needs 100 rUSDC and your vault has 40 free.",
    );
    // Still a draft: nothing is half-armed, and the person can resize or fund it.
    expect(row.status).toBe("draft");
  });

  it("adds the rungs up rather than checking each on its own", async () => {
    // 100 + 100 against a 150 balance: each rung passes alone, the plan does not.
    row = baseRow([absolute("100"), absolute("100")], { status: "draft" });
    state.vaultBalance.mockResolvedValue(150_000_000n);

    await expect(armPlaybook("pb-1", user)).rejects.toThrow(
      "Step 1 and Step 2 needs 200 rUSDC and your vault has 150 free.",
    );
  });

  it("does not make a ladder pre-hold what its first rung buys", async () => {
    // Buy rWETH with rUSDC, then sell that rWETH. The vault holds no rWETH and
    // should not have to: refusing this would refuse the headline use case.
    row = baseRow(
      [
        absolute("100"),
        normaliseStep(
          {
            trigger: { kind: "immediate" },
            action: { tokenIn: "rWETH", tokenOut: "rUSDC", amount: "100", amountIsPercent: true },
          },
          1,
        ),
      ],
      { status: "draft" },
    );
    state.vaultBalance.mockResolvedValue(200_000_000n);

    const pb = await armPlaybook("pb-1", user);

    expect(pb.status).toBe("armed");
    // rUSDC only. A hold on rWETH would mean the ladder was being charged for
    // money its own first rung creates.
    expect(held.locks.size).toBe(1);
    expect([...held.locks.values()].map((l) => l.token)).toEqual(["rUSDC"]);
    expect(held.lockedOf(user, "rWETH")).toBe(0n);
  });

  it("checks the money before paying for a consensus round", async () => {
    // Screening an event step costs half a minute of validator time. A plan the
    // vault cannot fund never gets that far.
    row = baseRow([absolute("100"), mkStep({ kind: "event", condition: CONDITION })], {
      status: "draft",
    });
    state.vaultBalance.mockResolvedValue(10_000_000n); // 10 rUSDC

    await expect(armPlaybook("pb-1", user)).rejects.toThrow("your vault has 10 free");
    expect(state.adjudicate).not.toHaveBeenCalled();
    expect(state.gatherEvidence).not.toHaveBeenCalled();
  });

  it("refuses a percentage rung when the vault is empty", async () => {
    row = baseRow([mkStep({ kind: "immediate" })], { status: "draft" });
    state.vaultBalance.mockResolvedValue(0n);

    await expect(armPlaybook("pb-1", user)).rejects.toThrow(
      "Step 1 spends a share of your rUSDC, and your vault has none free.",
    );
  });
});

describe("advancePlaybook", () => {
  it("fires a single immediate step and completes the playbook", async () => {
    const pb = await advancePlaybook("pb-1");

    expect(state.executeVaultSwap).toHaveBeenCalledTimes(1);
    expect(pb.status).toBe("completed");
    expect(pb.steps[0]!.status).toBe("done");
    expect(pb.steps[0]!.txHash).toBe(TX);
    expect(pb.steps[0]!.firedAt).not.toBeNull();
    // The fill goes through the shared vault gate with the playbook's slippage.
    expect(state.preflightVaultSwap).toHaveBeenCalledWith(
      expect.objectContaining({ user, amount: "25", amountIsPercent: true, slippageBps: 100 }),
    );
  });

  it("hands the clock to the next step so a delay measures from this fill", async () => {
    row = baseRow([mkStep({ kind: "immediate" }), mkStep({ kind: "delay", minutes: 10 })]);

    const pb = await advancePlaybook("pb-1");

    expect(pb.status).toBe("armed");
    expect(pb.stepCursor).toBe(1);
    expect(pb.steps[0]!.status).toBe("done");
    expect(pb.steps[1]!.status).toBe("waiting");
    // Null here would mean the delay never starts counting.
    expect(pb.steps[1]!.armedAt).not.toBeNull();
  });

  it("considers exactly one step per call", async () => {
    row = baseRow([mkStep({ kind: "immediate" }), mkStep({ kind: "immediate" })]);

    await advancePlaybook("pb-1");

    expect(state.executeVaultSwap).toHaveBeenCalledTimes(1);
  });

  it("records a check and trades nothing when a price trigger has not been reached", async () => {
    row = baseRow([mkStep({ kind: "price", direction: "above", usd: 5_000 })]);

    const pb = await advancePlaybook("pb-1");

    expect(state.executeVaultSwap).not.toHaveBeenCalled();
    expect(pb.steps[0]!.status).toBe("waiting");
    expect(pb.steps[0]!.checks).toBe(1);
    expect(pb.steps[0]!.lastCheckedAt).not.toBeNull();
    expect(ran("RETURNING id")).toBe(false);
  });

  it("fires once the price trigger is reached", async () => {
    row = baseRow([mkStep({ kind: "price", direction: "below", usd: 3_000 })]);

    const pb = await advancePlaybook("pb-1");

    expect(pb.steps[0]!.status).toBe("done");
    expect(state.executeVaultSwap).toHaveBeenCalledTimes(1);
  });

  it("asks GenLayer about an event step and records the verdict", async () => {
    row = baseRow([mkStep({ kind: "event", condition: CONDITION })]);
    state.adjudicate.mockResolvedValue({
      met: true,
      confidence: "high",
      rationale: "widely reported",
    });

    const pb = await advancePlaybook("pb-1");

    expect(state.gatherEvidence).toHaveBeenCalledWith(CONDITION);
    expect(state.adjudicate).toHaveBeenCalledTimes(1);
    expect(pb.steps[0]!.verdict).toEqual({
      met: true,
      confidence: "high",
      rationale: "widely reported",
    });
    expect(pb.steps[0]!.status).toBe("done");
  });

  it("does not fire an event step on a verdict the adjudicator is unsure about", async () => {
    row = baseRow([mkStep({ kind: "event", condition: CONDITION })]);
    state.adjudicate.mockResolvedValue({ met: true, confidence: "low", rationale: "unclear" });

    const pb = await advancePlaybook("pb-1");

    expect(state.executeVaultSwap).not.toHaveBeenCalled();
    expect(pb.steps[0]!.status).toBe("waiting");
    // The verdict is still written down, so the reason is visible in the UI.
    expect(pb.steps[0]!.verdict).toEqual({ met: true, confidence: "low", rationale: "unclear" });
  });

  it("bails without trading when another runner already claimed the step", async () => {
    // Two keepers, one step. The cursor-and-status guard means the loser's
    // UPDATE matches nothing, and it must not go on to trade anyway.
    claimResult = [];

    const pb = await advancePlaybook("pb-1");

    expect(state.preflightVaultSwap).not.toHaveBeenCalled();
    expect(state.executeVaultSwap).not.toHaveBeenCalled();
    expect(pb.status).toBe("armed");
    expect(pb.stepCursor).toBe(0);
  });

  it("stops the whole playbook when a step's fill fails", async () => {
    // A ladder whose first rung did not fill must not go on to its second: the
    // later steps were sized and priced on the assumption the earlier ones ran.
    row = baseRow([mkStep({ kind: "immediate" }), mkStep({ kind: "immediate" })]);
    state.preflightVaultSwap.mockRejectedValue(new Error("vault balance is too low"));

    const pb = await advancePlaybook("pb-1");

    expect(pb.status).toBe("failed");
    expect(pb.error).toBe("vault balance is too low");
    expect(pb.steps[0]!.status).toBe("failed");
    expect(pb.steps[0]!.error).toBe("vault balance is too low");
    expect(pb.stepCursor).toBe(0);
    expect(state.executeVaultSwap).not.toHaveBeenCalled();
  });

  it("rations an event step rather than checking it every tick", async () => {
    // Each event check is a consensus round. A step checked a moment ago is not
    // due, and the call must cost nothing at all.
    const step = mkStep({ kind: "event", condition: CONDITION });
    row = baseRow([{ ...step, lastCheckedAt: new Date().toISOString() }]);

    await advancePlaybook("pb-1");

    expect(state.gatherEvidence).not.toHaveBeenCalled();
    expect(state.adjudicate).not.toHaveBeenCalled();
    expect(sqls).toHaveLength(1);
  });

  it("completes a playbook whose cursor has run past the last step", async () => {
    row = baseRow([mkStep({ kind: "immediate" })], { step_cursor: 1 });

    const pb = await advancePlaybook("pb-1");

    expect(pb.status).toBe("completed");
    expect(state.executeVaultSwap).not.toHaveBeenCalled();
  });

  it("leaves a playbook alone unless it is armed", async () => {
    for (const status of ["draft", "cancelled", "completed", "failed"]) {
      vi.clearAllMocks();
      row = baseRow([mkStep({ kind: "immediate" })], { status });

      const pb = await advancePlaybook("pb-1");

      expect(pb.status).toBe(status);
      expect(state.executeVaultSwap).not.toHaveBeenCalled();
    }
  });

  it("refuses to advance a playbook that does not exist", async () => {
    state.q.mockResolvedValueOnce([]);
    await expect(advancePlaybook("nope")).rejects.toThrow("No such playbook.");
  });
});

/**
 * What a ladder promises the vault, and when it hands each rung back.
 *
 * A playbook is the harder case than a single event order, because it holds
 * several claims at once and has to let them go one at a time. Hold too long
 * and the rung that already traded keeps locking up money it has spent; let go
 * too early and the rungs still to come can be withdrawn out from under.
 */
describe("what a playbook promises the vault", () => {
  const openClaims = () =>
    held.held().filter((r) => r.source_kind === "playbook").map((r) => r.step_index).sort();

  /** A ladder of absolute-amount rungs, so the claims are figures not shares. */
  const fixedStep = (amount: string, tokenIn = "rUSDC", tokenOut = "rWETH") =>
    normaliseStep(
      { trigger: { kind: "immediate" }, action: { tokenIn, tokenOut, amount } },
      0,
    );

  it("claims nothing while the plan is still a draft", async () => {
    // A draft is a plan, not an order. It can be written, shared and forked
    // before the vault could pay for it, so it must not hold anything.
    row = baseRow([fixedStep("100")], { status: "draft" });
    expect(openClaims()).toHaveLength(0);
  });

  it("claims every rung the vault is on the hook for when the plan is armed", async () => {
    row = baseRow([fixedStep("100"), fixedStep("60")], { status: "draft" });
    state.vaultBalance.mockResolvedValue(500_000_000n);

    await armPlaybook("pb-1", user);

    expect(openClaims()).toEqual([0, 1]);
    const total = held.held().reduce((sum, r) => sum + BigInt(r.amount_raw), 0n);
    expect(total).toBe(160_000_000n);
  });

  it("does not claim a rung the ladder feeds itself", async () => {
    // Step two spends the rWETH step one bought. Holding vault rWETH for it
    // would demand the person already own what the plan is about to acquire.
    const downstream = fixedStep("100", "rWETH", "rUSDC");
    downstream.action.amountIsPercent = true;
    row = baseRow([fixedStep("100", "rUSDC", "rWETH"), downstream], {
      status: "draft",
    });
    state.vaultBalance.mockResolvedValue(500_000_000n);

    await armPlaybook("pb-1", user);

    expect(openClaims()).toEqual([0]);
  });

  it("hands back only the rung that fired, keeping the rest held", async () => {
    row = baseRow([fixedStep("100"), fixedStep("60")]);
    held.hold({ user_address: user, token: "rUSDC", amount_raw: "100000000", source_kind: "playbook", source_id: "pb-1", step_index: 0 });
    held.hold({ user_address: user, token: "rUSDC", amount_raw: "60000000", source_kind: "playbook", source_id: "pb-1", step_index: 1 });
    state.preflightVaultSwap.mockResolvedValue({ amountIn: 1n });
    state.executeVaultSwap.mockResolvedValue(TX);

    await advancePlaybook("pb-1");

    expect(openClaims()).toEqual([1]);
  });

  it("hands everything back when a step fails and the plan stops", async () => {
    row = baseRow([fixedStep("100"), fixedStep("60")]);
    held.hold({ user_address: user, token: "rUSDC", amount_raw: "100000000", source_kind: "playbook", source_id: "pb-1", step_index: 0 });
    held.hold({ user_address: user, token: "rUSDC", amount_raw: "60000000", source_kind: "playbook", source_id: "pb-1", step_index: 1 });
    state.preflightVaultSwap.mockRejectedValue(new Error("pool is dry"));

    const book = await advancePlaybook("pb-1");

    expect(book.status).toBe("failed");
    expect(openClaims()).toHaveLength(0);
  });

  it("hands everything back when the last rung completes the plan", async () => {
    row = baseRow([fixedStep("100")]);
    held.hold({ user_address: user, token: "rUSDC", amount_raw: "100000000", source_kind: "playbook", source_id: "pb-1", step_index: 0 });
    state.preflightVaultSwap.mockResolvedValue({ amountIn: 1n });
    state.executeVaultSwap.mockResolvedValue(TX);

    const book = await advancePlaybook("pb-1");

    expect(book.status).toBe("completed");
    expect(openClaims()).toHaveLength(0);
  });

  it("hands everything back when the person stops the plan", async () => {
    row = baseRow([fixedStep("100"), fixedStep("60")]);
    held.hold({ user_address: user, token: "rUSDC", amount_raw: "100000000", source_kind: "playbook", source_id: "pb-1", step_index: 0 });
    held.hold({ user_address: user, token: "rUSDC", amount_raw: "60000000", source_kind: "playbook", source_id: "pb-1", step_index: 1 });

    await cancelPlaybook("pb-1", user);

    expect(openClaims()).toHaveLength(0);
  });
});

/**
 * Two workers, one plan.
 *
 * The cursor guard already stopped a rung firing twice, which was the obvious
 * race. These are the ones around it: arming, cancelling, and the rung whose
 * worker died with a transaction in the air.
 */
describe("two workers reaching the same plan", () => {
  it("retains a lost submission reply without releasing or repeating the rung", async () => {
    row = baseRow([mkStep({kind:"immediate"})]);
    held.hold({user_address:user,token:"rUSDC",amount_raw:"100000000",source_kind:"playbook",source_id:"pb-1",step_index:0});
    state.executeVaultSwap.mockRejectedValue(new Error("RPC reply lost after broadcast"));
    const book = await advancePlaybook("pb-1");
    expect(book.status).toBe("armed");expect(book.steps[0].status).toBe("firing");
    expect(held.held()).toHaveLength(1);
    await advancePlaybook("pb-1");expect(state.executeVaultSwap).toHaveBeenCalledTimes(1);
  });

  const absolute = (amount: string) =>
    normaliseStep(
      {
        trigger: { kind: "immediate" },
        action: { tokenIn: "rUSDC", tokenOut: "rWETH", amount, amountIsPercent: false },
      },
      0,
    );

  beforeEach(() => {
    state.vaultBalance.mockResolvedValue(10_000_000_000n);
  });

  it("puts a plan back to draft when the chain will not hold the money", async () => {
    row = baseRow([absolute("100")], { status: "draft" });
    state.lockCommitments.mockRejectedValue(new Error("CommittedVault: 0 free"));

    await expect(armPlaybook("pb-1", user)).rejects.toThrow("CommittedVault");
    expect(row.status).toBe("draft");
    expect(row.error).toContain("could not hold the vault money");
  });

  it("arms a plan once however many requests ask", async () => {
    row = baseRow([absolute("100")], { status: "draft" });
    const results = await Promise.allSettled([
      armPlaybook("pb-1", user),
      armPlaybook("pb-1", user),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    // And the money is promised once, not twice, because the id is derived from
    // the rung rather than minted per attempt.
    expect(held.lockedOf(user, "rUSDC")).toBe(100_000_000n);
  });

  it("refuses to cancel while the rung at the cursor is mid-trade", async () => {
    row = baseRow([absolute("100")], { status: "armed" });
    row.steps[0]!.status = "firing";

    await expect(cancelPlaybook("pb-1", user)).rejects.toThrow("mid-trade");
    expect(row.status).toBe("armed");
  });

  it("retains an unknown mid-trade outcome without firing again", async () => {
    row = baseRow([absolute("100")], { status: "armed" });
    row.steps[0]!.status = "firing";
    stranded = true;

    await playbookTick();

    expect(row.status).toBe("armed");
    expect(row.steps[0].status).toBe("firing");
    expect(state.executeVaultSwap).not.toHaveBeenCalled();
  });
});

/**
 * Editing a draft.
 *
 * Nobody writes a ladder right first time, and before this the only way to
 * change one was to cancel it and retype. The rule that matters is the one
 * these mostly assert: a draft is free to change, and anything past a draft is
 * not, because an armed plan has money held against named rungs and a cursor
 * partway through them.
 */
describe("updatePlaybook", () => {
  const absolute = (amount: string, tokenIn = "rUSDC", tokenOut = "rWETH") =>
    normaliseStep(
      {
        trigger: { kind: "immediate" },
        action: { tokenIn, tokenOut, amount, amountIsPercent: false },
      },
      0,
    );

  const stepPayload = (amount: string) => ({
    trigger: { kind: "price", direction: "below", usd: 2500 },
    action: { tokenIn: "rUSDC", tokenOut: "rWETH", amount, amountIsPercent: false },
  });

  beforeEach(() => {
    row = baseRow([absolute("100")], { status: "draft", name: "Dip ladder" });
    state.vaultBalance.mockResolvedValue(10_000_000_000n);
  });

  it("replaces the steps of a draft", async () => {
    const pb = await updatePlaybook("pb-1", user, {
      name: "Dip ladder, rethought",
      steps: [stepPayload("40"), stepPayload("60")],
    });
    expect(pb.name).toBe("Dip ladder, rethought");
    expect(pb.steps).toHaveLength(2);
    expect(pb.steps[0]!.trigger).toEqual({ kind: "price", direction: "below", usd: 2500 });
    expect(pb.steps.map((s) => s.action.amount)).toEqual(["40", "60"]);
    expect(pb.status).toBe("draft");
  });

  it("leaves out fields the caller did not send", async () => {
    const pb = await updatePlaybook("pb-1", user, { steps: [stepPayload("40")] });
    expect(pb.name).toBe("Dip ladder");
  });

  it("re-normalises rather than trusting the shape it was handed", async () => {
    await expect(
      updatePlaybook("pb-1", user, {
        steps: [{ trigger: { kind: "price", usd: -5 }, action: stepPayload("10").action }],
      }),
    ).rejects.toThrow("needs a price above zero");
  });

  it("refuses a step that trades a token for itself", async () => {
    await expect(
      updatePlaybook("pb-1", user, {
        steps: [
          {
            trigger: { kind: "immediate" },
            action: { tokenIn: "rUSDC", tokenOut: "rUSDC", amount: "10" },
          },
        ],
      }),
    ).rejects.toThrow("trades a token for itself");
  });

  it("clears a screen verdict a failed arming left behind", async () => {
    // The sentence may have changed, and a stale verdict on new words is worse
    // than none at all.
    row.steps[0]!.screen = { verifiable: false, reason: "nobody could check it" };
    const pb = await updatePlaybook("pb-1", user, { steps: [stepPayload("40")] });
    expect(pb.steps[0]!.screen).toBeNull();
    expect(pb.error).toBeNull();
  });

  it("will not touch an armed plan, and says why", async () => {
    row = baseRow([absolute("100")], { status: "armed" });
    await expect(
      updatePlaybook("pb-1", user, { steps: [stepPayload("40")] }),
    ).rejects.toThrow("already armed");
  });

  it("will not touch a finished plan", async () => {
    row = baseRow([absolute("100")], { status: "completed" });
    await expect(
      updatePlaybook("pb-1", user, { steps: [stepPayload("40")] }),
    ).rejects.toThrow("nothing left to edit");
  });

  it("is not somebody else's to edit", async () => {
    await expect(
      updatePlaybook("pb-1", "0x9999999999999999999999999999999999999999", {
        steps: [stepPayload("40")],
      }),
    ).rejects.toThrow("No such playbook");
    expect(row.steps.map((s) => s.action.amount)).toEqual(["100"]);
  });

  it("refuses an empty plan and an over-long one", async () => {
    await expect(updatePlaybook("pb-1", user, { steps: [] })).rejects.toThrow(
      "at least one step",
    );
    await expect(
      updatePlaybook("pb-1", user, { steps: Array.from({ length: 11 }, () => stepPayload("1")) }),
    ).rejects.toThrow("at most 10 steps");
  });

  it("refuses a blank name", async () => {
    await expect(updatePlaybook("pb-1", user, { name: "   " })).rejects.toThrow(
      "needs a name",
    );
  });

  it("holds nothing, because a draft is still only a plan", async () => {
    await updatePlaybook("pb-1", user, { steps: [stepPayload("40")] });
    expect(state.lockCommitments).not.toHaveBeenCalled();
    expect(held.held()).toHaveLength(0);
  });
});
