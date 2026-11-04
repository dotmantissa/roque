/**
 * Vault reservations: money already promised, and what that forbids.
 *
 * The property under test is the one the ledger exists for, and it is easiest to
 * state as the bug it replaces. A vault holding 100 rUSDC used to let a person
 * write two event orders that each spent 100, because each order checked the
 * balance on its own and the balance had not moved yet. One of those two orders
 * was always going to fail, days later, on money the other one took.
 *
 * So most of these assert an absence: no second order, no second claim, no hold
 * left standing on something that can no longer trade. The releases matter as
 * much as the holds, since a claim that outlives its order is money locked up for
 * nothing, which is the same bug pointing the other way.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { reservationStore } from "./helpers/reservations.js";

const state = vi.hoisted(() => ({
  q: vi.fn(),
  vaultBalance: vi.fn(),
  lockedBalance: vi.fn(),
  vaultSnapshot: vi.fn(),
  freshNonce: vi.fn(),
  lockCommitments: vi.fn(),
  releaseCommitments: vi.fn(),
  getCommitment: vi.fn(),
}));

vi.mock("../src/db/index.js", () => ({ q: state.q }));
vi.mock("../src/intents.js", () => ({
  vaultBalance: state.vaultBalance,
  lockedBalance: state.lockedBalance,
  vaultSnapshot: state.vaultSnapshot,
  freshNonce: state.freshNonce,
  lockCommitments: state.lockCommitments,
  releaseCommitments: state.releaseCommitments,
  getCommitment: state.getCommitment,
}));

const { reserve, recoverReservation, release, heldByToken, availability, assertWithdrawable } = await import(
  "../src/reservations.js"
);
const { assertVaultFunds, vaultFundingNeeds } = await import("../src/funding.js");

const user = "0x1111111111111111111111111111111111111111" as const;
const other = "0x2222222222222222222222222222222222222222" as const;

/** rUSDC carries six decimals, so a whole token is a million base units. */
const USDC = (n: number) => BigInt(n) * 1_000_000n;

let held: ReturnType<typeof reservationStore>;

beforeEach(() => {
  vi.clearAllMocks();
  held = reservationStore();
  held.install(state);
  // Resolving a percentage share reads the balance, so every suite needs one.
  state.vaultBalance.mockResolvedValue(USDC(1000));
  state.q.mockImplementation(async (text: string, params: unknown[] = []) => {
    const handled = held.handle(text, params);
    if (handled !== null) return handled;
    throw new Error(`Unhandled test query: ${text.replace(/\s+/gu, " ").trim()}`);
  });
});

