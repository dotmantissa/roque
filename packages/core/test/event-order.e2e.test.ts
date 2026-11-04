/**
 * The event-order engine, end to end with the slow parts stubbed.
 *
 * Two properties matter more than the rest here, and both are about refusing to
 * act. An order whose condition nobody can source must be refused at arm time
 * rather than left resting forever; and a screen that fails because *our* side
 * broke must leave the order alone, because "we could not ask" and "the answer
 * is no" are different facts and only one of them is the order's fault.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { reservationStore } from "./helpers/reservations.js";

const state = vi.hoisted(() => ({
  q: vi.fn(),
  adjudicate: vi.fn(),
  ethUsd: vi.fn(),
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
// Writing an order reads the vault balance. Stubbing the read keeps the real
// funding gate in the loop with a balance the test chooses.
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

const {
  createEventOrder,
  screenEventOrder,
  evaluateEventOrder,
  cancelEventOrder,
  armEventOrder,
  eventTick,
} = await import("../src/events.js");
// Unmocked on purpose: the derived id is the thing the release has to get right,
// so a test that stubbed it would prove nothing.
const { commitmentIdFor } = await import("../src/reservations.js");

const user = "0x1111111111111111111111111111111111111111" as const;
const CHECKABLE = "the Federal Reserve cuts its benchmark interest rate";
const TX = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

// One Google News item, because the screen records which sources it sampled.
const RSS = `<rss><channel>
<item>
  <title>Fed cuts benchmark rate by 25 basis points</title>
  <link>https://example.com/fed</link>
  <pubDate>Fri, 02 Jan 2026 09:00:00 GMT</pubDate>
  <source url="https://reuters.com">Reuters</source>
</item>
</channel></rss>`;

type Row = Record<string, unknown> & { checks: number };

let row: Row;
let sqls: string[];

function baseRow(over: Record<string, unknown> = {}): Row {
  return {
    id: "ev-1",
    user_address: user,
    condition: CHECKABLE,
    token_in: "rUSDC",
    token_out: "rWETH",
    amount: "100",
    amount_is_percent: false,
    slippage_bps: 100,
    status: "screening",
    screen_verdict: null,
    screen_reason: null,
    screen_confidence: null,
    screen_sources: null,
    checks: 0,
    last_checked_at: null,
    verdict_met: null,
    verdict_confidence: null,
    verdict_rationale: null,
    evidence: null,
    expires_at: null,
    tx_hash: null,
    error: null,
    source_slug: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

const ran = (fragment: string) => sqls.some((s) => s.replace(/\s+/gu, " ").includes(fragment));

/** A row that has already passed its screen, which is where a fill starts. */
const armed = (over: Record<string, unknown> = {}) =>
  baseRow({ status: "armed", screen_verdict: "verifiable", ...over });

// The real reservations module runs against this, so the ledger's behaviour is
// exercised rather than stubbed.
let held: ReturnType<typeof reservationStore>;
/** Set by the one test that wants the mid-trade reaper to find something. */
let stranded = false;

