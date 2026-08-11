import deployment from "./deployment.json" assert { type: "json" };

import TestTokenAbi from "./abis/TestToken.json" assert { type: "json" };
import LiquidityPoolAbi from "./abis/LiquidityPool.json" assert { type: "json" };
import DEXRouterAbi from "./abis/DEXRouter.json" assert { type: "json" };
import OrderBookAbi from "./abis/OrderBook.json" assert { type: "json" };
import AgentExecutorAbi from "./abis/AgentExecutor.json" assert { type: "json" };
import FaucetRouterAbi from "./abis/FaucetRouter.json" assert { type: "json" };

// Everything the app and backend need to talk to the live Sepolia deployment.
// It all derives from one file, deployment.json, which the deploy script writes
// as a set of parallel arrays. Nothing here is typed by hand, so there is exactly
// one place the truth lives and the ten-token roster can never drift out of sync
// between the contracts, the relayer and the UI.

type Hex = `0x${string}`;

const hex = (v: unknown): Hex => String(v) as Hex;

// Foundry may emit a uint either as a JSON number or, once it grows large, as a
// decimal string. Coerce both the same way so a big price never arrives mangled.
const big = (v: unknown): bigint => BigInt(typeof v === "string" ? v : Math.trunc(Number(v)));

export const deployedChainId = Number(deployment.chainId);

export const addresses = {
  router: hex(deployment.router),
  orderBook: hex(deployment.orderBook),
  agentExecutor: hex(deployment.agentExecutor),
  faucetRouter: hex(deployment.faucetRouter),
  priceFeed: hex(deployment.priceFeed),
  agentSigner: hex(deployment.agentSigner),
  deployer: hex(deployment.deployer),
} as const;

export const abis = {
  testToken: TestTokenAbi,
  liquidityPool: LiquidityPoolAbi,
  router: DEXRouterAbi,
  orderBook: OrderBookAbi,
  agentExecutor: AgentExecutorAbi,
  faucetRouter: FaucetRouterAbi,
} as const;

// ── Tokens ──────────────────────────────────────────────────────────────────

// One tradable asset. `key` and `symbol` are the same string (the on-chain
// symbol, like "rWETH"); `key` stays as a distinct field because older call
// sites reach for it. `feed` is the zero address for a stable, which the
// executor treats as a flat dollar. `initialPrice8` is the deploy-time Chainlink
// price in 8-decimal dollars, useful as a display fallback before a live read.
export interface TokenMeta {
  key: string;
  symbol: string;
  name: string;
  address: Hex;
  decimals: number;
  isStable: boolean;
  feed: Hex;
  initialPrice8: bigint;
}

// Zip the parallel arrays back into objects, in the order the deploy declared
// them. That order is stable, so it doubles as the canonical display order.
export const tokenList: TokenMeta[] = deployment.tokenSymbols.map((symbol, i) => ({
  key: symbol,
  symbol,
  name: deployment.tokenNames[i],
  address: hex(deployment.tokenAddresses[i]),
  decimals: Number(deployment.tokenDecimals[i]),
  isStable: Boolean(deployment.tokenIsStable[i]),
  feed: hex(deployment.tokenFeeds[i]),
  initialPrice8: big(deployment.tokenPrice8[i]),
}));

// Keyed by symbol for the common "give me rWETH" lookup.
export const tokens: Record<string, TokenMeta> = Object.fromEntries(
  tokenList.map((t) => [t.symbol, t]),
);

// The full set of symbols, handy for building selectors and validating input.
export const tokenSymbols: string[] = tokenList.map((t) => t.symbol);

const bySymbolLower = new Map(tokenList.map((t) => [t.symbol.toLowerCase(), t]));
const byAddressLower = new Map(tokenList.map((t) => [t.address.toLowerCase(), t]));

export const tokenBySymbol = (symbol: string): TokenMeta | undefined =>
  bySymbolLower.get(symbol.toLowerCase());

export const tokenByAddress = (addr: string): TokenMeta | undefined =>
  byAddressLower.get(addr.toLowerCase());

/** Look up a token by symbol and throw if it is not one of ours. */
export const requireToken = (symbol: string): TokenMeta => {
  const t = tokenBySymbol(symbol);
  if (!t) throw new Error(`Unknown token: ${symbol}`);
  return t;
};

// ── Pools ───────────────────────────────────────────────────────────────────

// One liquidity pool, between two of the tokens. The mesh is complete: every
// unordered pair of the ten tokens has exactly one pool, so any asset swaps
// directly into any other in a single hop with no routing.
export interface PoolMeta {
  a: string; // token symbol
  b: string; // token symbol
  address: Hex;
}

export const pools: PoolMeta[] = deployment.poolA.map((a, i) => ({
  a,
  b: deployment.poolB[i],
  address: hex(deployment.poolAddresses[i]),
}));

// Index every pool under both orderings of its pair, so a lookup does not care
// which token the caller names first.
const poolByPair = new Map<string, PoolMeta>();
for (const p of pools) {
  const x = p.a.toLowerCase();
  const y = p.b.toLowerCase();
  poolByPair.set(`${x}/${y}`, p);
  poolByPair.set(`${y}/${x}`, p);
}

/**
 * The pool that trades two tokens, named by symbol in either order, or undefined
 * if the pair is the same token or somehow missing from the mesh.
 */
export const poolFor = (symbolA: string, symbolB: string): PoolMeta | undefined => {
  if (symbolA.toLowerCase() === symbolB.toLowerCase()) return undefined;
  return poolByPair.get(`${symbolA.toLowerCase()}/${symbolB.toLowerCase()}`);
};

/** The pool address for a pair, or throw with a clear message if there is none. */
export const poolAddressFor = (symbolA: string, symbolB: string): Hex => {
  const p = poolFor(symbolA, symbolB);
  if (!p) throw new Error(`No pool for pair ${symbolA}/${symbolB}`);
  return p.address;
};

// ── EIP-712 ─────────────────────────────────────────────────────────────────

// The domain the AgentExecutor was constructed with. Signers on both the
// frontend and the agent side must match this exactly or recovery fails.
export const eip712Domain = {
  name: "RoqueAgentExecutor",
  version: "1",
  chainId: deployedChainId,
  verifyingContract: addresses.agentExecutor,
} as const;

// The typed-data shapes for the two intents and the capability grant. These
// mirror the structs and typehashes in AgentExecutor.sol one for one.
export const eip712Types = {
  SwapIntent: [
    { name: "user", type: "address" },
    { name: "tokenIn", type: "address" },
    { name: "tokenOut", type: "address" },
    { name: "amountIn", type: "uint256" },
    { name: "minAmountOut", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
  LimitIntent: [
    { name: "user", type: "address" },
    { name: "tokenIn", type: "address" },
    { name: "tokenOut", type: "address" },
    { name: "amountIn", type: "uint256" },
    { name: "minAmountOut", type: "uint256" },
    { name: "triggerPrice", type: "uint256" },
    { name: "triggerAbove", type: "bool" },
    { name: "expiry", type: "uint64" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
  Grant: [
    { name: "user", type: "address" },
    { name: "agentSigner", type: "address" },
    { name: "maxPerTradeUsd", type: "uint256" },
    { name: "maxDailyUsd", type: "uint256" },
    { name: "maxSlippageBps", type: "uint256" },
    { name: "validUntil", type: "uint64" },
    { name: "grantNonce", type: "uint256" },
  ],
} as const;

export { deployment };
