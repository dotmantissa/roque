This is an independent app with a backend proxy and its own injected EVM wallet. No application key enters the browser. It demonstrates connect → English intent → poll → quote → review → allowance → wallet swap → confirmed status.

From the workspace root, bundle the browser client using the esbuild bundled with tsx:

```bash
pnpm --filter @roque/core exec node -e 'const entry=require.resolve("tsx");const esbuild=require(require.resolve("esbuild",{paths:[entry]}));esbuild.build({entryPoints:["../../examples/partner-app/browser.ts"],bundle:true,format:"esm",platform:"browser",outfile:"../../examples/partner-app/sdk.js"})'
ROQUE_API_URL=http://localhost:8787 ROQUE_API_KEY=your-local-partner-key node examples/partner-app/server.mjs
```

Register an allowlisted beta client using `scripts/register-api-client.ts`, run the API plus the separate public worker, and open http://localhost:3100 with a funded Sepolia EOA. Set `AUTH_ORIGIN` to the trusted approval origin and configure the SDK's `authOrigin` when the API and sign-in origins differ. The example proxy expects the same origin for sign-in; set it explicitly for your deployment.

The local EVM test `packages/core/test/wallet-flow.evm.test.ts` verifies the same SDK/HTTP/SQL path against deployed contracts and checks the wallet output balance. Live embedded-wallet-provider certification is still a pilot check. Generated sdk.js is ignored.
