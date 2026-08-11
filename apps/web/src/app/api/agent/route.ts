import { handleAgentInfo } from "@roque/core/api";
import { run } from "../_util";

export const runtime = "nodejs";

export async function GET() {
  return run(() => handleAgentInfo());
}
