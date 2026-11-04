/**
 * The rules behind the four judgment features, tested where they are pure.
 *
 * Every expensive part of Roque, a consensus round or a vault swap, sits behind
 * a decision that is just a function of its inputs. Those functions are what
 * this file pins down: which conditions are refused before anyone pays for a
 * screen, when a playbook step is allowed to fire, what a step may contain, and
 * what the agent is permitted to put in someone's inbox. No network, no chain,
 * no database.
 */

import { describe, it, expect } from "vitest";
import { localScreen } from "../src/events.js";
import {
  isTriggerReady,
  dueForCheck,
  normaliseStep,
  describeStep,
  PLAYBOOK_PRICE_INTERVAL_MS,
  PLAYBOOK_EVENT_INTERVAL_MS,
  type PlaybookStep,
} from "../src/playbooks.js";
import { buildProposals, type UserSnapshot, type ProposalCandidate } from "../src/proposals.js";
import { vaultFundingNeeds, type FundingLeg } from "../src/funding.js";
import type { OpenOrder } from "../src/orders.js";

// ─────────────────────────────────────────────────────────────
// localScreen: refuse the unfetchable before paying for a screen
// ─────────────────────────────────────────────────────────────

describe("localScreen", () => {
  it("lets a condition a reporter could settle through to the real screen", () => {
    // Null is the interesting answer here: it means "do not decide locally",
    // which is what hands the question to GenLayer.
    expect(localScreen("the Federal Reserve cuts its benchmark interest rate")).toBeNull();
    expect(localScreen("Bitcoin closes above one hundred thousand dollars")).toBeNull();
  });

  it("refuses a condition too short to describe an event", () => {
    expect(localScreen("ETH up")).toEqual({
      reason: "the condition is too short to describe a checkable event",
    });
  });

  it("refuses a condition with no words in it", () => {
    expect(localScreen("1234567890123456")).toEqual({
      reason: "the condition does not describe an event in words",
    });
  });

  it("refuses a condition that turns on how the author feels", () => {
    expect(localScreen("I feel good about the market next week")).toEqual({
      reason: "it turns on how you feel, which no validator can observe",
    });
    expect(localScreen("we decide to take the position off")).toEqual({
      reason: "it turns on how you feel, which no validator can observe",
    });
  });

  it("refuses a condition about the author's private life", () => {
    expect(localScreen("my landlord raises the rent on the flat")).toEqual({
      reason: "it turns on a private matter in your own life, not a public fact",
    });
  });

  it("refuses a condition that asks about something deliberately not public", () => {
    expect(localScreen("the board secretly approves the merger this quarter")).toEqual({
      reason: "it asks about something explicitly not public",
    });
  });

  it("refuses a prediction dressed up as an event", () => {
    expect(localScreen("ETH will probably reach a new all time high")).toEqual({
      reason: "it asks for a prediction rather than an event anyone can confirm",
    });
  });

  it("ignores surrounding whitespace when measuring length", () => {
    expect(localScreen("          ETH up           ")).toEqual({
      reason: "the condition is too short to describe a checkable event",
    });
  });
});

// ─────────────────────────────────────────────────────────────
// isTriggerReady: the gate in front of every playbook fill
// ─────────────────────────────────────────────────────────────

const NOW = Date.UTC(2026, 0, 2, 12, 0, 0);

