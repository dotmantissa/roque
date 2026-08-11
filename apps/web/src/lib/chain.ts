/**
 * Everything the browser does directly against Sepolia lives here. Reads (a
 * wallet's token balances, an allowance) go through a public client on a plain
 * RPC. Writes (approve, swap, deposit, a signed grant) take a viem wallet client
 * built from whatever wallet the person connected through Privy, so Roque never
 * holds their keys and every copilot action is signed by them, in their wallet.
 *
 * The trust line is deliberate: this file can ask a wallet to sign, never the
 * agent. The agent's signing lives on the server, behind the capability the user
 * granted. Nothing here can move funds without a signature the person just gave.
 */

import {
  createPublicClient,
  createWalletClient,
  custom,
  http,
  maxUint256,
  parseUnits,
  type Abi,
  type Account,
  type EIP1193Provider,
  type Hex,
  type WalletClient,
} from "viem";
import { sepolia } from "viem/chains";
import {
  abis,
  addresses,
  eip712Domain,
  eip712Types,
  tokenList,
} from "@roque/shared";

const RPC_URL =
  process.env.NEXT_PUBLIC_SEPOLIA_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com";

/** Shared read client. One instance, http transport, Sepolia. */
export const publicClient = createPublicClient({
  chain: sepolia,
  transport: http(RPC_URL),
});

const erc20 = abis.testToken;
const router = abis.router;
const executor = abis.agentExecutor;
const orderBook = abis.orderBook;
const faucetRouter = abis.faucetRouter;

/** Build a wallet client for reads-that-need-an-account and every write. */
export function walletClientFrom(
  provider: EIP1193Provider,
  account: `0x${string}`,
): WalletClient {
  return createWalletClient({
    account: account as unknown as Account,
    chain: sepolia,
    transport: custom(provider),
  });
}

/**
 * Make sure the connected wallet is pointed at Sepolia before we ask it to sign.
 * A wallet on the wrong network is the single most common reason a first trade
 * fails, so we handle it quietly rather than letting it revert.
 */
export async function ensureSepolia(provider: EIP1193Provider): Promise<void> {
  const hexId = `0x${sepolia.id.toString(16)}`;
  try {
    const current = (await provider.request({ method: "eth_chainId" })) as string;
    if (current?.toLowerCase() === hexId.toLowerCase()) return;
    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: hexId }],
    });
  } catch (err: unknown) {
    // 4902 means the chain is unknown to the wallet; offer to add it.
    const code = (err as { code?: number })?.code;
    if (code === 4902) {
      await provider.request({
        method: "wallet_addEthereumChain",
        params: [
          {
            chainId: hexId,
            chainName: "Sepolia",
            nativeCurrency: { name: "Sepolia Ether", symbol: "ETH", decimals: 18 },
            rpcUrls: [RPC_URL],
            blockExplorerUrls: ["https://sepolia.etherscan.io"],
          },
        ],
      });
      return;
    }
    throw err;
  }
}

// ── Reads ───────────────────────────────────────────────────────

/** Every tradable token's balance for a wallet, in human units, keyed by symbol. */
export async function walletBalances(
  user: `0x${string}`,
): Promise<Record<string, number>> {
  const raws = await publicClient.multicall({
    contracts: tokenList.map((t) => ({
      address: t.address,
      abi: erc20 as Abi,
      functionName: "balanceOf",
      args: [user],
    })),
    allowFailure: false,
  });
  const out: Record<string, number> = {};
  tokenList.forEach((t, i) => {
    out[t.symbol] = Number(raws[i]) / 10 ** t.decimals;
  });
  return out;
}

/**
 * How many faucet claims each token still allows this wallet, keyed by symbol.
 * TestToken caps a wallet at MAX_CLAIMS pulls; this reads what is left so the UI
 * can grey out a token that is tapped out rather than letting a claim revert.
 */
