# Runtime dependency compatibility

`decode-uri-component@0.5.1` fixes malformed-input decoding denial of service.
WalletConnect still consumes `query-string@7`, which calls its decoder with
CommonJS `require()`. The patch changes only the decoder's export syntax and
package module type to CommonJS. Its upstream decoding algorithm is unchanged;
ESM default imports retain Node/webpack CommonJS interoperability.

The lockfile pins both the upstream integrity and the pnpm patch hash. Run
`pnpm --filter @roque/web test:wallet-dependencies` to verify real WalletConnect
query parsing, ESM/CommonJS interoperability, bounded malformed-input decoding,
and the upgraded MetaMask UUID dependency. Remove the patch when WalletConnect
uses a supported decoder without requiring this compatibility adaptation.

The `genlayer-js>eslint-plugin-import` override removes unused lint tooling
mistakenly declared as a runtime dependency by GenLayer 1.1.8. Its published
JavaScript and declarations do not import that package. SDK typechecks and live
interpretation verify the remaining runtime.

Exact minimum-release-age exceptions cover the reviewed Next/Privy security
updates and their version-matched packages; the general release-age policy
remains enabled. Other overrides retain existing majors except patched Sharp,
Zod, UUID and the decoder, whose compatibility is covered by build/runtime tests.
