import { handleOpenOrders } from "@roque/core/api";
import { run } from "../../_util";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ user: string }> }) {
  const { user } = await ctx.params;
  return run(() => handleOpenOrders(user));
}
