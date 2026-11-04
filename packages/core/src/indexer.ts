/**
 * The indexer keeps the off-chain notebook honest. Sepolia is the truth; this
 * just walks the logs the contracts emit and writes a flat, joinable copy into
 * the trades table so the activity feed can read history without asking an
 * archive node to replay events on every page load.
 *
 * It is deliberately incremental and idempotent. A bookmark in indexer_state
 * remembers the last block fully scanned, every row is keyed on (tx_hash,
 * log_index) with an ON CONFLICT DO NOTHING, and the whole thing can be run on a
 * timer or a cron tick without ever double counting a trade. If it falls behind,
 * it catches up a bounded window at a time; if it crashes, it resumes.
 */

import { formatUnits } from "viem";
import { addresses, abis, tokenByAddress } from "@roque/shared";
import { publicClient } from "./chain.js";
import { acquireLease, releaseLease } from "./leases.js";
import { q } from "./db/index.js";

/**
 * viem decodes a log's indexed and data fields into `args` at runtime, but our
 * ABIs are plain JSON rather than `as const`, so the compiler cannot see that
 * shape. This reads the decoded args back out with the type we know each event
 * carries. It is a cast, but a checked-once, named-here one rather than a scatter
 * of `any` across the scan.
 */
function eventArgs<T>(log: unknown): T {
  return (log as { args: T }).args;
}

// The block the AgentExecutor went live. There is nothing of ours to find before
// it, so a fresh indexer starts here rather than crawling from genesis.
export const DEPLOY_BLOCK = 11_463_289n;

// How many blocks to pull in one getLogs sweep. Public RPCs cap log ranges, and
// a smaller window also means a crash loses less progress. Well under the usual
// limits with headroom to spare.
const MAX_RANGE = 800n;

const BOOKMARK_KEY = `last_block:${addresses.agentExecutor.toLowerCase()}:${addresses.orderBook.toLowerCase()}`;

interface ScanResult {
  fromBlock: bigint;
  toBlock: bigint;
  rows: number;
}

/**
 * Advance the indexer by at most one window. Returns what it did so a caller can
 * loop until it has caught up, or just tick it once from a cron. Reading the
 * bookmark, scanning, writing rows and moving the bookmark are one logical step.
 */
export async function indexOnce(): Promise<ScanResult> {
  const client = publicClient();
  const latest = (await client.getBlockNumber()) - 12n;

  const lease=await acquireLease(`index:${BOOKMARK_KEY}`,120);
  if(!lease) return {fromBlock:latest+1n,toBlock:latest,rows:0};
  try {
    const bookmark=await readBookmark(),fromBlock=bookmark+1n;
    const toBlock=fromBlock+MAX_RANGE-1n>latest?latest:fromBlock+MAX_RANGE-1n;
    const checkpoint=await q<{block_hash:string}>("SELECT block_hash FROM indexer_blocks WHERE deployment=$1 AND block_number=$2",[BOOKMARK_KEY,bookmark.toString()]);
    if(checkpoint[0]) {
      const canonical=await client.getBlock({blockNumber:bookmark});
      if(canonical.hash!==checkpoint[0].block_hash) {
        const ancestors=await q<{block_number:string;block_hash:string}>("SELECT block_number,block_hash FROM indexer_blocks WHERE deployment=$1 AND block_number<$2 ORDER BY block_number DESC LIMIT 100",[BOOKMARK_KEY,bookmark.toString()]);
        let ancestor=DEPLOY_BLOCK-1n;
        for(const candidate of ancestors) {
          if((await client.getBlock({blockNumber:BigInt(candidate.block_number)})).hash===candidate.block_hash) {ancestor=BigInt(candidate.block_number);break;}
        }
        const rewind=ancestor+1n;
        await q(`WITH owned AS (SELECT 1 FROM worker_leases WHERE key=$3 AND owner=$4 AND generation=$5 AND expires_at>now() AND EXISTS(SELECT 1 FROM indexer_state WHERE key=$2 AND value=$7)),
          removed AS (DELETE FROM trades WHERE block_number >= $1 AND deployment=$2 AND EXISTS(SELECT 1 FROM owned)),
          blocks AS (DELETE FROM indexer_blocks WHERE deployment=$2 AND block_number >= $1 AND EXISTS(SELECT 1 FROM owned))
          UPDATE indexer_state SET value=$6 WHERE key=$2 AND value=$7 AND EXISTS(SELECT 1 FROM owned)`,
          [rewind.toString(),BOOKMARK_KEY,lease.key,lease.owner,lease.generation,ancestor.toString(),bookmark.toString()]);
        return {fromBlock:rewind,toBlock:rewind-1n,rows:0};
      }
    }
    if(fromBlock>latest) return {fromBlock,toBlock:bookmark,rows:0};
    const rows=await scanRange(fromBlock,toBlock,lease);
    const block=await client.getBlock({blockNumber:toBlock});
    await q("INSERT INTO indexer_blocks(deployment,block_number,block_hash) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",[BOOKMARK_KEY,toBlock.toString(),block.hash]);
    if(!await claimWindow(bookmark,toBlock,lease)) throw new Error("Indexer lost checkpoint ownership.");
    return {fromBlock,toBlock,rows};
  } finally {await releaseLease(lease);}

}

