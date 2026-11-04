/**
 * Event orders: a resting order whose trigger is a sentence rather than a price.
 *
 * The OrderBook already holds the arithmetic kind. "Sell if ETH crosses 4000" is
 * a number a feed can answer, so it lives on-chain and the keeper fills it from
 * a Chainlink read. "Sell if a top-five exchange halts withdrawals" is not a
 * number at all, and no feed will ever answer it. Those orders live here: the
 * condition is kept as the person wrote it, the judgment layer rules on it, and
 * a fill runs through the same signed-intent path an autonomous trade uses, so
 * the caps the user granted on-chain enforce themselves without being restated.
 *
 * The part worth reading twice is the screen. A condition the validators cannot
 * source evidence for is not a slow order, it is a broken one: it would rest
 * forever, and any fill it ever produced would be a guess dressed as a verdict.
 * So before an order is armed we spend one round trip asking whether public
 * evidence could settle it at all, and refuse it with a reason the person can
 * read if the answer is no. Refusing early is the honest failure.
 */

import {SubmissionPendingError} from "./chain.js";
import {getCommitment} from "./intents.js";
import {vaultSettlement} from "./settlement.js";
import { randomUUID } from "node:crypto";
import { tokenBySymbol, type TokenMeta } from "@roque/shared";
import { adjudicate, type Adjudication } from "./genlayer.js";
import { q } from "./db/index.js";
import { ethUsd } from "./prices.js";
import { preflightVaultSwap, executeVaultSwap } from "./services.js";
import { assertVaultFunds } from "./funding.js";
import { commitmentIdFor, reserve, recoverReservation, release } from "./reservations.js";

/**
 * How long an armed order waits between verdicts. A GenLayer adjudication is a
 * consensus round across validators, not a cheap read, so polling it on the
 * keeper's fifteen-second beat would be both slow and wasteful. Ten minutes is
 * quick enough for a news-driven condition and cheap enough to leave running.
 */
export const EVENT_CHECK_INTERVAL_MS = 10 * 60 * 1000;

/** An order not judged met within this window closes itself out. */
export const EVENT_DEFAULT_TTL_DAYS = 14;

/** How many orders one tick will adjudicate, so a tick stays inside its budget. */
export const EVENT_TICK_BUDGET = 3;

/** Consecutive execution failures before an order stops retrying. */
export const EVENT_MAX_FILL_ATTEMPTS = 3;

export type EventOrderStatus =
  | "screening"
  | "screened"
  | "rejected"
  | "armed"
  /** Mid-trade. Brief, and nothing else may touch the row while it lasts. */
  | "arming"
  | "firing"
  | "filled"
  | "failed"
  | "expired"
  | "cancelled";

