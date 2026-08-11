import { handleConfirmSwap } from "@roque/core/api";
import { run, body } from "../../_util";

export const runtime = "nodejs";

export async function POST(req: Request) {
  return run(async () => handleConfirmSwap(await body(req)));
}
