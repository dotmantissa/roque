# Public wallet swap API

The public [Dev page](https://roque-dex.vercel.app/dev), linked from the landing page, includes copyable HTTP calls, wallet-proof and SDK examples, partner-app setup, MCP connection details and an endpoint table generated from OpenAPI.

Base URL: `https://roque-dex.vercel.app`. API reference: `/v1/openapi.json`. The allowlisted beta supports Sepolia test tokens, immediate absolute exact-input swaps and settlement into the authenticated EOA wallet. Application credentials belong on the partner backend. The browser receives only wallet proof/session information and reviewed transaction plans.

1. Register an application with `scripts/register-api-client.ts`, supplying a private absolute key-file path outside the repository and the application name. Only the key hash enters the database.
2. Send `X-API-Key` to `POST /v1/auth/challenges` with `owner` and `chainId:11155111`. Independently check the trusted domain, URI, chain and wallet before signing its message; the SDK does this.
3. Send the signature, owner and challenge ID to `POST /v1/auth/sessions`. Subsequent requests carry the application key plus the wallet bearer token.
4. `POST /v1/intents` with `{command,chainId:11155111,executionMode:"wallet",slippageBps:100}` and a stable `Idempotency-Key` returns 202. Poll `/v1/intents/{id}` until ready or rejected. Conditional orders, ambiguous/low-confidence actions, percentage sizing and unsupported chains are rejected.
5. `POST /v1/quotes` with the intent ID; `POST /v1/swaps/prepare` with the quote ID. Use distinct stable idempotency keys. The quote pins a canonical block and expires after 120 seconds.
6. Review input amount, token addresses, recipient, fee, impact and minimum receive. Validate the plan hash and independently decode the exact allowance and swap calldata. Approve only the exact input amount, wait for approval success, recheck expiry and simulate the swap before signing it.
7. Report the returned hash to `POST /v1/swaps/{id}/submissions`, then poll `GET /v1/swaps/{id}`. The API validates the wallet sender, chain, target, exact action and canonical receipt/event. Confirmed settlement reports the actual output; three confirmations are required.

See [the independent partner app](../examples/partner-app/README.md) and [SDK source](../packages/sdk/src/index.ts). A hash returned by a wallet is authoritative even if reporting times out. Persist it locally, inspect the explorer and retry the same report. An unknown outcome does not authorize another trade. The SDK's `SubmittedTradeError` exposes the hash and `onSubmitted` permits immediate journaling.

Intent, quote and plan records are isolated by client plus wallet. Idempotency keys are scoped to application/wallet/chain/operation: changed fields produce 409. Quote/plan generation fencing prevents expired workers from overwriting results. Disconnect with `DELETE /v1/auth/session`.

## MCP connection

Connector URL: `https://roque-dex.vercel.app/mcp`. OAuth discovery is published at `/.well-known/oauth-protected-resource/mcp` and `/.well-known/oauth-authorization-server`. Registration permits only explicitly configured callback URLs. The configured Claude callback is `https://claude.ai/api/mcp/auth_callback`, documented by [Claude](https://support.anthropic.com/en/articles/11503834-building-custom-integrations-via-remote-mcp-servers).

Authorization code flow requires S256 PKCE, exact redirects, resource audience and explicit wallet consent at `/connect`. Tokens and codes are hashed in storage; codes are one-time and connections can be revoked. Access tokens expire after one hour; reconnect is required because refresh-token grants are not enabled.

`POST /oauth/register` requires `redirect_uris`; `client_name` is optional. Unsupported client metadata is ignored. An optional space-separated `scope` may select only supported scopes; omitted scope grants the five beta scopes. Authorization defaults to that client's registered scopes and rejects requests for additional permissions. Include `swaps:read` when requesting a subset for MCP, since connector access requires it. This beta supports only `authorization_code`, response type `code` and token authentication method `none`. Registration returns a client ID and granted scope, not a REST API key or client secret. Use the separate operator registration script to provision REST access.

Registration errors use OAuth error strings such as `invalid_client_metadata` and `invalid_redirect_uri`, with a safe `error_description`. Responses include a generated `X-Request-Id` for support. Structured OAuth logs record the route template, timestamp, request ID, method, status and a safe rejection reason; validation diagnostics list only known field names. Request bodies, query values, client names, callback values, headers and raw errors are excluded. Keep the response request ID and failure time when retrying Claude so the operator can correlate Vercel logs. Callback changes require checking the actual client request against the operator's exact allowlist.

The five tools list tokens, queue an interpretation, prepare a supported trade, request an owner-bound approval URL and read swap status. Approval URLs expire with their plan, require fresh owner proof and become unavailable when their connection is revoked. Each trade requires a wallet signature on `/approve`. Raw commands may also be publicly visible in GenLayer transaction data; private HTTP history does not make on-chain prompts private.

## Workers and quotas

Next drains one durable interpretation job with `after()` after relevant intent/MCP requests. A SQL lease fences all replicas; the HTTP response does not wait for consensus. The daily Vercel `/api/cron/public` job and the existing five-minute judgment GitHub Action provide recovery. The standalone `pnpm keeper` runs the same public and settlement workers more often.

HTTP payloads are capped at 16 KiB. Fixed-window global/client/wallet limits precede expensive work. Only one interpretation job runs globally. Jobs retry after expired leases, with a maximum of three attempts. Operations have a permanent 100,000-row admission ceiling; an operator must archive before expanding capacity. Financial journals are retained; quotas and expired credentials are cleaned separately.

Order reads expose at most 100 owner indices per page; `/api/orders/{owner}?before={nextCursor}` continues older pages. The keeper scans at most 50 IDs and 40 seconds per pass with a persisted circular cursor. Broadcasts are returned as submitted; canonical matching receipts identify fills.

## Latch and custody

Production relayer writes require complete HTTPS Latch configuration and a dedicated non-admin gas payer. The gas payer and agent still sign with application-held keys; Latch is a configured RPC transport and provider policy boundary. Hosted custody, method/address policies, audit trails and denial behavior need separate provider evidence. Public v1 wallet transactions use the partner wallet's provider and do not implicitly travel through server Latch.

Optional unattended scoped delegation and direct autonomous wallet payout are excluded from v1 and remain behind a separate contract audit/migration gate. EOA wallet support is tested; a real embedded-wallet provider and actual Claude connection remain pilot acceptance checks until release evidence records them.
