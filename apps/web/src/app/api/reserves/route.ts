import { handleReserves } from "@roque/core/api";
import { run, body } from "../_util";

export const runtime = "nodejs";

export async function POST(req: Request) {
  return run(async () => handleReserves(await body(req)));
}
