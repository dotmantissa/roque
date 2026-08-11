import { handleKeeperTick } from "@roque/core/api";
import { serverEnv } from "@roque/core/env";
import { run } from "../../_util";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Keeper scans can run a little long when several orders trigger at once.
export const maxDuration = 60;

/**
 * The keeper: it wakes up, looks for resting orders whose trigger has been met,
 * and fills them. Vercel Cron drives it on a schedule. We guard the route with a
 * shared secret so only the scheduler, carrying the Authorization header Vercel
 * sets, can nudge it, not any passerby who finds the url.
 */
function authorized(req: Request): boolean {
  const secret = serverEnv().cronSecret;
  const header = req.headers.get("authorization");
  return header === `Bearer ${secret}` || req.headers.get("x-cron-secret") === secret;
}

export async function GET(req: Request) {
  if (!authorized(req)) {
    return new Response(JSON.stringify({ error: "Not your keeper to wake." }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  }
  return run(() => handleKeeperTick());
}

export const POST = GET;
