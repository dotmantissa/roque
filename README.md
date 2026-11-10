<div align="center">

# Roque

**Trade the way you'd say it.**

An agent native exchange on Ethereum Sepolia. Tell it what you want in plain words, a judgment layer reads the intent, and deterministic contracts on-chain decide whether it happens. Your keys never leave your hands.

</div>

---

## Why this exists

Most "AI trading" demos quietly hand a language model the keys and hope for the best. That is the whole risk in one sentence. A model that can be talked into anything should never be the thing standing between you and your money.

Roque is built the other way around. The clever part proposes. The boring part decides. An intelligent contract on GenLayer reads your sentence and turns it into a structured intent, but it holds no funds and has no authority over them. What actually moves value is a set of plain Solidity contracts on Sepolia that only honor what you cryptographically pre approved. Compromise the agent, the relayer, the keeper, the whole off-chain world, and the worst case is still bounded by caps you signed yourself.

The one rule everything serves:

> The AI can propose, reason, request, and coordinate. The AI cannot bypass on-chain authorization.

## What you can actually do

There are two ways to trade, and you switch between them with one toggle.

**Copilot.** You stay in the driver's seat. You type what you want, Roque quotes it against the same Chainlink price and pool reserves the market strip shows you, and then your own wallet signs every single action. Nothing happens without your signature. This is the honest default.

**Autonomous.** You grant Roque a bounded capability once, signed with EIP-712 from your wallet: a spend cap per trade, a daily ceiling, a slippage limit, and an expiry. From then on the agent signer can act inside that box without waking you up for every move, and the AgentExecutor contract refuses anything that steps outside it. Revoke it whenever you like and the door shuts on-chain immediately. You are delegating a narrow, expiring permission, not your account.

Either way, the market data is real, the signatures are real, and the money is Sepolia test money so nobody gets hurt while you poke at it.

## Four things a price feed cannot answer

The two modes above settle who signs. These four settle what you are allowed to ask for, and every one of them needs a judgment about the world rather than a number from an oracle.

**Orders that wait on an event.** "Sell half my ETH if the SEC approves a spot Solana ETF" is not a price trigger, and no feed on Sepolia carries it. Roque takes the condition in your own words, gathers public evidence, and puts the question to GenLayer's validators, who have to agree before anything moves. Two guards keep that honest. A low confidence verdict does not fill. And a condition that no public source could ever settle is refused when you place it, with the reason written down, instead of resting politely forever. "My neighbour's cat comes home" is a fine wish and a broken order, and you learn which one it is in the first half minute rather than never.

**Playbooks.** One condition is a trade. Several of them, in order, is a plan. A playbook is a chain of steps, each with its own trigger, and the keeper walks it one rung at a time: buy a quarter now, another quarter if ETH touches $2,565, the rest only if the Fed actually cuts. Steps fire in the order you wrote them and never out of it, because a ladder whose second rung fires before its first is not a plan, it is two random trades.

**Both of them spend from the agent vault, and only from there.** These fire while nobody is watching, so the money has to be money the agent already holds authority over: your vault balance, never your connected wallet. Both screens say so, and both refuse a size the vault cannot cover at the moment you commit to it rather than at the moment it would have filled. An event order is costed when you write it, so you hear about a shortfall before paying for a consensus round, and costed again when you arm it, because the screen takes half a minute and a balance can move in that time. A playbook is costed when you arm it, because a draft is still only a plan, and it is costed as a whole, since a ladder that can afford its first rung and not its second is a ladder that stops halfway. The one thing that does not count against you is the plan's own output: a rung that sells what the rung above it bought is funded by the ladder, not by your vault, so the dip ladder everyone actually wants to write still writes.

**Committed money stays committed.** Checking the balance is not enough once an order can rest for a fortnight, because nothing stopped that balance leaving afterwards. So arming sets the money aside in the vault contract, and arming rather than writing, because holding a balance against every sentence you screened would lock up a vault for orders that never go live. A share of a balance is resolved to a figure at that moment and that figure is held, so "spend all of my rUSDC when X happens" holds all of it rather than nothing; the fill still sizes itself at fire time. The vault shows the held part separately, a second order cannot be written against money the first one is waiting on, and nothing will move it: not a withdrawal, not an ordinary autonomous trade, not a trade into some other token the hold has never heard of. That last one is the door that mattered. A hold that lives in a database shuts the app's withdraw button and nothing else, so you could spend the same balance on a swap and walk out with what it bought, and the order would not find out until its condition came true. `AgentExecutor.lockedBalance` is the line now, and the only function that can move the money is the one doing the checking. Cancel the order and the money is free again. It is a hold and not a trap: every one carries its own expiry, anyone can release one past it, and revoking your capability lets you take back your own, because the right to your money should never depend on anyone else's cooperation.

