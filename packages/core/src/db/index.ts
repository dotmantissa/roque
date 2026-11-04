/**
 * The one connection to Neon, and the schema it expects. Roque keeps very little
 * off-chain state on purpose: Sepolia is the source of truth for balances,
 * orders and caps. What lives here is the stuff a chain is bad at, namely a
 * searchable history of what the agent was asked, what it decided, and how that
 * turned into a transaction. Think of this database as the agent's notebook, not
 * its wallet.
 */

import { neon, type NeonQueryFunction } from "@neondatabase/serverless";
import { migration0002 } from "./migrations/0002-public-api.js";
import { databaseUrl } from "../env.js";

let _sql: NeonQueryFunction<false, false> | undefined;

/** The shared SQL tag. Neon's driver is HTTP based, so this is serverless safe. */
export function sql(): NeonQueryFunction<false, false> {
  if (!_sql) {
    _sql = neon(databaseUrl());
  }
  return _sql;
}

/**
 * Run a parameterised query, returning the rows. Neon's HTTP driver occasionally
 * drops a cold connection with a transient "fetch failed", so we give a query a
 * few quick tries before giving up. Every write in Roque is idempotent or keyed,
 * so a retry can never double apply anything that matters.
 */
export async function q<T = Record<string, unknown>>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const db = sql();
  // A commit-then-timeout must never replay a mutation or conditional claim.
  const readOnly = /^\s*SELECT\b/iu.test(text);
  let lastErr: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const rows = await db.query(text, params);
      return (Array.isArray(rows) ? rows : ((rows as { rows?: T[] }).rows ?? [])) as T[];
    } catch (err) {
      lastErr = err;
      if (!readOnly || !isTransient(err) || attempt === 3) break;
      await sleep(250 * (attempt + 1));
    }
  }
  throw lastErr;
}

function isTransient(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /fetch failed|ECONNRESET|ETIMEDOUT|network|timeout/i.test(msg);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}


/**
 * The whole schema, as plain idempotent DDL. Running it more than once is a no
 * op, which is exactly what a migrate step and a cautious startup both want.
 */
