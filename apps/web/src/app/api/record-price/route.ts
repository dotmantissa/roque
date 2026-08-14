import { handleRecordPrice } from "@roque/core/api";
import { run } from "../_util";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const body = await request.json();
  return run(() => handleRecordPrice(body));
}