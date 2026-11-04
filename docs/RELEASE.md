# Public API release and recovery

## Candidate and verification

The candidate implements public v1/SDK/OAuth/MCP and source remediation in `91535e1`; executor fixes are `9ba8f5b`, interpreter fixes `cfa7e05`, persistence fixes `147502c`, and future OrderBook oracle hardening `05bbf91`.

Verified locally: 248 core tests, 100 Solidity tests, 50 Python tests with GenVM lint, workspace typechecks, production Next build, Foundry formatting/lint and independent partner browser bundle. The SQL/EVM wallet test verifies actual wallet output against the decoded settlement receipt on Anvil. Live release evidence is appended below as it is obtained.

Target: Vercel team `mantissas-projects`, project `roque`, root `apps/web`, Node24, domain `https://roque-dex.vercel.app`. Sepolia execution and GenLayer studionet interpretation. Native Rialo execution is outside scope; Rialo integration here means Latch.

## Authorized release procedure

Credentials remain in the owner's private deployment configuration directory, with mode 0600. Never print, stage or attach environment files, keys or signed raw-transaction journals. `packages/core/scripts/release.ts` reads those sources and writes a private recovery journal. Its prepare mode generates a dedicated relayer and stable GenLayer caller without replacing already-generated keys. Preflight checks Sepolia, the registered deployer and configured Latch chain read.

1. Verify the exact source commit, tests, target Vercel project/team and current registry. Apply the fixed additive schema in one advisory-locked transaction; no user balance or trade history is deleted.
2. Run the release helper's `genlayer` mode. It records the transaction hash, checks finalized lifecycle and execution errors, extracts only explicit deployment fields and verifies exact source, schema and initialized state. The old Python deployment entrypoint delegates to this helper.
3. Run `stage`. It minimally funds the dedicated gas payer, journals signed EVM bytes before broadcast, deploys executor v2 and registers all ten test assets. It verifies compiled runtime bytecode with immutable references, router/book/owner dependencies and records public version/hash/block metadata in both registries. It preserves prior vault addresses/domain versions. OrderBook authority is not changed yet.
4. Provision new production settings from private files: RELAYER_PRIVATE_KEY, GENLAYER_CALLER_PRIVATE_KEY, AUTH_ORIGIN, required Latch, MCP resource and exact OAuth redirect allowlist. Keep the application signer distinct from the gas payer and administrator. Existing strong cron credentials remain stable so the GitHub recovery scheduler continues to authenticate.
5. Stage a production Vercel deployment without assigning the domain. Check ready status, health, public metadata, OpenAPI, authentication failures, body/tenant/PKCE behavior and approval pages. Production auth uses the canonical trusted origin.
6. Run `cutover` only when the new deployment is ready. It rechecks executor bytecode/dependencies and the live legacy OrderBook's nonzero freshness limit/price read, then switches the book to executor v2. Promote the staged production app and verify canonical-domain API/auth/MCP behavior.
7. Record public addresses, transaction hashes, blocks, deployed commit and verified live flows. Check error logs. Perform the real partner/Claude/embedded-wallet pilot before claiming provider certification.

Every EVM release operation reuses the journal's original signed bytes/hash after interruption. Do not delete a pending operation or re-sign it at a new nonce merely because an HTTP response was lost. Funding, deployment and token registration are separate journaled operations. If a release transaction definitively reverts, investigate its cause before starting a replacement operation.

## Earlier vaults and rollback

The old executor is immutable. Balances, capability state, used signatures and holds do not migrate. Earlier addresses stay in `legacyExecutors`, with domain/version/block metadata; the UI provides owner revoke, releaseOwnCommitment and available-balance withdrawal. Find hold IDs in the earlier contract's indexed Committed events. Owner exits do not require the relayer or healthy price feed. Existing OrderBook orders and pool liquidity remain at their current addresses.

Before cutover, rollback means keeping the old app/book active while repairing the staged release. After cutover, avoid blindly reverting to old source or exposing a v2 ABI against a v1 address. Coordinate an app version with its registry and keep legacy exits available. New v2 vaults may hold user funds even if the old book is restored; those owners must retain v2 withdrawal/release access. Never transfer users' balances administratively.

## Incident response and Latch acceptance

Revoke affected application clients/sessions and provider credentials; stop worker writes, retain transaction hashes/raw bytes and reconcile canonical receipts before resuming. Owners can revoke agent authority and withdraw/release holds directly. Rotate compromised signing credentials and redeploy/remap domains when needed; old unused signatures are contained by v2 authority generations. An RPC timeout or Latch outage keeps the same recorded attempt; do not fall back to direct RPC for configured relayer writes.

Verify the hosted Latch policy permits only intended Sepolia methods/targets, the new executor/book, the dedicated sender and appropriate gas limits. Test denial, revoked token and outage with controlled operations; retain provider-side evidence and check that denied writes do not fall back to a different transport. Current code and a successful Latch chain read prove configuration/routing, not hosted policy restrictions or signing custody.

## Live evidence

Pending staging and promotion at the time this runbook was written. Credentials and operation recovery identifiers belong in the private local checklist/journal, never in this public document.
