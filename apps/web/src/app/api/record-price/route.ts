import { handleRecordPrice } from "@roque/core/api";
import { body, run } from "../_util";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  return run(async () => handleRecordPrice(await body(request)));
}