export const SCHEMA_SQL = `
-- Every natural-language request a user sent the agent, and what the judgment
-- layer made of it. This is the audit trail: given a trade, you can always trace
-- back to the exact words that caused it and the interpretation that passed.
CREATE TABLE IF NOT EXISTS intents (
  id             TEXT PRIMARY KEY,
  user_address   TEXT NOT NULL,
  mode           TEXT NOT NULL CHECK (mode IN ('copilot', 'autonomous')),
  command        TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'interpreting'
                   CHECK (status IN ('interpreting','rejected','ready','signed','submitted','confirmed','failed')),
  kind           TEXT,
  token_in       TEXT,
  token_out      TEXT,
  amount         TEXT,
  amount_is_percent BOOLEAN,
  trigger_price  TEXT,
  trigger_above  BOOLEAN,
  confidence     TEXT,
  reason         TEXT,
  error          TEXT,
  interpretation JSONB,
  tx_hash        TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_intents_user ON intents (user_address, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_intents_status ON intents (status);

-- One-time wallet challenges and their short-lived owner-bound sessions. The
-- bearer token itself is never stored, only its SHA-256 hash.
CREATE TABLE IF NOT EXISTS auth_challenges (
  id             TEXT PRIMARY KEY,
  owner_address  TEXT NOT NULL,
  nonce          TEXT NOT NULL,
  message        TEXT NOT NULL,
  expires_at     TIMESTAMPTZ NOT NULL,
  consumed_at    TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_auth_challenges_expiry
  ON auth_challenges (expires_at);

CREATE TABLE IF NOT EXISTS auth_sessions (
  token_hash     TEXT PRIMARY KEY,
  owner_address  TEXT NOT NULL,
  expires_at     TIMESTAMPTZ NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_owner_expiry
  ON auth_sessions (owner_address, expires_at DESC);

-- A flat, queryable mirror of the on-chain trade history, filled by the indexer
-- from AgentExecutor and OrderBook events. The chain remains the truth; this is
-- just the fast, joinable copy the activity feed reads from.
CREATE TABLE IF NOT EXISTS trades (
  id             BIGSERIAL PRIMARY KEY,
  kind           TEXT NOT NULL CHECK (kind IN ('swap','limit_created','limit_filled','limit_cancelled')),
  user_address   TEXT NOT NULL,
  token_in       TEXT,
  token_out      TEXT,
  amount_in      TEXT,
  amount_out     TEXT,
  usd_value      TEXT,
  order_id       BIGINT,
  price          TEXT,
  tx_hash        TEXT NOT NULL,
  log_index      INTEGER NOT NULL,
  block_number   BIGINT NOT NULL,
  block_time     TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tx_hash, log_index)
);
CREATE INDEX IF NOT EXISTS idx_trades_user ON trades (user_address, block_number DESC);
CREATE INDEX IF NOT EXISTS idx_trades_kind ON trades (kind);

-- USD price observations used by the in-app charts. These are deliberately
-- append-only; the read path limits each response to a bounded time window.
CREATE TABLE IF NOT EXISTS price_history (
  id             BIGSERIAL PRIMARY KEY,
  pair           TEXT NOT NULL,
  price          NUMERIC NOT NULL CHECK (price > 0),
  recorded_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_price_history_pair_time
  ON price_history (pair, recorded_at DESC);

-- A tiny key/value store for the indexer's bookmark, so a restart resumes from
-- the last block it fully processed instead of rescanning from genesis.
CREATE TABLE IF NOT EXISTS indexer_state (
  key            TEXT PRIMARY KEY,
  value          TEXT NOT NULL,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─────────────────────────────────────────────────────────────
-- Event orders: a limit order whose trigger is a sentence
-- ─────────────────────────────────────────────────────────────
-- A price trigger is arithmetic, so the OrderBook can hold it on-chain. A trigger
-- like "if a major exchange is hacked" is a judgment call, and no price feed will
-- ever answer it. These rows are that second kind. The condition is stored as the
-- user wrote it; the judgment layer rules on it; and when the verdict comes back
-- met, the fill runs through the same AgentExecutor path an autonomous trade uses,
-- so the user's on-chain caps enforce themselves and nothing new is trusted.
--
-- Note the screen_* columns. Before an order is ever armed we ask whether the
-- condition is something independent validators could actually source evidence
-- for. A condition about the user's private life, or about nothing observable at
-- all, is rejected up front with a reason they can read, rather than resting
-- forever as an order that can never honestly fill.
CREATE TABLE IF NOT EXISTS event_orders (
  id                 TEXT PRIMARY KEY,
  user_address       TEXT NOT NULL,
  condition          TEXT NOT NULL,
  token_in           TEXT NOT NULL,
  token_out          TEXT NOT NULL,
  amount             TEXT NOT NULL,
  amount_is_percent  BOOLEAN NOT NULL DEFAULT false,
  slippage_bps       INTEGER NOT NULL DEFAULT 100,
  status             TEXT NOT NULL DEFAULT 'screening'
                       CHECK (status IN ('screening','screened','rejected','arming','armed','firing','filled','failed','expired','cancelled')),
  screen_verdict     TEXT CHECK (screen_verdict IN ('verifiable','unverifiable')),
  screen_reason      TEXT,
  screen_confidence  TEXT,
  screen_sources     JSONB,
  checks             INTEGER NOT NULL DEFAULT 0,
  last_checked_at    TIMESTAMPTZ,
  verdict_met        BOOLEAN,
  verdict_confidence TEXT,
  verdict_rationale  TEXT,
  evidence           JSONB,
  expires_at         TIMESTAMPTZ,
  tx_hash            TEXT,
  error              TEXT,
  source_slug        TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_event_orders_user ON event_orders (user_address, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_event_orders_armed ON event_orders (status, last_checked_at);

-- ─────────────────────────────────────────────────────────────
-- Playbooks: chained rules the keeper walks
-- ─────────────────────────────────────────────────────────────
-- One event order is a single bet. A playbook is a plan: a sequence of steps, each
-- with its own trigger (a price level, a real-world condition, or a deadline) and
-- its own trade. The keeper watches only the step the cursor points at, so a
-- playbook costs the same to run whether it has two steps or ten, and a step can
-- never fire out of order. Steps live as JSONB because their shape varies by
-- trigger kind and the set of kinds will grow; the columns hold only what the
-- engine has to query on.
CREATE TABLE IF NOT EXISTS playbooks (
  id              TEXT PRIMARY KEY,
  user_address    TEXT NOT NULL,
  name            TEXT NOT NULL,
  note            TEXT,
  status          TEXT NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft','arming','armed','completed','cancelled','failed')),
  steps           JSONB NOT NULL DEFAULT '[]'::jsonb,
  step_cursor     INTEGER NOT NULL DEFAULT 0,
  slippage_bps    INTEGER NOT NULL DEFAULT 100,
  last_checked_at TIMESTAMPTZ,
  error           TEXT,
  source_slug     TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_playbooks_user ON playbooks (user_address, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_playbooks_armed ON playbooks (status, last_checked_at);

-- Every step transition, kept append-only. A playbook that did something odd can
-- be read back move by move, which matters when the thing being audited is an
-- agent acting on a judgment rather than a number.
CREATE TABLE IF NOT EXISTS playbook_events (
  id           BIGSERIAL PRIMARY KEY,
  playbook_id  TEXT NOT NULL,
  step_index   INTEGER NOT NULL,
  kind         TEXT NOT NULL,
  detail       TEXT,
  tx_hash      TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_playbook_events_pb ON playbook_events (playbook_id, id DESC);

-- ─────────────────────────────────────────────────────────────
-- Shares: a thesis as a link somebody else can fork
-- ─────────────────────────────────────────────────────────────
-- The payload here is a frozen snapshot, deliberately not a reference to the live
-- row it came from. Two reasons: the author cancelling their own order must not
-- break everyone who forked it, and a fork must never inherit the author's sizing
-- or address. What travels is the idea, not the position.
CREATE TABLE IF NOT EXISTS shares (
  slug           TEXT PRIMARY KEY,
  kind           TEXT NOT NULL CHECK (kind IN ('event_order','playbook')),
  author_address TEXT NOT NULL,
  title          TEXT NOT NULL,
  note           TEXT,
  payload        JSONB NOT NULL,
  forks          INTEGER NOT NULL DEFAULT 0,
  views          INTEGER NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_shares_author ON shares (author_address, created_at DESC);

-- ─────────────────────────────────────────────────────────────
-- Proposals: the agent bringing work to the user
-- ─────────────────────────────────────────────────────────────
-- Everything else in Roque starts with the person typing. This table is the one
-- place the agent starts the conversation: it watches positions, resting orders
-- and the market, and files something worth a tap. The dedupe_key is what keeps
-- that from becoming noise, since the generator runs on the same timer as the
-- keeper and would otherwise refile the identical observation every few minutes.
CREATE TABLE IF NOT EXISTS proposals (
  id            TEXT PRIMARY KEY,
  user_address  TEXT NOT NULL,
  kind          TEXT NOT NULL,
  title         TEXT NOT NULL,
  detail        TEXT NOT NULL,
  rationale     TEXT,
  action        JSONB NOT NULL,
  status        TEXT NOT NULL DEFAULT 'new'
                  CHECK (status IN ('new','accepted','dismissed','expired')),
  dedupe_key    TEXT NOT NULL,
  acted_at      TIMESTAMPTZ,
  result_ref    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_address, dedupe_key)
);
CREATE INDEX IF NOT EXISTS idx_proposals_inbox ON proposals (user_address, status, created_at DESC);

-- ─────────────────────────────────────────────────────────────
-- Reservations: vault money already promised to something
-- ─────────────────────────────────────────────────────────────
-- An event order or a playbook is a promise to spend from the vault days from
-- now, and until this table existed that promise was invisible. The money sat
-- there looking spendable: it counted as available to the next order written
-- against it, and it could be withdrawn in full while the order it was meant
-- to pay for was still armed and watching. Both then failed at fill time on a
-- balance nobody had mentioned.
--
-- A row here is one live claim on one token. The sum of a user's open claims is
-- the part of their vault that is spoken for, which is subtracted before a new
-- order is allowed and before a withdrawal is signed.
--
-- This table used to be the hold itself, and the caveat printed here was that a
-- row is not a lock: AgentExecutor.withdraw paid out the whole balance to anyone
-- who called it directly, and an ordinary autonomous trade could spend the same
-- money and withdraw whatever it bought. The executor owns the hold now, in
-- lockedBalance, so what is left here is the story rather than the custody:
-- which order promised what, which rung of which plan, and whether the figure
-- came from a percentage somebody typed. The amounts are read off the chain. If
-- a row and the chain ever disagree, the chain is right by construction.
--
-- commitment_id is the keccak of (source_kind, source_id, step_index), which is
-- also how the executor keys the lock. Deriving it rather than minting one means
-- arming the same order twice names the same commitment and resizes one hold
-- instead of stacking two, and there is no id that can drift out of step.
CREATE TABLE IF NOT EXISTS vault_reservations (
  id            TEXT PRIMARY KEY,
  user_address  TEXT NOT NULL,
  token         TEXT NOT NULL,
  -- Absolute token units, as a decimal string, matching how the chain holds it.
  -- Zero for a percentage claim, which reserves a share rather than a figure.
  amount_raw    TEXT NOT NULL DEFAULT '0',
  percent       NUMERIC,
  -- What promised it, so releasing is keyed to the thing and not to the row.
  source_kind   TEXT NOT NULL CHECK (source_kind IN ('event_order','playbook')),
  source_id     TEXT NOT NULL,
  -- Which rung of a playbook, so a ladder can release one step at a time. Zero
  -- for an event order, which has exactly one leg. NOT NULL because the unique
  -- constraint below depends on it: Postgres counts NULLs as distinct, so a
  -- nullable column here would let the same promise be claimed twice.
  step_index    INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'held'
                  CHECK (status IN ('held','spent','released')),
  -- The executor's key for this hold, derived from the three columns above.
  commitment_id TEXT,
  released_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- One claim per rung per source. Arming a playbook twice, or a keeper running
  -- twice over the same order, must not double-count the same promise.
  UNIQUE (source_kind, source_id, step_index)
);
CREATE INDEX IF NOT EXISTS idx_vault_res_held
  ON vault_reservations (user_address, token, status);
CREATE INDEX IF NOT EXISTS idx_vault_res_source
  ON vault_reservations (source_kind, source_id);

-- ─────────────────────────────────────────────────────────────
-- Widenings applied to tables that already exist
-- ─────────────────────────────────────────────────────────────
-- CREATE TABLE IF NOT EXISTS leaves an existing table exactly as it is, so a
-- new status value needs saying twice: once in the definition above for a fresh
-- database, and once here for one that is already running. Dropping the check
-- first makes it idempotent, and it only ever widens the set of values allowed,
-- so no row that was legal before becomes illegal.
--
-- 'screened' is the state between a passed screen and the person arming it. It
-- exists because a screen answers "could this be checked", which is not the
-- same question as "put my money behind it", and running the two together
-- turned a sentence into a live commitment with nobody pressing anything.
ALTER TABLE event_orders DROP CONSTRAINT IF EXISTS event_orders_status_check;
ALTER TABLE event_orders ADD CONSTRAINT event_orders_status_check
  CHECK (status IN ('screening','screened','rejected','arming','armed','firing','filled','failed','expired','cancelled'));

-- 'firing' is the brief window between claiming an order and knowing what the
-- swap did. It exists so two workers cannot both fill one verdict: the claim is
-- a guarded move into this state, and whoever loses it returns without trading.
-- It also keeps the expiry sweep off a row whose transaction is in the mempool.

-- The executor's key for a hold, on a database that predates commitments.
ALTER TABLE vault_reservations ADD COLUMN IF NOT EXISTS commitment_id TEXT;
`;

/** Create every table if it is not already there. Safe to call on each boot. */
export async function ensureSchema(): Promise<void> {
  // One transaction takes a migration lock and applies the ordered statements.
  const statements = (SCHEMA_SQL + "\n" + migration0002).split(/;\s*\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const db=sql();
  await db.transaction([db.query("SELECT pg_advisory_xact_lock(7266785)"),...statements.map(stmt=>db.query(stmt))]);
}