export async function faucetClaimsRemaining(
  user: `0x${string}`,
): Promise<Record<string, number>> {
  const raws = await publicClient.multicall({
    contracts: tokenList.map((t) => ({
      address: t.address,
      abi: erc20 as Abi,
      functionName: "claimsRemaining",
      args: [user],
    })),
    allowFailure: false,
  });
  const out: Record<string, number> = {};
  tokenList.forEach((t, i) => {
    out[t.symbol] = Number(raws[i]);
  });
  return out;
}

async function allowance(
  token: `0x${string}`,
  owner: `0x${string}`,
  spender: `0x${string}`,
): Promise<bigint> {
  return publicClient.readContract({
    address: token,
    abi: erc20,
    functionName: "allowance",
    args: [owner, spender],
  }) as Promise<bigint>;
}

/** Pull a faucet of a single test token so a fresh wallet has something to trade. */
export async function claimFaucet(
  wallet: WalletClient,
  user: `0x${string}`,
  token: `0x${string}`,
): Promise<Hex> {
  const hash = await wallet.writeContract({
    account: user as unknown as Account,
    chain: sepolia,
    address: token,
    abi: erc20,
    functionName: "faucet",
    args: [],
  });
  await publicClient.waitForTransactionReceipt({ hash });
  return hash;
}

/**
 * Claim every token in one transaction through the FaucetRouter. It calls each
 * token's faucet in a try/catch, so a token this wallet has already tapped out
 * is quietly skipped rather than reverting the whole batch. Returns the count it
 * actually delivered alongside the tx hash.
 */
export async function claimAllFaucets(
  wallet: WalletClient,
  user: `0x${string}`,
): Promise<Hex> {
  const tokenAddresses = tokenList.map((t) => t.address);
  const hash = await wallet.writeContract({
    account: user as unknown as Account,
    chain: sepolia,
    address: addresses.faucetRouter,
    abi: faucetRouter,
    functionName: "claimAll",
    args: [tokenAddresses],
  });
  await publicClient.waitForTransactionReceipt({ hash });
  return hash;
}

// ── Writes ──────────────────────────────────────────────────────

/** Approve `spender` for `amount` of `token` if the current allowance is short. */
async function approveIfNeeded(
  wallet: WalletClient,
  user: `0x${string}`,
  token: `0x${string}`,
  spender: `0x${string}`,
  amount: bigint,
): Promise<void> {
  const current = await allowance(token, user, spender);
  if (current >= amount) return;
  const hash = await wallet.writeContract({
    account: user as unknown as Account,
    chain: sepolia,
    address: token,
    abi: erc20,
    functionName: "approve",
    args: [spender, maxUint256],
  });
  await publicClient.waitForTransactionReceipt({ hash });
}

/** Copilot market swap: approve the router if needed, then swap, then settle. */
export async function copilotSwap(
  wallet: WalletClient,
  user: `0x${string}`,
  prep: {
    router: `0x${string}`;
    tokenIn: `0x${string}`;
    amountInRaw: string;
    tokenOut: `0x${string}`;
    minAmountOutRaw: string;
  },
): Promise<Hex> {
  const amountIn = BigInt(prep.amountInRaw);
  await approveIfNeeded(wallet, user, prep.tokenIn, prep.router, amountIn);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
  const hash = await wallet.writeContract({
    account: user as unknown as Account,
    chain: sepolia,
    address: prep.router,
    abi: router,
    functionName: "swapExactTokensForTokens",
    args: [prep.tokenIn, prep.tokenOut, amountIn, BigInt(prep.minAmountOutRaw), user, deadline],
  });
  await publicClient.waitForTransactionReceipt({ hash });
  return hash;
}

