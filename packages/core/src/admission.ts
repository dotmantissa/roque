import { q } from "./db/index.js";

export class QuotaError extends Error { status = 429; }
/** Atomic fixed-window quota; callers use verified identities or transport IPs. */
export async function admit(subject: string, limit = 20): Promise<void> {
  const rows = await q(`INSERT INTO api_budgets(subject,bucket,count) VALUES($1,$2,1)
    ON CONFLICT(subject,bucket) DO UPDATE SET count=api_budgets.count+1
    WHERE api_budgets.count < $3 RETURNING count`, [subject, Math.floor(Date.now()/60000), limit]);
  if (rows.length !== 1) throw new QuotaError("Request quota exceeded. Retry after one minute.");
}