/**
 * Keep advancing until the bookmark reaches the chain head, then stop. Handy for
 * a backfill or a long lived worker's first pass. Each window commits its own
 * bookmark, so an interruption mid-catchup just resumes from the last window.
 */
export async function indexToHead(): Promise<number> {
  let total = 0;
  for (;;) {
    const res = await indexOnce();
    total += res.rows;
    if (res.toBlock >= (await publicClient().getBlockNumber())) break;
    if (res.toBlock < res.fromBlock) break;
  }
  return total;
}

// ─────────────────────────────────────────────────────────────
// The actual scan: pull each contract's logs and fold them into trade rows
// ─────────────────────────────────────────────────────────────

async function scanRange(fromBlock: bigint, toBlock: bigint,lease:NonNullable<Awaited<ReturnType<typeof acquireLease>>>): Promise<number> {
  const client = publicClient();

  const [agentSwaps, orderCreated, orderFilled, orderCancelled, routerSwaps] = await Promise.all([
    client.getContractEvents({
      address: addresses.agentExecutor,
      abi: abis.agentExecutor,
      eventName: "AgentSwap",
      fromBlock,
      toBlock,
    }),
    client.getContractEvents({
      address: addresses.orderBook,
      abi: abis.orderBook,
      eventName: "OrderCreated",
      fromBlock,
      toBlock,
    }),
    client.getContractEvents({
      address: addresses.orderBook,
      abi: abis.orderBook,
      eventName: "OrderFilled",
      fromBlock,
      toBlock,
    }),
    client.getContractEvents({
      address: addresses.orderBook,
      abi: abis.orderBook,
      eventName: "OrderCancelled",
      fromBlock,
      toBlock,
    }),
    client.getContractEvents({
      address: addresses.router,
      abi: abis.router,
      eventName: "RouterSwap",
      fromBlock,
      toBlock,
    }),
  ]);

  // Fetch the timestamp of every block that carried an event, once each, so rows
  // can be ordered and displayed in wall-clock time without a getBlock per log.
  const times = await blockTimes(
    [...agentSwaps, ...orderCreated, ...orderFilled, ...orderCancelled, ...routerSwaps].map(
      (l) => l.blockNumber,
    ),
  );

  let written = 0;

  // Autonomous market swaps carry the user and a dollar value straight from the
  // executor, which is the cleanest source, so we take swaps from here.
  for (const log of agentSwaps) {
    const a = eventArgs<{
      user: `0x${string}`;
      tokenIn: `0x${string}`;
      tokenOut: `0x${string}`;
      amountIn: bigint;
      amountOut: bigint;
      usdValue: bigint;
    }>(log);
    written += await insertTrade({
      kind: "swap",
      user: a.user,
      tokenIn: a.tokenIn,
      tokenOut: a.tokenOut,
      amountIn: human(a.tokenIn, a.amountIn),
      amountOut: human(a.tokenOut, a.amountOut),
      usdValue: formatUnits(a.usdValue, 18),
      txHash: log.transactionHash,
      logIndex: log.logIndex,
      blockNumber: log.blockNumber,
      blockTime: times.get(log.blockNumber),
    },lease);
  }

  // Copilot swaps go straight through the router from the user's own wallet. The
  // same router also settles executor and order-book trades, so we skip any swap
  // whose sender is one of our contracts to avoid counting an autonomous trade
  // or a limit fill twice.
  for (const log of routerSwaps) {
    const a = eventArgs<{
      sender: `0x${string}`;
      tokenIn: `0x${string}`;
      tokenOut: `0x${string}`;
      amountIn: bigint;
      amountOut: bigint;
      to: `0x${string}`;
    }>(log);
    const sender = a.sender.toLowerCase();
    if (
      sender === addresses.agentExecutor.toLowerCase() ||
      sender === addresses.orderBook.toLowerCase()
    ) {
      continue;
    }
    written += await insertTrade({
      kind: "swap",
      user: a.sender,
      tokenIn: a.tokenIn,
      tokenOut: a.tokenOut,
      amountIn: human(a.tokenIn, a.amountIn),
      amountOut: human(a.tokenOut, a.amountOut),
      usdValue: null,
      txHash: log.transactionHash,
      logIndex: log.logIndex,
      blockNumber: log.blockNumber,
      blockTime: times.get(log.blockNumber),
    },lease);
  }

  // A resting limit order opening. Owner is the user whether it came from a
  // copilot call to the order book or the executor acting under a capability.
  for (const log of orderCreated) {
    const a = eventArgs<{
      id: bigint;
      owner: `0x${string}`;
      tokenIn: `0x${string}`;
      tokenOut: `0x${string}`;
      amountIn: bigint;
      minAmountOut: bigint;
      triggerPrice: bigint;
      triggerAbove: boolean;
      expiry: bigint;
    }>(log);
    written += await insertTrade({
      kind: "limit_created",
      user: a.owner,
      tokenIn: a.tokenIn,
      tokenOut: a.tokenOut,
      amountIn: human(a.tokenIn, a.amountIn),
      amountOut: null,
      usdValue: null,
      orderId: a.id,
      price: formatUnits(a.triggerPrice, 8),
      txHash: log.transactionHash,
      logIndex: log.logIndex,
      blockNumber: log.blockNumber,
      blockTime: times.get(log.blockNumber),
    },lease);
  }

  // A fill. The event names the filler, not the owner, and carries no token
  // detail, so we read the order back to label the row with the user and pair.
  for (const log of orderFilled) {
    const a = eventArgs<{ id: bigint; filler: `0x${string}`; amountOut: bigint; price: bigint }>(
      log,
    );
    const order = await readOrder(a.id);
    written += await insertTrade({
      kind: "limit_filled",
      user: order?.owner ?? a.filler,
      tokenIn: order?.tokenIn ?? null,
      tokenOut: order?.tokenOut ?? null,
      amountIn: order ? human(order.tokenIn, order.amountIn) : null,
      amountOut: order ? human(order.tokenOut, a.amountOut) : a.amountOut.toString(),
      usdValue: null,
      orderId: a.id,
      price: formatUnits(a.price, 8),
      txHash: log.transactionHash,
      logIndex: log.logIndex,
      blockNumber: log.blockNumber,
      blockTime: times.get(log.blockNumber),
    },lease);
  }

  // A cancellation. Same story: read the order back for the owner and pair.
  for (const log of orderCancelled) {
    const a = eventArgs<{ id: bigint }>(log);
    const order = await readOrder(a.id);
    written += await insertTrade({
      kind: "limit_cancelled",
      user: order?.owner ?? "",
      tokenIn: order?.tokenIn ?? null,
      tokenOut: order?.tokenOut ?? null,
      amountIn: order ? human(order.tokenIn, order.amountIn) : null,
      amountOut: null,
      usdValue: null,
      orderId: a.id,
      price: order ? formatUnits(order.triggerPrice, 8) : null,
      txHash: log.transactionHash,
      logIndex: log.logIndex,
      blockNumber: log.blockNumber,
      blockTime: times.get(log.blockNumber),
    },lease);
  }

  return written;
}

