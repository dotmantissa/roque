import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, Code2, ExternalLink } from "lucide-react";
import { RoqueLogo } from "@/components/RoqueMark";
import { ThemeToggle } from "@/components/ThemeToggle";
import { CodeExample } from "@/components/CodeExample";
import spec from "../../../../../docs/openapi.json";
import * as examples from "./examples";
import styles from "./page.module.css";

export const metadata: Metadata = {
  title: "Dev · API guide",
  description: "Integrate Roque: wallet authentication, natural-language swaps, immutable quotes, transaction signing, status and OAuth MCP examples.",
};

const sections = [
  ["start", "Start here"], ["authentication", "Wallet authentication"],
  ["interpret", "Create an intent"], ["quote", "Quote and prepare"],
  ["sign", "Review and sign"], ["settlement", "Track settlement"],
  ["example", "Run the partner app"], ["mcp", "Agent connector"],
  ["reference", "Endpoint reference"], ["errors", "Errors and retries"],
] as const;

const endpoints = Object.entries(spec.paths).flatMap(([path, operations]) =>
  Object.entries(operations).map(([method, operation]) => ({
    path, method: method.toUpperCase(), summary: operation.summary,
    auth: operation.security.length === 0 ? "Public" :
      path.startsWith("/v1/auth/challenges") || path.startsWith("/v1/auth/sessions")
        ? "App key" : path.startsWith("/v1/approval-links/")
          ? "Owner proof" : "App key + wallet token (or OAuth)",
  })),
);