describe("reserve", () => {
  it("holds the exact amount in the token's own base units", async () => {
    await reserve([
      { user, token: "rUSDC", amount: "250.5", source: "event_order", sourceId: "eo-1" },
    ]);
    const map = await heldByToken(user);
    expect(map.get("rUSDC")?.raw).toBe(250_500_000n);
    expect(map.get("rUSDC")?.claims).toBe(1);
  });

  it("adds a second claim to the first rather than replacing it", async () => {
    await reserve([
      { user, token: "rUSDC", amount: "100", source: "event_order", sourceId: "eo-1" },
    ]);
    await reserve([
      { user, token: "rUSDC", amount: "40", source: "event_order", sourceId: "eo-2" },
    ]);
    const map = await heldByToken(user);
    expect(map.get("rUSDC")?.raw).toBe(USDC(140));
    expect(map.get("rUSDC")?.claims).toBe(2);
  });

  it("is idempotent per rung, so arming twice claims the money once", async () => {
    const leg = {
      user,
      token: "rUSDC",
      amount: "100",
      source: "playbook" as const,
      sourceId: "pb-1",
      stepIndex: 0,
    };
    await reserve([leg]);
    await reserve([leg]);
    const map = await heldByToken(user);
    expect(map.get("rUSDC")?.raw).toBe(USDC(100));
    expect(held.held()).toHaveLength(1);
  });

  it("treats the rungs of one ladder as separate claims", async () => {
    await reserve([
      { user, token: "rUSDC", amount: "100", source: "playbook", sourceId: "pb-1", stepIndex: 0 },
      { user, token: "rUSDC", amount: "60", source: "playbook", sourceId: "pb-1", stepIndex: 1 },
    ]);
    expect((await heldByToken(user)).get("rUSDC")?.raw).toBe(USDC(160));
  });

  it("resolves a percentage against the balance and holds that figure", async () => {
    // Holding nothing for a share was useless in the case people reach for
    // first: "spend all of my rUSDC" showed the whole balance as free right up
    // until the order tried to fill.
    state.vaultBalance.mockResolvedValue(USDC(1000));
    await reserve([
      {
        user,
        token: "rUSDC",
        amount: "40",
        amountIsPercent: true,
        source: "event_order",
        sourceId: "eo-1",
      },
    ]);
    const hold = (await heldByToken(user)).get("rUSDC");
    expect(hold?.raw).toBe(USDC(400));
    // The share is kept alongside the figure, so the UI can say where the
    // number came from rather than presenting it as something typed.
    expect(hold?.percents).toEqual([40]);
  });

  it("holds the whole free balance for an order that spends all of it", async () => {
    state.vaultBalance.mockResolvedValue(USDC(1000));
    await reserve([
      {
        user,
        token: "rUSDC",
        amount: "100",
        amountIsPercent: true,
        source: "event_order",
        sourceId: "eo-1",
      },
    ]);
    expect((await heldByToken(user)).get("rUSDC")?.raw).toBe(USDC(1000));
  });

  it("resolves a second share against what the first one left", async () => {
    // Two "half of my rUSDC" orders promise half and then a quarter, not half
    // of the same money twice.
    state.vaultBalance.mockResolvedValue(USDC(1000));
    await reserve([
      { user, token: "rUSDC", amount: "50", amountIsPercent: true, source: "event_order", sourceId: "eo-1" },
    ]);
    await reserve([
      { user, token: "rUSDC", amount: "50", amountIsPercent: true, source: "event_order", sourceId: "eo-2" },
    ]);
    const hold = (await heldByToken(user)).get("rUSDC");
    expect(hold?.raw).toBe(USDC(750));
  });

  it("keeps one person's claims out of another's", async () => {
    await reserve([
      { user, token: "rUSDC", amount: "100", source: "event_order", sourceId: "eo-1" },
    ]);
    expect((await heldByToken(other)).size).toBe(0);
  });
});

describe("release", () => {
  it("stops a claim counting once its order is called off", async () => {
    await reserve([
      { user, token: "rUSDC", amount: "100", source: "event_order", sourceId: "eo-1" },
    ]);
    await release("event_order", "eo-1");
    expect((await heldByToken(user)).size).toBe(0);
  });

  it("frees one rung without freeing the rest of the ladder", async () => {
    await reserve([
      { user, token: "rUSDC", amount: "100", source: "playbook", sourceId: "pb-1", stepIndex: 0 },
      { user, token: "rUSDC", amount: "60", source: "playbook", sourceId: "pb-1", stepIndex: 1 },
    ]);
    await release("playbook", "pb-1", "spent", 0);
    expect((await heldByToken(user)).get("rUSDC")?.raw).toBe(USDC(60));
  });

  it("frees every rung when the whole plan stops", async () => {
    await reserve([
      { user, token: "rUSDC", amount: "100", source: "playbook", sourceId: "pb-1", stepIndex: 0 },
      { user, token: "rUSDC", amount: "60", source: "playbook", sourceId: "pb-1", stepIndex: 1 },
    ]);
    await release("playbook", "pb-1");
    expect((await heldByToken(user)).size).toBe(0);
  });

  it("leaves another source's claim alone", async () => {
    await reserve([
      { user, token: "rUSDC", amount: "100", source: "event_order", sourceId: "eo-1" },
      { user, token: "rUSDC", amount: "25", source: "event_order", sourceId: "eo-2" },
    ]);
    await release("event_order", "eo-1");
    expect((await heldByToken(user)).get("rUSDC")?.raw).toBe(USDC(25));
  });

  it("records a kept promise as spent and a broken one as released", async () => {
    // Both stop counting against the balance. The distinction is kept because
    // "this money was traded" and "this order was cancelled" are different
    // facts, and only one of them is worth asking questions about later.
    await reserve([
      { user, token: "rUSDC", amount: "10", source: "event_order", sourceId: "filled" },
      { user, token: "rUSDC", amount: "10", source: "event_order", sourceId: "gone" },
    ]);
    await release("event_order", "filled", "spent");
    await release("event_order", "gone", "released");
    expect(held.rows.map((r) => r.status).sort()).toEqual(["released", "spent"]);
    expect((await heldByToken(user)).size).toBe(0);
  });
});