**Forkable links.** Any order or playbook publishes to a short public URL. Whoever opens it sees the thesis, the triggers, and the reasoning behind them, and can fork the whole thing into their own vault at their own size. What travels is the thinking, not the position. Your capability grant stays yours, the fork sizes itself against the forker's own balance, and every stored step is validated again on the way in rather than trusted because a stranger published it. The author's size is checked against *your* vault too, so a link cannot hand you an order that arms, waits a fortnight, wins its verdict and then fails on a balance nobody mentioned.

**A proposals inbox.** Here the agent speaks first. It watches your vault, your resting orders, and the market, and when it finds something worth your attention it writes up a proposal along with its reasoning: a grant about to expire with money still sitting in the vault, an order whose condition just settled the wrong way, a drawdown deep enough to ladder into, stablecoins doing nothing. Accept turns a proposal into a real order or playbook. Dismiss makes it go away and stay away. Nothing in the inbox can move money by itself, so the worst a bad proposal costs you is a glance.

Under the inbox there is a small read-only chat that answers from what the app already has in hand: a price, your balances, your vault, your recent trades, your open orders, the conditions you are watching, and the step each playbook is on. It never calls the agent and never suggests a trade, so nothing in it can sign or spend, and anything asking for a prediction gets a plain refusal rather than an opinion.

Both list screens narrow by state and by period, because once a few orders have been through a screen the list is mostly history and finding what is still live means scrolling past all of it. On playbooks, failed plans get their own bucket rather than being lumped in with the endings: a plan that broke mid-ladder may have traded some rungs and not others, which is a position somebody needs to know about.

## How the pieces fit

Three layers, three jobs, and they are kept apart on purpose.

| Concern | The question it answers | Who owns it |
|---|---|---|
| Intelligence | "What does the person actually want?" | GenLayer intelligent contract, the judgment layer |
| Authorization | "What is this agent allowed to do?" | Capability registry on Sepolia, plus Latch for off-chain credentials |
| Execution | "Is this transaction genuinely valid right now?" | Solidity contracts on Sepolia, the financial source of truth |

Why GenLayer instead of a plain model call: interpretation runs across validators that reach consensus through the equivalence principle, so the judgment is trust minimized and the reasoning is auditable rather than a black box you take on faith. It is used only where judgment earns its place. Anything touching money stays deterministic on Sepolia.

That judgment gets asked two different questions, and the second one is the one worth noticing. Before an event order is allowed to rest, the validators are asked about the question rather than about the world: could any public source settle this condition at all? Only a condition that survives the screen can be armed, and arming is your press, not an automatic consequence of the verdict. A passed screen means the validators could check it, which is not the same as you wanting money behind it, so the order waits at "ready to arm" until you say so. The same consensus that later decides whether the event happened first decides whether the event is knowable, which is how an order that could never have filled gets refused out loud instead of quietly.

Why there is an off-chain relayer at all: a GenLayer contract cannot reach across to Sepolia by itself, and it cannot produce a signature Sepolia would accept. So a finalized GenLayer decision only lands on-chain through a relayer that reads that state and signs the transaction. That relayer is untrusted by design. The on-chain caps bound it even if it is fully compromised, which is the entire point of putting the caps on-chain.

Relayer and keeper writes use the configured Latch HTTPS RPC transport in production. The application still holds the agent and gas-payer signing keys; Latch policy restrictions, credential governance and audit trails require provider-side verification. Sepolia contracts enforce the signed spend caps. See [public API and custody details](docs/PUBLIC_API.md) and [security remediation](docs/SECURITY_REMEDIATION.md).

## Live on Sepolia

The current deployment is on Sepolia (chain id `11155111`). The canonical
addresses, token metadata, Chainlink feeds, prices, and all 45 pool addresses
are maintained in [`packages/shared/src/deployment.json`](packages/shared/src/deployment.json).

| Contract | Address |
|---|---|
| AgentExecutor | `0xcd0098dD2Cf098D4C82Fdd8fEdc4E1309e2009dC` |
| DEX Router | `0x7965E72630cDBC3d0cc0D6DdC75497d674d49799` |
| Order Book | `0x04d38a17587B4F7Ba9c477857735475aD39c61B4` |
| Faucet Router | `0x9E3d2EBb9c2dE8665f2F198b59Fe780FA2424077` |
| Chainlink ETH / USD feed | `0x694AA1769357215DE4FAC081bf1f309aDC325306` |

