/**
 * Vault money already promised to something.
 *
 * `funding.ts` answers "can the vault pay for this?" by reading the chain. That
 * was the whole story while every trade was signed and settled in one breath,
 * and it stopped being the whole story the moment an order could rest for a
 * fortnight. An event order is a promise to spend days from now, and until that
 * promise was written down it was invisible: the money sat in the vault looking
 * spendable, counted as available to the next order written against it, and
 * could be withdrawn in full while the order meant to spend it was still armed.
 *
 * This module used to be where that promise lived, as a row in a table, and the
 * honest caveat printed at the top was that a row is not a lock. It shut the
 * app's own withdraw button and nothing else. A person could spend the same
 * balance on an ordinary autonomous trade and withdraw what it bought, since the
 * ledger had never heard of the token on the other side. The hold was a note
 * stuck to money anyone could walk past.
 *
 * So the executor owns the hold now. `AgentExecutor.lockedBalance` is the line
 * between the free and committed halves of a vault, withdraw and every agent
 * trade are measured against it, and nothing can route around it because the
 * only function that can move the money is the one doing the checking.
 *
 * What is left here is the story, not the custody. A row records which order
 * promised what, which rung of which plan, and whether the figure came from a
 * percentage somebody typed, so the vault panel can say "committed to 2 live
 * orders" instead of an unexplained number. The figures themselves are read off
 * the chain. When the two disagree the chain is right, by construction.
 *
 * The percentage case is still the awkward one. Its size is decided at fire
 * time against whatever the balance is then, so there is no figure it has
 * committed to in advance. Holding nothing turned out to be useless in exactly
 * the case people reach for first: "spend all of my rUSDC when X happens" held
 * nothing at all, and the vault showed the whole balance as free right up until
 * the order tried to fill. So a share is resolved against what is free at the
 * moment it is promised and that figure is locked, with the percentage kept
 * beside it so the UI can say where the number came from. The fill still sizes
 * itself at fire time. What the hold promises is "this much will still be here",
 * which is the useful guarantee even when the final size is decided later.
 */

import { randomUUID } from "node:crypto";
import { formatUnits, keccak256, parseUnits, stringToHex } from "viem";
import { tokenBySymbol, type TokenMeta } from "@roque/shared";
import { q } from "./db/index.js";
import {
  freshNonce,
  lockCommitments,
  lockedBalance,
  releaseCommitments,
  vaultBalance,
  vaultSnapshot,
  type CommitIntent,
} from "./intents.js";

/** What promised the money. Releasing is keyed to this, not to a row id. */
export type ReservationSource = "event_order" | "playbook";

/**
 * Default life of a hold when a caller names no end. Every commitment carries
 * one: the contract refuses an unbounded hold, so that a lost agent key cannot
 * tie up somebody's vault forever. Thirty days comfortably outlasts the
 * fourteen-day default an event order gets.
 */
const DEFAULT_HOLD_DAYS = 30;

/** The contract's own ceiling, with a day of room so rounding cannot cross it. */
const MAX_HOLD_DAYS = 119;

/**
 * The most rungs a playbook can have, which bounds how many commitment ids one
 * source can own. Kept as a local number rather than imported from playbooks.ts
 * because that module imports this one, and a cycle to share a 10 is a poor
 * trade. Over-counting is harmless: an id that was never locked reads as
 * inactive and is skipped.
 */
const MAX_SOURCE_STEPS = 10;

export interface ReservationInput {
  user: string;
  token: string;
  /** Human units, as written. Ignored when `percent` is set. */
  amount: string;
  /** True when `amount` is a share of the balance rather than a figure. */
  amountIsPercent?: boolean;
  source: ReservationSource;
  sourceId: string;
  /** Which rung of a playbook. Zero for an event order, which has one leg. */
  stepIndex?: number;
  /** When the hold should lapse on its own. Defaults to thirty days out. */
  holdUntil?: Date;
}

export interface TokenHold {
  symbol: string;
  /** Absolute units the executor is holding, straight off the chain. */
  raw: bigint;
  /** Percent shares behind the hold, for explaining where a figure came from. */
  percents: number[];
  /** How many open claims make up this hold. */
  claims: number;
}

