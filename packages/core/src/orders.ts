/**
 * Open limit orders, read straight from the chain rather than the notebook. The
 * OrderBook is the truth for what is resting: it holds the escrow and the status,
 * so `getOrdersByOwner` plus `getOrder` tells us exactly what a person still has
 * live, whether the agent opened it or they did. The one thing the chain does not
 * record is which mode placed the order, so we recover that from the intents the
 * app wrote when it submitted: match each limit intent's transaction back to the
 * order id it created, and carry its mode across. A missing match just leaves the
 * order unlabeled, never wrong.
 */

import { formatUnits, parseEventLogs, type Abi, type Hex } from "viem";
import { abis, addresses, tokenByAddress } from "@roque/shared";
import { publicClient } from "./chain.js";
import { q } from "./db/index.js";

export type Mode = "copilot" | "autonomous";

export interface OpenOrder {
  id: string;
  // Which surface placed it, recovered from the intent that created it. Null when
  // the creating transaction has not been matched (for instance, still unmined).
  mode: Mode | null;
  tokenIn: string;
  tokenOut: string;
  tokenInSymbol: string;
  tokenOutSymbol: string;
  amountIn: string;
  minAmountOut: string;
  // The ETH/USD level that fills it, in plain dollars (the feed's 8 decimals).
  triggerPrice: string;
  triggerAbove: boolean;
  // Unix seconds; 0 means it never expires. `expired` folds in the current time.
  expiry: number;
  expired: boolean;
}

// The OrderBook.Status enum: None, Open, Filled, Cancelled. Only Open rests.
const STATUS_OPEN = 1;

/** The shape `getOrder` returns, as viem hands back a named-tuple struct. */
interface OrderStruct {
  owner: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: bigint;
  minAmountOut: bigint;
  triggerPrice: bigint;
  triggerAbove: boolean;
  expiry: bigint;
  status: number;
}

// A mined transaction's logs never change, so the order id a limit tx created is
// safe to remember forever. This keeps each poll from re-fetching receipts it has
// already resolved; only genuinely new limit intents cost a round trip.
const orderIdByTx = new Map<string, string>();

/**
 * Map order id to the mode that placed it, for this user. Reads the user's limit
 * intents that carry a transaction hash, resolves each hash to the order id its
 * OrderCreated log announced, and tags that id with the intent's mode. Both a
 * copilot `createOrder` and an autonomous `createOrderFor` emit OrderCreated from
 * the OrderBook, so one parse covers both paths.
 */
async function modeByOrderId(user: `0x${string}`): Promise<Map<string, Mode>> {
  const rows = await q<{ mode: Mode; tx_hash: string }>(
    `SELECT mode, tx_hash FROM intents
       WHERE LOWER(user_address)=LOWER($1) AND kind='limit' AND tx_hash IS NOT NULL
       ORDER BY created_at DESC LIMIT 200`,
    [user],
  );

  const client = publicClient();
  const out = new Map<string, Mode>();

  await Promise.all(
    rows.map(async (row) => {
      const txKey = row.tx_hash.toLowerCase();
      let orderId = orderIdByTx.get(txKey);
      if (!orderId) {
        try {
          const receipt = await client.getTransactionReceipt({ hash: row.tx_hash as Hex });
          const logs = parseEventLogs({
            abi: abis.orderBook as Abi,
            eventName: "OrderCreated",
            logs: receipt.logs,
          });
          const mine = logs.find(
            (l) =>
              String((l.args as { owner?: string }).owner ?? "").toLowerCase() ===
              user.toLowerCase(),
          );
          const id = (mine?.args as { id?: bigint } | undefined)?.id;
          if (id !== undefined) {
            orderId = id.toString();
            orderIdByTx.set(txKey, orderId);
          }
        } catch {
          // An unmined or dropped transaction has no receipt yet; the order just
          // stays unlabeled and picks up its mode on a later poll.
        }
      }
      if (orderId) out.set(orderId, row.mode);
    }),
  );

  return out;
}

/**
 * Every limit order a user still has resting on-chain, newest first. Reads the
 * live OrderBook, keeps only the ones that are actually Open, converts every raw
 * figure into human units off the token registry, and tags each with the mode
 * that placed it.
 */
export async function openOrders(user: `0x${string}`): Promise<OpenOrder[]> {
  const client = publicClient();

  const ids = (await client.readContract({
    address: addresses.orderBook,
    abi: abis.orderBook as Abi,
    functionName: "getOrdersByOwner",
    args: [user],
  })) as bigint[];

  if (ids.length === 0) return [];

  // One multicall for every order, and the mode lookup alongside it.
  const [raws, modes] = await Promise.all([
    client.multicall({
      contracts: ids.map((id) => ({
        address: addresses.orderBook,
        abi: abis.orderBook as Abi,
        functionName: "getOrder",
        args: [id],
      })),
      allowFailure: false,
    }),
    modeByOrderId(user).catch(() => new Map<string, Mode>()),
  ]);

  const now = Math.floor(Date.now() / 1000);
  const orders: OpenOrder[] = [];

  ids.forEach((id, i) => {
    const o = raws[i] as unknown as OrderStruct;
    if (Number(o.status) !== STATUS_OPEN) return;

    const tIn = tokenByAddress(o.tokenIn);
    const tOut = tokenByAddress(o.tokenOut);
    const expiry = Number(o.expiry);

    orders.push({
      id: id.toString(),
      mode: modes.get(id.toString()) ?? null,
      tokenIn: o.tokenIn,
      tokenOut: o.tokenOut,
      tokenInSymbol: tIn?.symbol ?? o.tokenIn,
      tokenOutSymbol: tOut?.symbol ?? o.tokenOut,
      amountIn: tIn ? formatUnits(o.amountIn, tIn.decimals) : o.amountIn.toString(),
      minAmountOut: tOut ? formatUnits(o.minAmountOut, tOut.decimals) : o.minAmountOut.toString(),
      triggerPrice: formatUnits(o.triggerPrice, 8),
      triggerAbove: o.triggerAbove,
      expiry,
      expired: expiry !== 0 && now > expiry,
    });
  });

  orders.sort((a, b) => Number(b.id) - Number(a.id));
  return orders;
}
