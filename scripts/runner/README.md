Run from `~/rialo`:

```bash
./roque_run --dry-run
./roque_run
./roque_run --max-txs 10
```

`~/rialo/roque_run` links to the executable in this directory. It uses a separate,
pinned viem dependency; the first launch installs it with `npm ci` if needed.
It does not require the app, relayer, pnpm or development server to run locally.

The default API is `https://roque-dex.vercel.app/api`. The wallet lives only in
`~/.config/roque-run/config.json`, with permissions `0600`. `--config PATH` or
`ROQUE_RUN_CONFIG` selects another file. Supported fields are `privateKey`,
`apiUrl`, `rpcUrl`, `latchRpcUrl` and `latchToken`. Environment overrides and all
CLI options are listed by `./roque_run --help`.

The runner uses Autonomous Confirm and Direct exclusively. It reads current
wallet and unlocked vault balances, chooses funded vault
input tokens and different random output tokens, and sizes swaps between $0.25
and $5, using at most 25% of a token's available balance. Random selection is
test coverage; requests identify themselves as `Roque-Testnet-Runner/1.0`.
Amounts, grant ceilings and token decimals are checked before sending. Existing
live grants and daily caps are honored; exhausted daily caps are not reset.
If necessary, it signs a bounded 24-hour capability and deposits a small part
of one wallet balance in the vault. Deposits stay in the vault between runs.
Approvals are bounded by the current wallet balance rather than unlimited.

Every swap follows wallet authentication → interpret → execute.
Confirm and Direct are frontend behaviors using the same API: the runner's
Confirm adds an automated review/logging step, while Direct submits after
interpretation validation. This is API workload coverage, not a browser UI test.
Confirm and Direct are shuffled with equal weight. `--modes` can select either
or both; Copilot is disabled and explicit Copilot selections are rejected.
Small budgets or insufficient funds may not exercise both modes.

Autonomous grants and swaps use the deployed app's relayer and its server-side
Latch configuration. This script cannot independently verify the hosted
relayer's Latch settings; check the Latch audit trail. Local Latch credentials
are not required. Funding an empty vault still needs owner-signed token approvals
and deposits, which use `rpcUrl` by default. Optional `latchRpcUrl` and `latchToken`
can route that setup through local Latch; `--require-wallet-latch` enforces this
optional setup routing. All swaps use the app relayer with the normal command:

```bash
./roque_run
```

The hard limit is 100 Sepolia transaction submissions per invocation, including
setup, grants, approvals, deposits, reverts and uncertain sends. A smaller limit
can be selected with `--max-txs`. This can mean fewer completed swaps. GenLayer
interpretation transactions initiated internally by the app are outside this
Sepolia limit. Interpretation attempts are separately bounded (150 by default,
maximum 300). Runs are sequential and may take over an hour because each trade
waits for interpretation and a mined receipt. The runner stops after five
consecutive failed trade attempts. `--interval-ms` is fixed pacing, not a human
activity simulation.

`--dry-run` only reads the app and chain and prints sample plans. It does not
authenticate, sign, interpret, deposit, grant or send transactions. It cannot
prove that the deployed interpreter, Latch proxy or relayer will execute a swap.

Logs are private JSONL files under `~/.local/state/roque-run/runs/`. Each reserved
submission is recorded before sending. A per-wallet process lock prevents
overlapping local runs. Ctrl-C requests a stop after the current operation.
If interrupted after a submission, the next run checks its stored hash for a
receipt before continuing. For a relayer call whose response was lost before a
hash was returned, inspect app activity and the pending journal; do not resend
blindly. `--acknowledge-unresolved` clears the unresolved marker after you have
checked its outcome. Auth sessions, private keys, Latch credentials, signatures
and signed raw transactions are not logged.

Validation:

```bash
npm test --prefix scripts/runner
bash -n scripts/runner/roque_run
```
