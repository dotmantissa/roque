import { createHash } from "node:crypto";
import { keccak256, type Hex } from "viem";
import { q } from "./db/index.js";
import { acquireLease, releaseLease } from "./leases.js";
import { publicClient, relayerWallet } from "./chain.js";

interface Attempt {id:string;nonce:string;target:Hex;calldata:Hex;raw_tx:Hex|null;tx_hash:Hex|null;status:string}
/** Reserve nonce durably, persist signed bytes/hash, then broadcast only those bytes. */
export async function durableSend(params:{to:Hex;data:Hex;operationId?:string}):Promise<Hex> {
 const wallet=relayerWallet(), account=wallet.account!;
 const chainId=wallet.chain!.id, sender=account.address.toLowerCase();
 const id=params.operationId??createHash("sha256").update(JSON.stringify([chainId,sender,params.to.toLowerCase(),params.data])).digest("hex");
 const existing=await q<Attempt>("SELECT * FROM execution_attempts WHERE id=$1",[id]);
 if(existing[0]?.tx_hash) return existing[0].tx_hash;
 const lease=await acquireLease(`sender:${chainId}:${sender}`);
 if(!lease) throw new Error("Relayer sender is busy; retry the same operation.");
 try {
   // Recover earlier reserved nonces first. Never allocate beyond an unsigned hole.
   const unresolved=await q<Attempt>("SELECT * FROM execution_attempts WHERE chain_id=$1 AND sender=$2 AND status='created' ORDER BY nonce LIMIT 1",[chainId,sender]);
   if(unresolved[0] && unresolved[0].id!==id) {
     await signAndBroadcast(unresolved[0],lease);
   }
   let attempt=(await q<Attempt>("SELECT * FROM execution_attempts WHERE id=$1",[id]))[0];
   if(!attempt) {
     const pending=await publicClient().getTransactionCount({address:account.address,blockTag:"pending"});
     await q("INSERT INTO relayer_senders(chain_id,sender,next_nonce) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",[chainId,sender,pending]);
     const rows=await q<Attempt>(`WITH reserved AS (
       UPDATE relayer_senders SET next_nonce=GREATEST(next_nonce,$3)+1 WHERE chain_id=$1 AND sender=$2
       AND EXISTS(SELECT 1 FROM worker_leases WHERE key=$7 AND owner=$8 AND generation=$9 AND expires_at>now()) RETURNING next_nonce-1 AS nonce)
       INSERT INTO execution_attempts(id,chain_id,sender,nonce,target,calldata)
       SELECT $4,$1,$2,nonce,$5,$6 FROM reserved RETURNING *`,
       [chainId,sender,pending,id,params.to,params.data,lease.key,lease.owner,lease.generation]);
     if(!rows[0]) throw new Error("Sender lease expired.");
     attempt=rows[0];
   }
   return await signAndBroadcast(attempt,lease);
 } finally {await releaseLease(lease).catch(()=>{});}
}
async function signAndBroadcast(attempt:Attempt,lease:NonNullable<Awaited<ReturnType<typeof acquireLease>>>):Promise<Hex> {
 const wallet=relayerWallet();
 let raw=attempt.raw_tx, hash=attempt.tx_hash;
 if(!raw || !hash) {
   const request=await wallet.prepareTransactionRequest({account:wallet.account!,chain:wallet.chain,
     to:attempt.target,data:attempt.calldata,nonce:Number(attempt.nonce),value:0n});
   raw=await wallet.signTransaction(request as Parameters<typeof wallet.signTransaction>[0]);
   hash=keccak256(raw);
   const persisted=await q(`UPDATE execution_attempts SET raw_tx=$2,tx_hash=$3,status='signed',updated_at=now()
     WHERE id=$1 AND raw_tx IS NULL AND EXISTS(SELECT 1 FROM worker_leases WHERE key=$4 AND owner=$5 AND generation=$6 AND expires_at>now()) RETURNING id`,
     [attempt.id,raw,hash,lease.key,lease.owner,lease.generation]);
   if(persisted.length!==1) throw new Error("Sender lost ownership before signing was recorded.");
 }
 try {
   const returned=await wallet.sendRawTransaction({serializedTransaction:raw});
   if(returned!==hash) throw new Error("Unexpected RPC transaction hash.");
   await q("UPDATE execution_attempts SET status='broadcast',updated_at=now() WHERE id=$1",[attempt.id]);
 } catch {
   // The signed hash remains authoritative even when the RPC reply is lost.
   await q("UPDATE execution_attempts SET status='submission_unknown',updated_at=now() WHERE id=$1",[attempt.id]).catch(()=>{});
 }
 return hash;
}
/** Recovery rebroadcasts identical bytes, never a newly signed business intent. */
export async function reconcileRelayerAttempts():Promise<void> {
 const rows=await q<Attempt>("SELECT * FROM execution_attempts WHERE status IN ('signed','broadcast','submission_unknown') ORDER BY created_at LIMIT 20");
 for(const row of rows) {
   if(!row.tx_hash||!row.raw_tx) continue;
   try {
     const receipt=await publicClient().getTransactionReceipt({hash:row.tx_hash});
     const block=await publicClient().getBlock({blockNumber:receipt.blockNumber});
     if(block.hash!==receipt.blockHash) continue;
     const confirmations=await publicClient().getBlockNumber()-receipt.blockNumber+1n;
     if(confirmations<3n) continue;
     await q("UPDATE execution_attempts SET status=$2,receipt=$3::jsonb,updated_at=now() WHERE id=$1",[row.id,
       receipt.status==="success"?"mined_success":"mined_revert",JSON.stringify({hash:receipt.transactionHash,blockHash:receipt.blockHash,blockNumber:receipt.blockNumber.toString(),status:receipt.status})]);
   } catch {
     try {await relayerWallet().sendRawTransaction({serializedTransaction:row.raw_tx});} catch { /* retained for next pass */ }
   }
 }
}
