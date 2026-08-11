# Roque — Architecture & Build Plan

> An agent-native DEX. Trade by clicking, or by talking: *"Buy ETH if it drops below $2,500,"* *"you can trade ETH for me, max $500/trade, expires tomorrow."*
> The point is not "AI can swap tokens." It is: **users safely delegate bounded financial capabilities to an agent, and those bounds are enforced independently of the agent's intelligence.**

Status: greenfield. This document is the confirmed design; nothing is built yet.

---

## 1. The one invariant everything serves

```
AI can propose, reason, request, coordinate.
AI cannot bypass deterministic authorization.
```

The LLM is never the authority over funds. It proposes a **structured intent**; deterministic Ethereum contracts decide whether that intent is permitted. Compromise of the agent, the relayer, the keeper, or Latch must never move funds beyond what the user cryptographically pre-authorized on-chain.

---

## 2. Three layers, three concerns

| Concern | Question | Owner |
|---|---|---|
| **Intelligence** | "What does the user want?" | GenLayer Intelligent Contract (judgment layer) |
| **Authorization** | "What is this agent allowed to do?" | On-chain capability registry (Sepolia) + Latch (off-chain creds) |
| **Execution** | "Is this transaction actually valid?" | Sepolia Solidity contracts (financial source of truth) |

```
                              USER
                                │
                ┌───────────────┴────────────────┐
                ▼                                 ▼
        Traditional DEX UI                  Agent Chat UI
                │                                 │
     user signs directly                         ▼
     (own wallet, Sepolia)             GenLayer IC  ── JUDGMENT ONLY, holds no funds
                │                       NL → structured intent
                │                       reasoning-based conditions
                │                                 │  finalized intent
                │                                 ▼
                │                          Off-chain RELAYER  ◄── governed by ──┐
                │                          (holds agentSigner key)              │
                │                                 │                         ┌───┴───┐
                │                                 ▼                         │ LATCH │
                └────────────────┬────────────────┘                        └───────┘
                                 ▼                              key custody · spend cap ·
                        Ethereum Sepolia                        API/RPC creds · allowlist · audit
                        ┌────────┴─────────┐
                        ▼                  ▼
             AgentExecutor + Capability   DEXRouter → AMM Pools / Order Book
             (deterministic enforcement)  ERC-20 test tokens · Chainlink feeds
```

**Why GenLayer at all** (vs. a plain LLM call): interpretation is run by multiple validators reaching consensus via the equivalence principle — decentralized, trust-minimized judgment — and the reasoning is auditable. It is used *only* where judgment adds value; anything involving money is deterministic on Sepolia.

**Why the off-chain relayer is unavoidable:** a GenLayer IC cannot natively send a transaction to Sepolia, and cannot produce a signature Sepolia can verify (no IC private key; output is non-deterministic across validators). Cross-chain is read-only via `gl.nondet.web` RPC. So a GenLayer decision reaches Sepolia only through an off-chain relayer that reads finalized GenLayer state and signs the Sepolia tx itself. The relayer is **untrusted** — on-chain caps bound it.

---

## 3. The two-signature delegation model

GenLayer never signs for Ethereum, so the trust root is the **user's own wallet**.

