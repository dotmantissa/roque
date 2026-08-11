import { handleActivity } from "@roque/core/api";
import { run } from "../../_util";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ user: string }> }) {
  const { user } = await ctx.params;
  const limit = Number(new URL(req.url).searchParams.get("limit") ?? "25");
  return run(() => handleActivity(user, Number.isFinite(limit) ? limit : 25));
}
