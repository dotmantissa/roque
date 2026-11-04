/**
 * An in-memory stand-in for the vault: the executor's lock mapping, and the
 * `vault_reservations` rows that explain it.
 *
 * The reservations module is deliberately *not* mocked in the suites that reach
 * it. It is the thing deciding whether one deposit can back two orders, so a
 * test that stubs it out proves nothing about the property it exists to hold.
 * What is mocked is the boundary below it, and the interesting half of that is
 * now the chain rather than the database.
 *
 * So the lock model here enforces what AgentExecutor enforces: a hold may only
 * take money that is free, locking an id that is already live resizes that one
 * hold instead of stacking a second, and a spend consumes the hold whole. Get
 * those three wrong and the suites pass while the contract refuses, which is
 * the one failure mode a fake like this must not have.
 *
 * Each suite's `q` mock delegates to `handle` first and falls through to its own
 * statements, so `handle` returns `null` -- not `[]` -- when a statement is none
 * of its business. An empty array is a legitimate answer to a `SELECT`, so the
 * two cases cannot share a value.
 */

import { keccak256, stringToHex } from "viem";
import { tokenByAddress, tokenBySymbol, tokenList } from "@roque/shared";

export interface ReservationRow {
  user_address: string;
  token: string;
  amount_raw: string;
  percent: number | null;
  source_kind: string;
  source_id: string;
  step_index: number;
  commitment_id: string | null;
  status: "held" | "spent" | "released";
}

export interface Lock {
  user: string;
  token: string;
  amount: bigint;
  unlockAt: bigint;
  epoch: number;
  active: boolean;
}

/**
 * The subset of `../src/intents.js` the vault path calls.
 *
 * `vaultBalance` is left alone: every suite sets it with `mockResolvedValue`,
 * which is how a test says "the chain reports this much". The lock model reads
 * the balance back through that same mock rather than keeping its own copy, so
 * there is one place a test can change the balance and no way for the two to
 * disagree.
 */
interface MockFn {
  (...args: never[]): unknown;
  mockImplementation: (fn: (...args: never[]) => unknown) => unknown;
}
export interface IntentsMocks {
  vaultBalance: MockFn;
  lockedBalance?: MockFn;
  vaultSnapshot?: MockFn;
  freshNonce?: MockFn;
  lockCommitments?: MockFn;
  releaseCommitments?: MockFn;
  getCommitment?: MockFn;
}

export interface ReservationStore {
  rows: ReservationRow[];
  locks: Map<string, Lock>;
  /** Every open claim, for assertions. */
  held: () => ReservationRow[];
  /** Pre-load a claim, for testing what a *second* order is allowed to do. */
  hold: (row: Partial<ReservationRow> & { user_address: string; token: string }) => void;
  /** Absolute units locked for a user against one symbol. */
  lockedOf: (user: string, symbol: string) => bigint;
  /** Consume a hold the way a swap naming it would. */
  spend: (commitmentId: string) => void;
  handle: (sql: string, params: unknown[]) => unknown[] | null;
  /** Point a suite's hoisted intents mocks at this store. */
  install: (mocks: IntentsMocks) => void;
}

const idFor = (kind: string, sourceId: string, stepIndex: number) =>
  keccak256(stringToHex(`roque:${kind}:${sourceId}:${stepIndex}`));