The executor was redeployed when the vault learned to hold money for a resting
order, since that moved both intent typehashes. Everything else stayed: same
router, same tokens, same forty-five pools and their liquidity, same order book
and the orders resting in it. If you had a balance in the previous executor at
`0xff3ACF2377C831886bF674543eb4bE38DF19a5cc`, it is still there and still
withdrawable from that contract; move it across and grant again.

The deployment contains ten faucet-backed tokens:
`rUSDC`, `rUSDT`, `rDAI`, `rWETH`, `rWBTC`, `rLINK`, `rSNX`, `rFORTH`,
`rEURC`, and `rPAXG`. Each unordered token pair has its own pool, for 45
direct pools in total. The GenLayer interpreter address is recorded in
[`packages/genlayer/deployment.json`](packages/genlayer/deployment.json).

## Running it yourself

You need pnpm, Node, and Foundry. For the GenLayer piece you also need Python with the GenLayer tooling.

Start with the environment. Copy the template and fill it in with your own testnet keys and endpoints. Treat these keys as burnable, because that is exactly what they are.

```bash
cp .env.example .env
# then open .env and fill in the blanks
```

The web app reads its own environment from `apps/web/.env.local`. The simplest thing is to point it at the root file so there is one place to edit:

```bash
ln -sf ../../.env apps/web/.env.local
```

Install everything and bring up the front end:

```bash
pnpm install
pnpm web        # Next.js app on http://localhost:3000
```

The backend runs as a standalone service when you want the autonomous side working end to end:

```bash
pnpm relayer    # the relayer and API
pnpm keeper     # the keeper loop that settles resting orders
```

For randomized testnet swaps against the deployed app, run `~/rialo/roque_run`.
Use `~/rialo/roque_run --dry-run` for a read-only balance check and sample plans.
The runner uses Autonomous Confirm/Direct exclusively, with a hard limit of
100 Sepolia submissions including setup. Configuration, Latch routing, logs and
recovery are documented in [the runner guide](scripts/runner/README.md).

## Testing

The contracts carry a full Foundry suite, and it is meant to stay green.

```bash
cd contracts
forge test
```

The backend logic in `@roque/core` has its own tests, and the GenLayer interpreter is exercised with gltest. Most of that suite covers the judgment features, and the sharpest tests in it are the ones that assert nothing happens: a screening call that fails leaves the order screening rather than rejected, because "we could not ask" and "the answer is no" are different facts and only one of them is the order's fault; a low confidence verdict does not move money; and a playbook that loses the race to claim its own step walks away without trading.

A chunk of the suite is about two workers reaching the same row, because the judgment work genuinely runs in more than one place: a Vercel cron, the standalone relayer's loop, and a GitHub Action against the keeper. Those tests cover two workers filling one verdict, buying one consensus round, screening one order, a sweep meeting a row mid-trade, a cancel meeting one, arming rolled back when the chain will not take the hold, concurrent relayer sends getting distinct nonces, and two indexers sharing one block window. The Solidity side has its own suite for the vault holds, and most of it asserts an absence: no withdrawal into a hold, no ordinary trade reaching past one, no second commitment on the same deposit, and, fuzzed, no hold that can outlive the money behind it.

```bash
pnpm check                              # typecheck, core tests, and web build
cd contracts && forge test              # Solidity unit and fuzz tests
cd packages/genlayer && uv run pytest   # deterministic interpreter tests
```

## Repo layout

```
apps/
  web/        the Next.js front end, both modes, real data
  relayer/    the standalone relayer and keeper service
packages/
  core/       all the backend logic, one implementation shared by web and relayer
  shared/     ABIs, addresses, and the EIP-712 types both sides agree on
  genlayer/   the intelligent contract and its tests
contracts/    the Solidity, the Foundry suite, and the deploy script
```

One detail worth calling out: `@roque/core` ships TypeScript source rather than a build step, and the web app and the relayer import the exact same modules. There is one implementation of the logic, and it runs the same whether it sits behind a serverless route or a long lived process. Less to keep in sync, fewer places for the two worlds to drift apart.

## A word of caution

This is a demo on a testnet. The money is play money, the keys in `.env.example` are placeholders, and nothing here is financial advice. What is real is the shape of it: real signatures, real contracts, real on-chain enforcement of limits you set yourself. Bring your own testnet wallet, grab some Sepolia ETH from a faucet, and have a go.