describe("availability", () => {
  it("subtracts what is held from what the chain reports", async () => {
    state.vaultBalance.mockResolvedValue(USDC(1000));
    await reserve([
      { user, token: "rUSDC", amount: "400", source: "event_order", sourceId: "eo-1" },
    ]);
    const state_ = await availability(user, "rUSDC");
    expect(state_.balance).toBe(USDC(1000));
    expect(state_.held).toBe(USDC(400));
    expect(state_.available).toBe(USDC(600));
  });

  it("cannot be asked to hold money the vault does not have", async () => {
    // This used to be a test that `available` floors at zero, because a claim
    // could stand against a balance that had already been withdrawn behind the
    // ledger's back. The executor owns the hold now and will not take one it
    // cannot cover, so the state that needed flooring is unreachable: the
    // promise is refused instead of recorded and quietly ignored later.
    state.vaultBalance.mockResolvedValue(USDC(10));
    await expect(
      reserve([{ user, token: "rUSDC", amount: "400", source: "event_order", sourceId: "eo-1" }]),
    ).rejects.toThrow(/CommittedVault/u);
    expect(held.held()).toHaveLength(0);
    expect((await availability(user, "rUSDC")).available).toBe(USDC(10));
  });

  it("reports the whole balance as free when nothing is promised", async () => {
    state.vaultBalance.mockResolvedValue(USDC(500));
    const s = await availability(user, "rUSDC");
    expect(s.available).toBe(USDC(500));
    expect(s.claims).toBe(0);
  });
});

describe("assertWithdrawable", () => {
  beforeEach(() => {
    state.vaultBalance.mockResolvedValue(USDC(1000));
  });

  it("allows a withdrawal that stays inside the free part", async () => {
    await reserve([
      { user, token: "rUSDC", amount: "400", source: "event_order", sourceId: "eo-1" },
    ]);
    await expect(assertWithdrawable(user, "rUSDC", USDC(600))).resolves.toBeUndefined();
  });

  it("refuses one that dips into committed money, and says what is free", async () => {
    await reserve([
      { user, token: "rUSDC", amount: "400", source: "event_order", sourceId: "eo-1" },
    ]);
    await expect(assertWithdrawable(user, "rUSDC", USDC(601))).rejects.toThrow(
      "400 rUSDC is committed to 1 live order, so 600 of your 1000 is free to withdraw.",
    );
  });

  it("lets the whole balance go once the order is cancelled", async () => {
    await reserve([
      { user, token: "rUSDC", amount: "400", source: "event_order", sourceId: "eo-1" },
    ]);
    await release("event_order", "eo-1");
    await expect(assertWithdrawable(user, "rUSDC", USDC(1000))).resolves.toBeUndefined();
  });
});

describe("assertVaultFunds against held money", () => {
  const leg = (amount: string) => ({
    tokenIn: "rUSDC",
    tokenOut: "rWETH",
    amount,
    where: "This order",
  });

  it("refuses a second order that would spend the first one's money", async () => {
    // The whole point. 100 in the vault, 100 already promised, so the next
    // order gets nothing -- even though the balance has not moved yet.
    state.vaultBalance.mockResolvedValue(USDC(100));
    await reserve([
      { user, token: "rUSDC", amount: "100", source: "event_order", sourceId: "eo-1" },
    ]);
    await expect(assertVaultFunds(user, [leg("100")])).rejects.toThrow(
      "This order needs 100 rUSDC and your vault has 0 free.",
    );
  });

  it("names the committed money and how to get it back", async () => {
    state.vaultBalance.mockResolvedValue(USDC(100));
    await reserve([
      { user, token: "rUSDC", amount: "80", source: "event_order", sourceId: "eo-1" },
    ]);
    await expect(assertVaultFunds(user, [leg("50")])).rejects.toThrow(
      "80 rUSDC is already committed to orders that have not fired yet; cancel one to free it.",
    );
  });

  it("allows a second order that fits in what is left", async () => {
    state.vaultBalance.mockResolvedValue(USDC(100));
    await reserve([
      { user, token: "rUSDC", amount: "60", source: "event_order", sourceId: "eo-1" },
    ]);
    await expect(assertVaultFunds(user, [leg("40")])).resolves.toBeUndefined();
  });

  it("allows the order again once the holder is cancelled", async () => {
    state.vaultBalance.mockResolvedValue(USDC(100));
    await reserve([
      { user, token: "rUSDC", amount: "100", source: "event_order", sourceId: "eo-1" },
    ]);
    await release("event_order", "eo-1");
    await expect(assertVaultFunds(user, [leg("100")])).resolves.toBeUndefined();
  });

  it("refuses a percentage order when every token is spoken for", async () => {
    state.vaultBalance.mockResolvedValue(USDC(100));
    await reserve([
      { user, token: "rUSDC", amount: "100", source: "event_order", sourceId: "eo-1" },
    ]);
    await expect(
      assertVaultFunds(user, [{ ...leg("50"), amountIsPercent: true }]),
    ).rejects.toThrow("spends a share of your rUSDC, and your vault has none free");
  });

  it("ignores a hold on a token this order never touches", async () => {
    state.vaultBalance.mockResolvedValue(USDC(100));
    await reserve([
      { user, token: "rWBTC", amount: "1", source: "event_order", sourceId: "eo-1" },
    ]);
    await expect(assertVaultFunds(user, [leg("100")])).resolves.toBeUndefined();
  });
});