describe("isTriggerReady", () => {
  const base = { now: NOW, ethUsd: 3_000, armedAt: null };

  it("fires an immediate trigger unconditionally", () => {
    expect(isTriggerReady({ kind: "immediate" }, base)).toBe(true);
  });

  it("treats a price trigger as inclusive of the level itself", () => {
    const above = { kind: "price", direction: "above", usd: 3_000 } as const;
    expect(isTriggerReady(above, { ...base, ethUsd: 3_000 })).toBe(true);
    expect(isTriggerReady(above, { ...base, ethUsd: 2_999.99 })).toBe(false);

    const below = { kind: "price", direction: "below", usd: 3_000 } as const;
    expect(isTriggerReady(below, { ...base, ethUsd: 3_000 })).toBe(true);
    expect(isTriggerReady(below, { ...base, ethUsd: 3_000.01 })).toBe(false);
  });

  it("holds a delay trigger until the step has actually been armed", () => {
    const delay = { kind: "delay", minutes: 10 } as const;
    // No armedAt means nothing has started the clock, so the delay has not run.
    expect(isTriggerReady(delay, { ...base, armedAt: null })).toBe(false);
    expect(isTriggerReady(delay, { ...base, armedAt: NOW - 9 * 60_000 })).toBe(false);
    expect(isTriggerReady(delay, { ...base, armedAt: NOW - 10 * 60_000 })).toBe(true);
  });

  it("requires a real verdict of met for an event trigger", () => {
    const event = { kind: "event", condition: "a central bank cuts rates" } as const;
    // Undefined is the no-adjudication-yet case and must not read as ready.
    expect(isTriggerReady(event, { ...base, verdictMet: undefined })).toBe(false);
    expect(isTriggerReady(event, { ...base, verdictMet: false })).toBe(false);
    expect(isTriggerReady(event, { ...base, verdictMet: true })).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────
// dueForCheck: how often a step is allowed to cost something
// ─────────────────────────────────────────────────────────────

function step(trigger: unknown, lastCheckedAt: string | null): PlaybookStep {
  const s = normaliseStep(
    { trigger, action: { tokenIn: "rUSDC", tokenOut: "rWETH", amount: "10" } },
    0,
  );
  return { ...s, lastCheckedAt };
}

describe("dueForCheck", () => {
  it("always checks a step that has never been checked", () => {
    expect(dueForCheck(step({ kind: "immediate" }, null), NOW)).toBe(true);
  });

  it("re-checks a price step on the fast interval", () => {
    const trigger = { kind: "price", direction: "above", usd: 3_000 };
    const justNow = new Date(NOW - PLAYBOOK_PRICE_INTERVAL_MS + 1).toISOString();
    const due = new Date(NOW - PLAYBOOK_PRICE_INTERVAL_MS).toISOString();
    expect(dueForCheck(step(trigger, justNow), NOW)).toBe(false);
    expect(dueForCheck(step(trigger, due), NOW)).toBe(true);
  });

  it("rations an event step to the slow interval, because each check costs a consensus round", () => {
    const trigger = { kind: "event", condition: "a central bank cuts its policy rate" };
    const fastGapAgo = new Date(NOW - PLAYBOOK_PRICE_INTERVAL_MS * 2).toISOString();
    const due = new Date(NOW - PLAYBOOK_EVENT_INTERVAL_MS).toISOString();
    // Long past the price interval, still not due: the expensive one waits.
    expect(dueForCheck(step(trigger, fastGapAgo), NOW)).toBe(false);
    expect(dueForCheck(step(trigger, due), NOW)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────
// normaliseStep: nothing trusted, because steps arrive from links
// ─────────────────────────────────────────────────────────────

describe("normaliseStep", () => {
  const action = { tokenIn: "rUSDC", tokenOut: "rWETH", amount: "10" };

  it("builds a clean waiting step from a valid one", () => {
    const s = normaliseStep({ trigger: { kind: "immediate" }, action }, 0);
    expect(s.status).toBe("waiting");
    expect(s.action).toEqual({
      tokenIn: "rUSDC",
      tokenOut: "rWETH",
      amount: "10",
      amountIsPercent: false,
    });
    expect(s.checks).toBe(0);
    expect(s.armedAt).toBeNull();
    expect(s.lastCheckedAt).toBeNull();
    expect(s.verdict).toBeNull();
    expect(s.txHash).toBeNull();
    expect(s.id).toMatch(/^[0-9a-f-]{36}$/u);
    expect(s.label).toBe("Right away, swap 10 rUSDC for rWETH");
  });

  it("refuses a token Roque does not trade", () => {
    // Roque's tokens are r-prefixed; bare WETH is not one of them.
    expect(() =>
      normaliseStep({ trigger: { kind: "immediate" }, action: { ...action, tokenIn: "WETH" } }, 0),
    ).toThrow("step 1 names a token I do not trade.");
  });

  it("refuses a swap of a token for itself", () => {
    expect(() =>
      normaliseStep({ trigger: { kind: "immediate" }, action: { ...action, tokenOut: "rUSDC" } }, 0),
    ).toThrow("step 1 trades a token for itself.");
  });

  it("refuses an amount that is not a positive number", () => {
    for (const amount of ["0", "-5", "", "lots", "1.2.3"]) {
      expect(() =>
        normaliseStep({ trigger: { kind: "immediate" }, action: { ...action, amount } }, 0),
      ).toThrow("step 1 needs a positive amount.");
    }
  });

  it("refuses more than the whole balance", () => {
    expect(() =>
      normaliseStep(
        { trigger: { kind: "immediate" }, action: { ...action, amount: "150", amountIsPercent: true } },
        0,
      ),
    ).toThrow("step 1 asks for more than 100 percent of the balance.");
  });

  it("refuses a trigger it does not recognise", () => {
    expect(() => normaliseStep({ trigger: { kind: "vibes" }, action }, 0)).toThrow(
      "step 1 has no trigger I recognise.",
    );
    expect(() => normaliseStep({ action }, 0)).toThrow("step 1 has no trigger I recognise.");
  });

  it("names the step the caller is looking at, one-indexed", () => {
    expect(() => normaliseStep({ trigger: { kind: "immediate" } }, 2)).toThrow(/^step 3 /u);
  });

  it("validates each trigger's own fields", () => {
    expect(() => normaliseStep({ trigger: { kind: "price", usd: 0 }, action }, 0)).toThrow(
      "step 1 needs a price above zero.",
    );
    expect(() => normaliseStep({ trigger: { kind: "delay", minutes: 0 }, action }, 0)).toThrow(
      "step 1 needs a positive delay.",
    );
    expect(() => normaliseStep({ trigger: { kind: "event", condition: "soon" }, action }, 0)).toThrow(
      "step 1 needs a condition to wait on.",
    );
    expect(() =>
      normaliseStep({ trigger: { kind: "event", condition: "x".repeat(501) }, action }, 0),
    ).toThrow("step 1 has a condition over 500 characters.");
  });

  it("defaults a price direction to above and caps a delay at ninety days", () => {
    const up = normaliseStep({ trigger: { kind: "price", usd: 3_000 }, action }, 0);
    expect(up.trigger).toEqual({ kind: "price", direction: "above", usd: 3_000 });
    const long = normaliseStep({ trigger: { kind: "delay", minutes: 999_999 }, action }, 0);
    expect(long.trigger).toEqual({ kind: "delay", minutes: 60 * 24 * 90 });
  });
});

describe("describeStep", () => {
  const action = { tokenIn: "rUSDC", tokenOut: "rWETH", amount: "10", amountIsPercent: false };

  it("reads as a sentence for each kind of trigger", () => {
    expect(describeStep({ kind: "immediate" }, action)).toBe("Right away, swap 10 rUSDC for rWETH");
    expect(describeStep({ kind: "price", direction: "above", usd: 3_000 }, action)).toBe(
      "If ETH goes above $3,000, swap 10 rUSDC for rWETH",
    );
    expect(describeStep({ kind: "delay", minutes: 30 }, action)).toBe(
      "After 30 minutes, swap 10 rUSDC for rWETH",
    );
    expect(describeStep({ kind: "event", condition: "the ECB cuts rates" }, action)).toBe(
      "If the ECB cuts rates, swap 10 rUSDC for rWETH",
    );
  });

  it("says percent out loud when the size is relative", () => {
    expect(describeStep({ kind: "immediate" }, { ...action, amount: "25", amountIsPercent: true })).toBe(
      "Right away, swap 25% of rUSDC for rWETH",
    );
  });
});

// ─────────────────────────────────────────────────────────────
// vaultFundingNeeds: what the vault has to be holding before we sign
// ─────────────────────────────────────────────────────────────

describe("vaultFundingNeeds", () => {
  const leg = (over: Partial<FundingLeg> = {}): FundingLeg => ({
    tokenIn: "rUSDC",
    tokenOut: "rWETH",
    amount: "100",
    amountIsPercent: false,
    where: "This order",
    ...over,
  });

  it("asks for the trade's own size, in the token's own decimals", () => {
    expect(vaultFundingNeeds([leg()])).toEqual([
      { symbol: "rUSDC", raw: 100_000_000n, needsSome: false, where: ["This order"] },
    ]);
  });

  it("sums two rungs that both spend straight from the vault", () => {
    // Two 100 rUSDC steps need 200 sitting there. Checking each against the
    // balance on its own would wave through a plan that cannot finish.
    const needs = vaultFundingNeeds([
      leg({ where: "Step 1" }),
      leg({ where: "Step 2" }),
    ]);
    expect(needs).toHaveLength(1);
    expect(needs[0].raw).toBe(200_000_000n);
    expect(needs[0].where).toEqual(["Step 1", "Step 2"]);
  });

  it("does not charge a ladder for money an earlier rung creates", () => {
    // The canonical dip ladder: buy rWETH with rUSDC, then sell that rWETH. You
    // are meant to be able to write this while holding no rWETH at all, so only
    // the rUSDC is the vault's problem.
    const needs = vaultFundingNeeds([
      leg({ where: "Step 1" }),
      leg({ tokenIn: "rWETH", tokenOut: "rUSDC", amount: "100", amountIsPercent: true, where: "Step 2" }),
    ]);
    expect(needs.map((n) => n.symbol)).toEqual(["rUSDC"]);
    expect(needs[0].raw).toBe(100_000_000n);
  });

  it("keeps separate tokens separate", () => {
    const needs = vaultFundingNeeds([
      leg({ where: "Step 1" }),
      leg({ tokenIn: "rDAI", tokenOut: "rWBTC", amount: "50", where: "Step 2" }),
    ]);
    expect(needs.map((n) => [n.symbol, n.raw])).toEqual([
      ["rUSDC", 100_000_000n],
      ["rDAI", 50_000_000_000_000_000_000n],
    ]);
  });

  it("only asks a percentage leg for a balance that is not zero", () => {
    // 25% of the vault cannot be sized now, since the keeper decides it at fire time
    // against whatever is there. What can be said now is that 25% of nothing is
    // nothing, so an empty vault is still a refusal.
    expect(vaultFundingNeeds([leg({ amount: "25", amountIsPercent: true })])).toEqual([
      { symbol: "rUSDC", raw: 0n, needsSome: true, where: ["This order"] },
    ]);
  });

  it("carries an absolute rung and a percentage rung on the same token", () => {
    const needs = vaultFundingNeeds([
      leg({ where: "Step 1" }),
      leg({ amount: "25", amountIsPercent: true, where: "Step 2" }),
    ]);
    expect(needs).toEqual([
      { symbol: "rUSDC", raw: 100_000_000n, needsSome: true, where: ["Step 1", "Step 2"] },
    ]);
  });

  it("refuses to reason about a token Roque does not trade", () => {
    expect(() => vaultFundingNeeds([leg({ tokenIn: "USDC" })])).toThrow("Unknown token USDC.");
  });

  it("has nothing to say about an empty plan", () => {
    expect(vaultFundingNeeds([])).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────
// buildProposals: what the agent is allowed to say first
// ─────────────────────────────────────────────────────────────

function snap(over: Partial<UserSnapshot> = {}): UserSnapshot {
  return {
    user: "0x1111111111111111111111111111111111111111",
    now: NOW,
    vault: [],
    capability: null,
    openOrders: [],
    eventOrders: [],
    activePlaybooks: 0,
    ethUsd: 3_000,
    ethUsdYesterday: 3_000,
    ...over,
  };
}

function order(over: Partial<OpenOrder> = {}): OpenOrder {
  return {
    id: "7",
    mode: null,
    tokenIn: "0x1111111111111111111111111111111111111111",
    tokenOut: "0x2222222222222222222222222222222222222222",
    tokenInSymbol: "rUSDC",
    tokenOutSymbol: "rWETH",
    amountIn: "100",
    minAmountOut: "0.03",
    triggerPrice: "5000",
    triggerAbove: true,
    expiry: 0,
    expired: false,
    ...over,
  };
}

const kinds = (out: ProposalCandidate[]) => out.map((c) => c.kind);
const find = (out: ProposalCandidate[], kind: string) => out.find((c) => c.kind === kind);

describe("buildProposals", () => {
  it("says nothing when there is nothing to say", () => {
    // An inbox that always has something in it is an inbox nobody opens.
    expect(buildProposals(snap())).toEqual([]);
  });

  describe("capability expiry", () => {
    it("warns once the grant is inside the warning window", () => {
      const validUntilMs = NOW + 2 * 60 * 60 * 1000;
      const out = buildProposals(snap({ capability: { validUntilMs, revoked: false } }));
      const c = find(out, "capability-expiring");
      expect(c).toBeDefined();
      expect(c!.detail).toContain("about 2 hours");
      expect(c!.dedupeKey).toBe(`cap-expiry:${validUntilMs}`);
      expect(c!.action).toEqual({ type: "open", href: "/autonomous", label: "Renew the capability" });
    });

    it("stays quiet on a grant with days left, one already revoked, or one already lapsed", () => {
      const far = snap({ capability: { validUntilMs: NOW + 5 * 24 * 60 * 60 * 1000, revoked: false } });
      const revoked = snap({ capability: { validUntilMs: NOW + 60_000, revoked: true } });
      const lapsed = snap({ capability: { validUntilMs: NOW - 60_000, revoked: false } });
      for (const s of [far, revoked, lapsed]) {
        expect(kinds(buildProposals(s))).not.toContain("capability-expiring");
      }
    });
  });

  describe("a refused condition", () => {
    it("quotes the reason back and offers a rewrite", () => {
      const out = buildProposals(
        snap({
          eventOrders: [
            {
              id: "ev-1",
              status: "rejected",
              condition: "my landlord raises the rent",
              screenReason: "it turns on a private matter in your own life, not a public fact",
              tokenIn: "rUSDC",
              tokenOut: "rWETH",
              amount: "100",
            },
          ],
        }),
      );
      const c = find(out, "rejected-condition");
      expect(c).toBeDefined();
      expect(c!.detail).toContain("my landlord raises the rent");
      expect(c!.detail).toContain("a private matter in your own life");
      expect(c!.dedupeKey).toBe("rejected:ev-1");
    });

    it("ignores an order that is armed rather than refused", () => {
      const out = buildProposals(
        snap({
          eventOrders: [
            {
              id: "ev-2",
              status: "armed",
              condition: "the ECB cuts rates",
              screenReason: null,
              tokenIn: "rUSDC",
              tokenOut: "rWETH",
              amount: "100",
            },
          ],
        }),
      );
      expect(kinds(out)).not.toContain("rejected-condition");
    });
  });

  describe("a resting trigger the market is nowhere near", () => {
    it("flags an order far on the unreachable side", () => {
      const out = buildProposals(snap({ openOrders: [order({ triggerPrice: "5000" })] }));
      const c = find(out, "far-trigger");
      expect(c).toBeDefined();
      // 5000 against 3000 spot is 67% away, bucketed to 70 so the key is stable
      // while the distance drifts.
      expect(c!.title).toContain("67%");
      expect(c!.dedupeKey).toBe("far-order:7:70");
    });

    it("says nothing about an order close to filling", () => {
      const out = buildProposals(snap({ openOrders: [order({ triggerPrice: "3200" })] }));
      expect(kinds(out)).not.toContain("far-trigger");
    });

    it("says nothing about an order the market has already passed", () => {
      // Waiting for ETH above $1,000 with spot at $3,000 is not a far trigger,
      // it is a trigger that should already have filled.
      const out = buildProposals(snap({ openOrders: [order({ triggerPrice: "1000" })] }));
      expect(kinds(out)).not.toContain("far-trigger");
    });

    it("ignores an order with no usable trigger price", () => {
      const out = buildProposals(snap({ openOrders: [order({ triggerPrice: "0" })] }));
      expect(kinds(out)).not.toContain("far-trigger");
    });
  });

  describe("the market moved", () => {
    const stable = { symbol: "rUSDC", amount: 1_000, usd: 1_000 };
    const eth = { symbol: "rWETH", amount: 0.4, usd: 1_200 };

    it("proposes a two-step ladder after a fall, priced off spot", () => {
      const out = buildProposals(
        snap({ ethUsd: 2_700, ethUsdYesterday: 3_000, vault: [stable], activePlaybooks: 1 }),
      );
      const c = find(out, "drawdown-ladder");
      expect(c).toBeDefined();
      expect(c!.title).toBe("ETH is down 10.0% since yesterday");
      expect(c!.action).toMatchObject({ type: "playbook" });
      const action = c!.action as { type: "playbook"; steps: Array<Record<string, unknown>> };
      expect(action.steps).toHaveLength(2);
      expect(action.steps[0]!.trigger).toEqual({ kind: "immediate" });
      // The second rung sits 5% under today's price, not under yesterday's.
      expect(action.steps[1]!.trigger).toEqual({ kind: "price", direction: "below", usd: 2_565 });
      expect(c!.dedupeKey).toBe("drawdown:2026-01-02:-10");
    });

    it("proposes a trim after a rally, exiting at half the move given back", () => {
      const out = buildProposals(
        snap({ ethUsd: 3_300, ethUsdYesterday: 3_000, vault: [eth], activePlaybooks: 1 }),
      );
      const c = find(out, "rally-trim");
      expect(c).toBeDefined();
      expect(c!.title).toBe("ETH is up 10.0% since yesterday");
      const action = c!.action as { type: "playbook"; steps: Array<Record<string, unknown>> };
      expect(action.steps).toHaveLength(1);
      expect(action.steps[0]!.trigger).toEqual({ kind: "price", direction: "below", usd: 3_150 });
      expect(c!.dedupeKey).toBe("rally:2026-01-02:10");
    });

    it("keeps quiet on a move too small to be worth a plan", () => {
      const out = buildProposals(
        snap({ ethUsd: 2_940, ethUsdYesterday: 3_000, vault: [stable], activePlaybooks: 1 }),
      );
      expect(kinds(out)).not.toContain("drawdown-ladder");
    });

    it("does not propose a trade the vault cannot fund", () => {
      // A ladder needs stablecoins to ladder with, and a trim needs ETH to trim.
      const noStable = buildProposals(
        snap({ ethUsd: 2_700, ethUsdYesterday: 3_000, vault: [eth], activePlaybooks: 1 }),
      );
      expect(kinds(noStable)).not.toContain("drawdown-ladder");
      const noEth = buildProposals(
        snap({ ethUsd: 3_300, ethUsdYesterday: 3_000, vault: [stable], activePlaybooks: 1 }),
      );
      expect(kinds(noEth)).not.toContain("rally-trim");
    });

    it("keeps quiet when there is no reading from yesterday to compare against", () => {
      const out = buildProposals(
        snap({ ethUsd: 2_700, ethUsdYesterday: null, vault: [stable], activePlaybooks: 1 }),
      );
      expect(kinds(out)).not.toContain("drawdown-ladder");
    });
  });

  describe("an idle vault", () => {
    it("offers a first rule for the largest idle holding", () => {
      const out = buildProposals(snap({ vault: [{ symbol: "rUSDC", amount: 500, usd: 500 }] }));
      const c = find(out, "idle-vault");
      expect(c).toBeDefined();
      expect(c!.title).toContain("$500 of rUSDC");
      expect(c!.action).toMatchObject({ type: "event_order", tokenIn: "rUSDC", tokenOut: "rWETH" });
      expect(c!.dedupeKey).toBe("idle:rUSDC:500");
    });

    it("picks the biggest holding and pairs a non-stablecoin back into rUSDC", () => {
      const out = buildProposals(
        snap({
          vault: [
            { symbol: "rUSDC", amount: 100, usd: 100 },
            { symbol: "rWBTC", amount: 0.05, usd: 4_000 },
          ],
        }),
      );
      expect(find(out, "idle-vault")!.action).toMatchObject({
        type: "event_order",
        tokenIn: "rWBTC",
        tokenOut: "rUSDC",
      });
    });

    it("stays quiet when something is already watching the money", () => {
      const vault = [{ symbol: "rUSDC", amount: 500, usd: 500 }];
      expect(kinds(buildProposals(snap({ vault, activePlaybooks: 1 })))).not.toContain("idle-vault");
      expect(kinds(buildProposals(snap({ vault, openOrders: [order()] })))).not.toContain("idle-vault");
    });

    it("stays quiet about dust", () => {
      const out = buildProposals(snap({ vault: [{ symbol: "rUSDC", amount: 5, usd: 5 }] }));
      expect(kinds(out)).not.toContain("idle-vault");
    });
  });

  it("keeps a dedupe key stable while the underlying number drifts", () => {
    // This is the whole anti-spam mechanism: the same advice must keep the same
    // identity as the balance moves, or the inbox fills with near-duplicates.
    const key = (usd: number) =>
      find(buildProposals(snap({ vault: [{ symbol: "rUSDC", amount: usd, usd }] })), "idle-vault")!
        .dedupeKey;
    expect(key(500)).toBe(key(512));
    expect(key(500)).not.toBe(key(660));
  });
});
