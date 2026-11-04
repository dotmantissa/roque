/**
 * The standalone Roque backend. A thin Fastify shell over the shared handlers in
 * @roque/core: every route here does three things and no more, namely read the
 * request, hand it to the matching handler, and translate an ApiError into a
 * status code. All the real behaviour lives in core so the web app's serverless
 * routes answer identically. Keep this file boring on purpose.
 */

import {pathToFileURL} from "node:url";
import OAuth2Server from "@node-oauth/oauth2-server";
import {registerOAuth} from "./oauth.js";
import Fastify from "fastify";
import {z,ZodError} from "zod";
import {admitTransport,admit} from "../../../packages/core/src/admission.js";
import * as v1 from "@roque/core/public-api";
import cors from "@fastify/cors";
import { serverEnv } from "@roque/core/env";
import {
  ApiError,
  handleRevokeSession,
  handleAuthChallenge,
  handleAuthSession,
  handleInterpret,
  handleQuote,
  handlePrice,
  handleReserves,
  handlePrepareSwap,
  handlePrepareLimit,
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
  handleCreateEventOrder,
  handleScreenEventOrder,
  handleArmEventOrder,
  handleEventOrders,
  handleCancelEventOrder,
  handleCreatePlaybook,
  handleUpdatePlaybook,
  handleArmPlaybook,
  handlePlaybooks,
  handlePlaybook,
  handleCancelPlaybook,
  handleReadShare,
  handleRecentShares,
  handleMyShares,
  handlePublishShare,
  handleForkShare,
  handleProposals,
  handleRefreshProposals,
  handleAcceptProposal,
  handleDismissProposal,
  handleJudgmentTick,
} from "@roque/core/api";
import { startWorkers } from "./workers.js";

