/**
 * The two background loops that make Roque live rather than merely responsive.
 * The indexer keeps the trade history current; the keeper watches resting limit
 * orders and fills the ones whose trigger the market has reached. Both are safe
 * to run anywhere: the indexer is idempotent, and the keeper can only ever pay
 * gas to attempt a fill the contract itself judges valid.
 *
 * This same module is the entry point for `pnpm keeper`, so the background work
 * can run as its own process on a host that supports long-lived workers, or
 * in-process alongside the API for a single-command local backend.
 */

import { keeperTick, indexToHead } from "@roque/core";

// How often each loop runs when hosted as a persistent process. The keeper wants
// to be responsive so a triggered order fills promptly; the indexer can be a
// touch more relaxed since a few seconds of lag on history hurts no one.
const KEEPER_INTERVAL_MS = 15_000;
const INDEX_INTERVAL_MS = 20_000;

interface Logger {
  info: (msg: string) => void;
  error: (msg: unknown) => void;
}

const consoleLogger: Logger = {
  info: (msg) => console.log(new Date().toISOString(), msg),
  error: (msg) => console.error(new Date().toISOString(), msg),
};

/**
 * Start both loops. Each tick is wrapped so a transient RPC or database hiccup
 * logs and is retried on the next interval rather than killing the loop. Returns
 * a stop function, handy for tests and clean shutdown.
 */
export function startWorkers(logger: Logger = consoleLogger): () => void {
  logger.info("keeper and indexer loops starting");

  const runKeeper = async () => {
    try {
      const res = await keeperTick();
      if (res.triggered > 0 || res.filled.length > 0 || res.errors.length > 0) {
        logger.info(
          `keeper: scanned ${res.scanned}, triggered ${res.triggered}, filled ${res.filled.length}, errors ${res.errors.length}`,
        );
      }
    } catch (err) {
      logger.error(`keeper tick failed: ${(err as Error).message}`);
    }
  };

  const runIndexer = async () => {
    try {
      const rows = await indexToHead();
      if (rows > 0) logger.info(`indexer: wrote ${rows} new trade rows`);
    } catch (err) {
      logger.error(`index tick failed: ${(err as Error).message}`);
    }
  };

  // Kick both once on boot so a fresh start catches up immediately, then settle
  // into their intervals.
  void runIndexer();
  void runKeeper();

  const keeperTimer = setInterval(runKeeper, KEEPER_INTERVAL_MS);
  const indexTimer = setInterval(runIndexer, INDEX_INTERVAL_MS);

  return () => {
    clearInterval(keeperTimer);
    clearInterval(indexTimer);
    logger.info("keeper and indexer loops stopped");
  };
}

// When run directly (pnpm keeper), start the loops and keep the process alive.
// import.meta.url matching argv[1] is the ESM way to ask "was I run, or imported".
const invokedDirectly =
  process.argv[1] && import.meta.url === `file://${process.argv[1]}`;

if (invokedDirectly) {
  startWorkers();
  // Nothing else holds the event loop open, so park on a promise that never
  // resolves; the interval timers keep the process ticking.
  await new Promise(() => {});
}
