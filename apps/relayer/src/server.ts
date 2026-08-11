/**
 * The standalone Roque backend. A thin Fastify shell over the shared handlers in
 * @roque/core: every route here does three things and no more, namely read the
 * request, hand it to the matching handler, and translate an ApiError into a
 * status code. All the real behaviour lives in core so the web app's serverless
 * routes answer identically. Keep this file boring on purpose.
 */

import Fastify from "fastify";
import cors from "@fastify/cors";
import { serverEnv } from "@roque/core/env";
import {
  ApiError,
  handleInterpret,
  handleQuote,
  handlePrice,
  handlePrepareSwap,
  handleConfirmSwap,
  handleGrant,
  handleExecute,
  handleAgentInfo,
  handleCapability,
  handleVault,
  handleActivity,
  handleKeeperTick,
  handleIndex,
  handleHealth,
} from "@roque/core/api";
import { startWorkers } from "./workers.js";

const app = Fastify({
  logger: {
    level: "info",
    transport: { target: "pino-pretty", options: { colorize: true, translateTime: "HH:MM:ss" } },
  },
});

await app.register(cors, { origin: true });

app.setErrorHandler((err, _req, reply) => {
  if (err instanceof ApiError) {
    reply.status(err.status).send({ error: err.message });
    return;
  }
  app.log.error(err);
  reply.status(500).send({ error: "Something went wrong on our side. Try again in a moment." });
});

// ── Health and static info ────────────────────────────────────
app.get("/health", async () => handleHealth());
app.get("/agent", async () => handleAgentInfo());

// ── Judgment and market ───────────────────────────────────────
app.post("/interpret", async (req) => handleInterpret(req.body));
app.post("/quote", async (req) => handleQuote(req.body));
app.get("/price", async () => handlePrice());

// ── Copilot: user-signed swaps ────────────────────────────────
app.post("/swap/prepare", async (req) => handlePrepareSwap(req.body));
app.post("/swap/confirm", async (req) => handleConfirmSwap(req.body));

// ── Autonomous: grants and the executor ───────────────────────
app.post("/grant", async (req) => handleGrant(req.body));
app.post("/execute", async (req) => handleExecute(req.body));

// ── Dashboard reads ───────────────────────────────────────────
app.get<{ Params: { user: string } }>("/capability/:user", async (req) =>
  handleCapability(req.params.user),
);
app.get<{ Params: { user: string } }>("/vault/:user", async (req) => handleVault(req.params.user));
app.get<{ Params: { user: string }; Querystring: { limit?: string } }>(
  "/activity/:user",
  async (req) => handleActivity(req.params.user, Number(req.query.limit ?? 25)),
);

// ── Worker nudges, guarded by the shared cron secret ──────────
app.post<{ Headers: { "x-cron-secret"?: string } }>("/tick/keeper", async (req, reply) => {
  requireCron(req.headers["x-cron-secret"], reply);
  return handleKeeperTick();
});
app.post<{ Headers: { "x-cron-secret"?: string } }>("/tick/index", async (req, reply) => {
  requireCron(req.headers["x-cron-secret"], reply);
  return handleIndex();
});

function requireCron(provided: string | undefined, reply: import("fastify").FastifyReply) {
  if (provided !== serverEnv().cronSecret) {
    reply.status(401).send({ error: "Not authorised." });
    throw new Error("unauthorised cron");
  }
}

const env = serverEnv();

app
  .listen({ port: env.port, host: "0.0.0.0" })
  .then(() => {
    // With the HTTP surface up, start the in-process keeper and indexer loops so a
    // single `pnpm relayer` gives you the whole live backend, not just the API.
    startWorkers(app.log);
  })
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