beforeEach(() => {
  vi.clearAllMocks();
  held = reservationStore();
  held.install(state);
  row = baseRow();
  sqls = [];
  stranded = false;

  // A tiny in-memory event_orders table: each UPDATE applies the fields it sets
  // to the one row, so assertions can read the persisted state afterwards.
  state.q.mockImplementation(async (text: string, params: unknown[] = []) => {
    sqls.push(text);
    const t = text.replace(/\s+/gu, " ").trim();

    if(t.includes("WHERE status='firing'")) return row.status==='firing'?[{...row}]:[];
    if(t.includes("WHERE status='arming'")) return row.status==='arming'?[{...row}]:[];
    if (t.startsWith("SELECT")) {
      // Honour the owner filter when the statement carries one. The ownership
      // guard is security-relevant, so a mock that answered regardless of who
      // asked would make it untestable.
      if (t.includes("LOWER(user_address)=LOWER($2)")) {
        const asked = String(params[1] ?? "").toLowerCase();
        if (asked !== String(row.user_address).toLowerCase()) return [];
      }
      return [{ ...row }];
    }

    // The two leases, which keep two workers from buying the same consensus
    // round, and the claim, which keeps them from both filling one verdict.
    // Modelled with the real guards rather than waved through, because a mock
    // that always lets the lease succeed cannot show the second worker losing.
    if (t.startsWith("UPDATE event_orders SET last_checked_at=now()")) {
      const screening = t.includes("status='screening'");
      if (row.status !== (screening ? "screening" : "armed")) return [];
      const gapMs = screening ? 120_000 : Number(params[1]);
      const since = row.last_checked_at
        ? Date.now() - new Date(row.last_checked_at).getTime()
        : Infinity;
      const due = screening ? since >= gapMs : row.verdict_met === true || since >= gapMs;
      if (!due) return [];
      Object.assign(row, { last_checked_at: new Date().toISOString() });
      return screening ? [{ id: row.id }] : [{ ...row }];
    }
    if(t.includes("SET status='firing', tx_hash=$2")){Object.assign(row,{tx_hash:params[1]});return [{...row}];}
    if(t.includes("SET status=$2,tx_hash=$3")){Object.assign(row,{status:params[1],tx_hash:params[2],error:params[3]});return [{...row}];}
    if(t.includes("SET status='armed',updated_at")){if(row.status!=="arming")return [];Object.assign(row,{status:"armed"});return [{...row}];}
    if (t.includes("SET status='firing'")) {
      if (row.status !== "armed") return [];
      Object.assign(row, { status: "firing" });
      return [{ id: row.id }];
    }
    if (t.includes("This order was interrupted mid-trade")) {
      if (row.status !== "firing" || !stranded) return [];
      Object.assign(row, { status: "failed" });
      return [{ id: row.id }];
    }

    if (t.startsWith("INSERT INTO event_orders")) {
      return [
        baseRow({
          id: params[0],
          user_address: params[1],
          condition: params[2],
          token_in: params[3],
          token_out: params[4],
          amount: params[5],
          amount_is_percent: params[6],
          slippage_bps: params[7],
        }),
      ];
    }

    if (t.includes("SET status='rejected'")) {
      Object.assign(row, {
        status: "rejected",
        screen_verdict: "unverifiable",
        screen_reason: params[1],
        screen_confidence: params[2],
        screen_sources: params[3] ? JSON.parse(String(params[3])) : null,
      });
      return [{ ...row }];
    }
    if (t.includes("SET status='screened', screen_verdict='verifiable'")) {
      Object.assign(row, {
        status: "screened",
        screen_verdict: "verifiable",
        screen_reason: params[1],
        screen_confidence: params[2],
        screen_sources: JSON.parse(String(params[3])),
        evidence: JSON.parse(String(params[4])),
        error: null,
      });
      return [{ ...row }];
    }
    if (t.includes("SET error=$2")) {
      Object.assign(row, { error: params[1] });
      return [];
    }
    if (t.includes("SET checks=checks+1")) {
      Object.assign(row, {
        checks: row.checks + 1,
        last_checked_at: new Date().toISOString(),
        evidence: JSON.parse(String(params[1])),
        verdict_met: params[2],
        verdict_confidence: params[3],
        verdict_rationale: params[4],
      });
      return [{ ...row }];
    }
    if (t.includes("SET status='expired'")) {
      // Two statements share this shape. The one inside evaluateEventOrder
      // names an id and only takes an armed row; the sweep at the end of a tick
      // takes any armed or screened row past its date. Neither may touch a row
      // that is mid-trade, which is the whole reason 'firing' exists, so the
      // guards are modelled rather than waved through.
      const byId = t.includes("WHERE id=$1");
      const allowed = byId ? ["armed"] : ["armed", "screened"];
      if (!allowed.includes(row.status as string)) return [];
      if (!byId) {
        const due =
          row.expires_at !== null && new Date(String(row.expires_at)).getTime() <= Date.now();
        if (!due) return [];
      }
      Object.assign(row, { status: "expired" });
      return byId ? [{ ...row }] : [{ id: row.id }];
    }
    if (t.includes("SET status='filled'")) {
      if (row.status !== "firing") return [];
      Object.assign(row, { status: "filled", tx_hash: params[1], error: null });
      return [{ ...row }];
    }
    // Arming rolled back because the chain would not take the hold.
    if (t.includes("SET status='screened', error=$2")) {
      if (row.status !== "arming") return [];
      Object.assign(row, { status: "screened", error: params[1] });
      return [];
    }
    if (t.includes("SET status='arming', error=NULL")) {
      Object.assign(row, { status: "arming", error: null });
      return [{ ...row }];
    }
    if (t.includes("SET status='cancelled'")) {
      // Cancelling is scoped to the states a person can still call off. A row
      // whose swap is in the mempool is not one of them.
      if (!["screening", "screened", "armed"].includes(row.status as string)) return [];
      Object.assign(row, { status: "cancelled" });
      return [{ ...row }];
    }
    if (t.includes("SET status=$3, error=$2")) {
      if (row.status !== "firing") return [];
      Object.assign(row, { status: params[2], error: params[1] });
      return [{ ...row }];
    }
    // The reservations table is real in these suites; anything it does not own
    // falls through to the throw below.
    const reservation = held.handle(t, params);
    if (reservation !== null) return reservation;

    throw new Error(`Unhandled test query: ${t}`);
  });

  state.ethUsd.mockResolvedValue({ usd: 3_000 });
  state.vaultBalance.mockResolvedValue(10_000_000_000n); // 10,000 rUSDC
  state.preflightVaultSwap.mockResolvedValue({ amountInRaw: 1n, minOutRaw: 1n });
  state.executeVaultSwap.mockResolvedValue(TX);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, status: 200, text: async () => RSS })),
  );
});