export default function DevPage() {
  return (
    <div className={styles.page}>
      <header className="landing-nav">
        <Link href="/" className="site-brand" aria-label="Roque home"><RoqueLogo size={26} /></Link>
        <nav className="landing-nav-right" aria-label="Primary navigation">
          <ThemeToggle />
          <Link href="/copilot" className="btn btn-primary">Open app <ArrowRight size={16} /></Link>
        </nav>
      </header>

      <main id="main-content">
        <div className={styles.hero}>
          <span className="landing-eyebrow"><Code2 size={15} /> Developer guide · v1</span>
          <h1>From a sentence<br />to a signed swap.</h1>
          <p>Give your app a trading API. Roque reads the intent, prepares an exact trade, and settles into your user&apos;s wallet after they sign.</p>
          <div className={styles.heroLinks}>
            <a href="#authentication" className="btn btn-primary">Make your first call <ArrowRight size={16} /></a>
            <a href="/v1/openapi.json" className="btn btn-ghost">OpenAPI JSON <ExternalLink size={15} /></a>
          </div>
          <div className={styles.facts}><span>Sepolia · 11155111</span><span>EOA wallets</span><span>Exact input · market swaps</span><span>Allowlisted beta</span></div>
        </div>

        <div className={styles.layout}>
          <aside className={styles.sidebar}>
            <nav aria-label="On this page"><span className={styles.contentsLabel}>On this page</span>
              {sections.map(([id, label]) => <a key={id} href={`#${id}`}>{label}</a>)}
            </nav>
          </aside>
          <div className={styles.article}>
            <section id="start" className={styles.section}>
              <span className={styles.step}>01 / Start here</span><h2>One backend. Your user&apos;s wallet.</h2>
              <p>The API base is <code>https://roque-dex.vercel.app</code>. Your backend holds an application key and forwards your user&apos;s authenticated calls. Their EVM wallet signs the login message and each transaction. The output goes to that same wallet.</p>
              <p>Use Sepolia ETH for gas and the test-token addresses from <code>/v1/tokens</code>. Public v1 accepts absolute, immediate swaps such as <strong>Swap 0.1 rUSDC for rWETH</strong>. Conditional trades, percentage amounts, smart accounts and autonomous delegation are outside this API.</p>
              <div className={styles.note}><strong>Get an application key</strong><p>Application access is provisioned by the Roque operator for beta partners. Request a key through <a href="https://github.com/dotmantissa/roque/issues/new">the project&apos;s integration issue tracker</a>; never include credentials in an issue. There is no public API-key signup endpoint. Operators use <a href="https://github.com/dotmantissa/roque/blob/master/scripts/register-api-client.ts">register-api-client.ts</a> with private database configuration.</p></div>
              <CodeExample label="Public discovery · curl" code={examples.discovery} />
            </section>

            <section id="authentication" className={styles.section}>
              <span className={styles.step}>02 / Authentication</span><h2>Prove which wallet is trading.</h2>
              <p>Send your app key as <code>X-API-Key</code>. Create a challenge for the selected wallet, validate the exact message against the trusted Roque origin, and ask that wallet to sign it. Challenges expire after five minutes and can be used once.</p>
              <p>The shell examples share variables and require Bash, curl, jq and Node.js 22.13 or newer. Set <code>OWNER</code> to the wallet address selected by your user. Keep the application key on your backend; forward only the challenge JSON to the browser.</p>
              <CodeExample label="Create a challenge · private terminal" code={examples.credentials} />
              <CodeExample label="Validate and sign · browser TypeScript" code={examples.walletProof} />
              <p>Return <code>challengeId</code>, <code>owner</code> and <code>signature</code> to your backend, then exchange them for a wallet token. Keep that token private and send it as <code>Authorization: Bearer …</code> alongside the app key on protected calls.</p>
              <CodeExample label="Exchange the signature · private terminal" code={examples.session} />
              <p>Use the <a href="#example">SDK from this repository</a> for the TypeScript examples. It validates domain, URI, chain, wallet and expiry before requesting a signature.</p>
            </section>

            <section id="interpret" className={styles.section}>
              <span className={styles.step}>03 / Intent</span><h2>Send the words. Poll the result.</h2>
              <p><code>POST /v1/intents</code> returns <code>202</code> with an <code>id</code>, <code>status</code> and <code>statusUrl</code>. Interpretation runs asynchronously. Poll the same ID through <code>queued</code> and <code>interpreting</code>; proceed only when it is <code>ready</code>. Stop on <code>rejected</code> or <code>failed</code>.</p>
              <p><code>slippageBps: 100</code> means 1%; the accepted range is 0–500. Commands are limited to 500 characters. Give each new trade a stable request ID and retain it across retries.</p>
              <CodeExample label="Create and poll an intent · private terminal" code={examples.interpretation} />
            </section>

            <section id="quote" className={styles.section}>
              <span className={styles.step}>04 / Quote</span><h2>Prepare the exact transactions.</h2>
              <p>Quote a ready intent, then prepare its quote ID. Each write needs its own <code>Idempotency-Key</code>. The quote pins a canonical chain block and expires after 120 seconds. A plan contains the approval and swap calldata, recipient, input amount, minimum receive, fees, price impact and expiry.</p>
              <CodeExample label="Quote and prepare · private terminal" code={examples.preparation} />
              <p>Amounts ending in <code>Raw</code> are decimal strings in the token&apos;s smallest units. For example, <code>100000</code> raw units of a six-decimal token is <code>0.1</code> token. Use the returned decimal metadata and integer arithmetic.</p>
            </section>

            <section id="sign" className={styles.section}>
              <span className={styles.step}>05 / Wallet signing</span><h2>Review first. Sign on a separate action.</h2>
              <p>Display token addresses, spend amount, minimum receive, recipient, fees, impact and expiry. After explicit user approval, validate the plan, sign the exact allowance, wait for its successful receipt, check expiry again, simulate the swap and ask the wallet to sign it.</p>
              <p>The SDK performs these checks and independently decodes the calldata. This example uses a same-origin backend proxy that adds the app key to <code>/v1/*</code> requests and preserves the wallet token and idempotency headers. The complete proxy is in the <a href="#example">partner app below</a>.</p>
              <CodeExample label="Prepare, review and sign · browser TypeScript" code={examples.sdk} />
              <div className={styles.note}><strong>Retain the submitted hash</strong><p>Persist the swap ID, plan and returned transaction hash. If reporting times out after a wallet broadcast, report that same hash and poll status. Resume an existing trade after a reload; another signature would create another trade.</p></div>
            </section>

            <section id="settlement" className={styles.section}>
              <span className={styles.step}>06 / Settlement</span><h2>A hash is the start of confirmation.</h2>
              <p>Report the <strong>swap transaction hash</strong>, then poll its swap ID. Status progresses through <code>submitted</code> and <code>confirming</code>. <code>confirmed</code> requires a successful, matching receipt and three confirmations; <code>reverted</code> means the transaction failed. Confirmed output is returned in <code>settlement.amountOutRaw</code>.</p>
              <CodeExample label="Report, poll and disconnect · private terminal" code={examples.settlement} />
              <p>Intent, quote and swap records are isolated by application and wallet. Disconnecting revokes this session; an already submitted transaction continues to settle on chain.</p>
            </section>

            <section id="example" className={styles.section}>
              <span className={styles.step}>07 / Working example</span><h2>Run an independent partner app.</h2>
              <p><code>@roque/sdk</code> and <code>@roque/shared</code> are workspace packages in the repository; the examples do not require an npm-published SDK. The bundled partner app includes a backend proxy, injected EVM wallet, review screen and status polling. Set <code>ROQUE_API_KEY</code> in the server environment from your supplied private key file before starting it.</p>
              <CodeExample label="Run the partner example · backend terminal" code={examples.partner} />
              <div className={styles.resources}>
                <a href="https://github.com/dotmantissa/roque/tree/master/examples/partner-app">Partner app source <ExternalLink size={14} /></a>
                <a href="https://github.com/dotmantissa/roque/blob/master/packages/sdk/src/index.ts">SDK source <ExternalLink size={14} /></a>
              </div>
            </section>

            <section id="mcp" className={styles.section}>
              <span className={styles.step}>08 / Agent connector</span><h2>Connect through OAuth and MCP.</h2>
              <p>Use the remote connector URL below in an OAuth-capable MCP client. Authorization requires an allowlisted callback, S256 PKCE, the exact resource audience and explicit wallet consent on <code>/connect</code>. Access tokens last one hour; reconnect after expiry because refresh grants are not enabled.</p>
              <CodeExample label="MCP connection details" code={examples.mcp} />
              <p>The connector can prepare a trade and request an approval link. The wallet owner reviews and signs on <code>/approve</code>. For a custom client, ask the operator to allowlist its exact callback before registering it. The configured Claude callback is <code>https://claude.ai/api/mcp/auth_callback</code>.</p>
              <p>Raw commands may also be visible in GenLayer transaction data. Actual Claude-account and embedded-wallet provider certification remain pilot acceptance checks.</p>
            </section>

            <section id="reference" className={styles.section}>
              <span className={styles.step}>09 / Reference</span><h2>The public v1 endpoints.</h2>
              <p>This table is generated from the checked-in <a href="/v1/openapi.json">OpenAPI specification</a>. JSON bodies use <code>Content-Type: application/json</code>; GET requests and empty DELETE requests do not need it.</p>
              <div className={styles.tableScroll} tabIndex={0} aria-label="API endpoint reference">
                <table><caption className={styles.copyStatus}>Public v1 API endpoints and authentication</caption><thead><tr><th>Method / endpoint</th><th>Use</th><th>Authentication</th></tr></thead>
                  <tbody>{endpoints.map(endpoint => <tr key={`${endpoint.method}:${endpoint.path}`}><td><span className={styles.method}>{endpoint.method}</span><code>{endpoint.path}</code></td><td>{endpoint.summary}</td><td>{endpoint.auth}</td></tr>)}</tbody>
                </table>
              </div>
              <p>OAuth tokens replace the app-key/wallet-token pair for permitted scopes. Approval-link resolution and submission require the link token plus a fresh wallet-owner proof; see the specification for their request fields.</p>
            </section>

            <section id="errors" className={styles.section}>
              <span className={styles.step}>10 / Errors</span><h2>Retry the operation you already started.</h2>
              <p>Errors have <code>error.code</code>, <code>error.message</code> and <code>error.requestId</code>. Keep the request ID for support, and avoid logging app keys, bearer tokens or signed transaction bytes.</p>
              <dl className={styles.errors}>
                <div><dt>400 / 413 / 422</dt><dd>Fix invalid fields, payloads over 16 KiB or unsupported trade instructions.</dd></div>
                <div><dt>401 / 403</dt><dd>Reconnect an expired or revoked wallet session; check the app key, wallet and granted scopes.</dd></div>
                <div><dt>409</dt><dd>Wait for a pending operation and retry its original key. Changed request fields need a new operation; never reuse a key for different input.</dd></div>
                <div><dt>410</dt><dd>The quote or plan expired. Obtain a fresh quote and plan with new operation keys, then review them again.</dd></div>
                <div><dt>429 / 503</dt><dd>Back off and retry the same operation key. Do not turn a timeout into a second trade.</dd></div>
              </dl>
              <p>Idempotency keys must be 8–128 characters using letters, digits, <code>.</code>, <code>_</code>, <code>:</code> or <code>-</code>. They are scoped to application, wallet, chain and operation. Keep each original request body with its key.</p>
            </section>
          </div>
        </div>
      </main>
      <footer className="landing-footer">Roque developer API · Sepolia test tokens. <Link href="/">Back to Roque</Link></footer>
    </div>
  );
}
