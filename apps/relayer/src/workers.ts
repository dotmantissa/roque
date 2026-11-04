/**
 * The background loops that make Roque live rather than merely responsive.
 * The indexer keeps the trade history current; the keeper watches resting limit
 * orders and fills the ones whose trigger the market has reached. Both are safe
 * to run anywhere: the indexer is idempotent, and the keeper can only ever pay
 * gas to attempt a fill the contract itself judges valid.
 *
 * Two slower loops sit alongside them. Judgment carries the work that has to ask
 * GenLayer something: screening event conditions, then deciding whether they
 * came true, and walking playbooks one rung at a time. Proposals is the agent
 * looking over each active vault and writing down what it would do next.
 *
 * This same module is the entry point for `pnpm keeper`, so the background work
 * can run as its own process on a host that supports long-lived workers, or
 * in-process alongside the API for a single-command local backend.
 */

import {interpretationTick,walletSettlementTick} from "@roque/core/public-api";
import {reconcileRelayerAttempts} from "@roque/core/sender";
import {maintenanceTick} from "../../../packages/core/src/admission.js";
import {
  keeperTick,
  indexToHead,
  eventTick,
  playbookTick,
  proposalTick,
} from "@roque/core";

// How often each loop runs when hosted as a persistent process. The keeper wants
// to be responsive so a triggered order fills promptly; the indexer can be a
// touch more relaxed since a few seconds of lag on history hurts no one.
const KEEPER_INTERVAL_MS = 15_000;
const INDEX_INTERVAL_MS = 20_000;

// Judgment is on a different clock entirely. A single GenLayer round trip is a
// write plus a receipt poll, measured at 24 to 36 seconds, and a tick works
// through several rows, so one pass can run for minutes. The interval is the
// floor on how often we *check*, not a promise about duration; the guard below
// means a long pass simply runs into the next window instead of stacking.
const JUDGMENT_INTERVAL_MS = 60_000;

// Proposals ask nothing of GenLayer, so they are cheap, but they are also
// advice, and advice that rewrites itself every minute reads as noise. Once
// every ten minutes is plenty for a suggestion the user may act on tomorrow.
const PROPOSAL_INTERVAL_MS = 10 * 60 * 1000;

interface Logger {
  info: (msg: string) => void;
  error: (msg: unknown) => void;
}

const consoleLogger: Logger = {
  info: (msg) => console.log(new Date().toISOString(), msg),
  error: (msg) => console.error(new Date().toISOString(), msg),
};

/**
 * Wrap a tick so it never overlaps itself and never throws into the timer.
 *
 * setInterval does not wait for an async callback, so a pass that outlives its
 * interval would otherwise have a second copy start underneath it: two workers
 * reading the same due rows and both acting on them. For the GenLayer loops,
 * where a pass genuinely can run for minutes, that is the difference between
 * one fill and two. A skipped tick costs nothing: the row is still due next
 * time, because due-ness is a database fact rather than something the loop
 * remembers.
 *
 * Worth being exact about the scope: this stops a loop overlapping *itself* and
 * nothing more. The same work also runs from a Vercel cron and, for the keeper,
 * from a GitHub Action, and no wrapper in this process can see those. The guards
 * that handle two processes are in the database and on the chain: a claim before
 * acting, a lease before paying for a consensus round, and a serialised queue in
 * front of the relayer wallet.
 */
function serial(name: string, tick: () => Promise<void>, logger: Logger) {
  let running = false;
  return async () => {
    if (running) return;
    running = true;
    try {
      await tick();
    } catch (err) {
      logger.error(`${name} tick failed: ${(err as Error).message}`);
    } finally {
      running = false;
    }
  };
}

/**
 * Start every loop. Each tick is wrapped so a transient RPC or database hiccup
 * logs and is retried on the next interval rather than killing the loop, and so
 * a slow pass is never overlapped by the next one. Returns a stop function,
 * handy for tests and clean shutdown.
 */
export function startWorkers(logger: Logger = consoleLogger): () => void {
  logger.info("keeper, indexer, judgment and proposal loops starting");

  const runKeeper = serial("keeper", async () => {
    const res = await keeperTick();
    if (res.triggered > 0 || res.filled.length > 0 || res.errors.length > 0) {
      logger.info(
        `keeper: scanned ${res.scanned}, triggered ${res.triggered}, filled ${res.filled.length}, errors ${res.errors.length}`,
      );
    }
  }, logger);

  const runIndexer = serial("index", async () => {
    const rows = await indexToHead();
    if (rows > 0) logger.info(`indexer: wrote ${rows} new trade rows`);
  }, logger);

  // Events and playbooks share this loop deliberately, run one after the other
  // rather than together: both talk to the same GenLayer node, and pipelining
  // them would only mean two slow round trips contending instead of one.
  const runJudgment = serial("judgment", async () => {
    const ev = await eventTick();
    if (ev.screened > 0 || ev.evaluated > 0 || ev.errors.length > 0) {
      logger.info(
        `events: screened ${ev.screened}, evaluated ${ev.evaluated}, filled ${ev.filled.length}, rejected ${ev.rejected.length}, errors ${ev.errors.length}`,
      );
    }
    for (const err of ev.errors) logger.error(`events: ${err}`);

    const pb = await playbookTick();
    if (pb.advanced > 0 || pb.errors.length > 0) {
      logger.info(
        `playbooks: advanced ${pb.advanced}, filled ${pb.filled.length}, completed ${pb.completed.length}, errors ${pb.errors.length}`,
      );
    }
    for (const err of pb.errors) logger.error(`playbooks: ${err}`);
  }, logger);

  const runProposals = serial("proposals", async () => {
    const res = await proposalTick();
    if (res.filed > 0 || res.errors.length > 0) {
      logger.info(`proposals: ${res.filed} filed across ${res.users} vaults, errors ${res.errors.length}`);
    }
    for (const err of res.errors) logger.error(`proposals: ${err}`);
  }, logger);

  // Kick the fast loops once on boot so a fresh start catches up immediately.
  // Judgment and proposals wait out their first interval instead: a restart
  // should not open with a minutes-long GenLayer pass before the API is warm.
  void runIndexer();
  void runKeeper();

  const runPublic=serial("public",async()=>{await reconcileRelayerAttempts();await walletSettlementTick();await interpretationTick();},logger);
  const runMaintenance=serial("maintenance",maintenanceTick,logger);
  void runPublic();void runMaintenance();
  const timers = [
    setInterval(runPublic,1000),
    setInterval(runMaintenance,60000),
    setInterval(runKeeper, KEEPER_INTERVAL_MS),
    setInterval(runIndexer, INDEX_INTERVAL_MS),
    setInterval(runJudgment, JUDGMENT_INTERVAL_MS),
    setInterval(runProposals, PROPOSAL_INTERVAL_MS),
  ];

  return () => {
    for (const t of timers) clearInterval(t);
    logger.info("background loops stopped");
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
