/**
 * The keeper is the muscle behind a resting limit order. A limit order on Roque
 * is a real escrowed position in the OrderBook contract, but nothing fills it on
 * its own; someone has to notice the trigger price is met and send the
 * executeOrder transaction. That someone is this.
 *
 * It is intentionally dumb and safe. It reads open orders from the chain, asks
 * the contract itself whether each is triggered (the contract reads the same
 * Chainlink feed it will use to honour the fill), and for the ones that are, it
 * sends executeOrder from the relayer wallet. Every rule that matters, the
 * trigger, the slippage floor, the expiry, is enforced inside the contract; the
 * keeper cannot make a bad fill happen, it can only pay the gas to attempt a
 * good one. If it is offline, orders simply wait; nothing is lost.
 */

import { encodeFunctionData } from "viem";
import { addresses, abis } from "@roque/shared";
import { publicClient, relayerWallet } from "./chain.js";

export interface KeeperResult {
  scanned: number;
  triggered: number;
  filled: { id: string; txHash: string }[];
  errors: { id: string; error: string }[];
}

// Order status as the contract numbers it: 0 None, 1 Open, 2 Filled, 3 Cancelled.
const STATUS_OPEN = 1;

/**
 * Run one keeper pass. Walks every order id the book has minted, fills the ones
 * that are open and triggered, and reports what happened. Cheap enough to run on
 * a short timer; the order count on a testnet DEX is small and every check is a
 * view call.
 */
export async function keeperTick(): Promise<KeeperResult> {
  const client = publicClient();
  const result: KeeperResult = { scanned: 0, triggered: 0, filled: [], errors: [] };

  const nextId = (await client.readContract({
    address: addresses.orderBook,
    abi: abis.orderBook,
    functionName: "nextOrderId",
    args: [],
  })) as bigint;

  // Order ids run 1..nextId-1. Check each; the open, triggered ones get filled.
  for (let id = 1n; id < nextId; id++) {
    result.scanned++;

    const order = (await client.readContract({
      address: addresses.orderBook,
      abi: abis.orderBook,
      functionName: "getOrder",
      args: [id],
    })) as { status: number };

    if (order.status !== STATUS_OPEN) continue;

    const triggered = (await client.readContract({
      address: addresses.orderBook,
      abi: abis.orderBook,
      functionName: "isTriggered",
      args: [id],
    })) as boolean;

    if (!triggered) continue;
    result.triggered++;

    try {
      const txHash = await fillOrder(id);
      result.filled.push({ id: id.toString(), txHash });
    } catch (err) {
      // A revert here is usually a race: another filler got it first, or the
      // price slipped back across the trigger between the check and the send.
      // Neither is fatal; log it and move on to the next order.
      result.errors.push({ id: id.toString(), error: (err as Error).message });
    }
  }

  return result;
}

/** Send executeOrder for one id from the relayer wallet, returning the tx hash. */
async function fillOrder(id: bigint): Promise<`0x${string}`> {
  const wallet = relayerWallet();
  const data = encodeFunctionData({
    abi: abis.orderBook,
    functionName: "executeOrder",
    args: [id],
  });
  return wallet.sendTransaction({
    account: wallet.account!,
    chain: wallet.chain,
    to: addresses.orderBook,
    data,
  });
}
