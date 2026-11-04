import {encodeFunctionData,parseEventLogs,type Abi,type Hex} from "viem";
import {addresses,abis} from "@roque/shared";
import {publicClient,sendRelayerTx} from "./chain.js";
import {q} from "./db/index.js";
import {acquireLease,releaseLease} from "./leases.js";
export interface KeeperResult {
 scanned:number;triggered:number;
 submitted:{id:string;txHash:string}[];
 filled:{id:string;txHash:string}[];
 errors:{id:string;error:string}[];
}
/** A persistent bounded circular scan; a hash alone is a submission. */
export async function keeperTick():Promise<KeeperResult>{
 const result:KeeperResult={scanned:0,triggered:0,submitted:[],filled:[],errors:[]};
 const key=`keeper:${addresses.orderBook.toLowerCase()}`;
 const lease=await acquireLease(key);if(!lease)return result;
 try{
  const client=publicClient();
  const nextId=await client.readContract({address:addresses.orderBook,abi:abis.orderBook,functionName:"nextOrderId"}) as bigint;
  await q("INSERT INTO keeper_progress(key,next_order_id) VALUES($1,1) ON CONFLICT DO NOTHING",[key]);
  const row=(await q<{next_order_id:string}>("SELECT next_order_id FROM keeper_progress WHERE key=$1",[key]))[0];
  let cursor=BigInt(row.next_order_id);if(cursor>=nextId)cursor=1n;
  const started=Date.now();
  while(cursor<nextId&&result.scanned<50&&Date.now()-started<40000){
   const id=cursor++;result.scanned++;
   try{
    const order=await client.readContract({address:addresses.orderBook,abi:abis.orderBook,functionName:"getOrder",args:[id]}) as {status:number};
    if(Number(order.status)!==1)continue;
    const triggered=await client.readContract({address:addresses.orderBook,abi:abis.orderBook,functionName:"isTriggered",args:[id]});
    if(!triggered)continue;result.triggered++;
    // Identical calldata maps to the same durable attempt across all scans.
    const data=encodeFunctionData({abi:abis.orderBook,functionName:"executeOrder",args:[id]});
    const base=`${key}:order:${id}`;
    const prior=(await q<{id:string;status:string}>("SELECT id,status FROM execution_attempts WHERE id=$1 OR id LIKE $2 ORDER BY created_at DESC LIMIT 1",[base,`${base}:retry:%`]))[0];
    // A definitively mined revert permits a fresh gas transaction; unknowns retain their hash.
    const operationId=prior?.status==='mined_revert'?`${base}:retry:${lease.generation}`:prior?.id??base;
    const hash=await sendRelayerTx({to:addresses.orderBook,data,operationId});
    result.submitted.push({id:id.toString(),txHash:hash});
    try{
     const receipt=await client.getTransactionReceipt({hash});
     const block=await client.getBlock({blockNumber:receipt.blockNumber});
     if(receipt.status==='success'&&block.hash===receipt.blockHash&&await client.getBlockNumber()-receipt.blockNumber+1n>=3n){
      const fill=parseEventLogs({abi:abis.orderBook as Abi,eventName:'OrderFilled',logs:receipt.logs.filter(l=>l.address.toLowerCase()===addresses.orderBook.toLowerCase())}).some(l=>(l.args as {id?:bigint}).id===id);
      if(fill)result.filled.push({id:id.toString(),txHash:hash});
     }
    }catch{/* Pending or unreadable receipts remain submitted. */}
   }catch{result.errors.push({id:id.toString(),error:'Order check or submission unavailable; retry on the next scan.'});}
  }
  await q(`UPDATE keeper_progress SET next_order_id=$2 WHERE key=$1 AND EXISTS(SELECT 1 FROM worker_leases WHERE key=$1 AND owner=$3 AND generation=$4 AND expires_at>now())`,[key,cursor>=nextId?1n:cursor,lease.owner,lease.generation]);
  return result;
 }finally{await releaseLease(lease).catch(()=>{});}
}