describe("the hold is the chain's, not the table's", () => {
  it("reports what the executor is locking, not what the rows add up to", async () => {
    // The row is the explanation; the lock is the number. A row left behind by
    // a release that already happened on-chain must not re-create a hold.
    state.vaultBalance.mockResolvedValue(USDC(1000));
    await reserve([
      { user, token: "rUSDC", amount: "400", source: "event_order", sourceId: "eo-1" },
    ]);
    held.hold({ user_address: user, token: "rUSDC", amount_raw: String(USDC(900)) });
    expect((await heldByToken(user)).get("rUSDC")?.raw).toBe(USDC(400));
  });

  it("writes no row when the chain refuses the hold", async () => {
    state.vaultBalance.mockResolvedValue(USDC(100));
    await expect(
      reserve([
        { user, token: "rUSDC", amount: "60", source: "event_order", sourceId: "eo-1" },
        { user, token: "rUSDC", amount: "60", source: "event_order", sourceId: "eo-2" },
      ]),
    ).rejects.toThrow();
    // All or nothing, so the first leg is not left holding on its own either.
    expect(held.held()).toHaveLength(0);
    expect(held.lockedOf(user, "rUSDC")).toBe(0n);
  });

  it("asks the chain to let go before marking a claim released", async () => {
    state.vaultBalance.mockResolvedValue(USDC(1000));
    await reserve([
      { user, token: "rUSDC", amount: "400", source: "event_order", sourceId: "eo-1" },
    ]);
    expect(held.lockedOf(user, "rUSDC")).toBe(USDC(400));
    await release("event_order", "eo-1");
    expect(state.releaseCommitments).toHaveBeenCalled();
    expect(held.lockedOf(user, "rUSDC")).toBe(0n);
  });

  it("asks the chain for nothing when the trade already consumed the hold", async () => {
    // A spend ends the commitment inside the same swap that moved the tokens,
    // so there is nothing left to release and no transaction to pay for.
    state.vaultBalance.mockResolvedValue(USDC(1000));
    await reserve([
      { user, token: "rUSDC", amount: "400", source: "event_order", sourceId: "eo-1" },
    ]);
    await release("event_order", "eo-1", "spent");
    expect(state.releaseCommitments).not.toHaveBeenCalled();
  });

  it("gives every rung of one plan a hold the chain can tell apart", async () => {
    state.vaultBalance.mockResolvedValue(USDC(1000));
    await reserve([
      { user, token: "rUSDC", amount: "100", source: "playbook", sourceId: "pb-1", stepIndex: 0 },
      { user, token: "rUSDC", amount: "60", source: "playbook", sourceId: "pb-1", stepIndex: 1 },
    ]);
    expect(held.locks.size).toBe(2);
    await release("playbook", "pb-1", "spent", 0);
    expect(held.lockedOf(user, "rUSDC")).toBe(USDC(60));
  });

  it("refuses to promise a share of a token with nothing free", async () => {
    state.vaultBalance.mockResolvedValue(USDC(100));
    await reserve([
      { user, token: "rUSDC", amount: "100", source: "event_order", sourceId: "eo-1" },
    ]);
    await expect(
      reserve([
        {
          user,
          token: "rUSDC",
          amount: "50",
          amountIsPercent: true,
          source: "event_order",
          sourceId: "eo-2",
        },
      ]),
    ).rejects.toThrow("no rUSDC free in your vault");
  });
});