interface ReservationRow {
  token: string;
  amount_raw: string;
  percent: string | null;
}

function requireToken(symbol: string): TokenMeta {
  const token = tokenBySymbol(symbol);
  if (!token) throw new Error(`Unknown token ${symbol}.`);
  return token;
}

/**
 * The commitment id for one promise, derived rather than stored.
 *
 * Deriving it from what made the promise is what buys idempotence for free:
 * arming the same order twice, or a keeper running twice over the same rung,
 * names the same commitment both times, and the contract resizes that one hold
 * instead of stacking a second claim on the same money. There is no id to keep
 * in step with anything, and no way for a row and a lock to drift apart.
 */
export function commitmentIdFor(
  source: ReservationSource,
  sourceId: string,
  stepIndex = 0,
): `0x${string}` {
  return keccak256(stringToHex(`roque:${source}:${sourceId}:${stepIndex}`));
}

function holdDeadline(holdUntil?: Date): bigint {
  const now = Date.now();
  const floor = now + 60 * 60 * 1000;
  const ceiling = now + MAX_HOLD_DAYS * 24 * 60 * 60 * 1000;
  const wanted = holdUntil ? holdUntil.getTime() : now + DEFAULT_HOLD_DAYS * 24 * 60 * 60 * 1000;
  const clamped = Math.min(Math.max(wanted, floor), ceiling);
  return BigInt(Math.floor(clamped / 1000));
}

/**
 * Promise the money, on-chain, and record what promised it.
 *
 * The lock goes first and this does not return until the chain has confirmed
 * it, because an order called armed while its hold is still in the mempool is
 * the original bug with extra steps: the funding gate would read a lock that is
 * not there and let the next order promise the same balance. A refusal from the
 * contract propagates as a thrown error, which is what turns "your vault cannot
 * cover this" into a sentence at the moment somebody presses the button rather
 * than a fill that quietly never happens.
 *
 * The rows are written after, and only after. A row with no lock behind it would
 * overstate what is committed; the figures are read from the chain anyway, so
 * the worst a missing row costs is a less specific sentence in the UI.
 */
export async function reserve(legs: ReservationInput[]): Promise<void> {
  if (legs.length === 0) return;

  const prepared: Array<{ leg: ReservationInput; token: TokenMeta; raw: bigint; percent: number | null; id: `0x${string}` }> = [];
  // Running total of what this call has already claimed, so a plan with two
  // rungs on the same token sizes its second share against what the first one
  // left rather than against the same free balance twice.
  const claimedHere = new Map<string, bigint>();

  for (const leg of legs) {
    const token = requireToken(leg.token);
    const percent = leg.amountIsPercent ? Number(leg.amount) : null;
    let raw: bigint;
    if (percent === null) {
      raw = parseUnits(leg.amount, token.decimals);
    } else {
      const free = (await availability(leg.user, token.symbol)).available;
      const alreadyHere = claimedHere.get(token.symbol) ?? 0n;
      const spare = free > alreadyHere ? free - alreadyHere : 0n;
      raw = (spare * BigInt(Math.round(percent * 100))) / 10_000n;
    }
    if (raw <= 0n) {
      throw new Error(
        `There is no ${token.symbol} free in your vault to promise to this order.`,
      );
    }
    claimedHere.set(token.symbol, (claimedHere.get(token.symbol) ?? 0n) + raw);
    prepared.push({
      leg,
      token,
      raw,
      percent,
      id: commitmentIdFor(leg.source, leg.sourceId, leg.stepIndex ?? 0),
    });
  }

  const user = legs[0].user.toLowerCase() as `0x${string}`;
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 300);
  const intents: CommitIntent[] = [];
  for (const item of prepared) {
    intents.push({
      user: item.leg.user.toLowerCase() as `0x${string}`,
      token: item.token.address,
      amount: item.raw,
      unlockAt: holdDeadline(item.leg.holdUntil),
      commitmentId: item.id,
      nonce: await freshNonce(user),
      deadline,
    });
  }

  const batchId = `hold:${legs[0].source}:${legs[0].sourceId}:${randomUUID()}`;
  await q("INSERT INTO reservation_batches(id,source_kind,source_id,payload) VALUES($1,$2,$3,$4::jsonb)",
    [batchId,legs[0].source,legs[0].sourceId,JSON.stringify({prepared,intents},(_key,value)=>typeof value==="bigint"?value.toString():value)]);
  await lockCommitments(intents,batchId);
  await persistReservations(prepared);
  await q("UPDATE reservation_batches SET status='held' WHERE id=$1",[batchId]);
}