// ─────────────────────────────────────────────────────────────
// Small helpers
// ─────────────────────────────────────────────────────────────

interface TradeRow {
  kind: "swap" | "limit_created" | "limit_filled" | "limit_cancelled";
  user: string;
  tokenIn: string | null;
  tokenOut: string | null;
  amountIn: string | null;
  amountOut: string | null;
  usdValue: string | null;
  orderId?: bigint;
  price?: string | null;
  txHash: string;
  logIndex: number;
  blockNumber: bigint;
  blockTime?: number;
}

/** Insert one trade row, ignoring a replay of the same log. Returns 1 if new. */
async function insertTrade(row: TradeRow,lease:NonNullable<Awaited<ReturnType<typeof acquireLease>>>): Promise<number> {
  const rows = await q(
    `INSERT INTO trades
       (kind, user_address, token_in, token_out, amount_in, amount_out, usd_value,
        order_id, price, tx_hash, log_index, block_number, block_time, deployment)
     SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14
     WHERE EXISTS(SELECT 1 FROM worker_leases WHERE key=$15 AND owner=$16 AND generation=$17 AND expires_at>now())
     ON CONFLICT (tx_hash, log_index) DO NOTHING
     RETURNING id`,
    [
      row.kind,
      row.user,
      row.tokenIn,
      row.tokenOut,
      row.amountIn,
      row.amountOut,
      row.usdValue,
      row.orderId !== undefined ? row.orderId.toString() : null,
      row.price ?? null,
      row.txHash,
      row.logIndex,
      row.blockNumber.toString(),
      row.blockTime ? new Date(row.blockTime * 1000).toISOString() : null,
      BOOKMARK_KEY,lease.key,lease.owner,lease.generation,
    ],
  );
  return rows.length;
}

