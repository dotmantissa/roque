# Public API release and recovery

## Candidate and verification

The promoted application source is `ddea807`, including the verified SDK session-revocation correction. Public v1/SDK/OAuth/MCP and initial source remediation are in `91535e1`; executor fixes are `9ba8f5b`, interpreter fixes `cfa7e05`, persistence fixes `147502c`, and future OrderBook oracle hardening `05bbf91`.

Verified locally: 258 core tests, 100 Solidity tests, 54 Python tests with GenVM lint, workspace typechecks, production Next build, Foundry formatting/lint and independent partner browser bundle. The SQL/EVM wallet test verifies actual wallet output against the decoded settlement receipt on Anvil. Live release evidence is appended below as it is obtained.

The subsequent dependency candidate patches runtime and development advisories, with zero findings in both pnpm audits. It passes 259 core tests, three WalletConnect/UUID/Sharp compatibility checks, all workspace typechecks and the production Next build. The ordinary local build hit Google font HTTPS timeouts; the successful local retry used genuine font bytes cached outside the repository. The hosted redeployment uses the normal build. This candidate also fixes exact-timestamp lease reacquisition with a deterministic owner/generation fencing regression. The currently promoted deployment remains the earlier source until staged hosted verification and promotion complete.

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

Verified on 2026-11-04:

- The additive live Neon migration completed atomically. Existing records were retained.
- Executor v2: `0x097ab154e71da5c68ba9ec1939e7394b4ffc24c7`, deployment `0xc0a83d7ace714828361e9fb7b8918f77414e2467aa2d0c47b6d280c5e7b5c25e`, block `12061723`. Runtime code and immutable dependencies match the compiled artifact. All ten token mappings match the registry. The previous executor remains in legacy recovery metadata.
- Interpreter: `0xdA5ac3c48a6B977E2b2aa52F74da71d50BFf2B3F`, deployment `0x54238a7a7aa69d946d1a12a23e2ceaf3d80314be6e42badf1a80a7c2447d629e`. Finalized execution succeeded, and exact source/schema/initialized storage were verified.
- Live English interpretation `0x32179a728cd065279a4f392c4b087d11c0be6ade3ad72be3ab35af9726b09c0c` produced the expected `0.1 rUSDC` to `rWETH` trade with matching caller/request/input identity. Conflicting input `0x8f8b4de1b76fb16c5a1980504dff8e3695a62ac7f4a94704fc95521466b8591e` was rejected, preserving the original result. Cross-caller overwrite `0x0839cf05307fe6c5f691ee0bc22916dd1d982c8148b0e0a5f6ff35ae74e361a4` was also rejected with the result unchanged.
- Live OrderBook freshness is `86400` seconds, and its price read succeeds. Hosted Latch accepts a Sepolia chain read and rejects an invalid token with HTTP 401. Transport regressions confirm denials/outages stay on Latch without direct-RPC fallback.
- Production deployment [9hNteEwDVgNvNGgQcTxEPYbchF2Y](https://vercel.com/mantissas-projects/roque/9hNteEwDVgNvNGgQcTxEPYbchF2Y), source `ddea807`, passed the remote Node24 build and hosted wallet-authentication, isolation, immutable quote/plan and disconnect checks before promotion to [roque-dex.vercel.app](https://roque-dex.vercel.app).
- OrderBook executor cutover `0xdf855c508b2300d166ce9bf89201d853edf065ac9b706a3fe4fea2bb7ad593ab` confirmed at block `12061922`. Existing book orders, liquidity and earlier owner exits were retained.
- Canonical hosted OAuth checks verify wallet consent, exact redirect allowlist, S256 PKCE, single-use authorization codes, MCP initialization, all five tools and token revocation. This is a protocol/client simulation; no actual Claude account connection is claimed.
- Real hosted wallet swap `0x0751be7e6a005faab0b70091f90da05a2bfd072ba8244c795ccc1aec5f3dee94` confirmed at block `12061941` with three confirmations. It spends `0.1 rUSDC` and receives `52254076253192` raw `rWETH` into the same EOA. The observed wallet balance increase equals the canonical decoded receipt settlement. Its exact-amount approval is `0x1942b412098da6d4aaee9937a33a7bb0aff9cb392df01e1593d775c3608d8989`.
- Canonical health/tokens/OpenAPI/protected-resource metadata return 200. Public recovery cron returns 200 with the configured credential; all three cron routes reject anonymous requests. The rotated scheduler credential is synchronized in GitHub.

The deployed interpreter retains the network-compatible concrete runner `1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6` and the studionet `v0.2.0` wire header. A minimal contract with this runner executes successfully; the newer runner `1zr6nqk597d97kg0dyxg0shhrykx5v02zjgnyrajapy4wlqvfvwh` fails with `invalid_contract` even with the same wire header. The linter's newer-runner advisory is therefore not a deployment instruction. The actual pinned SDK exposes caller identity as `gl.message.sender_address`.

Hosted Latch target/method restrictions and audit retention, an actual Claude-client connection and embedded-wallet provider certification remain external acceptance checks. Local networking and studionet's 500-request/hour limit affected diagnostics; neither is treated as proof of a production outage.