async function persistReservations(prepared:Array<{leg:ReservationInput;token:TokenMeta;raw:bigint;percent:number|null;id:`0x${string}`}>) {

  for (const item of prepared) {
    await q(
      `INSERT INTO vault_reservations
         (id, user_address, token, amount_raw, percent, source_kind, source_id, step_index,
          commitment_id, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'held')
       ON CONFLICT (source_kind, source_id, step_index) DO UPDATE
         SET amount_raw    = EXCLUDED.amount_raw,
             percent       = EXCLUDED.percent,
             token         = EXCLUDED.token,
             commitment_id = EXCLUDED.commitment_id,
             status        = 'held',
             released_at   = NULL`,
      [
        randomUUID(),
        item.leg.user.toLowerCase(),
        item.token.symbol,
        item.raw.toString(),
        item.percent,
        item.leg.source,
        item.leg.sourceId,
        item.leg.stepIndex ?? 0,
        item.id,
      ],
    );
  }
}

/** Resume the recorded hold with identical business data, including after a lost reply. */
export async function recoverReservation(source:string,sourceId:string):Promise<boolean> {
  const rows=await q<{id:string;payload:{prepared:Array<{leg:ReservationInput;token:TokenMeta;raw:string;percent:number|null;id:`0x${string}`}>;intents:Array<Record<string,string>>}}>(
    "SELECT id,payload FROM reservation_batches WHERE source_kind=$1 AND source_id=$2 ORDER BY created_at DESC LIMIT 1",[source,sourceId]);
  const batch=rows[0];if(!batch)return false;
  const intents=batch.payload.intents.map(i=>({...i,amount:BigInt(i.amount),unlockAt:BigInt(i.unlockAt),nonce:BigInt(i.nonce),deadline:BigInt(i.deadline)})) as CommitIntent[];
  await lockCommitments(intents,batch.id);
  await persistReservations(batch.payload.prepared.map(p=>({...p,raw:BigInt(p.raw)})));
  await q("UPDATE reservation_batches SET status='held' WHERE id=$1",[batch.id]);
  return true;
}

/**
 * Let a claim go. `spent` when the trade actually happened and `released` when
 * it never will. Both stop counting against the balance, and the distinction is
 * kept because "this money was used" and "this order was called off" are
 * different facts somebody will want to tell apart later.
 *
 * It is also the difference between sending a transaction and not. A spend
 * consumed the commitment inside the same swap that moved the tokens, so the
 * chain has already let go and there is nothing to ask it for. A release has to
 * be asked for, and is asked for before the rows are marked, so a failure
 * leaves the claim standing rather than claiming a hold is gone while the chain
 * still holds it.
 *
 * With no `stepIndex` this releases every rung of the source, which is what
 * cancelling a playbook means. With one, it releases that rung alone, which is
 * what finishing a step means.
 */
export async function release(
  source: ReservationSource,
  sourceId: string,
  outcome: "spent" | "released" = "released",
  stepIndex?: number,
): Promise<void> {
  if (outcome === "released") {
    // Derived, not looked up. Reading the rows first would make releasing
    // depend on a row having survived, and the one case where that fails is
    // the one that matters: a lock that landed on-chain while the write
    // recording it did not. The ids are a pure function of the source, the
    // owner comes off the commitment, and an id that was never locked reads as
    // inactive and is skipped. So this frees the money whatever the table says.
    const steps =
      stepIndex !== undefined
        ? [stepIndex]
        : source === "event_order"
          ? [0]
          : Array.from({ length: MAX_SOURCE_STEPS }, (_, i) => i);
    await releaseCommitments(steps.map((i) => commitmentIdFor(source, sourceId, i)));
  }

  if (stepIndex === undefined) {
    await q(
      `UPDATE vault_reservations SET status=$3, released_at=now()
        WHERE source_kind=$1 AND source_id=$2 AND status='held'`,
      [source, sourceId, outcome],
    );
    return;
  }
  await q(
    `UPDATE vault_reservations SET status=$4, released_at=now()
      WHERE source_kind=$1 AND source_id=$2 AND step_index=$3 AND status='held'`,
    [source, sourceId, stepIndex, outcome],
  );
}

