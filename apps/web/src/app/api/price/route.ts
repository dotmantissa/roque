import { handlePrice } from "@roque/core/api";
import { run } from "../_util";

export const runtime = "nodejs";

// The market ticker refreshes often; never let a CDN pin a stale price.
export const dynamic = "force-dynamic";

export async function GET() {
  return run(() => handlePrice());
}