export interface EventOrder {
  id: string;
  user: string;
  condition: string;
  tokenIn: string;
  tokenOut: string;
  amount: string;
  amountIsPercent: boolean;
  slippageBps: number;
  status: EventOrderStatus;
  screenVerdict: "verifiable" | "unverifiable" | null;
  screenReason: string | null;
  screenConfidence: string | null;
  screenSources: string[] | null;
  checks: number;
  lastCheckedAt: string | null;
  verdictMet: boolean | null;
  verdictConfidence: string | null;
  verdictRationale: string | null;
  evidence: Evidence | null;
  expiresAt: string | null;
  txHash: string | null;
  error: string | null;
  sourceSlug: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface EvidenceItem {
  source: string;
  title: string;
  published: string | null;
  url: string | null;
}

export interface Evidence {
  query: string;
  fetchedAt: string;
  items: EvidenceItem[];
  market: { ethUsd: number } | null;
  notes: string[];
}

interface EventOrderRow {
  id: string;
  user_address: string;
  condition: string;
  token_in: string;
  token_out: string;
  amount: string;
  amount_is_percent: boolean;
  slippage_bps: number;
  status: EventOrderStatus;
  screen_verdict: "verifiable" | "unverifiable" | null;
  screen_reason: string | null;
  screen_confidence: string | null;
  screen_sources: string[] | null;
  checks: number;
  last_checked_at: string | null;
  verdict_met: boolean | null;
  verdict_confidence: string | null;
  verdict_rationale: string | null;
  evidence: Evidence | null;
  expires_at: string | null;
  tx_hash: string | null;
  error: string | null;
  source_slug: string | null;
  created_at: string;
  updated_at: string;
}

const SELECT = `SELECT id, user_address, condition, token_in, token_out, amount,
  amount_is_percent, slippage_bps, status, screen_verdict, screen_reason,
  screen_confidence, screen_sources, checks, last_checked_at, verdict_met,
  verdict_confidence, verdict_rationale, evidence, expires_at, tx_hash, error,
  source_slug, created_at, updated_at FROM event_orders`;

function toEventOrder(row: EventOrderRow): EventOrder {
  return {
    id: row.id,
    user: row.user_address,
    condition: row.condition,
    tokenIn: row.token_in,
    tokenOut: row.token_out,
    amount: row.amount,
    amountIsPercent: row.amount_is_percent,
    slippageBps: row.slippage_bps,
    status: row.status,
    screenVerdict: row.screen_verdict,
    screenReason: row.screen_reason,
    screenConfidence: row.screen_confidence,
    screenSources: row.screen_sources,
    checks: row.checks,
    lastCheckedAt: row.last_checked_at,
    verdictMet: row.verdict_met,
    verdictConfidence: row.verdict_confidence,
    verdictRationale: row.verdict_rationale,
    evidence: row.evidence,
    expiresAt: row.expires_at,
    txHash: row.tx_hash,
    error: row.error,
    sourceSlug: row.source_slug,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ─────────────────────────────────────────────────────────────
// Screening: can anyone actually check this?
// ─────────────────────────────────────────────────────────────

/**
 * Conditions that are unverifiable on their face, caught without paying for a
 * consensus round. These are the patterns that show up constantly in practice:
 * a condition about the person's own private life, about somebody's unobservable
 * intent, or about nothing in particular. The list is deliberately short and
 * conservative, because the expensive screen behind it is the real judge and a
 * heuristic that rejects too eagerly is worse than one that defers.
 */
const UNVERIFIABLE_PATTERNS: Array<{ re: RegExp; why: string }> = [
  {
    re: /\b(i|we)\s+(feel|think|decide|want|change my mind|am ready)\b/iu,
    why: "it turns on how you feel, which no validator can observe",
  },
  {
    re: /\b(my|our)\s+(boss|wife|husband|partner|friend|mum|mom|dad|landlord|therapist|doctor)\b/iu,
    why: "it turns on a private matter in your own life, not a public fact",
  },
  {
    re: /\b(secretly|privately|behind closed doors|off the record)\b/iu,
    why: "it asks about something explicitly not public",
  },
  {
    re: /\b(will|going to|about to)\s+(probably|likely|eventually)\b/iu,
    why: "it asks for a prediction rather than an event anyone can confirm",
  },
];

/** A cheap local verdict, or null when the expensive screen should decide. */
export function localScreen(condition: string): { reason: string } | null {
  const text = condition.trim();
  if (text.length < 12) {
    return { reason: "the condition is too short to describe a checkable event" };
  }
  if (!/[a-z]{3}/iu.test(text)) {
    return { reason: "the condition does not describe an event in words" };
  }
  for (const { re, why } of UNVERIFIABLE_PATTERNS) {
    if (re.test(text)) return { reason: why };
  }
  return null;
}

/**
 * The meta-question. We reuse the deployed adjudicator rather than adding a new
 * entry point: framed this way, "met" means "a validator could settle this",
 * and the equivalence principle still compares on that one boolean, so the
 * validators have to agree about verifiability before an order is ever armed.
 */
function verifiabilityQuestion(condition: string): string {
  return [
    "VERIFIABILITY CHECK. Do not judge whether the statement is true.",
    "Judge only whether it could be checked.",
    "",
    'Answer met=true only if an independent person with ordinary web access could,',
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
// Evidence
// ─────────────────────────────────────────────────────────────

/** Strip the filler so the search query carries the nouns that matter. */
function searchQuery(condition: string): string {
  const stop = new Set([
    "if", "when", "the", "a", "an", "is", "are", "was", "were", "be", "been",
    "to", "of", "and", "or", "in", "on", "at", "by", "for", "with", "that",
    "this", "it", "any", "then", "sell", "buy", "swap", "my", "me", "i",
  ]);
  const words = condition
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/gu, " ")
    .split(/\s+/u)
    .filter((w) => w.length > 1 && !stop.has(w));
  return (words.length > 0 ? words : condition.split(/\s+/u)).slice(0, 12).join(" ");
}

/** Pull the fields we care about out of an RSS item without a parser dependency. */
function parseRss(xml: string, limit: number): EvidenceItem[] {
  const items: EvidenceItem[] = [];
  const blocks = xml.split(/<item[\s>]/iu).slice(1, limit + 1);
  for (const block of blocks) {
    const pick = (tag: string) => {
      const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "iu"));
      if (!m) return null;
      return m[1]
        .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gu, "$1")
        .replace(/<[^>]+>/gu, "")
        .replace(/&amp;/gu, "&")
        .replace(/&quot;/gu, '"')
        .replace(/&#39;/gu, "'")
        .replace(/&lt;/gu, "<")
        .replace(/&gt;/gu, ">")
        .trim();
    };
    const title = pick("title");
    if (!title) continue;
    items.push({
      source: pick("source") ?? "news",
      title: title.slice(0, 240),
      published: pick("pubDate"),
      url: pick("link"),
    });
  }
  return items;
}

/**
 * Gather what a validator would look at. The adjudicator on GenLayer does not
 * browse for itself, by design: it rules on evidence handed to it, which keeps
 * the verdict reproducible across validators reading the same bytes. So the
 * gathering happens here, and it is deliberately forgiving. A source that is
 * down becomes a note in the evidence, not an exception, because thin evidence
 * already resolves to "not met" and that is the safe direction to fail in.
 */
export async function gatherEvidence(condition: string): Promise<Evidence> {
  const query = searchQuery(condition);
  const notes: string[] = [];
  let items: EvidenceItem[] = [];

  try {
    const url =
      "https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=" +
      encodeURIComponent(query);
    const res = await fetch(url, {
      headers: { "user-agent": "roque-relayer/1.0 (+https://roque-dex.vercel.app)" },
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) notes.push(`news search returned HTTP ${res.status}`);
    else items = parseRss(await res.text(), 8);
  } catch (err) {
    notes.push(`news search unavailable: ${(err as Error).message}`);
  }
  if (items.length === 0 && notes.length === 0) {
    notes.push("no public reporting matched this query");
  }

  // The market reading is cheap and is context for almost any condition worth
  // trading on, so it goes in regardless of what the news search returned.
  let market: { ethUsd: number } | null = null;
  try {
    market = { ethUsd: (await ethUsd()).usd };
  } catch {
    notes.push("price feed unavailable");
  }

  return { query, fetchedAt: new Date().toISOString(), items, market, notes };
}

// ─────────────────────────────────────────────────────────────
// Lifecycle
// ─────────────────────────────────────────────────────────────

export interface CreateEventOrderInput {
  user: string;
  condition: string;
  tokenIn: string;
  tokenOut: string;
  amount: string;
  amountIsPercent?: boolean;
  slippageBps?: number;
  expiresInDays?: number;
  sourceSlug?: string;
}

function requireToken(symbol: string): TokenMeta {
  const token = tokenBySymbol(symbol);
  if (!token) throw new Error(`Unknown token ${symbol}.`);
  return token;
}

/**
 * Record the order in the screening state. Nothing is armed and nothing can
 * fill until `screenEventOrder` has ruled, so a crash between the two leaves an
 * inert row that the next tick picks up rather than a live order nobody vetted.
 */
export async function createEventOrder(input: CreateEventOrderInput): Promise<EventOrder> {
  const tokenIn = requireToken(input.tokenIn);
  const tokenOut = requireToken(input.tokenOut);
  if (tokenIn.symbol === tokenOut.symbol) throw new Error("A trade needs two different tokens.");

  const condition = input.condition.trim();
  if (!condition) throw new Error("An event order needs a condition.");
  if (condition.length > 500) throw new Error("Keep the condition under 500 characters.");

  const amount = input.amount.trim();
  if (!/^\d+(\.\d+)?$/u.test(amount) || Number(amount) <= 0) {
    throw new Error("The amount has to be a positive number.");
  }
  if (input.amountIsPercent && Number(amount) > 100) {
    throw new Error("A percentage amount has to be between 0 and 100.");
  }

  // The vault is the only money this order can ever spend, so it is checked
  // here rather than at fill time. Creating the order is what a person signs,
  // and the fill happens days later with nobody watching; refusing now is the
  // difference between "you cannot afford this" and an order that arms, waits,
  // gets its verdict and then quietly fails on a balance nobody mentioned.
  await assertVaultFunds(input.user as `0x${string}`, [
    {
      tokenIn: tokenIn.symbol,
      tokenOut: tokenOut.symbol,
      amount,
      amountIsPercent: input.amountIsPercent ?? false,
      where: "This order",
    },
  ]);

  const days = Math.min(Math.max(input.expiresInDays ?? EVENT_DEFAULT_TTL_DAYS, 1), 90);
  const slippage = Math.min(Math.max(input.slippageBps ?? 100, 1), 5_000);

  const rows = await q<EventOrderRow>(
    `INSERT INTO event_orders
       (id, user_address, condition, token_in, token_out, amount, amount_is_percent,
        slippage_bps, status, expires_at, source_slug)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'screening', now() + ($9 || ' days')::interval, $10)
     RETURNING *`,
    [
      randomUUID(),
      input.user.toLowerCase(),
      condition,
      tokenIn.symbol,
      tokenOut.symbol,
      amount,
      input.amountIsPercent ?? false,
      slippage,
      String(days),
      input.sourceSlug ?? null,
    ],
  );
  // Nothing is promised yet. The vault was checked above so the person is told
  // now rather than after a consensus round, but the money is not held until
  // they arm the order themselves -- holding a balance against every sentence
  // somebody screened would lock up a vault for orders that never go live.
  return toEventOrder(rows[0]);
}

/**
 * Decide whether the order may be armed. The local heuristics run first and can
 * refuse on their own; anything they let through costs one consensus round on
 * the meta-question, with a live evidence sample attached so the validators are
 * judging what a real check would actually turn up rather than the idea of one.
 */
export async function screenEventOrder(id: string): Promise<EventOrder> {
  const rows = await q<EventOrderRow>(`${SELECT} WHERE id=$1`, [id]);
  const row = rows[0];
  if (!row) throw new Error("No such event order.");
  if (row.status !== "screening") return toEventOrder(row);

  // Same lease as the verdict, for the same reason: a screen is a consensus
  // round, and a cron tick overlapping the standalone loop would otherwise buy
  // the same answer twice. Two minutes is long enough that a screen in flight
  // is not re-taken and short enough that a crashed one is retried promptly.
  const taken = await q<{ id: string }>(
    `UPDATE event_orders SET last_checked_at=now(), updated_at=now()
      WHERE id=$1 AND status='screening'
        AND (last_checked_at IS NULL OR last_checked_at < now() - interval '2 minutes')
      RETURNING id`,
    [id],
  );
  if (taken.length !== 1) return toEventOrder(row);

  const quick = localScreen(row.condition);
  if (quick) return reject(id, quick.reason, "high", null);

  let evidence: Evidence;
  try {
    evidence = await gatherEvidence(row.condition);
  } catch (err) {
    // A gathering failure is about our network, not about the condition, so the
    // order stays in screening and the next tick tries again.
    await q(`UPDATE event_orders SET error=$2, updated_at=now() WHERE id=$1`, [
      id,
      `evidence gathering failed: ${(err as Error).message}`,
    ]);
    return toEventOrder((await q<EventOrderRow>(`${SELECT} WHERE id=$1`, [id]))[0]);
  }

  let verdict: Adjudication;
  try {
    verdict = await adjudicate(
      `screen:${id}`,
      verifiabilityQuestion(row.condition),
      { sampleEvidence: evidence },
    );
  } catch (err) {
    await q(`UPDATE event_orders SET error=$2, updated_at=now() WHERE id=$1`, [
      id,
      `screening failed: ${(err as Error).message}`,
    ]);
    return toEventOrder((await q<EventOrderRow>(`${SELECT} WHERE id=$1`, [id]))[0]);
  }

  const sources = evidence.items.map((i) => i.source).filter((s, n, a) => a.indexOf(s) === n);
  if (!verdict.met) {
    return reject(
      id,
      verdict.rationale || "no public source could settle this condition",
      verdict.confidence,
      sources,
    );
  }

  // Verifiable, and that is all this step decides. The order waits at
  // 'screened' for the person to arm it: a screen answers "could this be
  // checked", which is not the same question as "put my money behind it", and
  // running the two together meant a sentence became a live commitment without
  // anybody pressing anything.
  const screened = await q<EventOrderRow>(
    `UPDATE event_orders
        SET status='screened', screen_verdict='verifiable', screen_reason=$2,
            screen_confidence=$3, screen_sources=$4, evidence=$5, error=NULL,
            updated_at=now()
      WHERE id=$1 AND status='screening' RETURNING *`,
    [id, verdict.rationale, verdict.confidence, JSON.stringify(sources), JSON.stringify(evidence)],
  );
  return toEventOrder(screened[0] ?? rows[0]);
}

/**
 * Arm a screened order, which is the moment it becomes a real commitment.
 *
 * This is where the money is promised, for the same reason a playbook holds
 * nothing until it is armed: a screened order is a sentence the validators say
 * they could check, and holding a balance against every sentence somebody tried
 * would lock up a vault for nothing.
 *
 * The vault is checked again here rather than trusted from creation time. The
 * screen is a consensus round and takes half a minute; the balance can have
 * moved, or another order can have promised it, in between.
 */
export async function armEventOrder(id: string, user: string): Promise<EventOrder> {
  const rows = await q<EventOrderRow>(
    `${SELECT} WHERE id=$1 AND LOWER(user_address)=LOWER($2)`,
    [id, user],
  );
  const row = rows[0];
  if (!row) throw new Error("That order is not yours.");
  if (row.status === "armed") return toEventOrder(row);
  if (row.status !== "screened") {
    throw new Error("Only an order the validators have cleared can be armed.");
  }
  if (row.expires_at && new Date(row.expires_at).getTime() <= Date.now()) {
    throw new Error("That order ran out its clock before it was armed.");
  }

  const tokenIn = requireToken(row.token_in);
  await assertVaultFunds(row.user_address as `0x${string}`, [
    {
      tokenIn: tokenIn.symbol,
      tokenOut: requireToken(row.token_out).symbol,
      amount: row.amount,
      amountIsPercent: row.amount_is_percent,
      where: "This order",
    },
  ]);

  const armed = await q<EventOrderRow>(
    `UPDATE event_orders SET status='arming', error=NULL, updated_at=now()
      WHERE id=$1 AND status='screened' RETURNING *`,
    [id],
  );
  if (!armed[0]) throw new Error("That order is no longer waiting to be armed.");

  // Claimed after the status moves, so two requests cannot both get here, and
  // rolled back if the hold does not land. An armed order with nothing behind it
  // is the worse of the two failures: it looks live, it counts for nothing in
  // the funding gate, and the next order written against the same money is
  // allowed to promise it. Better to send the person back to a screened order
  // with the contract's reason attached.
  try {
    await reserve([
      {
        user: row.user_address,
        token: tokenIn.symbol,
        amount: row.amount,
        amountIsPercent: row.amount_is_percent,
        source: "event_order",
        sourceId: id,
        // The hold is given two days beyond the order's own clock. They are
        // the same deadline otherwise, and an order filling in the last
        // moments of its life would find its hold already lapsed and refuse
        // itself. The sweep releases the hold when the order expires, so the
        // slack only matters if the sweep never runs.
        holdUntil: row.expires_at
          ? new Date(new Date(row.expires_at).getTime() + 2 * 24 * 60 * 60 * 1000)
          : undefined,
      },
    ]);
  } catch (err) {
    if(err instanceof SubmissionPendingError) return toEventOrder(armed[0]);
    // The lock is written before the row that records it, so a failure in
    // between leaves money held on-chain for something that is no longer armed.
    // `release` derives its candidate ids from the source instead of reading a
    // row, which is exactly this case, and an id that was never locked reads as
    // inactive and is skipped. So it is safe whether the lock landed or not.
    //
    // Leaving this out is what stranded 150 rUSDC on 2026-10-03. The orphan then
    // blocked re-arming, because the funding gate measures `available` off the
    // chain and could not tell that the lock in its way belonged to the very
    // order being armed.
    let stranded = false;
    try {
      await release("event_order", id);
    } catch {
    // Freeing it failed too. The original reason is the more useful one to
    // raise, so that is what is thrown, but the money really may still be held
    // and the row is the only place the person would find that out.
      stranded = true;
    }
    await q(
      `UPDATE event_orders SET status='screened', error=$2, updated_at=now()
        WHERE id=$1 AND status='arming'`,
      [
        id,
        `could not hold the vault money: ${(err as Error).message}` +
          (stranded ? " Freeing what did land also failed, so some may still be held." : ""),
      ],
    );
    throw err;
  }
  const completed=await q<EventOrderRow>(`UPDATE event_orders SET status='armed',updated_at=now() WHERE id=$1 AND status='arming' RETURNING *`,[id]);
  return toEventOrder(completed[0]??armed[0]);
}

async function reject(
  id: string,
  reason: string,
  confidence: string,
  sources: string[] | null,
): Promise<EventOrder> {
  const rows = await q<EventOrderRow>(
    `UPDATE event_orders
        SET status='rejected', screen_verdict='unverifiable', screen_reason=$2,
            screen_confidence=$3, screen_sources=$4, updated_at=now()
      WHERE id=$1 RETURNING *`,
    [id, reason, confidence, sources ? JSON.stringify(sources) : null],
  );
  // A refused order will never trade, so its claim on the vault ends here
  // rather than sitting held forever against an order nobody can arm.
  await release("event_order", id);
  return toEventOrder(rows[0]);
}

/**
 * Ask whether the condition has now happened, and act if it has. Two guards sit
 * in front of the trade. A verdict of met with low confidence does not fill: the
 * adjudicator is told to lean sceptical, so low confidence on a "yes" is the
 * model telling us it is not sure, and money should not move on that. And the
 * fill itself goes through the shared vault gate, so the user's on-chain caps
 * apply to an order the keeper triggered exactly as they would to one the user
 * pressed themselves.
 */
export async function evaluateEventOrder(id: string): Promise<EventOrder> {
  // Take the check before doing it. An adjudication is a consensus round worth
  // tens of seconds, and two workers that both read this row as due would both
  // pay for it and both get the same answer. Stamping last_checked_at under the
  // same interval guard the selection used means the second one finds nothing to
  // take. A retry of a met verdict is exempt: it has a verdict already and is
  // only here because the fill did not land.
  const leased = await q<EventOrderRow>(
    `UPDATE event_orders SET last_checked_at=now(), updated_at=now()
      WHERE id=$1 AND status='armed'
        AND (verdict_met IS TRUE
             OR last_checked_at IS NULL
             OR last_checked_at < now() - ($2 || ' milliseconds')::interval)
      RETURNING *`,
    [id, String(EVENT_CHECK_INTERVAL_MS)],
  );
  if (!leased[0]) {
    const current = await q<EventOrderRow>(`${SELECT} WHERE id=$1`, [id]);
    if (!current[0]) throw new Error("No such event order.");
    return toEventOrder(current[0]);
  }
  const row = leased[0];

  if (row.expires_at && new Date(row.expires_at).getTime() <= Date.now()) {
    const done = await q<EventOrderRow>(
      `UPDATE event_orders SET status='expired', updated_at=now()
        WHERE id=$1 AND status='armed' RETURNING *`,
      [id],
    );
    await release("event_order", id);
    return toEventOrder(done[0] ?? row);
  }

  // A verdict already returned met; we are here only because the fill did not
  // land. Retry the trade without paying for another consensus round.
  if (row.verdict_met === true) return fill(row);

  const evidence = await gatherEvidence(row.condition);
  const verdict = await adjudicate(`event:${id}:${row.checks + 1}`, row.condition, {
    evidence,
    asOf: new Date().toISOString(),
  });

  const updated = await q<EventOrderRow>(
    `UPDATE event_orders
        SET checks=checks+1, last_checked_at=now(), evidence=$2, verdict_met=$3,
            verdict_confidence=$4, verdict_rationale=$5, updated_at=now()
      WHERE id=$1 RETURNING *`,
    [
      id,
      JSON.stringify(evidence),
      verdict.met && verdict.confidence !== "low",
      verdict.confidence,
      verdict.rationale,
    ],
  );
  const next = updated[0] ?? row;
  return next.verdict_met === true ? fill(next) : toEventOrder(next);
}

/** Errors worth retrying: the chain or the network, not the order itself. */
function isTransientChainError(message: string): boolean {
  return /timeout|timed out|ECONN|ETIMEDOUT|fetch failed|socket|rate limit|429|502|503|504|nonce|replacement|already known/iu.test(
    message,
  );
}

/**
 * Trade, having decided the condition is met.
 *
 * The claim at the top is the concurrency gate, and it has to be in front of the
 * trade rather than behind it. The old shape sent the swap first and only then
 * tried to move the row from armed to filled, which meant two workers reaching
 * here together -- a Vercel cron tick and the standalone judgment loop, say --
 * both traded, and only the second discovered it had been beaten. One verdict,
 * two fills, and the second one spending money the first had already moved.
 *
 * So the row moves to 'firing' first, under a guard only one of them can pass.
 * The loser returns without trading. 'firing' also keeps the expiry sweep off a
 * row whose transaction is in flight, which was the same bug from the other
 * direction: a sweep could expire the order and release its hold while the swap
 * fulfilling it was still in the mempool.
 */
async function fill(row: EventOrderRow): Promise<EventOrder> {
  const claimed = await q<{ id: string }>(
    `UPDATE event_orders SET status='firing', updated_at=now()
      WHERE id=$1 AND status='armed' RETURNING id`,
    [row.id],
  );
  if (claimed.length !== 1) return toEventOrder(row);

  let submissionStarted = false;
  try {
    const plan = await preflightVaultSwap({
      user: row.user_address as `0x${string}`,
      tokenIn: requireToken(row.token_in),
      tokenOut: requireToken(row.token_out),
      amount: row.amount,
      amountIsPercent: row.amount_is_percent,
      slippageBps: row.slippage_bps,
      commitmentId: commitmentIdFor("event_order", row.id),
    });
    submissionStarted = true;
    const txHash = await executeVaultSwap(row.user_address as `0x${string}`, plan,`event:${row.id}`);
    const done = await q<EventOrderRow>(
      `UPDATE event_orders SET status='firing', tx_hash=$2, error=NULL, updated_at=now()
        WHERE id=$1 AND status='firing' RETURNING *`,
      [row.id, txHash],
    );
    // The promise was kept, so the claim is spent rather than released. The
    // money has genuinely left the vault by now and the on-chain balance
    // already reflects that; holding it twice would under-report what is free.
    return reconcileEvent(done[0] ?? {...row,tx_hash:txHash});
  } catch (err) {
    if (submissionStarted) return toEventOrder({...row,status:"firing"});
    const message = (err as Error).message;
    // Retry a blip; give up on a refusal the next attempt would also earn, and
    // give up either way once the attempts are spent, so a broken order cannot
    // quietly spend gas forever.
    const attempts = row.checks + 1;
    const keepTrying = isTransientChainError(message) && attempts < EVENT_MAX_FILL_ATTEMPTS;
    const done = await q<EventOrderRow>(
      `UPDATE event_orders SET status=$3, error=$2, updated_at=now()
        WHERE id=$1 AND status='firing' RETURNING *`,
      [row.id, message, keepTrying ? "armed" : "failed"],
    );
    // Only once the order has really given up. While it is still retrying the
    // money stays held, because the next attempt will need it.
    if (!keepTrying) await release("event_order", row.id);
    return toEventOrder(done[0] ?? row);
  }
}

// ─────────────────────────────────────────────────────────────
// Reads and the tick
// ─────────────────────────────────────────────────────────────

export async function listEventOrders(user: string, limit = 50): Promise<EventOrder[]> {
  const rows = await q<EventOrderRow>(
    `${SELECT} WHERE LOWER(user_address)=LOWER($1) ORDER BY created_at DESC LIMIT $2`,
    [user, limit],
  );
  return rows.map(toEventOrder);
}

export async function getEventOrder(id: string): Promise<EventOrder | null> {
  const rows = await q<EventOrderRow>(`${SELECT} WHERE id=$1`, [id]);
  return rows[0] ? toEventOrder(rows[0]) : null;
}

/** Cancel is owner-scoped in the statement itself, so a wrong owner changes nothing. */
export async function cancelEventOrder(id: string, user: string): Promise<EventOrder> {
  const rows = await q<EventOrderRow>(
    `UPDATE event_orders SET status='cancelled', updated_at=now()
      WHERE id=$1 AND LOWER(user_address)=LOWER($2)
        AND status IN ('screening','screened','armed') RETURNING *`,
    [id, user],
  );
  if (!rows[0]) throw new Error("That order is not yours, or is no longer open.");
  await release("event_order", id);
  return toEventOrder(rows[0]);
}

export interface EventTickResult {
  screened: number;
  evaluated: number;
  filled: string[];
  rejected: string[];
  errors: string[];
}

/**
 * One pass over the orders that need attention. Screening comes first because an
 * order stuck unscreened is doing nothing for its owner, and the work is bounded
 * per tick because each item is a consensus round and the tick runs on a serverless
 * clock with a hard ceiling.
 */
export async function eventTick(): Promise<EventTickResult> {
  const result: EventTickResult = {
    screened: 0, evaluated: 0, filled: [], rejected: [], errors: [],
  };

  const pending = await q<{ id: string }>(
    `SELECT id FROM event_orders WHERE status='screening'
      ORDER BY created_at ASC LIMIT $1`,
    [EVENT_TICK_BUDGET],
  );
  for (const { id } of pending) {
    try {
      const order = await screenEventOrder(id);
      result.screened += 1;
      if (order.status === "rejected") result.rejected.push(id);
    } catch (err) {
      result.errors.push(`screen ${id}: ${(err as Error).message}`);
    }
  }

  const due = await q<{ id: string }>(
    `SELECT id FROM event_orders
      WHERE status='armed'
        AND (last_checked_at IS NULL OR last_checked_at < now() - ($2 || ' milliseconds')::interval)
      ORDER BY last_checked_at ASC NULLS FIRST LIMIT $1`,
    [Math.max(EVENT_TICK_BUDGET - pending.length, 1), String(EVENT_CHECK_INTERVAL_MS)],
  );
  for (const { id } of due) {
    try {
      const order = await evaluateEventOrder(id);
      result.evaluated += 1;
      if (order.status === "filled" && order.txHash) result.filled.push(order.txHash);
    } catch (err) {
      result.errors.push(`evaluate ${id}: ${(err as Error).message}`);
    }
  }

  const arming=await q<EventOrderRow>(`${SELECT} WHERE status='arming' AND updated_at<now()-interval '5 minutes' ORDER BY updated_at LIMIT 20`);
  for(const row of arming) {
    try {
      if(await recoverReservation("event_order",row.id))
        await q("UPDATE event_orders SET status='armed',updated_at=now() WHERE id=$1 AND status='arming'",[row.id]);
    } catch(err) { result.errors.push(`arming ${row.id}: ${(err as Error).message}`); }
  }
  const submitted=await q<EventOrderRow>(`${SELECT} WHERE status='firing' ORDER BY updated_at LIMIT 20`);
  for(const row of submitted) {
    try { await reconcileEvent(row); } catch(err) { result.errors.push(`reconcile ${row.id}: ${(err as Error).message}`); }
  }

  // 'firing' is deliberately absent. A row whose swap is in the mempool must
  // not be expired out from under it, or the sweep releases the hold the trade
  // is about to spend.
  const expired = await q<{ id: string }>(
    `UPDATE event_orders SET status='expired', updated_at=now()
      WHERE status IN ('armed','screened') AND expires_at IS NOT NULL
        AND expires_at <= now()
      RETURNING id`,
  );
  // This sweep never goes through evaluateEventOrder, so it has to let the
  // claims go itself, or money stays held against an order that has lapsed.
  for (const { id } of expired) {
    try {
      await release("event_order", id);
    } catch (err) {
      result.errors.push(`release ${id}: ${(err as Error).message}`);
    }
  }
  if (expired.length > 0) result.evaluated += expired.length;

  return result;
}

async function reconcileEvent(row:EventOrderRow):Promise<EventOrder> {
 const settlement=await vaultSettlement(`event:${row.id}`);
 if(settlement.status==="pending") return toEventOrder({...row,status:"firing"});
 const rows=await q<EventOrderRow>(`UPDATE event_orders SET status=$2,tx_hash=$3,error=$4,updated_at=now() WHERE id=$1 AND status='firing' RETURNING *`,
   [row.id,settlement.status==="confirmed"?"filled":"failed",settlement.txHash,settlement.status==="reverted"?"Transaction reverted":null]);
 if(rows[0]) await release("event_order",row.id,settlement.status==="confirmed"?"spent":"released");
 return toEventOrder(rows[0]??row);
}
