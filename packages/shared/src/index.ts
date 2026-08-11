import deployment from "./deployment.json" assert { type: "json" };

import TestTokenAbi from "./abis/TestToken.json" assert { type: "json" };
import LiquidityPoolAbi from "./abis/LiquidityPool.json" assert { type: "json" };
import DEXRouterAbi from "./abis/DEXRouter.json" assert { type: "json" };
import OrderBookAbi from "./abis/OrderBook.json" assert { type: "json" };
import AgentExecutorAbi from "./abis/AgentExecutor.json" assert { type: "json" };

// Everything the app and backend need to talk to the live Sepolia deployment.
// Addresses come straight from the deploy script's output, so there is exactly
// one place the truth lives and nothing here is typed by hand.
export const deployedChainId = deployment.chainId;

export const addresses = {
  usdc: deployment.usdc as `0x${string}`,
  weth: deployment.weth as `0x${string}`,
  pool: deployment.pool as `0x${string}`,
  router: deployment.router as `0x${string}`,
  orderBook: deployment.orderBook as `0x${string}`,
  agentExecutor: deployment.agentExecutor as `0x${string}`,
  priceFeed: deployment.priceFeed as `0x${string}`,
  agentSigner: deployment.agentSigner as `0x${string}`,
} as const;

export const abis = {
  testToken: TestTokenAbi,
  liquidityPool: LiquidityPoolAbi,
  router: DEXRouterAbi,
  orderBook: OrderBookAbi,
  agentExecutor: AgentExecutorAbi,
} as const;

// The two tradable assets, described once. `key` is what the interpreter and the
// UI use to name a token; `address` is what the chain uses.
export interface TokenMeta {
  key: "USDC" | "WETH";
  symbol: string;
  name: string;
  address: `0x${string}`;
  decimals: number;
  isStable: boolean;
}

export const tokens: Record<"USDC" | "WETH", TokenMeta> = {
  USDC: {
    key: "USDC",
    symbol: "USDC",
    name: "Roque USD",
    address: addresses.usdc,
    decimals: 6,
    isStable: true,
  },
  WETH: {
    key: "WETH",
    symbol: "WETH",
    name: "Roque Wrapped Ether",
    address: addresses.weth,
    decimals: 18,
    isStable: false,
  },
};

export const tokenByAddress = (addr: string): TokenMeta | undefined => {
  const lower = addr.toLowerCase();
  return Object.values(tokens).find((t) => t.address.toLowerCase() === lower);
};

// The EIP-712 domain the AgentExecutor was constructed with. Signers on both the
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
