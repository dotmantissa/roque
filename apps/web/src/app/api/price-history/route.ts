import { handlePriceHistory } from "@roque/core/api";
import { run } from "../_util";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  return run(() => handlePriceHistory(searchParams));
}