export function reservationStore(): ReservationStore {
  const rows: ReservationRow[] = [];
  const batches = new Map<string,{id:string;source:string;sourceId:string;payload:unknown;status:string}>();
  const locks = new Map<string, Lock>();

  const lockedOf = (user: string, symbol: string): bigint => {
    let total = 0n;
    for (const lock of locks.values()) {
      if (lock.active && lock.user.toLowerCase() === user.toLowerCase() && lock.token === symbol) {
        total += lock.amount;
      }
    }
    return total;
  };

  const store: ReservationStore = {
    rows,
    locks,
    held: () => rows.filter((r) => r.status === "held"),

    hold: (row) =>
      rows.push({
        amount_raw: "0",
        percent: null,
        source_kind: "event_order",
        source_id: `seed-${rows.length}`,
        step_index: 0,
        commitment_id: null,
        status: "held",
        ...row,
      }),

    lockedOf,
    spend: (commitmentId) => {
      const lock = locks.get(commitmentId);
      if (lock) lock.active = false;
    },

    install: (mocks) => {
      const balanceOf = async (user: string, symbol: string): Promise<bigint> =>
        (await (mocks.vaultBalance as (u: string, a: string) => Promise<bigint>)(
          user,
          tokenBySymbol(symbol)!.address,
        )) ?? 0n;

      mocks.lockedBalance?.mockImplementation(async (user: string, address: string) => {
        const token = tokenByAddress(address);
        return token ? lockedOf(user, token.symbol) : 0n;
      });
      // The batched read, served off the same two models so it cannot disagree
      // with the single reads beside it.
      mocks.vaultSnapshot?.mockImplementation(async (user: string) => {
        const out = new Map<string, { balance: bigint; locked: bigint; available: bigint }>();
        for (const t of tokenList) {
          const balance = await balanceOf(user, t.symbol);
          const locked = lockedOf(user, t.symbol);
          out.set(t.symbol, {
            balance,
            locked,
            available: balance > locked ? balance - locked : 0n,
          });
        }
        return out;
      });
      let nonce = 1n;
      mocks.freshNonce?.mockImplementation(async () => nonce++);
      mocks.getCommitment?.mockImplementation(async (id: string) => {
        const lock = locks.get(id);
        if (!lock) {
          return {
            user: "0x0000000000000000000000000000000000000000",
            token: "0x0000000000000000000000000000000000000000",
            amount: 0n,
            unlockAt: 0n,
            epoch: 0,
            active: false,
          };
        }
        return { ...lock, token: tokenBySymbol(lock.token)!.address };
      });
      // The contract's rules, because a fake that is more permissive than the
      // executor would let these suites pass on holds the chain refuses.
      mocks.lockCommitments?.mockImplementation(
        async (
          intents: Array<{
            user: string;
            token: string;
            amount: bigint;
            unlockAt: bigint;
            commitmentId: string;
          }>,
        ) => {
          // Staged, because the real call is one transaction: lockForCommitments
          // reverts the whole set if any leg cannot be covered, so a plan is
          // never half funded. A fake that applied legs as it went would let a
          // suite pass on a state the chain will not produce.
          const staged = new Map<string, Lock>();
          const stagedTotal = (user: string, symbol: string): bigint => {
            let total = 0n;
            for (const lock of staged.values()) {
              if (
                lock.active &&
                lock.user.toLowerCase() === user.toLowerCase() &&
                lock.token === symbol
              ) {
                total += lock.amount;
              }
            }
            return total;
          };
          const liveTotal = (user: string, symbol: string): bigint => {
            let total = 0n;
            for (const [id, lock] of locks) {
              if (
                staged.has(id) ||
                !lock.active ||
                lock.user.toLowerCase() !== user.toLowerCase() ||
                lock.token !== symbol
              ) {
                continue;
              }
              total += lock.amount;
            }
            return total;
          };

          for (const intent of intents) {
            const token = tokenByAddress(intent.token);
            if (!token) throw new Error("unregistered token");
            const existing = locks.get(intent.commitmentId);
            const balance = await balanceOf(intent.user, token.symbol);
            // A resize counts its own old claim as free again, matching _lock.
            const free =
              balance - liveTotal(intent.user, token.symbol) - stagedTotal(intent.user, token.symbol);
            if (free < intent.amount) {
              throw new Error(
                `CommittedVault: ${free} free, wanted ${intent.amount} of ${token.symbol}`,
              );
            }
            staged.set(intent.commitmentId, {
              user: intent.user,
              token: token.symbol,
              amount: intent.amount,
              unlockAt: intent.unlockAt,
              epoch: (existing?.epoch ?? 0) + 1,
              active: true,
            });
          }

          for (const [id, lock] of staged) locks.set(id, lock);
          return "0xlock";
        },
      );
      mocks.releaseCommitments?.mockImplementation(async (ids: string[]) => {
        let touched = false;
        for (const id of ids) {
          const lock = locks.get(id);
          if (lock?.active) {
            lock.active = false;
            touched = true;
          }
        }
        return touched ? "0xrelease" : null;
      });
    },

    handle: (sql, params) => {
      if(sql.startsWith("INSERT INTO reservation_batches")) {batches.set(String(params[0]),{id:String(params[0]),source:String(params[1]),sourceId:String(params[2]),payload:JSON.parse(String(params[3])),status:"pending"});return [];}
      if(sql.startsWith("UPDATE reservation_batches")) {const batch=batches.get(String(params[0]));if(batch)batch.status="held";return [];}
      if(sql.startsWith("SELECT id,payload FROM reservation_batches")) return [...batches.values()].filter(b=>b.source===params[0]&&b.sourceId===params[1]).slice(-1);

      const t = sql.replace(/\s+/gu, " ").trim();

      if (t.startsWith("INSERT INTO vault_reservations")) {
        const [, user, token, amountRaw, percent, kind, sourceId, stepIndex, commitmentId] =
          params as [
            string, string, string, string, number | null, string, string, number, string,
          ];
        // The real statement is an upsert on (source_kind, source_id,
        // step_index), and that idempotence is load-bearing: arming a playbook
        // twice must not claim the same money twice.
        const existing = rows.find(
          (r) =>
            r.source_kind === kind && r.source_id === sourceId && r.step_index === stepIndex,
        );
        if (existing) {
          existing.token = token;
          existing.amount_raw = amountRaw;
          existing.percent = percent;
          existing.commitment_id = commitmentId;
          existing.status = "held";
          return [];
        }
        rows.push({
          user_address: user,
          token,
          amount_raw: amountRaw,
          percent,
          source_kind: kind,
          source_id: sourceId,
          step_index: stepIndex,
          commitment_id: commitmentId,
          status: "held",
        });
        return [];
      }

      // What release reads before it asks the chain to let go: the open claims
      // of one source, or of one rung of it.
      if (t.startsWith("SELECT user_address, step_index FROM vault_reservations")) {
        const [kind, sourceId] = params as [string, string];
        const stepIndex = t.includes("step_index=$3") ? Number(params[2]) : undefined;
        return rows
          .filter(
            (r) =>
              r.source_kind === kind &&
              r.source_id === sourceId &&
              r.status === "held" &&
              (stepIndex === undefined || r.step_index === stepIndex),
          )
          .map((r) => ({ user_address: r.user_address, step_index: r.step_index }));
      }

      // Releasing one rung of a ladder. Matched before the whole-source form,
      // because the two statements share their opening clause.
      if (t.startsWith("UPDATE vault_reservations") && t.includes("step_index=$3")) {
        const [kind, sourceId, stepIndex, outcome] = params as [string, string, number, string];
        for (const r of rows) {
          if (
            r.source_kind === kind &&
            r.source_id === sourceId &&
            r.step_index === stepIndex &&
            r.status === "held"
          ) {
            r.status = outcome as ReservationRow["status"];
            if (outcome === "spent") store.spend(idFor(kind, sourceId, stepIndex));
          }
        }
        return [];
      }

      if (t.startsWith("UPDATE vault_reservations")) {
        const [kind, sourceId, outcome] = params as [string, string, string];
        for (const r of rows) {
          if (r.source_kind === kind && r.source_id === sourceId && r.status === "held") {
            r.status = outcome as ReservationRow["status"];
            if (outcome === "spent") store.spend(idFor(kind, sourceId, r.step_index));
          }
        }
        return [];
      }

      if (t.startsWith("SELECT token, amount_raw, percent FROM vault_reservations")) {
        const user = String(params[0]).toLowerCase();
        const symbol = params.length > 1 ? String(params[1]) : null;
        return rows
          .filter(
            (r) =>
              r.status === "held" &&
              r.user_address.toLowerCase() === user &&
              (symbol === null || r.token === symbol),
          )
          .map((r) => ({
            token: r.token,
            amount_raw: r.amount_raw,
            percent: r.percent === null ? null : String(r.percent),
          }));
      }

      return null;
    },
  };

  return store;
}