1. **User capability grant (EIP-712, signed once):** designates an `agentSigner`, permitted actions, allowed tokens, `maxPerTrade`, `maxDailyVolume`, `maxSlippage`, `validUntil`, nonce. Recorded on-chain via `AgentExecutor.grantCapability(...)` (emits `AgentAuthorized`).
2. **Per-action authorization (EIP-712, signed by the relayer's `agentSigner`):** the specific intent the relayer submits.

`AgentExecutor` verifies **both** signatures, then re-checks every bound deterministically (action allowed? token allowed? amount ≤ cap? daily volume ≤ cap? slippage ≤ policy? nonce unused? not expired? not revoked?) before calling the DEX. Only whitelisted typed operations exist (`executeSwap`, `createLimitOrder`, `cancelLimitOrder`) — **never** `execute(target, arbitraryData)`.

**Copilot mode** needs none of this: the agent fills the form, the user signs the swap with their own wallet like a normal DEX. Delegation crypto is required only for **autonomous mode**.

---

## 4. Components

### 4.1 Ethereum Sepolia (Solidity, Foundry)
- **Test tokens** — mintable ERC-20 `USDC` (6dp), `WETH` (18dp), public `faucet()`.
- **LiquidityPool** — constant-product AMM (`x*y=k`), LP shares, `addLiquidity` / `removeLiquidity` / `swap`, fee in bps. Deterministic; no AI.
- **DEXRouter** — `swapExactTokensForTokens`, `quoteSwap`, `swapForAgent` (only callable by AgentExecutor); slippage (`minAmountOut`), deadline, routing, fees.
- **OrderBook** — limit orders as on-chain state (owner, pair, amountIn, minOut, triggerPrice, expiry, nonce, status). `executeLimitOrder(orderId)` callable by anyone (keeper); contract checks the trigger against a **Chainlink Sepolia price feed** deterministically → a malicious keeper cannot execute an untriggered order.
- **AgentExecutor + CapabilityRegistry** — grant/revoke, the 10-point validation of §3, per-user **agent vault** (funds the agent may touch, isolated from the user's main wallet), daily-volume accounting, nonces. Emits the full agent event set.

### 4.2 GenLayer (Python Intelligent Contract, judgment layer)
- `interpret(text)` → structured intent via `gl.eq_principle.prompt_comparative` (nondet, isolated in a named function per the lint taint rule). Asks for clarification when a financially-material parameter is genuinely ambiguous (never silently guesses).
- Reasoning-based condition adjudication for fuzzy mandates. Simple price triggers stay on Sepolia/Chainlink.
- Reads Sepolia state (prices/balances/positions) via `gl.nondet.web.post` `eth_call`, block-pinned for consensus stability.
- **Holds no funds. Its output is advisory until the on-chain re-check passes.**

### 4.3 Off-chain (Node) — relayer + keeper
- **Relayer:** watches finalized GenLayer intents, builds + `agentSigner`-signs the Sepolia tx, submits to AgentExecutor. Untrusted.
- **Keeper:** polls order triggers, calls `executeLimitOrder`. No special authority.
- **Neon (Postgres):** activity log / indexer for the agent-activity view and portfolio reads.

### 4.4 Latch (Rialo, off-chain governance — Phase 4)
Governs the relayer + keeper only: custodies the relayer signing key (TEE secp256k1 signer + allowlist), governs price-API/RPC credentials, spend ceiling, rate limits, audit receipts. **Never an on-chain authority** — the independent second boundary of the dual-layer model. (Private beta; software-proxy path for MVP; confirm access early.)

### 4.5 Frontend (Next.js, Arbiter quality bar)
- **Privy in external-wallet-only mode** — MetaMask / WalletConnect to Sepolia. No email/embedded wallets.
- Traditional DEX (Swap / Limit / Liquidity / Portfolio / Orders) + Agent chat with **structured transaction previews** ([Approve]/[Reject]) and an autonomous-permission panel.
- Real icon pack, custom logo + favicon tied to the concept, light/dark toggle, clean motion. Not vibecoded.

---

## 5. Worked flows

**Instant swap (copilot):** user types *"swap 200 USDC for ETH"* → GenLayer `interpret` → SWAP intent → frontend preview → **user signs with own wallet** → DEXRouter swaps → event → UI updates. *(No relayer, no capability, no agent key.)*

**Autonomous limit order:** user grants a capability (EIP-712) → types *"buy $1,000 of ETH if it drops below $2,500 within 48h"* → GenLayer interprets (clarifies "max $1,000 spend vs. 1,000 USDC worth" if ambiguous) → relayer signs + submits `createLimitOrder` → AgentExecutor validates capability + records order → keeper watches Chainlink → on trigger, `executeLimitOrder` validates the condition on-chain → swap → events → activity log.

---

## 6. Failure scenarios (must survive by design)
- **Agent/LLM compromised or hallucinating** → intent re-validated on-chain; anything over caps/allowlist REJECTED.
- **Relayer compromised** → can only act within the user's signed capability; arbitrary calldata has no entrypoint.
- **Latch compromised** → off-chain access only; on-chain caps still bind.
- **GenLayer unavailable** → traditional DEX UI keeps working; only the agent chat degrades.

---

## 7. Phase plan (hackathon, full-vision scope)

| Phase | Deliverable | Gate |
|---|---|---|
| **P1** | Solidity DEX on Sepolia: tokens+faucet, AMM pool, router, order book+keeper, Chainlink triggers. Foundry tests green, deployed, verified. | A human can swap / LP / place a limit order via cast or a minimal UI. |
| **P2** | GenLayer IC (`interpret` + Sepolia reads), genlayer-js wiring, chat UI, **copilot mode** (user signs). Lint + gltest green. | "Swap 200 USDC for ETH" → preview → user-signed swap end-to-end. |
| **P3** | AgentExecutor + CapabilityRegistry + agent vault + EIP-712 two-sig, relayer, **autonomous mode**. | Granted capability → agent executes a bounded swap; over-cap attempt REJECTED on-chain. |
| **P4** | **Latch** over relayer + keeper (key custody, spend cap, allowlist, audit). | Relayer signs via Latch; over-budget call blocked at the proxy. |
| **P5** | Multi-agent / monitoring / activity view polish. | Agent-activity log reconstructs user→agent→authorization→action→result. |

Core demo = **P1–P3**. **P4 (Latch)** is the differentiator for a Rialo submission. Dev on GenLayer **studionet** (gasless) → demo on **testnet-asimov**.

---

## 8. Known limitations (state honestly in the submission)
- Pool spot price is manipulable; Chainlink mitigates triggers but AMM depth is shallow on testnet.
- Relayer/keeper are centralized off-chain services in the MVP (bounded, not trustless).
- Latch enclave/attestation features are private-beta gated; MVP uses the software-proxy path.
- GenLayer→Sepolia is one-directional read + off-chain-relayed write; no trustless bridge.
