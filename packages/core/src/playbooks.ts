/**
 * Playbooks: a plan the agent walks, one step at a time.
 *
 * An event order is a single bet. A playbook is the thing people actually
 * describe when they talk about a strategy: "put a third in now, another third
 * if it drops ten percent, and take it all off if the Fed cuts." Three rules,
 * in order, each waiting on the one before it.
 *
 * The cursor is the whole design. Only the step it points at is ever watched,
 * so a ten-step playbook costs the same per tick as a two-step one, a step can
 * never fire out of order, and a crash mid-walk resumes exactly where it
 * stopped because the position is a column rather than something held in a
 * process. Steps live as JSONB because trigger kinds vary and will grow; the
 * columns hold only what the engine has to filter on.
 *
 * Execution reuses the same vault gate as everything else, so a step that fires
 * unattended at four in the morning is bound by the same on-chain caps as a
 * trade the person watched themselves press.
 */

import {formatUnits,parseUnits} from "viem";
import {vaultSettlement} from "./settlement.js";
import {SubmissionPendingError} from "./chain.js";
import {getCommitment} from "./intents.js";
import {NO_COMMITMENT} from "./intents.js";
import { randomUUID } from "node:crypto";
import { tokenBySymbol } from "@roque/shared";
import { q } from "./db/index.js";
import { ethUsd } from "./prices.js";
import { adjudicate } from "./genlayer.js";
import { preflightVaultSwap, executeVaultSwap } from "./services.js";
import { gatherEvidence, localScreen, EVENT_CHECK_INTERVAL_MS } from "./events.js";
import { assertVaultFunds } from "./funding.js";
import { commitmentIdFor, reserve, recoverReservation, release } from "./reservations.js";

/**
 * How long a rung's hold should last. Every commitment carries an end, because
 * the contract will not take an unbounded one, so a plan whose last rung waits
 * ninety days needs a hold that outlives it. Take the furthest delay the plan
 * contains and add a month of slack.
 */
function holdWindow(steps: PlaybookStep[]): Date {
  let minutes = 0;
  for (const step of steps) {
    if (step.trigger.kind === "delay") minutes += step.trigger.minutes;
  }
  const days = Math.min(Math.round(minutes / (60 * 24)) + 30, 115);
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000);
}

/** How often a waiting step is re-examined. Price is cheap; events are not. */
export const PLAYBOOK_PRICE_INTERVAL_MS = 30_000;
export const PLAYBOOK_EVENT_INTERVAL_MS = EVENT_CHECK_INTERVAL_MS;

/** Steps advanced per tick, keeping a serverless tick inside its budget. */
export const PLAYBOOK_TICK_BUDGET = 4;

export const MAX_STEPS = 10;

export type PlaybookTrigger =
  | { kind: "immediate" }
  | { kind: "price"; direction: "above" | "below"; usd: number }
  | { kind: "event"; condition: string }
  | { kind: "delay"; minutes: number };

export interface PlaybookAction {
  tokenIn: string;
  tokenOut: string;
  amount: string;
  amountIsPercent?: boolean;
}

export type StepStatus = "waiting" | "firing" | "done" | "failed" | "skipped";

export interface PlaybookStep {
  id: string;
  funding?: {source:"vault"|"previous_output";stepIndex?:number};
  amountOutRaw?:string;
  label: string;
  trigger: PlaybookTrigger;
  action: PlaybookAction;
  status: StepStatus;
  /** Set on the event triggers the arming screen cleared, with its reasoning. */
  screen?: { verifiable: boolean; reason: string } | null;
  txHash?: string | null;
  error?: string | null;
  armedAt?: string | null;
  firedAt?: string | null;
  checks?: number;
  lastCheckedAt?: string | null;
  verdict?: { met: boolean; confidence: string; rationale: string } | null;
}

export type PlaybookStatus = "draft" | "arming" | "armed" | "completed" | "cancelled" | "failed";

export interface Playbook {
  id: string;
  user: string;
  name: string;
  note: string | null;
  status: PlaybookStatus;
  steps: PlaybookStep[];
  stepCursor: number;
  slippageBps: number;
  lastCheckedAt: string | null;
  error: string | null;
  sourceSlug: string | null;
  createdAt: string;
  updatedAt: string;
}

interface PlaybookRow {
  id: string;
  user_address: string;
  name: string;
  note: string | null;
  status: PlaybookStatus;
  steps: PlaybookStep[];
  step_cursor: number;
  slippage_bps: number;
  last_checked_at: string | null;
  error: string | null;
  source_slug: string | null;
  created_at: string;
  updated_at: string;
}