// ─────────────────────────────────────────────────────────────
// Writing the order is what a person signs, so it is where the vault is checked
// ─────────────────────────────────────────────────────────────

describe("createEventOrder", () => {
  const draft = {
    user,
    condition: CHECKABLE,
    tokenIn: "rUSDC",
    tokenOut: "rWETH",
    amount: "100",
    amountIsPercent: false,
    slippageBps: 100,
  };

  it("writes an order the vault can pay for", async () => {
    const order = await createEventOrder(draft);

    expect(order.status).toBe("screening");
    expect(order.amount).toBe("100");
    // The vault was consulted. Not a call count: the gate reads every token in
    // one multicall, so counting calls would be measuring the batch rather than
    // the rule. What is costed is asserted in vault-reservations.test.ts,
    // against vaultFundingNeeds, which is pure.
    expect(state.vaultSnapshot).toHaveBeenCalled();
  });

  it("refuses an order the vault cannot pay for, and says by how much", async () => {
    // The refusal has to arrive now. An order written against money the agent
    // cannot reach would arm, rest for a fortnight, win its verdict and then
    // fail on a balance check nobody was ever shown.
    state.vaultBalance.mockResolvedValue(40_000_000n); // 40 rUSDC

    await expect(createEventOrder(draft)).rejects.toThrow(
      "This order needs 100 rUSDC and your vault has 40 free.",
    );
    expect(ran("INSERT INTO event_orders")).toBe(false);
  });

  it("refuses a percentage order against an empty vault", async () => {
    state.vaultBalance.mockResolvedValue(0n);

    await expect(
      createEventOrder({ ...draft, amount: "25", amountIsPercent: true }),
    ).rejects.toThrow("This order spends a share of your rUSDC, and your vault has none free.");
  });

  it("takes a percentage order against a vault that holds something", async () => {
    state.vaultBalance.mockResolvedValue(1n);

    const order = await createEventOrder({ ...draft, amount: "25", amountIsPercent: true });

    expect(order.amountIsPercent).toBe(true);
  });

  it("will not read the chain for an order it has already refused on its face", async () => {
    await expect(createEventOrder({ ...draft, amount: "0" })).rejects.toThrow(
      "The amount has to be a positive number.",
    );
    await expect(
      createEventOrder({ ...draft, amount: "150", amountIsPercent: true }),
    ).rejects.toThrow("A percentage amount has to be between 0 and 100.");
    expect(state.vaultBalance).not.toHaveBeenCalled();
  });
});