/**
 * Every open claim a user has, grouped by token.
 *
 * The figure is the chain's: `lockedBalance` is what the executor will actually
 * refuse to move. The rows only supply the explanation, so a stale or missing
 * row makes the sentence vaguer and never makes the number wrong.
 */
export async function heldByToken(user: string): Promise<Map<string, TokenHold>> {
  const owner = user.toLowerCase() as `0x${string}`;
  const [snapshot, rows] = await Promise.all([
    vaultSnapshot(owner),
    q<ReservationRow>(
      `SELECT token, amount_raw, percent FROM vault_reservations
        WHERE LOWER(user_address)=LOWER($1) AND status='held'`,
      [user],
    ),
  ]);

  const held = new Map<string, TokenHold>();
  for (const [symbol, state] of snapshot) {
    if (state.locked > 0n) {
      held.set(symbol, { symbol, raw: state.locked, percents: [], claims: 0 });
    }
  }
  for (const row of rows) {
    const entry = held.get(row.token);
    // A row with no lock behind it is a claim the chain has already let go, or
    // one whose lock never landed. Either way the chain is the one to believe,
    // so it is not counted and not explained.
    if (!entry) continue;
    entry.claims += 1;
    if (row.percent !== null) entry.percents.push(Number(row.percent));
  }
  return held;
}

export interface TokenAvailability {
  symbol: string;
  /** What the chain says is in the vault. */
  balance: bigint;
  /** What the chain is holding for commitments. */
  held: bigint;
  /** Balance minus held, floored at zero. */
  available: bigint;
  /** Percent shares claimed against this token, which hold no fixed figure. */
  percents: number[];
  claims: number;
}

/**
 * What of one token is actually free to spend or withdraw. Both figures come
 * from the executor, so this agrees with what a withdrawal will do rather than
 * predicting it.
 */
export async function availability(
  user: string,
  symbol: string,
): Promise<TokenAvailability> {
  const token = requireToken(symbol);
  const owner = user.toLowerCase() as `0x${string}`;
  const [balance, locked, rows] = await Promise.all([
    vaultBalance(owner, token.address),
    lockedBalance(owner, token.address),
    q<ReservationRow>(
      `SELECT token, amount_raw, percent FROM vault_reservations
        WHERE LOWER(user_address)=LOWER($1) AND status='held' AND token=$2`,
      [user, token.symbol],
    ),
  ]);
  return {
    symbol: token.symbol,
    balance,
    held: locked,
    available: balance > locked ? balance - locked : 0n,
    percents: rows.filter((r) => r.percent !== null).map((r) => Number(r.percent)),
    claims: locked > 0n ? rows.length : 0,
  };
}

/**
 * Refuse a withdrawal that would dip into committed money, before the wallet
 * prompt rather than after it.
 *
 * The contract refuses this too, and the contract is the one that matters. What
 * this adds is a sentence: "400 is committed to 2 live orders, so 600 of your
 * 1,000 is free" reads better than a reverted transaction, and it arrives
 * before somebody has approved anything.
 */
export async function assertWithdrawable(
  user: string,
  symbol: string,
  amountRaw: bigint,
): Promise<void> {
  const token = requireToken(symbol);
  const state = await availability(user, symbol);
  if (amountRaw <= state.available) return;
  const human = (v: bigint) => formatUnits(v, token.decimals);
  const claims =
    state.claims > 0
      ? `${state.claims} live order${state.claims === 1 ? "" : "s"}`
      : "orders that have not fired yet";
  throw new Error(
    `${human(state.held)} ${token.symbol} is committed to ${claims}, so ${human(state.available)} of your ${human(state.balance)} is free to withdraw. Cancel an order to free the rest.`,
  );
}
