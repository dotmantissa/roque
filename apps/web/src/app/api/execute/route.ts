import { handleExecute } from "@roque/core/api";
import { run, body, bearerToken } from "../_util";

export const runtime = "nodejs";

export async function POST(req: Request) {
  return run(async () => handleExecute(await body(req), bearerToken(req)));
}