/** Format a raw token amount into human units using the known token decimals. */
function human(token: `0x${string}`, raw: bigint): string {
  const meta = tokenByAddress(token);
  return meta ? formatUnits(raw, meta.decimals) : raw.toString();
}

interface OnChainOrder {
  owner: `0x${string}`;
  tokenIn: `0x${string}`;
  tokenOut: `0x${string}`;
  amountIn: bigint;
  minAmountOut: bigint;
  triggerPrice: bigint;
  triggerAbove: boolean;
  expiry: bigint;
  status: number;
}

/** Read a full order struct back from the order book, or null if it is gone. */
async function readOrder(id: bigint): Promise<OnChainOrder | null> {
  try {
    const o = (await publicClient().readContract({
      address: addresses.orderBook,
      abi: abis.orderBook,
      functionName: "getOrder",
      args: [id],
    })) as OnChainOrder;
    return o;
  } catch {
    throw new Error("Order attribution could not be read; range will be retried.");
  }
}

/** Fetch the timestamp for each distinct block number, as a lookup map. */
async function blockTimes(blockNumbers: bigint[]): Promise<Map<bigint, number>> {
  const unique = [...new Set(blockNumbers.map((b) => b.toString()))].map((s) => BigInt(s));
  const client = publicClient();
  const entries = await Promise.all(
    unique.map(async (bn) => {
      const block = await client.getBlock({ blockNumber: bn });
      return [bn, Number(block.timestamp)] as const;
    }),
  );
  return new Map(entries);
}

async function readBookmark(): Promise<bigint> {
  const rows = await q<{ value: string }>(`SELECT value FROM indexer_state WHERE key=$1`, [
    BOOKMARK_KEY,
  ]);
  if (rows.length > 0) return BigInt(rows[0].value);
  // Start one block before the deployment so the first sweep includes it.
  return DEPLOY_BLOCK - 1n;
}

/**
 * Move the bookmark from exactly where we read it to the end of the window we
 * are about to scan, and say whether we won. A compare-and-swap rather than a
 * plain write, so only one of several indexers can take any given window.
 *
 * The seed is separate and deliberately not a swap: on a fresh database there is
 * no value to compare against, and folding that case into the swap made a loser
 * unable to tell "I claimed this" from "somebody claimed exactly this", which
 * is precisely the pair that has to be distinguishable.
 */
async function claimWindow(from: bigint, to: bigint, lease: {key:string;owner:string;generation:string}): Promise<boolean> {
  await q(
    `INSERT INTO indexer_state (key, value, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (key) DO NOTHING`,
    [BOOKMARK_KEY, from.toString()],
  );
  const claimed = await q<{ key: string }>(
    `UPDATE indexer_state SET value=$2, updated_at=now()
      WHERE key=$1 AND value=$3 AND EXISTS(SELECT 1 FROM worker_leases WHERE key=$4 AND owner=$5 AND generation=$6 AND expires_at>now()) RETURNING key`,
    [BOOKMARK_KEY, to.toString(), from.toString(),lease.key,lease.owner,lease.generation],
  );
  return claimed.length === 1;
}
