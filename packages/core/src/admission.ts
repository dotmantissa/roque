import { q } from "./db/index.js";

export class QuotaError extends Error { status = 429; }
/** Atomic fixed-window quota; callers use verified identities or transport IPs. */
export async function admit(subject: string, limit = 20): Promise<void> {
  const rows = await q(`INSERT INTO api_budgets(subject,bucket,count) VALUES($1,$2,1)
    ON CONFLICT(subject,bucket) DO UPDATE SET count=api_budgets.count+1
    WHERE api_budgets.count < $3 RETURNING count`, [subject, Math.floor(Date.now()/60000), limit]);
  if (rows.length !== 1) throw new QuotaError("Request quota exceeded. Retry after one minute.");
}

const transportBudgets=new Map<string,{bucket:number;count:number}>();
/** Bound the local map before creating any database/RPC/GenLayer work. */
export function admitTransport(ip:string):void {
 const bucket=Math.floor(Date.now()/60000);
 for(const [key,value] of transportBudgets) if(value.bucket!==bucket) transportBudgets.delete(key);
 const prior=transportBudgets.get(ip);
 if(!prior && transportBudgets.size>=2048) throw new QuotaError("Service admission is full.");
 const next={bucket,count:(prior?.count??0)+1};
 transportBudgets.set(ip,next);
 if(next.count>120) throw new QuotaError("Request quota exceeded.");
}

export async function costlyAdmission(subject:string):Promise<void> {
 await admit("global:interpretation",100);
 await admit(subject,10);
}

/** Expire credentials and quota buckets; retain financial journals for recovery. */
export async function maintenanceTick():Promise<void> {
 await q("DELETE FROM api_budgets WHERE bucket<$1",[Math.floor(Date.now()/60000)-1440]);
 await q("DELETE FROM auth_challenges WHERE expires_at<now()-interval '1 day'");
 await q("DELETE FROM auth_sessions WHERE expires_at<now()-interval '1 day'");
 await q("DELETE FROM oauth_requests WHERE expires_at<now()-interval '1 day'");
 await q("DELETE FROM oauth_codes WHERE expires_at<now()-interval '1 day'");
 await q("DELETE FROM approval_links WHERE expires_at<now()-interval '1 day'");
}
