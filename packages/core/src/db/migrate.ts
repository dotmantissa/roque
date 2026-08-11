/**
 * Create the schema on a fresh Neon database. Run it once with
 *   pnpm --filter @roque/core migrate
 * It is safe to run again; every statement is idempotent.
 */

import { ensureSchema } from "./index.js";

async function main() {
  process.stdout.write("Applying Roque schema to Neon ... ");
  await ensureSchema();
  process.stdout.write("done.\n");
}

main().catch((err) => {
  console.error("\nMigration failed:", err);
  process.exit(1);
});