describe("screenEventOrder", () => {
  it("refuses an unverifiable condition without paying for a consensus round", async () => {
    row = baseRow({ condition: "my landlord raises the rent on the flat" });

    const order = await screenEventOrder("ev-1");

    expect(order.status).toBe("rejected");
    expect(order.screenVerdict).toBe("unverifiable");
    expect(order.screenReason).toBe(
      "it turns on a private matter in your own life, not a public fact",
    );
    expect(order.screenConfidence).toBe("high");
    // The whole point of the local pass: no evidence gathered, no round paid for.
    expect(state.adjudicate).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("clears an order the validators agree is checkable, recording what it sampled", async () => {
    state.adjudicate.mockResolvedValue({
      met: true,
      confidence: "high",
      rationale: "central bank rate decisions are published and widely reported",
    });

    const order = await screenEventOrder("ev-1");

    // Cleared, not armed. A passed screen says the condition could be checked;
    // arming is the person deciding to put money behind it.
    expect(order.status).toBe("screened");
    expect(order.screenVerdict).toBe("verifiable");
    expect(order.screenConfidence).toBe("high");
    expect(order.screenSources).toEqual(["Reuters"]);
    expect(order.evidence?.items[0]?.title).toContain("Fed cuts benchmark rate");
    expect(order.error).toBeNull();

    // The screen asks the meta-question, not the condition itself.
    const [requestId, question] = state.adjudicate.mock.calls[0]!;
    expect(requestId).toBe("screen:ev-1");
    expect(question).toContain("VERIFIABILITY CHECK");
    expect(question).toContain(CHECKABLE);
  });

  it("rejects an order the validators cannot source, and says why", async () => {
    state.adjudicate.mockResolvedValue({
      met: false,
      confidence: "high",
      rationale: "no public source reports on this subject",
    });

    const order = await screenEventOrder("ev-1");

    expect(order.status).toBe("rejected");
    expect(order.screenVerdict).toBe("unverifiable");
    expect(order.screenReason).toBe("no public source reports on this subject");
    expect(order.screenSources).toEqual(["Reuters"]);
  });

  it("supplies its own words when the adjudicator offers no rationale", async () => {
    state.adjudicate.mockResolvedValue({ met: false, confidence: "medium", rationale: "" });

    const order = await screenEventOrder("ev-1");

    expect(order.screenReason).toBe("no public source could settle this condition");
  });

  it("leaves the order in screening when the consensus round itself fails", async () => {
    // A GenLayer outage is our problem, not the condition's. Rejecting here
    // would tell the user their perfectly checkable condition is unverifiable.
    state.adjudicate.mockRejectedValue(new Error("receipt poll timed out"));

    const order = await screenEventOrder("ev-1");

    expect(order.status).toBe("screening");
    expect(order.screenVerdict).toBeNull();
    expect(order.error).toBe("screening failed: receipt poll timed out");
    expect(ran("SET status='rejected'")).toBe(false);
  });

  it("does not re-screen an order that has already left screening", async () => {
    row = baseRow({ status: "armed", screen_verdict: "verifiable" });

    const order = await screenEventOrder("ev-1");

    expect(order.status).toBe("armed");
    expect(state.adjudicate).not.toHaveBeenCalled();
  });

  it("refuses to screen an order that does not exist", async () => {
    state.q.mockResolvedValueOnce([]);
    await expect(screenEventOrder("nope")).rejects.toThrow("No such event order.");
  });
});

describe("evaluateEventOrder", () => {

  it("expires an order that ran out its clock, without asking anyone", async () => {
    row = armed({ expires_at: "2026-01-01T00:00:00.000Z" });

    const order = await evaluateEventOrder("ev-1");

    expect(order.status).toBe("expired");
    expect(state.adjudicate).not.toHaveBeenCalled();
    expect(state.executeVaultSwap).not.toHaveBeenCalled();
  });

  it("fills on a confident verdict that the condition happened", async () => {
    row = armed();
    state.adjudicate.mockResolvedValue({
      met: true,
      confidence: "high",
      rationale: "the cut was announced and reported by several outlets",
    });

    const order = await evaluateEventOrder("ev-1");

    expect(order.status).toBe("filled");
    expect(order.txHash).toBe(TX);
    expect(order.verdictMet).toBe(true);
    // The fill goes through the shared vault gate, so the user's on-chain caps
    // apply to a keeper-triggered trade exactly as to one they pressed.
    expect(state.preflightVaultSwap).toHaveBeenCalledWith(
      expect.objectContaining({ user, amount: "100", slippageBps: 100 }),
    );
    expect(state.executeVaultSwap).toHaveBeenCalledTimes(1);
  });

  it("does not move money on a met verdict the adjudicator is unsure about", async () => {
    // The adjudicator is told to lean sceptical, so low confidence on a "yes"
    // is the model saying it does not know.
    row = armed();
    state.adjudicate.mockResolvedValue({ met: true, confidence: "low", rationale: "unclear" });

    const order = await evaluateEventOrder("ev-1");

    expect(order.status).toBe("armed");
    expect(order.verdictMet).toBe(false);
    expect(order.verdictConfidence).toBe("low");
    expect(state.executeVaultSwap).not.toHaveBeenCalled();
  });

  it("leaves the order resting when the condition has not happened", async () => {
    row = armed();
    state.adjudicate.mockResolvedValue({ met: false, confidence: "high", rationale: "no cut yet" });

    const order = await evaluateEventOrder("ev-1");

    expect(order.status).toBe("armed");
    expect(order.verdictMet).toBe(false);
    expect(order.checks).toBe(1);
    expect(state.executeVaultSwap).not.toHaveBeenCalled();
  });

  it("retries a fill on an already-met verdict without paying for a second round", async () => {
    row = armed({ verdict_met: true, verdict_confidence: "high", checks: 1 });

    const order = await evaluateEventOrder("ev-1");

    expect(order.status).toBe("filled");
    expect(state.adjudicate).not.toHaveBeenCalled();
    expect(state.executeVaultSwap).toHaveBeenCalledTimes(1);
  });

  it("stays armed after a transient chain error, so the next tick tries again", async () => {
    row = armed({ verdict_met: true, checks: 0 });
    state.preflightVaultSwap.mockRejectedValue(new Error("fetch failed"));

    const order = await evaluateEventOrder("ev-1");

    expect(order.status).toBe("armed");
    expect(order.error).toBe("fetch failed");
  });

  it("fails outright on a refusal the next attempt would earn again", async () => {
    row = armed({ verdict_met: true, checks: 0 });
    state.preflightVaultSwap.mockRejectedValue(
      new Error("This trade ($600.00) exceeds your per-trade limit of $500.00."),
    );

    const order = await evaluateEventOrder("ev-1");

    expect(order.status).toBe("failed");
    expect(order.error).toContain("exceeds your per-trade limit");
  });

  it("gives up once the fill attempts are spent, so a broken order cannot burn gas forever", async () => {
    row = armed({ verdict_met: true, checks: 2 });
    state.preflightVaultSwap.mockRejectedValue(new Error("fetch failed"));

    const order = await evaluateEventOrder("ev-1");

    expect(order.status).toBe("failed");
  });

  it("does nothing to an order that is not armed", async () => {
    row = baseRow({ status: "cancelled" });

    const order = await evaluateEventOrder("ev-1");

    expect(order.status).toBe("cancelled");
    expect(state.adjudicate).not.toHaveBeenCalled();
  });
});

/**
 * The claim on the vault, followed through the order's whole life.
 *
 * The module's own behaviour is covered in vault-reservations.test.ts. What is
 * checked here is the wiring, which is the part that actually breaks: a hold
 * taken and never let go is money locked up for nothing, and every one of these
 * exits used to leave it standing.
 */
describe("what an event order promises the vault", () => {
  const openClaims = () => held.held().filter((r) => r.source_kind === "event_order");

  it("claims nothing when the order is merely written", async () => {
    // Writing is not committing. Holding a balance against every sentence
    // somebody screened would lock up a vault for orders that never go live.
    state.vaultBalance.mockResolvedValue(500_000_000n);

    await createEventOrder({
      user,
      condition: CHECKABLE,
      tokenIn: "rUSDC",
      tokenOut: "rWETH",
      amount: "100",
    });

    expect(openClaims()).toHaveLength(0);
  });

  it("claims the amount when the person arms it", async () => {
    row = baseRow({ status: "screened", screen_verdict: "verifiable" });
    state.vaultBalance.mockResolvedValue(500_000_000n);

    const order = await armEventOrder("ev-1", user);

    expect(order.status).toBe("armed");
    const claims = openClaims();
    expect(claims).toHaveLength(1);
    expect(claims[0].source_id).toBe("ev-1");
    expect(claims[0].amount_raw).toBe("100000000");
  });

  it("refuses to arm an order the vault can no longer pay for", async () => {
    // The screen is a consensus round and takes half a minute. The balance can
    // move in that time, so arming checks again rather than trusting creation.
    row = baseRow({ status: "screened", screen_verdict: "verifiable" });
    state.vaultBalance.mockResolvedValue(40_000_000n);

    await expect(armEventOrder("ev-1", user)).rejects.toThrow(
      "This order needs 100 rUSDC and your vault has 40 free.",
    );
    expect(openClaims()).toHaveLength(0);
  });

  it("will not arm an order that has not been screened", async () => {
    row = baseRow({ status: "screening" });
    await expect(armEventOrder("ev-1", user)).rejects.toThrow(
      "Only an order the validators have cleared can be armed.",
    );
  });

  it("will not arm somebody else's order", async () => {
    row = baseRow({ status: "screened", screen_verdict: "verifiable" });
    await expect(
      armEventOrder("ev-1", "0x9999999999999999999999999999999999999999"),
    ).rejects.toThrow("That order is not yours.");
  });

  it("lets the claim go when the condition turns out to be uncheckable", async () => {
    // A refused order can never trade, so holding its money would lock up a
    // balance against something nobody is allowed to arm.
    row = baseRow({ condition: "my neighbour's cat comes home" });
    held.hold({ user_address: user, token: "rUSDC", amount_raw: "100000000", source_id: "ev-1" });

    await screenEventOrder("ev-1");

    expect(openClaims()).toHaveLength(0);
  });

  it("marks the claim spent once the trade actually lands", async () => {
    row = armed({ verdict_met: true });
    held.hold({ user_address: user, token: "rUSDC", amount_raw: "100000000", source_id: "ev-1" });
    state.preflightVaultSwap.mockResolvedValue({ amountIn: 1n });
    state.executeVaultSwap.mockResolvedValue(TX);

    await evaluateEventOrder("ev-1");

    expect(openClaims()).toHaveLength(0);
    expect(held.rows[0].status).toBe("spent");
  });

  it("keeps holding while a fill is still worth retrying", async () => {
    // The next attempt will need the money, so letting go here would refuse the
    // retry the order is entitled to.
    row = armed({ verdict_met: true, checks: 0 });
    held.hold({ user_address: user, token: "rUSDC", amount_raw: "100000000", source_id: "ev-1" });
    state.preflightVaultSwap.mockResolvedValue({ amountIn: 1n });
    state.preflightVaultSwap.mockRejectedValue(new Error("fetch failed"));

    const order = await evaluateEventOrder("ev-1");

    expect(order.status).toBe("armed");
    expect(openClaims()).toHaveLength(1);
  });

  it("lets go once the order has given up for good", async () => {
    row = armed({ verdict_met: true, checks: 2 });
    held.hold({ user_address: user, token: "rUSDC", amount_raw: "100000000", source_id: "ev-1" });
    state.preflightVaultSwap.mockResolvedValue({ amountIn: 1n });
    state.preflightVaultSwap.mockRejectedValue(new Error("fetch failed"));

    const order = await evaluateEventOrder("ev-1");

    expect(order.status).toBe("failed");
    expect(openClaims()).toHaveLength(0);
  });

  it("lets go when the order runs out its clock", async () => {
    row = armed({ expires_at: "2020-01-01T00:00:00.000Z" });
    held.hold({ user_address: user, token: "rUSDC", amount_raw: "100000000", source_id: "ev-1" });

    const order = await evaluateEventOrder("ev-1");

    expect(order.status).toBe("expired");
    expect(openClaims()).toHaveLength(0);
  });

  it("lets go when the person calls the order off", async () => {
    row = armed();
    held.hold({ user_address: user, token: "rUSDC", amount_raw: "100000000", source_id: "ev-1" });

    await cancelEventOrder("ev-1", user);

    expect(openClaims()).toHaveLength(0);
  });
});

/**
 * Two workers, one order.
 *
 * The judgment work runs in more than one place: a Vercel cron tick, and the
 * standalone relayer's own loop, and either can be nudged by hand. The `serial`
 * wrapper in the worker module stops a loop overlapping itself and says nothing
 * at all about two processes, which is the case that actually costs money. Every
 * guard below is about the same moment arriving twice.
 */
describe("two workers reaching the same order", () => {
  it("retains a lost submission reply and keeps its hold", async () => {
    row = armed({verdict_met:true,checks:0});
    held.hold({user_address:user,token:"rUSDC",amount_raw:"100000000",source_id:"ev-1"});
    state.executeVaultSwap.mockRejectedValue(new Error("RPC reply lost after broadcast"));
    const order = await evaluateEventOrder("ev-1");
    expect(order.status).toBe("firing");
    expect(held.held()).toHaveLength(1);
    await evaluateEventOrder("ev-1");
    expect(state.executeVaultSwap).toHaveBeenCalledTimes(1);
  });

  const met = {
    met: true,
    confidence: "high" as const,
    rationale: "it happened",
    sources: [],
  };

  beforeEach(() => {
    state.ethUsd.mockResolvedValue({ usd: 2500, updatedAt: 0, ageSeconds: 1 });
    state.preflightVaultSwap.mockResolvedValue({ amountInRaw: 1n, minOut: 1n });
    state.executeVaultSwap.mockResolvedValue(TX);
    state.vaultBalance.mockResolvedValue(10_000_000_000n);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(RSS, { status: 200 })));
  });

  it("fills a met verdict exactly once", async () => {
    row = baseRow({ status: "armed", verdict_met: true, verdict_confidence: "high" });

    const [first, second] = await Promise.all([
      evaluateEventOrder("ev-1"),
      evaluateEventOrder("ev-1"),
    ]);

    // One trade. Before the claim moved in front of the swap, both of these
    // traded and only the second found out it had been beaten.
    expect(state.executeVaultSwap).toHaveBeenCalledTimes(1);
    expect([first.status, second.status]).toContain("filled");
  });

  it("buys one consensus round for one check, not two", async () => {
    row = baseRow({ status: "armed" });
    state.adjudicate.mockResolvedValue(met);

    await Promise.all([evaluateEventOrder("ev-1"), evaluateEventOrder("ev-1")]);

    // The loser of the lease returns without asking the validators anything.
    expect(state.adjudicate).toHaveBeenCalledTimes(1);
  });

  it("screens once however many workers notice the order", async () => {
    row = baseRow({ status: "screening" });
    state.adjudicate.mockResolvedValue({ ...met, rationale: "checkable" });

    await Promise.all([screenEventOrder("ev-1"), screenEventOrder("ev-1")]);

    expect(state.adjudicate).toHaveBeenCalledTimes(1);
  });

  it("will not expire an order whose trade is still in the mempool", async () => {
    // The sweep used to take any armed row past its date, including one the
    // fill had already claimed, which released the hold the trade was spending.
    row = baseRow({ status: "firing", expires_at: "2020-01-01T00:00:00.000Z" });
    stranded = true;

    const result = await eventTick();

    expect(row.status).toBe("firing");
    expect(result.errors).toEqual([]);
  });

  it("will not cancel an order whose trade is still in the mempool", async () => {
    row = baseRow({ status: "firing" });
    await expect(cancelEventOrder("ev-1", user)).rejects.toThrow("no longer open");
    expect(row.status).toBe("firing");
  });

  it("retains an unknown mid-trade outcome without trading again", async () => {
    // We cannot tell from here whether the swap landed, so retrying risks
    // spending twice. Failing is the direction that cannot cost the person
    // money they did not agree to.
    row = baseRow({ status: "firing" });
    stranded = true;

    await eventTick();

    expect(row.status).toBe("firing");
    expect(state.executeVaultSwap).not.toHaveBeenCalled();
  });
});