function toPlaybook(row: PlaybookRow): Playbook {
  return {
    id: row.id,
    user: row.user_address,
    name: row.name,
    note: row.note,
    status: row.status,
    steps: row.steps ?? [],
    stepCursor: row.step_cursor,
    slippageBps: row.slippage_bps,
    lastCheckedAt: row.last_checked_at,
    error: row.error,
    sourceSlug: row.source_slug,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ─────────────────────────────────────────────────────────────
// Validation
// ─────────────────────────────────────────────────────────────

/**
 * Normalise a step the caller supplied. Everything a playbook can do must be
 * expressible from a shared link, which means these objects arrive from a
 * stranger's browser; nothing here trusts a field it did not check.
 */
export function normaliseStep(raw: unknown, index: number): PlaybookStep {
  const step = (raw ?? {}) as Partial<PlaybookStep>;
  const where = `step ${index + 1}`;

  const action = (step.action ?? {}) as Partial<PlaybookAction>;
  const tokenIn = tokenBySymbol(String(action.tokenIn ?? ""));
  const tokenOut = tokenBySymbol(String(action.tokenOut ?? ""));
  if (!tokenIn || !tokenOut) throw new Error(`${where} names a token I do not trade.`);
  if (tokenIn.symbol === tokenOut.symbol) throw new Error(`${where} trades a token for itself.`);

  const amount = String(action.amount ?? "").trim();
  if (amount.length>78 || !/^\d+(\.\d+)?$/u.test(amount) || Number(amount) <= 0) {
    throw new Error(`${where} needs a positive amount.`);
  }
  if(action.amountIsPercent!==undefined && typeof action.amountIsPercent!=="boolean") throw new Error(`${where} needs an exact boolean percentage flag.`);
  const amountIsPercent = action.amountIsPercent === true;
  if (amountIsPercent && Number(amount) > 100) {
    throw new Error(`${where} asks for more than 100 percent of the balance.`);
  }

  const trigger = normaliseTrigger(step.trigger, where);

  return {
    id: typeof step.id === "string" && step.id ? step.id : randomUUID(),
    label: String(step.label ?? describeStep(trigger, { tokenIn: tokenIn.symbol, tokenOut: tokenOut.symbol, amount, amountIsPercent })).slice(0, 140),
    trigger,
    action: { tokenIn: tokenIn.symbol, tokenOut: tokenOut.symbol, amount, amountIsPercent },
    status: "waiting",
    screen: null,
    txHash: null,
    error: null,
    armedAt: null,
    firedAt: null,
    checks: 0,
    lastCheckedAt: null,
    verdict: null,
  };
}

function normaliseTrigger(raw: unknown, where: string): PlaybookTrigger {
  const t = (raw ?? {}) as Record<string, unknown>;
  switch (t.kind) {
    case "immediate":
      return { kind: "immediate" };
    case "price": {
      const usd = Number(t.usd);
      if (!Number.isFinite(usd) || usd <= 0) throw new Error(`${where} needs a price above zero.`);
      const direction = t.direction === "below" ? "below" : "above";
      return { kind: "price", direction, usd };
    }
    case "event": {
      const condition = String(t.condition ?? "").trim();
      if (condition.length < 12) throw new Error(`${where} needs a condition to wait on.`);
      if (condition.length > 500) throw new Error(`${where} has a condition over 500 characters.`);
      return { kind: "event", condition };
    }
    case "delay": {
      const minutes = Number(t.minutes);
      if (!Number.isFinite(minutes) || minutes <= 0) throw new Error(`${where} needs a positive delay.`);
      return { kind: "delay", minutes: Math.min(minutes, 60 * 24 * 90) };
    }
    default:
      throw new Error(`${where} has no trigger I recognise.`);
  }
}

/** A readable one-liner, used as the default label and in the share card. */
export function describeStep(trigger: PlaybookTrigger, action: PlaybookAction): string {
  const size = action.amountIsPercent ? `${action.amount}% of ${action.tokenIn}` : `${action.amount} ${action.tokenIn}`;
  const trade = `swap ${size} for ${action.tokenOut}`;
  switch (trigger.kind) {
    case "immediate": return `Right away, ${trade}`;
    case "price": return `If ETH goes ${trigger.direction} $${trigger.usd.toLocaleString("en-US")}, ${trade}`;
    case "event": return `If ${trigger.condition}, ${trade}`;
    case "delay": return `After ${trigger.minutes} minutes, ${trade}`;
  }
}

// ─────────────────────────────────────────────────────────────
// Trigger evaluation
// ─────────────────────────────────────────────────────────────

export interface TriggerContext {
  now: number;
  ethUsd: number;
  armedAt: number | null;
  /** Supplied only for event triggers, after an adjudication. */
  verdictMet?: boolean;
}

/**
 * Pure, so the rules can be tested without a chain or a model behind them.
 * An event trigger reports not-ready unless a verdict was handed in, which
 * keeps the expensive call outside this function and the decision inside it.
 */
export function isTriggerReady(trigger: PlaybookTrigger, ctx: TriggerContext): boolean {
  switch (trigger.kind) {
    case "immediate":
      return true;
    case "price":
      return trigger.direction === "above" ? ctx.ethUsd >= trigger.usd : ctx.ethUsd <= trigger.usd;
    case "delay":
      return ctx.armedAt !== null && ctx.now >= ctx.armedAt + trigger.minutes * 60_000;
    case "event":
      return ctx.verdictMet === true;
  }
}

/** Whether enough time has passed to spend another check on this step. */
export function dueForCheck(step: PlaybookStep, now: number): boolean {
  if (!step.lastCheckedAt) return true;
  const gap = step.trigger.kind === "event" ? PLAYBOOK_EVENT_INTERVAL_MS : PLAYBOOK_PRICE_INTERVAL_MS;
  return now - new Date(step.lastCheckedAt).getTime() >= gap;
}

// ─────────────────────────────────────────────────────────────
// Lifecycle
// ─────────────────────────────────────────────────────────────

export interface CreatePlaybookInput {
  user: string;
  name: string;
  note?: string;
  steps: unknown[];
  slippageBps?: number;
  sourceSlug?: string;
}

export async function createPlaybook(input: CreatePlaybookInput): Promise<Playbook> {
  const name = input.name.trim();
  if (!name) throw new Error("A playbook needs a name.");
  if (name.length > 120) throw new Error("Keep the name under 120 characters.");
  if (!Array.isArray(input.steps) || input.steps.length === 0) {
    throw new Error("A playbook needs at least one step.");
  }
  if (input.steps.length > MAX_STEPS) {
    throw new Error(`A playbook can hold at most ${MAX_STEPS} steps.`);
  }
  const steps = input.steps.map(normaliseStep);

  const rows = await q<PlaybookRow>(
    `INSERT INTO playbooks (id, user_address, name, note, status, steps, slippage_bps, source_slug)
     VALUES ($1,$2,$3,$4,'draft',$5::jsonb,$6,$7) RETURNING *`,
    [
      randomUUID(),
      input.user.toLowerCase(),
      name,
      input.note?.trim() || null,
      JSON.stringify(steps),
      Math.min(Math.max(input.slippageBps ?? 100, 1), 5_000),
      input.sourceSlug ?? null,
    ],
  );
  return toPlaybook(rows[0]);
}

export interface UpdatePlaybookInput {
  name?: string;
  note?: string | null;
  steps?: unknown[];
  slippageBps?: number;
}

/**
 * Change a draft before it goes anywhere.
 *
 * A plan is written in one sitting and almost never right first time: a rung in
 * the wrong order, a size that turns out to be more than the vault holds, a
 * condition the screen refused and that the person wants to reword rather than
 * throw away. Until now the only way to do any of that was to cancel the plan
 * and retype it, which also lost the sharing slug and the step ids.
 *
 * Draft only, and the guard is in the statement rather than in a check above it.
 * An armed plan has money held against named rungs and a cursor partway through
 * them; editing that is not an edit, it is a different plan, and the honest
 * answer is to cancel and write one. A completed or cancelled plan is history.
 *
 * Steps are re-normalised rather than merged, so an edit cannot smuggle in a
 * shape `normaliseStep` would have refused. That also clears any `screen`
 * verdict a failed arming left on a step, which is correct: the sentence may
 * have changed, and a stale verdict on new words is worse than none.
 */
export async function updatePlaybook(
  id: string,
  user: string,
  input: UpdatePlaybookInput,
): Promise<Playbook> {
  const rows = await q<PlaybookRow>(
    `SELECT * FROM playbooks WHERE id=$1 AND LOWER(user_address)=LOWER($2)`,
    [id, user],
  );
  const row = rows[0];
  if (!row) throw new Error("No such playbook.");
  if (row.status !== "draft") {
    throw new Error(
      row.status === "armed"
        ? "That playbook is already armed, and its money is held against the steps as they stand. Cancel it to edit, or let it run."
        : `That playbook is ${row.status}, so there is nothing left to edit.`,
    );
  }

  const name = input.name === undefined ? row.name : input.name.trim();
  if (!name) throw new Error("A playbook needs a name.");
  if (name.length > 120) throw new Error("Keep the name under 120 characters.");

  let steps = row.steps;
  if (input.steps !== undefined) {
    if (!Array.isArray(input.steps) || input.steps.length === 0) {
      throw new Error("A playbook needs at least one step.");
    }
    if (input.steps.length > MAX_STEPS) {
      throw new Error(`A playbook can hold at most ${MAX_STEPS} steps.`);
    }
    steps = input.steps.map(normaliseStep);
  }

  const note =
    input.note === undefined ? row.note : (input.note?.trim() || null);
  const slippage =
    input.slippageBps === undefined
      ? row.slippage_bps
      : Math.min(Math.max(input.slippageBps, 1), 5_000);

  const saved = await q<PlaybookRow>(
    `UPDATE playbooks
        SET name=$2, note=$3, steps=$4::jsonb, slippage_bps=$5, error=NULL, updated_at=now()
      WHERE id=$1 AND status='draft' RETURNING *`,
    [id, name, note, JSON.stringify(steps), slippage],
  );
  if (!saved[0]) throw new Error("That playbook stopped being a draft while you were editing it.");
  await log(id, 0, "edited", `${steps.length} step${steps.length === 1 ? "" : "s"}`);
  return toPlaybook(saved[0]);
}

/**
 * Arm a draft. Every event trigger is screened for verifiability first, on the
 * same principle as a standalone event order: a plan whose second step waits on
 * something nobody can check is a plan that silently stalls, and a person is
 * owed that news now rather than in a fortnight when nothing has happened.
 */
export async function armPlaybook(id: string, user: string): Promise<Playbook> {
  const rows = await q<PlaybookRow>(
    `SELECT * FROM playbooks WHERE id=$1 AND LOWER(user_address)=LOWER($2)`,
    [id, user],
  );
  const row = rows[0];
  if (!row) throw new Error("No such playbook.");
  if (row.status !== "draft") throw new Error("That playbook is not a draft.");

  const steps = row.steps.map((s) => ({ ...s }));

  // Funding first, because it is the cheap refusal. Screening the event steps
  // costs a consensus round each, and there is no sense spending half a minute
  // per rung proving a plan is checkable when the vault cannot pay for it.
  //
  // Only the rungs the vault is actually on the hook for are counted: a step
  // that spends what an earlier step bought is funded by the ladder itself, and
  // insisting the person already hold it would refuse every sensible plan.
  await assertVaultFunds(
    row.user_address as `0x${string}`,
    steps.map((step, index) => ({
      tokenIn: step.action.tokenIn,
      tokenOut: step.action.tokenOut,
      amount: step.action.amount,
      amountIsPercent: step.action.amountIsPercent,
      where: `Step ${index + 1}`,
    })),
  );

  const unverifiable: string[] = [];

  for (const [index, step] of steps.entries()) {
    if (step.trigger.kind !== "event") continue;
    const condition = step.trigger.condition;

    const quick = localScreen(condition);
    if (quick) {
      step.screen = { verifiable: false, reason: quick.reason };
      unverifiable.push(`Step ${index + 1}: ${quick.reason}`);
      continue;
    }
    const evidence = await gatherEvidence(condition);
    const verdict = await adjudicate(
      `pbscreen:${id}:${step.id}`,
      verifiabilityQuestion(condition),
      { sampleEvidence: evidence },
    );
    step.screen = { verifiable: verdict.met, reason: verdict.rationale };
    if (!verdict.met) {
      unverifiable.push(`Step ${index + 1}: ${verdict.rationale || "no public source could settle it"}`);
    }
  }

  if (unverifiable.length > 0) {
    // Persist the reasoning even on refusal, so the person can see precisely
    // which step failed and why rather than being told the plan is bad.
    await q(`UPDATE playbooks SET steps=$2::jsonb, error=$3, updated_at=now() WHERE id=$1`, [
      id,
      JSON.stringify(steps),
      unverifiable.join(" · "),
    ]);
    throw new Error(`This playbook waits on something nobody can verify. ${unverifiable.join(" · ")}`);
  }

  // Arming is the moment the plan becomes a promise, so it is the moment the
  // money is claimed. A draft holds nothing, which is why a plan can still be
  // written, shared and forked before the vault could pay for it.
  //
  // The status moves first and the hold is taken after, which is the opposite of
  // how this used to read. Claiming first means two requests cannot both arm the
  // same plan, and it means a failed hold has somewhere to put the plan back:
  // 'draft', with the contract's reason attached. The other order left the loser
  // of that race holding money for a plan it never armed.
  //
  // Only the rungs the vault is on the hook for are claimed, matching the gate
  // above: a step that spends what an earlier step bought is funded by the
  // ladder, and holding vault money for it would double-count the same trade.
  const produced = new Set<string>();
  const claims: Parameters<typeof reserve>[0] = [];
  const holdUntil = holdWindow(steps);
  const outputShares = new Map<number,bigint>();
  for (const [index, step] of steps.entries()) {
    if (!produced.has(step.action.tokenIn) || !step.action.amountIsPercent) {
      step.funding={source:"vault"};
      claims.push({
        user: row.user_address,
        token: step.action.tokenIn,
        amount: step.action.amount,
        amountIsPercent: step.action.amountIsPercent,
        source: "playbook",
        sourceId: id,
        stepIndex: index,
        holdUntil,
      });
    }
    if(!step.funding) step.funding={source:"previous_output",stepIndex:steps.slice(0,index).map(s=>s.action.tokenOut).lastIndexOf(step.action.tokenIn)};
    if(step.funding.source==="previous_output") {
      const upstream=step.funding.stepIndex!;
      const total=(outputShares.get(upstream)??0n)+parseUnits(step.action.amount,4);
      if(total>1000000n) throw new Error("Downstream steps promise more than 100 percent of upstream output.");
      outputShares.set(upstream,total);
    }
    produced.add(step.action.tokenOut);
  }

  steps[0].armedAt = new Date().toISOString();
  const armed = await q<PlaybookRow>(
    `UPDATE playbooks SET status='arming', steps=$2::jsonb, step_cursor=0, error=NULL,
        last_checked_at=NULL, updated_at=now()
      WHERE id=$1 AND status='draft' RETURNING *`,
    [id, JSON.stringify(steps)],
  );
  if (!armed[0]) throw new Error("That playbook is no longer a draft.");

  if (claims.length > 0) {
    try {
      await reserve(claims);
    } catch (err) {
      if(err instanceof SubmissionPendingError) return toPlaybook(armed[0]);
      // Same shape as an event order, deliberately. This path already released,
      // but it did so after the row write and without guarding the release
      // itself, so a release that threw replaced the reason the person needed
      // with one about the cleanup.
      let stranded = false;
      try {
        await release("playbook", id);
      } catch {
        stranded = true;
      }
      await q(
        `UPDATE playbooks SET status='draft', error=$2, updated_at=now()
          WHERE id=$1 AND status='arming'`,
        [
          id,
          `could not hold the vault money: ${(err as Error).message}` +
            (stranded ? " Freeing what did land also failed, so some may still be held." : ""),
        ],
      );
      throw err;
    }
  }

  await q("UPDATE playbooks SET status='armed',updated_at=now() WHERE id=$1 AND status='arming'",[id]);
  await log(id, 0, "armed", `${steps.length} step${steps.length === 1 ? "" : "s"} armed`);
  return toPlaybook({...armed[0],status:"armed"});
}

/** The same meta-question the standalone screen asks, kept in one wording. */
function verifiabilityQuestion(condition: string): string {
  return [
    "VERIFIABILITY CHECK. Do not judge whether the statement is true.",
    "Judge only whether it could be checked.",
    "",
    "Answer met=true only if an independent person with ordinary web access could,",
    "on any given day, find public evidence that settles the statement below as",
    "clearly true or clearly false.",
    "",
    "Answer met=false if it depends on private information, on someone's inner",
    "state or intent, on the personal circumstances of the person who wrote it,",
    "or if it names no subject any public source reports on.",
    "",
    `Statement: "${condition.trim()}"`,
  ].join("\n");
}

// ─────────────────────────────────────────────────────────────
// The engine
// ─────────────────────────────────────────────────────────────

/**
 * Examine the step the cursor points at and, if its trigger has fired, trade
 * and move on. Exactly one step is considered per call, which is what makes the
 * ordering guarantee hold under a keeper that may run twice concurrently: the
 * claim below moves the step to firing under a cursor-guarded update, so a
 * second runner finds nothing to claim.
 */
export async function advancePlaybook(id: string): Promise<Playbook> {
  const rows = await q<PlaybookRow>(`SELECT * FROM playbooks WHERE id=$1`, [id]);
  const row = rows[0];
  if (!row) throw new Error("No such playbook.");
  if (row.status !== "armed") return toPlaybook(row);

  const cursor = row.step_cursor;
  const steps = row.steps.map((s) => ({ ...s }));
  const step = steps[cursor];

  if (!step) return complete(id, steps);
  if (step.status !== "waiting") return toPlaybook(row);
  if (!dueForCheck(step, Date.now())) return toPlaybook(row);

  // Event steps need a verdict before the pure rule can decide.
  let verdictMet: boolean | undefined;
  if (step.trigger.kind === "event") {
    const evidence = await gatherEvidence(step.trigger.condition);
    const verdict = await adjudicate(
      `pb:${id}:${step.id}:${(step.checks ?? 0) + 1}`,
      step.trigger.condition,
      { evidence, asOf: new Date().toISOString() },
    );
    // Same rule as an event order: a sceptical adjudicator saying "yes, but I
    // am unsure" is not grounds to move money.
    verdictMet = verdict.met && verdict.confidence !== "low";
    step.verdict = { met: verdict.met, confidence: verdict.confidence, rationale: verdict.rationale };
  }

  step.checks = (step.checks ?? 0) + 1;
  step.lastCheckedAt = new Date().toISOString();

  const ready = isTriggerReady(step.trigger, {
    now: Date.now(),
    ethUsd: step.trigger.kind === "price" ? (await ethUsd()).usd : 0,
    armedAt: step.armedAt ? new Date(step.armedAt).getTime() : null,
    verdictMet,
  });

  if (!ready) {
    await q(
      `UPDATE playbooks SET steps=$2::jsonb, last_checked_at=now(), updated_at=now()
        WHERE id=$1 AND step_cursor=$3 AND status='armed' AND (steps->$3->>'status')='waiting'`,
      [id, JSON.stringify(steps), cursor],
    );
    return toPlaybook({ ...row, steps, last_checked_at: new Date().toISOString() });
  }

  // Claim the step. The cursor guard is the concurrency gate.
  step.status = "firing";
  const claimed = await q<{ id: string }>(
    `UPDATE playbooks SET steps=$2::jsonb, last_checked_at=now(), updated_at=now()
      WHERE id=$1 AND step_cursor=$3 AND status='armed'
        AND (steps->$3->>'status') = 'waiting' RETURNING id`,
    [id, JSON.stringify(steps), cursor],
  );
  if (claimed.length !== 1) return toPlaybook(row);

  let submissionStarted = false;
  try {
    const plan = await preflightVaultSwap({
      user: row.user_address as `0x${string}`,
      tokenIn: tokenBySymbol(step.action.tokenIn)!,
      tokenOut: tokenBySymbol(step.action.tokenOut)!,
      amount: step.funding?.source==="previous_output" ? priorOutputAmount(steps,step) : step.action.amount,
      amountIsPercent: step.funding?.source==="previous_output" ? false : step.action.amountIsPercent,
      slippageBps: row.slippage_bps,
      // The rung spends the hold taken for it at arm time, and the hold ends in
      // the same transaction. A rung whose input an earlier rung produces took
      // no hold, so this resolves to a commitment that was never made and the
      // trade draws on free money instead, which is what the funding gate
      // already assumed when it skipped that leg.
      commitmentId: step.funding?.source==="previous_output" ? NO_COMMITMENT : commitmentIdFor("playbook", id, cursor),
    });
    submissionStarted = true;
    const txHash = await executeVaultSwap(row.user_address as `0x${string}`, plan,`playbook:${id}:${cursor}`);
    step.txHash = txHash;
    await q(`UPDATE playbooks SET steps=$2::jsonb,updated_at=now() WHERE id=$1 AND step_cursor=$3 AND status='armed'`,[id,JSON.stringify(steps),cursor]);
    const settlement=await vaultSettlement(`playbook:${id}:${cursor}`);
    if(settlement.status==="pending") return toPlaybook({...row,steps});
    if(settlement.status==="reverted") throw new Error("Transaction reverted.");
    step.amountOutRaw=settlement.amountOutRaw;
    step.status = "done";
    step.firedAt = new Date().toISOString();
    step.error = null;
    // This rung's promise was kept. Released one rung at a time so the rest of
    // the ladder keeps holding what it still needs.
    await release("playbook", id, "spent", cursor);
    await log(id, cursor, "filled", step.label, txHash);
  } catch (err) {
    if (submissionStarted) return toPlaybook({...row,steps});
    step.status = "failed";
    step.error = (err as Error).message;
    await log(id, cursor, "failed", step.error);
    const failed = await q<PlaybookRow>(
      `UPDATE playbooks SET steps=$2::jsonb, status='failed', error=$3, updated_at=now()
        WHERE id=$1 RETURNING *`,
      [id, JSON.stringify(steps), step.error],
    );
    // A failed playbook stops for good, so nothing downstream will spend. Every
    // rung still held lets go, including the one that just failed.
    await release("playbook", id);
    return toPlaybook(failed[0]);
  }

  // Hand the clock to the next step so a delay measures from this fill.
  // Guarded on the cursor we claimed and on the plan still being armed. The
  // trade has already happened, so this write is bookkeeping; what the guard
  // prevents is advancing a plan somebody cancelled while the swap was in
  // flight, which would hand the next rung a clock it should never have got.
  const next = cursor + 1;
  if (steps[next]) steps[next].armedAt = new Date().toISOString();
  const moved = await q<PlaybookRow>(
    `UPDATE playbooks SET steps=$2::jsonb, step_cursor=$3, updated_at=now()
      WHERE id=$1 AND step_cursor=$4 AND status='armed' RETURNING *`,
    [id, JSON.stringify(steps), next, cursor],
  );
  if (!moved[0]) return toPlaybook({ ...row, steps });
  return steps[next] ? toPlaybook(moved[0]) : complete(id, steps);
}

async function complete(id: string, steps: PlaybookStep[]): Promise<Playbook> {
  // Guarded, so a plan cancelled mid-walk is not quietly marked completed.
  const rows = await q<PlaybookRow>(
    `UPDATE playbooks SET status='completed', steps=$2::jsonb, updated_at=now()
      WHERE id=$1 AND status='armed' RETURNING *`,
    [id, JSON.stringify(steps)],
  );
  if (!rows[0]) {
    const current = await q<PlaybookRow>(`SELECT * FROM playbooks WHERE id=$1`, [id]);
    await release("playbook", id);
    return toPlaybook(current[0]);
  }
  // Belt and braces: each rung releases as it fills, so this is normally a
  // no-op. It catches a claim whose per-step release did not land, which would
  // otherwise hold money against a plan that has finished running.
  await release("playbook", id);
  await log(id, steps.length, "completed", "every step ran");
  return toPlaybook(rows[0]);
}

async function log(
  playbookId: string,
  stepIndex: number,
  kind: string,
  detail?: string | null,
  txHash?: string | null,
): Promise<void> {
  await q(
    `INSERT INTO playbook_events (playbook_id, step_index, kind, detail, tx_hash)
     VALUES ($1,$2,$3,$4,$5)`,
    [playbookId, stepIndex, kind, detail ?? null, txHash ?? null],
  );
}

// ─────────────────────────────────────────────────────────────
// Reads and the tick
// ─────────────────────────────────────────────────────────────

export async function listPlaybooks(user: string, limit = 50): Promise<Playbook[]> {
  const rows = await q<PlaybookRow>(
    `SELECT * FROM playbooks WHERE LOWER(user_address)=LOWER($1)
      ORDER BY created_at DESC LIMIT $2`,
    [user, limit],
  );
  return rows.map(toPlaybook);
}

export async function getPlaybook(id: string): Promise<Playbook | null> {
  const rows = await q<PlaybookRow>(`SELECT * FROM playbooks WHERE id=$1`, [id]);
  return rows[0] ? toPlaybook(rows[0]) : null;
}

export interface PlaybookLogEntry {
  id: string;
  stepIndex: number;
  kind: string;
  detail: string | null;
  txHash: string | null;
  createdAt: string;
}

export async function playbookLog(id: string, limit = 50): Promise<PlaybookLogEntry[]> {
  const rows = await q<{
    id: string; step_index: number; kind: string;
    detail: string | null; tx_hash: string | null; created_at: string;
  }>(
    `SELECT id::text, step_index, kind, detail, tx_hash, created_at
       FROM playbook_events WHERE playbook_id=$1 ORDER BY id DESC LIMIT $2`,
    [id, limit],
  );
  return rows.map((r) => ({
    id: r.id,
    stepIndex: r.step_index,
    kind: r.kind,
    detail: r.detail,
    txHash: r.tx_hash,
    createdAt: r.created_at,
  }));
}

export async function cancelPlaybook(id: string, user: string): Promise<Playbook> {
  // The step clause refuses a cancel while the rung at the cursor is mid-trade.
  // Without it, cancelling released the hold and marked the plan dead while the
  // swap spending that hold was still in the mempool, and the trade landed
  // against a plan that no longer existed. A moment later the rung has settled
  // and the cancel goes through cleanly.
  const rows = await q<PlaybookRow>(
    `UPDATE playbooks SET status='cancelled', updated_at=now()
      WHERE id=$1 AND LOWER(user_address)=LOWER($2) AND status IN ('draft','armed')
        AND COALESCE(steps->step_cursor->>'status', '') <> 'firing'
      RETURNING *`,
    [id, user],
  );
  if (rows[0]) await release("playbook", id);
  if (!rows[0]) {
    const current = await q<{ status: string; steps: PlaybookStep[]; step_cursor: number }>(
      `SELECT status, steps, step_cursor FROM playbooks
        WHERE id=$1 AND LOWER(user_address)=LOWER($2)`,
      [id, user],
    );
    if (current[0]?.steps?.[current[0].step_cursor]?.status === "firing") {
      throw new Error("That step is mid-trade. Give it a moment and cancel again.");
    }
    throw new Error("That playbook is not yours, or is already finished.");
  }
  await log(id, rows[0].step_cursor, "cancelled", "cancelled by the owner");
  return toPlaybook(rows[0]);
}

export interface PlaybookTickResult {
  advanced: number;
  filled: string[];
  completed: string[];
  errors: string[];
}

/**
 * How long a rung may sit mid-trade before we call it lost. Generously past a
 * Sepolia confirmation, because the cost of being hasty is a second fill.
 */
const FIRING_REAP_MINUTES = 10;

/**
 * A rung stuck at 'firing' means the worker holding it died between sending the
 * swap and recording what happened. We cannot tell from here whether the trade
 * landed, so the plan fails rather than retries: a retry risks spending twice,
 * and the person can read the transaction list and start a fresh plan. The hold
 * is let go either way, since a commitment the swap already consumed releases as
 * a no-op and one it never reached should not stay locked.
 */
async function reapStuckPlaybooks(result: PlaybookTickResult): Promise<void> {
  // Unknown submission is retained; reconciliation never starts a replacement business action.
  const stuck=await q<PlaybookRow>(`SELECT * FROM playbooks WHERE status='armed' AND COALESCE(steps->step_cursor->>'status','')='firing' ORDER BY updated_at LIMIT 20`);
  for(const row of stuck) {
    const steps=row.steps.map(s=>({...s})),cursor=row.step_cursor,step=steps[cursor];
    if(!step) continue;
    const settlement=await vaultSettlement(`playbook:${row.id}:${cursor}`);
    if(settlement.status==="pending") continue;
    if(settlement.status==="reverted") {
      await q("UPDATE playbooks SET status='failed',error='Transaction reverted',updated_at=now() WHERE id=$1 AND status='armed'",[row.id]);
      await release("playbook",row.id);continue;
    }
    step.status="done";step.txHash=settlement.txHash;step.amountOutRaw=settlement.amountOutRaw;step.firedAt=new Date().toISOString();
    if(steps[cursor+1]) steps[cursor+1].armedAt=step.firedAt;
    await q(`UPDATE playbooks SET steps=$2::jsonb,step_cursor=$3,updated_at=now() WHERE id=$1 AND step_cursor=$4 AND status='armed'`,[row.id,JSON.stringify(steps),cursor+1,cursor]);
    await release("playbook",row.id,"spent",cursor);
    if(!steps[cursor+1]) await complete(row.id,steps);
  }

}

export async function playbookTick(): Promise<PlaybookTickResult> {
  const result: PlaybookTickResult = { advanced: 0, filled: [], completed: [], errors: [] };
  const arming=await q<PlaybookRow>("SELECT * FROM playbooks WHERE status='arming' AND updated_at<now()-interval '5 minutes' ORDER BY updated_at LIMIT 20");
  for(const row of arming) {
    try {
      if(await recoverReservation("playbook",row.id))
        await q("UPDATE playbooks SET status='armed',updated_at=now() WHERE id=$1 AND status='arming'",[row.id]);
    } catch(err) { result.errors.push(`arming ${row.id}: ${(err as Error).message}`); }
  }
  await reapStuckPlaybooks(result).catch((err) =>
    result.errors.push(`reap: ${(err as Error).message}`),
  );
  const due = await q<{ id: string }>(
    `SELECT id FROM playbooks WHERE status='armed'
      ORDER BY last_checked_at ASC NULLS FIRST LIMIT $1`,
    [PLAYBOOK_TICK_BUDGET],
  );
  for (const { id } of due) {
    try {
      const before = await getPlaybook(id);
      const after = await advancePlaybook(id);
      result.advanced += 1;
      if (before && after.stepCursor > before.stepCursor) {
        const fired = after.steps[before.stepCursor];
        if (fired?.txHash) result.filled.push(fired.txHash);
      }
      if (after.status === "completed") result.completed.push(id);
    } catch (err) {
      result.errors.push(`playbook ${id}: ${(err as Error).message}`);
    }
  }
  return result;
}

function priorOutputAmount(steps:PlaybookStep[],step:PlaybookStep):string {
 const prior=steps[step.funding?.stepIndex??-1];
 if(prior?.status!=="done"||!prior.amountOutRaw) throw new Error("Confirmed upstream funding is missing.");
 const percent=parseUnits(step.action.amount,4);if(percent<=0n||percent>1000000n) throw new Error("Invalid upstream percentage.");
 const raw=BigInt(prior.amountOutRaw)*percent/1000000n;
 return formatUnits(raw,tokenBySymbol(step.action.tokenIn)!.decimals);
}
