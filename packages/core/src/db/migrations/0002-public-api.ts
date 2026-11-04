/** Versioned, additive migration. Apply before enabling the v1 API/workers. */
export const migration0002 = `
CREATE TABLE IF NOT EXISTS schema_migrations(version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE auth_challenges ADD COLUMN IF NOT EXISTS client_id text NOT NULL DEFAULT 'first-party';
ALTER TABLE auth_challenges ADD COLUMN IF NOT EXISTS audience text NOT NULL DEFAULT '';
ALTER TABLE auth_challenges ADD COLUMN IF NOT EXISTS scopes text[] NOT NULL DEFAULT '{}';
ALTER TABLE auth_sessions ADD COLUMN IF NOT EXISTS client_id text NOT NULL DEFAULT 'first-party';
ALTER TABLE auth_sessions ADD COLUMN IF NOT EXISTS audience text NOT NULL DEFAULT '';
ALTER TABLE auth_sessions ADD COLUMN IF NOT EXISTS scopes text[] NOT NULL DEFAULT '{}';
ALTER TABLE auth_sessions ADD COLUMN IF NOT EXISTS session_type text NOT NULL DEFAULT 'wallet';
ALTER TABLE auth_sessions ADD COLUMN IF NOT EXISTS revoked_at timestamptz;
ALTER TABLE intents ADD COLUMN IF NOT EXISTS prepared_plan jsonb;
CREATE TABLE IF NOT EXISTS api_clients(
 id text PRIMARY KEY, key_hash text UNIQUE NOT NULL, name text NOT NULL,
 scopes text[] NOT NULL, origins text[] NOT NULL DEFAULT '{}', redirects text[] NOT NULL DEFAULT '{}',
 revoked_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS api_operations(
 id uuid PRIMARY KEY, client_id text NOT NULL REFERENCES api_clients(id), owner_address text NOT NULL,
 chain_id integer NOT NULL, operation text NOT NULL, idempotency_key text NOT NULL,
 request_hash text NOT NULL, input jsonb NOT NULL, result jsonb,
 status text NOT NULL DEFAULT 'queued', attempts integer NOT NULL DEFAULT 0,
 lease_owner uuid, lease_until timestamptz, generation bigint NOT NULL DEFAULT 0,
 error_code text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(client_id,owner_address,chain_id,operation,idempotency_key)
);
CREATE INDEX IF NOT EXISTS api_operations_work ON api_operations(status,lease_until,created_at);
CREATE TABLE IF NOT EXISTS swap_quotes(
 id uuid PRIMARY KEY, intent_id uuid NOT NULL REFERENCES api_operations(id), client_id text NOT NULL,
 owner_address text NOT NULL, payload jsonb NOT NULL, expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS swap_plans(
 id uuid PRIMARY KEY, quote_id uuid NOT NULL UNIQUE REFERENCES swap_quotes(id), client_id text NOT NULL,
 owner_address text NOT NULL, payload jsonb NOT NULL, status text NOT NULL DEFAULT 'awaiting_wallet',
 tx_hash text UNIQUE, receipt jsonb, updated_at timestamptz NOT NULL DEFAULT now(), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS approval_links(
 token_hash text PRIMARY KEY, swap_id uuid NOT NULL REFERENCES swap_plans(id), client_id text NOT NULL,
 owner_address text NOT NULL, expires_at timestamptz NOT NULL, consumed_at timestamptz
);
CREATE TABLE IF NOT EXISTS reservation_batches(
 id text PRIMARY KEY, source_kind text NOT NULL, source_id text NOT NULL,
 payload jsonb NOT NULL, status text NOT NULL DEFAULT 'pending', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS reservation_batches_source ON reservation_batches(source_kind,source_id,created_at DESC);
CREATE TABLE IF NOT EXISTS api_budgets(
 subject text NOT NULL, bucket bigint NOT NULL, count integer NOT NULL DEFAULT 0, PRIMARY KEY(subject,bucket)
);
CREATE TABLE IF NOT EXISTS worker_leases(
 key text PRIMARY KEY, owner uuid NOT NULL, generation bigint NOT NULL DEFAULT 1, expires_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS relayer_senders(
 chain_id integer NOT NULL, sender text NOT NULL, next_nonce bigint NOT NULL DEFAULT 0, PRIMARY KEY(chain_id,sender)
);
CREATE TABLE IF NOT EXISTS execution_attempts(
 id text PRIMARY KEY, chain_id integer NOT NULL, sender text NOT NULL, nonce bigint NOT NULL,
 target text NOT NULL, calldata text NOT NULL, raw_tx text, tx_hash text UNIQUE,
 status text NOT NULL DEFAULT 'created', receipt jsonb, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(chain_id,sender,nonce)
);
ALTER TABLE trades ADD COLUMN IF NOT EXISTS block_hash text;
ALTER TABLE trades ADD COLUMN IF NOT EXISTS deployment text NOT NULL DEFAULT 'legacy';
CREATE TABLE IF NOT EXISTS indexer_blocks(
 deployment text NOT NULL, block_number bigint NOT NULL, block_hash text NOT NULL, PRIMARY KEY(deployment,block_number)
);
ALTER TABLE playbooks DROP CONSTRAINT IF EXISTS playbooks_status_check;
ALTER TABLE playbooks ADD CONSTRAINT playbooks_status_check CHECK(status IN ('draft','arming','armed','completed','cancelled','failed'));
CREATE TABLE IF NOT EXISTS oauth_requests(id uuid PRIMARY KEY,query jsonb NOT NULL,expires_at timestamptz NOT NULL,consumed_at timestamptz);
CREATE TABLE IF NOT EXISTS oauth_codes(code_hash text PRIMARY KEY,payload jsonb NOT NULL,expires_at timestamptz NOT NULL,consumed_at timestamptz);
INSERT INTO schema_migrations(version) VALUES('0002-public-api') ON CONFLICT DO NOTHING;
`;