describe("arming when the hold cannot be taken", () => {
  it("puts the order back to screened rather than leaving it armed for nothing", async () => {
    // An armed order with no hold behind it is the original bug wearing a hat:
    // it looks live, counts for nothing in the funding gate, and the next order
    // written against the same money is allowed to promise it.
    row = baseRow({ status: "screened", screen_verdict: "verifiable" });
    state.vaultBalance.mockResolvedValue(10_000_000_000n);
    state.lockCommitments.mockRejectedValue(new Error("CommittedVault: 0 free"));

    await expect(armEventOrder("ev-1", user)).rejects.toThrow("CommittedVault");
    expect(row.status).toBe("screened");
    expect(row.error).toContain("could not hold the vault money");
  });

  it("frees a lock that landed before the row recording it could not be written", async () => {
    // The case that actually happened, on 2026-10-03: the chain lock went
    // through, the insert hit a column the live database did not have, and the
    // rollback put the order back to 'screened' without letting the money go.
    // 150 rUSDC stayed locked with nothing pointing at it, and because the
    // funding gate measures `available` off the chain, re-arming the very order
    // that owned the lock was refused for lack of funds.
    //
    // So this asserts the cleanup, not the refusal: the lock must be released.
    row = baseRow({ status: "screened", screen_verdict: "verifiable" });
    state.vaultBalance.mockResolvedValue(10_000_000_000n);
    state.lockCommitments.mockResolvedValue(undefined);
    const realQ = state.q.getMockImplementation()!;
    state.q.mockImplementation(async (text: string, params?: unknown[]) => {
      if (text.includes("INSERT INTO vault_reservations")) {
        throw new Error(`column "commitment_id" of relation "vault_reservations" does not exist`);
      }
      return realQ(text, params);
    });

    await expect(armEventOrder("ev-1", user)).rejects.toThrow("commitment_id");

    expect(state.lockCommitments).toHaveBeenCalled();
    // The whole point. Without this the money is stranded.
    expect(state.releaseCommitments).toHaveBeenCalledWith([
      commitmentIdFor("event_order", "ev-1", 0),
    ]);
    expect(row.status).toBe("screened");
    expect(row.error).toContain("could not hold the vault money");
    // The release worked, so the message must not claim money is still held.
    expect(row.error).not.toContain("may still be held");
  });

  it("says so on the row when freeing the lock fails as well", async () => {
    // Then the person is told two things: why it would not arm, and that some of
    // their balance may still be held. The thrown error stays the original one,
    // because "the vault refused" is more use than "the cleanup refused".
    row = baseRow({ status: "screened", screen_verdict: "verifiable" });
    state.vaultBalance.mockResolvedValue(10_000_000_000n);
    state.lockCommitments.mockResolvedValue(undefined);
    state.releaseCommitments.mockRejectedValue(new Error("nonce too low"));
    const realQ = state.q.getMockImplementation()!;
    state.q.mockImplementation(async (text: string, params?: unknown[]) => {
      if (text.includes("INSERT INTO vault_reservations")) throw new Error("insert blew up");
      return realQ(text, params);
    });

    await expect(armEventOrder("ev-1", user)).rejects.toThrow("insert blew up");
    expect(row.error).toContain("may still be held");
  });
});
