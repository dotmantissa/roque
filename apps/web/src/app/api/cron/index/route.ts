import { handleIndex } from "@roque/core/api";
import { serverEnv } from "@roque/core/env";
import { run } from "../../_util";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * The indexer: it reads new blocks, decodes Roque's events, and writes trades to
 * the database so the activity feed reflects what actually settled on-chain.
 * Same shared secret guard as the keeper.
 */
function authorized(req: Request): boolean {
  const secret = serverEnv().cronSecret;
  const header = req.headers.get("authorization");
  return header === `Bearer ${secret}` || req.headers.get("x-cron-secret") === secret;
}

export async function GET(req: Request) {
  if (!authorized(req)) {
    return new Response(JSON.stringify({ error: "Not your indexer to run." }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  }
  return run(() => handleIndex());
}

export const POST = GET;
