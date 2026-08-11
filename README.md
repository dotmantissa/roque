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

## How the pieces fit

Three layers, three jobs, and they are kept apart on purpose.

| Concern | The question it answers | Who owns it |
|---|---|---|
| Intelligence | "What does the person actually want?" | GenLayer intelligent contract, the judgment layer |
| Authorization | "What is this agent allowed to do?" | Capability registry on Sepolia, plus Latch for off-chain credentials |
| Execution | "Is this transaction genuinely valid right now?" | Solidity contracts on Sepolia, the financial source of truth |

Why GenLayer instead of a plain model call: interpretation runs across validators that reach consensus through the equivalence principle, so the judgment is trust minimized and the reasoning is auditable rather than a black box you take on faith. It is used only where judgment earns its place. Anything touching money stays deterministic on Sepolia.

Why there is an off-chain relayer at all: a GenLayer contract cannot reach across to Sepolia by itself, and it cannot produce a signature Sepolia would accept. So a finalized GenLayer decision only lands on-chain through a relayer that reads that state and signs the transaction. That relayer is untrusted by design. The on-chain caps bound it even if it is fully compromised, which is the entire point of putting the caps on-chain.

Latch sits over the relayer and keeper as an independent off-chain boundary: key custody, spend limits, credential governance, and an audit trail. It is deliberately not an on-chain authority. The signed caps on Sepolia stay primary, and Latch is the second, separate fence around the machinery that does the signing.

## Live on Sepolia

Everything below is deployed and verified on Sepolia (chain id `11155111`). The GenLayer interpreter runs on studionet.

| Contract | Address |
|---|---|
| AgentExecutor | `0x56C122192a5a05d40897fa67F26a2De86fdecFf9` |
| DEX Router | `0x2B69E5359dfc4cA575A82063B746d2b8BC346008` |
| Order Book | `0x78a67CA08dA92c95e2E4836d718902A328dD10e4` |
| Liquidity Pool | `0x536a50B0923942256366c56374aEaA16a789a415` |
| USDC (test) | `0x41aB951D0e80Ae358A254c521Cd388a92385939d` |
| WETH (test) | `0x9b325DcF0C39F620e73707181BB2AdDa0a5B7b8c` |
| Chainlink ETH / USD feed | `0x694AA1769357215DE4FAC081bf1f309aDC325306` |
| GenLayer interpreter (studionet) | `0xba1eEE9A8F07e7e68EEfC9E5Cd3aF396e023d357` |

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

## Testing

The contracts carry a full Foundry suite, and it is meant to stay green.

```bash
cd contracts
forge test
```

The backend logic in `@roque/core` has its own tests, and the GenLayer interpreter is exercised with gltest.

```bash
pnpm -r typecheck                       # types across the whole workspace
cd packages/genlayer && pytest          # the interpreter, adjudication included
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