export async function createServer() {
const app = Fastify({logger:false,bodyLimit:16384});
app.addHook("onRequest",async req=>{admitTransport(req.ip);await admit("global:http",600);});
app.addHook("onSend",async(_req,reply)=>{reply.header("Cache-Control","no-store");reply.header("X-Content-Type-Options","nosniff");});
app.addContentTypeParser("application/x-www-form-urlencoded",{parseAs:"string"},(_req,body,done)=>{
  const parsed=Object.fromEntries(new URLSearchParams(String(body)));done(null,parsed);
});
const allowedOrigins=(process.env.API_ALLOWED_ORIGINS??"http://localhost:3000").split(",");
await app.register(cors,{origin:allowedOrigins,allowedHeaders:["content-type","authorization","x-api-key","idempotency-key"],methods:["GET","POST","DELETE","OPTIONS"]});

app.setErrorHandler((err, _req, reply) => {
  if(err instanceof OAuth2Server.OAuthError){reply.status(err.code).send({error:err.name,error_description:err.code<500?err.message:"Authorization service unavailable."});return;}
  if(err instanceof ZodError) {reply.status(400).send({error:{code:"INVALID_REQUEST",message:"Invalid request fields.",requestId:_req.id}});return;}
  if(err instanceof v1.PublicApiError) {reply.status(err.status).send({error:{code:err.code,message:err.message,requestId:_req.id}});return;}
  if((err as {status?:number}).status===429) {reply.header("Retry-After","60").status(429).send({error:{code:"RATE_LIMITED",message:"Request quota exceeded.",requestId:_req.id}});return;}
  if (err instanceof ApiError) {
    reply.status(err.status).send({ error: err.message });
    return;
  }
  app.log.error(err);
  if(_req.url.startsWith("/v1/")) {const status=(err as {statusCode?:number}).statusCode;reply.status(status===413?413:500).send({error:{code:status===413?"BODY_TOO_LARGE":"INTERNAL_ERROR",message:"Request could not be completed. Check status before retrying.",requestId:_req.id}});}
  else reply.status(500).send({ error: "Something went wrong on our side. Try again in a moment." });
});

// ── Health and static info ────────────────────────────────────
app.get("/health", async () => handleHealth());
app.get("/agent", async () => handleAgentInfo());

// ── Wallet authentication ────────────────────────────────────
app.post("/auth/challenge", async (req) => handleAuthChallenge(req.body));
app.delete("/auth/session",async(req)=>handleRevokeSession(bearerToken(req.headers.authorization)));
app.post("/auth/session", async (req) => handleAuthSession(req.body));

// ── Judgment and market ───────────────────────────────────────
app.post("/interpret", async (req) =>
  handleInterpret(req.body, bearerToken(req.headers.authorization)),
);
app.post("/quote", async (req) => handleQuote(req.body));
app.post("/reserves", async (req) => handleReserves(req.body));
app.get("/price", async () => handlePrice());

// ── Copilot: user-signed swaps ────────────────────────────────
app.post("/swap/prepare", async (req) => handlePrepareSwap(req.body,bearerToken(req.headers.authorization)));
app.post("/swap/prepare-limit",async req=>handlePrepareLimit(req.body,bearerToken(req.headers.authorization)));
app.post("/swap/confirm", async (req) => handleConfirmSwap(req.body,bearerToken(req.headers.authorization)));

// ── Autonomous: grants and the executor ───────────────────────
app.post("/grant", async (req) =>
  handleGrant(req.body, bearerToken(req.headers.authorization)),
);
app.post("/execute", async (req) =>
  handleExecute(req.body, bearerToken(req.headers.authorization)),
);

// ── Dashboard reads ───────────────────────────────────────────
app.get<{ Params: { user: string } }>("/capability/:user", async (req) =>
  handleCapability(req.params.user),
);
app.get<{ Params: { user: string } }>("/vault/:user", async (req) => handleVault(req.params.user));
app.get<{ Params: { user: string }; Querystring: { limit?: string } }>(
  "/activity/:user",
  async (req) => handleActivity(req.params.user, Number(req.query.limit ?? 25),bearerToken(req.headers.authorization)),
);

// ── Event orders: limit orders on real-world conditions ───────
// Screening is the slow one. It asks GenLayer whether the condition is even
// checkable before the order is allowed to rest, so expect tens of seconds.
app.post("/events", async (req) =>
  handleCreateEventOrder(req.body, bearerToken(req.headers.authorization)),
);
app.post("/events/screen", async (req) =>
  handleScreenEventOrder(req.body, bearerToken(req.headers.authorization)),
);
app.post("/events/arm", async (req) =>
  handleArmEventOrder(req.body, bearerToken(req.headers.authorization)),
);
app.post("/events/cancel", async (req) =>
  handleCancelEventOrder(req.body, bearerToken(req.headers.authorization)),
);
app.get<{ Params: { user: string } }>("/events/:user", async (req) =>
  handleEventOrders(req.params.user, bearerToken(req.headers.authorization)),
);

// ── Playbooks: a plan the keeper walks one step at a time ──────
app.post("/playbooks", async (req) =>
  handleCreatePlaybook(req.body, bearerToken(req.headers.authorization)),
);
app.post("/playbooks/update", async (req) =>
  handleUpdatePlaybook(req.body, bearerToken(req.headers.authorization)),
);
app.post("/playbooks/arm", async (req) =>
  handleArmPlaybook(req.body, bearerToken(req.headers.authorization)),
);
app.post("/playbooks/cancel", async (req) =>
  handleCancelPlaybook(req.body, bearerToken(req.headers.authorization)),
);
app.get<{ Params: { id: string } }>("/playbooks/detail/:id", async (req) =>
  handlePlaybook(req.params.id, bearerToken(req.headers.authorization)),
);
app.get<{ Params: { user: string } }>("/playbooks/:user", async (req) =>
  handlePlaybooks(req.params.user, bearerToken(req.headers.authorization)),
);

// ── Shares: a thesis that travels without the position ────────
// Reading a share is deliberately public, which is the whole point of the link.
// Everything that touches a vault still needs the session.
app.post("/shares", async (req) =>
  handlePublishShare(req.body, bearerToken(req.headers.authorization)),
);
app.post("/shares/fork", async (req) =>
  handleForkShare(req.body, bearerToken(req.headers.authorization)),
);
app.get("/shares/recent", async () => handleRecentShares());
app.get<{ Params: { user: string } }>("/shares/mine/:user", async (req) =>
  handleMyShares(req.params.user, bearerToken(req.headers.authorization)),
);
// Registered after the two literal paths above so Fastify matches those first.
// Slugs always carry a random suffix, so one can never collide with them anyway.
app.get<{ Params: { slug: string } }>("/shares/:slug", async (req) =>
  handleReadShare(req.params.slug),
);

// ── Proposals: where the agent speaks first ───────────────────
app.get<{ Params: { user: string } }>("/proposals/:user", async (req) =>
  handleProposals(req.params.user, bearerToken(req.headers.authorization)),
);
app.post("/proposals/refresh", async (req) =>
  handleRefreshProposals(req.body, bearerToken(req.headers.authorization)),
);
app.post("/proposals/accept", async (req) =>
  handleAcceptProposal(req.body, bearerToken(req.headers.authorization)),
);
app.post("/proposals/dismiss", async (req) =>
  handleDismissProposal(req.body, bearerToken(req.headers.authorization)),
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
app.post<{ Headers: { "x-cron-secret"?: string } }>("/tick/judgment", async (req, reply) => {
  requireCron(req.headers["x-cron-secret"], reply);
  return handleJudgmentTick();
});

function requireCron(provided: string | undefined, reply: import("fastify").FastifyReply) {
  if (provided !== serverEnv().cronSecret) {
    reply.status(401).send({ error: "Not authorised." });
    throw new Error("unauthorised cron");
  }
}

function bearerToken(header: string | undefined): string | undefined {
  const match = header?.match(/^Bearer ([A-Za-z0-9_-]+)$/u);
  return match?.[1];
}

const key=(req:import("fastify").FastifyRequest)=>typeof req.headers["x-api-key"]==="string"?req.headers["x-api-key"]:undefined;
const idem=(req:import("fastify").FastifyRequest)=>req.headers["idempotency-key"];
const context=(req:import("fastify").FastifyRequest,scope:string)=>v1.apiContext(key(req),bearerToken(req.headers.authorization),scope,req.id);
app.get("/v1/openapi.json",async()=> (await import("../../../docs/openapi.json",{with:{type:"json"}})).default);
app.get("/v1/health",async()=>({status:"ok"}));
app.get("/v1/chains",async()=>v1.chains());
app.get<{Querystring:{chainId?:string}}>("/v1/tokens",async req=>v1.tokens(req.query.chainId));
app.post("/v1/auth/challenges",async req=>v1.createApiChallenge(key(req),req.body));
app.post("/v1/auth/sessions",async req=>v1.createApiSession(key(req),req.body));
app.delete("/v1/auth/session",async req=>v1.disconnect(await context(req,"swaps:read")));
app.post("/v1/intents",async(req,reply)=>reply.status(202).send(await v1.createIntent(await context(req,"intents:write"),req.body,idem(req))));
app.get<{Params:{id:string}}>("/v1/intents/:id",async req=>v1.getIntent(await context(req,"intents:read"),req.params.id));
app.post("/v1/quotes",async req=>v1.createQuote(await context(req,"quotes:read"),req.body,idem(req)));
app.post("/v1/swaps/prepare",async req=>v1.prepareSwap(await context(req,"swaps:prepare"),req.body,idem(req)));
app.get<{Params:{id:string}}>("/v1/swaps/:id",async req=>v1.getSwap(await context(req,"swaps:read"),req.params.id));
app.post<{Params:{id:string}}>("/v1/swaps/:id/submissions",async req=>v1.reportSubmission(await context(req,"swaps:prepare"),req.params.id,req.body,idem(req)));
app.post<{Params:{id:string}}>("/v1/swaps/:id/approval-links",async req=>v1.approvalLink(await context(req,"swaps:prepare"),req.params.id,idem(req)));
app.post("/v1/approval-links/resolve",async req=>{
 const input=z.object({token:z.string().min(32).max(128)}).strict().parse(req.body);if(typeof input.token!=="string"||input.token.length>256)throw new v1.PublicApiError(400,"INVALID_REQUEST","Invalid link token.");
 const link=await v1.resolveApprovalLink(input.token,bearerToken(req.headers.authorization));return v1.getSwap(link.ctx,link.swapId);
});
app.post("/v1/approval-links/submissions",async req=>{
 const input=z.object({token:z.string().regex(/^[A-Za-z0-9_-]{43}$/u),txHash:z.string().regex(/^0x[a-fA-F0-9]{64}$/u)}).strict().parse(req.body);const link=await v1.resolveApprovalLink(input.token,bearerToken(req.headers.authorization),true);
 return v1.reportSubmission(link.ctx,link.swapId,{txHash:input.txHash},`approval-submit:${link.swapId}`);
});
await registerOAuth(app);
return app;
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const app=await createServer();
 await app.listen({port:Number(process.env.RELAYER_PORT??8787),host:"0.0.0.0"});
 if(process.env.RUN_WORKERS==="true") {serverEnv();startWorkers(app.log);}
}
