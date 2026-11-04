import { randomUUID } from "node:crypto";
import { q } from "./db/index.js";
/** Every write uses the returned generation; an expired worker cannot commit progress. */
export async function acquireLease(key: string, seconds = 120) {
 const owner=randomUUID();
 const rows=await q<{generation:string}>(`INSERT INTO worker_leases(key,owner,expires_at) VALUES($1,$2,now()+$3*interval '1 second')
   ON CONFLICT(key) DO UPDATE SET owner=$2,generation=worker_leases.generation+1,expires_at=now()+$3*interval '1 second'
   WHERE worker_leases.expires_at<=now() RETURNING generation`,[key,owner,seconds]);
 return rows[0]?{key,owner,generation:rows[0].generation}:null;
}
export async function releaseLease(lease:NonNullable<Awaited<ReturnType<typeof acquireLease>>>) {
 await q("UPDATE worker_leases SET expires_at=now() WHERE key=$1 AND owner=$2 AND generation=$3",[lease.key,lease.owner,lease.generation]);
}
