/**
 * The one connection to Neon, and the schema it expects. Roque keeps very little
 * off-chain state on purpose: Sepolia is the source of truth for balances,
 * orders and caps. What lives here is the stuff a chain is bad at, namely a
 * searchable history of what the agent was asked, what it decided, and how that
 * turned into a transaction. Think of this database as the agent's notebook, not
 * its wallet.
 */

import { neon, type NeonQueryFunction } from "@neondatabase/serverless";
import { serverEnv } from "../env.js";

let _sql: NeonQueryFunction<false, false> | undefined;

/** The shared SQL tag. Neon's driver is HTTP based, so this is serverless safe. */
export function sql(): NeonQueryFunction<false, false> {
  if (!_sql) {
    _sql = neon(serverEnv().databaseUrl);
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
  let lastErr: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const rows = await db.query(text, params);
      return (Array.isArray(rows) ? rows : ((rows as { rows?: T[] }).rows ?? [])) as T[];
    } catch (err) {
      lastErr = err;
      if (!isTransient(err) || attempt === 3) break;
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

-- A tiny key/value store for the indexer's bookmark, so a restart resumes from
-- the last block it fully processed instead of rescanning from genesis.
CREATE TABLE IF NOT EXISTS indexer_state (
  key            TEXT PRIMARY KEY,
  value          TEXT NOT NULL,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

/** Create every table if it is not already there. Safe to call on each boot. */
export async function ensureSchema(): Promise<void> {
  // Neon's HTTP driver runs one statement per call, so split the DDL and run the
  // pieces in order. Splitting on a blank-line-preceded semicolon keeps the
  // CHECK-clause semicolons inside a statement from tripping us up.
  const statements = SCHEMA_SQL.split(/;\s*\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  for (const stmt of statements) {
    await q(stmt);
  }
}