describe("letting go without the table's help", () => {
  it("frees a hold whose row never got written", async () => {
    // The gap this closes: the lock lands on-chain and the write recording it
    // does not. The row is the explanation, so losing it should cost a
    // sentence in the UI, never the money itself.
    state.vaultBalance.mockResolvedValue(USDC(1000));
    await reserve([
      { user, token: "rUSDC", amount: "400", source: "event_order", sourceId: "eo-1" },
    ]);
    held.rows.length = 0; // the row is gone; the lock is not
    expect(held.lockedOf(user, "rUSDC")).toBe(USDC(400));

    await release("event_order", "eo-1");
    expect(held.lockedOf(user, "rUSDC")).toBe(0n);
  });

  it("frees every rung of a plan whose rows are gone", async () => {
    state.vaultBalance.mockResolvedValue(USDC(1000));
    await reserve([
      { user, token: "rUSDC", amount: "100", source: "playbook", sourceId: "pb-1", stepIndex: 0 },
      { user, token: "rUSDC", amount: "60", source: "playbook", sourceId: "pb-1", stepIndex: 2 },
    ]);
    held.rows.length = 0;

    await release("playbook", "pb-1");
    expect(held.lockedOf(user, "rUSDC")).toBe(0n);
  });

  it("asks for nothing when the source never held anything", async () => {
    await release("event_order", "never-armed");
    expect(state.releaseCommitments).toHaveBeenCalledTimes(1);
    // Every candidate id reads as inactive, so no transaction is sent.
    await expect(state.releaseCommitments.mock.results[0].value).resolves.toBeNull();
  });
});

describe("what the vault is actually on the hook for", () => {
  // The pure half of the funding gate, asserted directly. It used to be
  // inferred from how many balance reads the gate made, which stopped meaning
  // anything once those reads were batched into one multicall.
  it("requires upfront funds for an absolute downstream spend", () => {
    const needs = vaultFundingNeeds([
      { tokenIn: "rUSDC", tokenOut: "rWETH", amount: "100", where: "Step 1" },
      { tokenIn: "rWETH", tokenOut: "rUSDC", amount: "1", where: "Step 2" },
    ]);
    expect(needs.map((n) => n.symbol)).toEqual(["rUSDC", "rWETH"]);
    expect(needs[0]!.raw).toBe(USDC(100));
  });

  it("adds up two legs that each draw on the vault", () => {
    const needs = vaultFundingNeeds([
      { tokenIn: "rUSDC", tokenOut: "rWETH", amount: "100", where: "Step 1" },
      { tokenIn: "rUSDC", tokenOut: "rWBTC", amount: "60", where: "Step 2" },
    ]);
    expect(needs).toHaveLength(1);
    expect(needs[0]!.raw).toBe(USDC(160));
    expect(needs[0]!.where).toEqual(["Step 1", "Step 2"]);
  });

  it("asks only for a non-zero balance when a leg spends a share", () => {
    const needs = vaultFundingNeeds([
      { tokenIn: "rUSDC", tokenOut: "rWETH", amount: "50", amountIsPercent: true, where: "This order" },
    ]);
    expect(needs[0]!.raw).toBe(0n);
    expect(needs[0]!.needsSome).toBe(true);
  });
});

it("terminally rejects a definitively reverted arming batch without signing again",async()=>{
 state.q.mockImplementation(async(text:string)=>{
  if(text.startsWith('SELECT id,payload FROM reservation_batches'))return [{id:'batch-reverted',payload:{prepared:[],intents:[]}}];
  if(text.startsWith('SELECT status FROM execution_attempts'))return [{status:'mined_revert'}];
  if(text.startsWith('UPDATE reservation_batches'))return [];
  throw new Error('Unexpected recovery query');
 });
 await expect(recoverReservation('event_order','order')).rejects.toThrow('recorded hold reverted');
 expect(state.lockCommitments).not.toHaveBeenCalled();
});