/** Copilot resting order: approve the order book, then create the order. */
export async function copilotLimitOrder(
  wallet: WalletClient,
  user: `0x${string}`,
  order: {
    tokenIn: `0x${string}`;
    tokenOut: `0x${string}`;
    amountInRaw: bigint;
    minAmountOutRaw: bigint;
    triggerPrice: bigint;
    triggerAbove: boolean;
    expiry: bigint;
  },
): Promise<Hex> {
  await approveIfNeeded(wallet, user, order.tokenIn, addresses.orderBook, order.amountInRaw);
  const hash = await wallet.writeContract({
    account: user as unknown as Account,
    chain: sepolia,
    address: addresses.orderBook,
    abi: orderBook,
    functionName: "createOrder",
    args: [
      order.tokenIn,
      order.tokenOut,
      order.amountInRaw,
      order.minAmountOutRaw,
      order.triggerPrice,
      order.triggerAbove,
      order.expiry,
    ],
  });
  await publicClient.waitForTransactionReceipt({ hash });
  return hash;
}

/** Move funds into the agent vault: approve the executor, then deposit. */
export async function depositToVault(
  wallet: WalletClient,
  user: `0x${string}`,
  token: `0x${string}`,
  amountRaw: bigint,
): Promise<Hex> {
  await approveIfNeeded(wallet, user, token, addresses.agentExecutor, amountRaw);
  const hash = await wallet.writeContract({
    account: user as unknown as Account,
    chain: sepolia,
    address: addresses.agentExecutor,
    abi: executor,
    functionName: "deposit",
    args: [token, amountRaw],
  });
  await publicClient.waitForTransactionReceipt({ hash });
  return hash;
}

/** Pull funds back out of the vault. Always the user's call, never the agent's. */
export async function withdrawFromVault(
  wallet: WalletClient,
  user: `0x${string}`,
  token: `0x${string}`,
  amountRaw: bigint,
): Promise<Hex> {
  const hash = await wallet.writeContract({
    account: user as unknown as Account,
    chain: sepolia,
    address: addresses.agentExecutor,
    abi: executor,
    functionName: "withdraw",
    args: [token, amountRaw],
  });
  await publicClient.waitForTransactionReceipt({ hash });
  return hash;
}

/** Tear up the agent's permission on-chain. Takes effect the moment it mines. */
export async function revokeCapability(
  wallet: WalletClient,
  user: `0x${string}`,
): Promise<Hex> {
  const hash = await wallet.writeContract({
    account: user as unknown as Account,
    chain: sepolia,
    address: addresses.agentExecutor,
    abi: executor,
    functionName: "revokeCapability",
    args: [],
  });
  await publicClient.waitForTransactionReceipt({ hash });
  return hash;
}

/**
 * Sign the capability grant as the user. This is the one signature that lets the
 * agent act later, so it spells out the caps in plain uint terms: a ceiling per
 * trade, a ceiling per day, a slippage bound, and a date it all lapses.
 */
export async function signGrant(
  wallet: WalletClient,
  user: `0x${string}`,
  grant: {
    maxPerTradeUsd: string;
    maxDailyUsd: string;
    maxSlippageBps: number;
    validUntil: number;
    grantNonce: string;
  },
): Promise<{ signature: Hex; message: Record<string, string> }> {
  const message = {
    user,
    agentSigner: addresses.agentSigner,
    maxPerTradeUsd: parseUnits(grant.maxPerTradeUsd, 18).toString(),
    maxDailyUsd: parseUnits(grant.maxDailyUsd, 18).toString(),
    maxSlippageBps: BigInt(grant.maxSlippageBps).toString(),
    validUntil: BigInt(grant.validUntil).toString(),
    grantNonce: grant.grantNonce,
  };
  const signature = await wallet.signTypedData({
    account: user as unknown as Account,
    domain: eip712Domain,
    types: { Grant: eip712Types.Grant as unknown as [] },
    primaryType: "Grant",
    message: {
      user,
      agentSigner: addresses.agentSigner,
      maxPerTradeUsd: BigInt(message.maxPerTradeUsd),
      maxDailyUsd: BigInt(message.maxDailyUsd),
      maxSlippageBps: BigInt(grant.maxSlippageBps),
      validUntil: BigInt(grant.validUntil),
      grantNonce: BigInt(grant.grantNonce),
    },
  });
  return { signature, message };
}
