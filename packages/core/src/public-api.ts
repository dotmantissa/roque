import {createHash,randomUUID,randomBytes} from "node:crypto";
import {z} from "zod";
import {encodeFunctionData,erc20Abi,keccak256,stringToHex,parseUnits,type Hex} from "viem";
import {addresses,abis,deployedChainId,tokenList,requireToken,poolAddressFor,type SwapPlan} from "@roque/shared";
import {acquireLease,releaseLease} from "./leases.js";
import {q} from "./db/index.js";
import {authOrigin} from "./env.js";
import {tokenHash,issueWalletChallenge,completeWalletChallenge,revokeSession} from "./auth.js";
import {admit,costlyAdmission} from "./admission.js";
import {interpret} from "./genlayer.js";
import {decimal,interpretationSchema} from "./validation.js";
import {publicClient} from "./chain.js";
import {walletRouterAbi,inspectWalletTx,verifyWalletTrade} from "./settlement.js";

export const API_SCOPES=["intents:write","intents:read","quotes:read","swaps:prepare","swaps:read"] as const;
export class PublicApiError extends Error {constructor(public status:number,public code:string,message:string){super(message);}}
export interface RequestContext {clientId:string;owner:Hex;scopes:string[];requestId:string;token:string}
interface Client {id:string;scopes:string[];origins:string[];redirects:string[]}
interface Operation {id:string;input:unknown;result:unknown;status:string;request_hash:string;error_code:string|null;generation:string}
const fail=(status:number,code:string,message:string):never=>{throw new PublicApiError(status,code,message);};
const parse=<S extends z.ZodTypeAny>(schema:S,value:unknown):z.infer<S>=>{const r=schema.safeParse(value);return r.success?r.data:fail(400,"INVALID_REQUEST","Invalid request fields.");};
const address=z.string().regex(/^0x[a-fA-F0-9]{40}$/u).transform(s=>s.toLowerCase() as Hex);
const idSchema=z.string().uuid();
export function canonicalJson(value:unknown):string {
 if(Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
 if(value!==null&&typeof value==="object") return `{${Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
 return JSON.stringify(value);
}
export function planHash(plan:Omit<SwapPlan,"planHash">):Hex {return keccak256(stringToHex(canonicalJson(plan)));}
export async function apiClient(key:string|undefined):Promise<Client> {
 if(!key||key.length>256) return fail(401,"CLIENT_REQUIRED","A registered application key is required.");
 const rows=await q<Client>("SELECT id,scopes,origins,redirects FROM api_clients WHERE key_hash=$1 AND revoked_at IS NULL",[tokenHash(key)]);
 return rows[0]??fail(401,"INVALID_CLIENT","Application access is unavailable.");
}
export async function apiContext(key:string|undefined,token:string|undefined,scope:string,requestId:string=randomUUID(),audience=authOrigin()):Promise<RequestContext> {
 if(!token||token.length>256) return fail(401,"WALLET_REQUIRED","Authenticate the execution wallet.");
 const rows=await q<{client_id:string;owner_address:Hex;scopes:string[];session_type:string}>(`SELECT s.client_id,s.owner_address,s.scopes,s.session_type
   FROM auth_sessions s JOIN api_clients c ON c.id=s.client_id
   WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>now() AND s.audience=$2 AND c.revoked_at IS NULL`,[tokenHash(token),audience]);
 const session=rows[0];if(!session) return fail(401,"SESSION_EXPIRED","Connection is expired or revoked.");
 if(key) {const client=await apiClient(key);if(client.id!==session.client_id) return fail(403,"CLIENT_MISMATCH","Session belongs to another application.");}
 else if(session.session_type!=="oauth") return fail(401,"CLIENT_REQUIRED","Application access is required.");
 if(!session.scopes.includes(scope)) return fail(403,"INSUFFICIENT_SCOPE","Connection does not permit this operation.");
 await admit(`api:${session.client_id}:${session.owner_address}`,60);
 return {clientId:session.client_id,owner:session.owner_address.toLowerCase() as Hex,scopes:session.scopes,requestId,token};
}
export const chains=()=>({chains:[{chainId:deployedChainId,name:"Ethereum Sepolia",testnet:true,executionModes:["wallet"],settlement:"same_wallet",router:addresses.router,confirmations:3}]});
export function tokens(chainId:unknown) {if(chainId!==undefined&&Number(chainId)!==deployedChainId) fail(422,"UNSUPPORTED_CHAIN","Only Sepolia is supported.");return {tokens:tokenList.map(t=>({symbol:t.symbol,address:t.address,decimals:t.decimals,testnet:true,operations:["exact_input_market_swap"]}))};}
export async function createApiChallenge(key:string|undefined,body:unknown) {
 const client=await apiClient(key);const input=parse(z.object({owner:address,chainId:z.literal(deployedChainId)}).strict(),body);
 await admit(`challenge:${client.id}`,20);
 return issueWalletChallenge(input.owner,{clientId:client.id,scopes:client.scopes.filter(s=>API_SCOPES.includes(s as typeof API_SCOPES[number]))});
}
export async function createApiSession(key:string|undefined,body:unknown) {
 const client=await apiClient(key);const input=parse(z.object({challengeId:idSchema,owner:address,signature:z.string().regex(/^0x[a-fA-F0-9]{130}$/u).transform(s=>s as Hex)}).strict(),body);
 const session=await completeWalletChallenge({...input,clientId:client.id});return session??fail(401,"INVALID_PROOF","Wallet proof is invalid or expired.");
}
export async function disconnect(ctx:RequestContext){await revokeSession(ctx.token);return {revoked:true};}
async function reserveOperation(ctx:RequestContext,operation:string,key:unknown,input:unknown) {
 const id=randomUUID();const checked=parse(z.string().min(8).max(128).regex(/^[A-Za-z0-9._:-]+$/u),key);
 const hash=createHash("sha256").update(canonicalJson(input)).digest("hex");
 // Serialize new-row admission across replicas; existing idempotent requests remain recoverable at capacity.
 const lease=await acquireLease("api-operation-capacity",30);if(!lease)return fail(503,"ADMISSION_BUSY","Retry the same idempotency key.");
 let rows:Operation[];
 try{
  const existing=await q<Operation>("SELECT * FROM api_operations WHERE client_id=$1 AND owner_address=$2 AND chain_id=$3 AND operation=$4 AND idempotency_key=$5",[ctx.clientId,ctx.owner,deployedChainId,operation,checked]);
  if(existing.length)rows=existing;
  else{
   const capacity=await q<{count:string}>("SELECT count(*) AS count FROM api_operations");
   if(BigInt(capacity[0].count)>=100000n)return fail(429,"STORAGE_LIMIT","Operation storage is full; contact the operator.");
   rows=await q<Operation>(`INSERT INTO api_operations(id,client_id,owner_address,chain_id,operation,idempotency_key,request_hash,input)
    SELECT $1,$2,$3,$4,$5,$6,$7,$8::jsonb WHERE EXISTS(SELECT 1 FROM worker_leases WHERE key=$9 AND owner=$10 AND generation=$11 AND expires_at>now())
    ON CONFLICT(client_id,owner_address,chain_id,operation,idempotency_key) DO UPDATE SET idempotency_key=api_operations.idempotency_key RETURNING *`,[id,ctx.clientId,ctx.owner,deployedChainId,operation,checked,hash,JSON.stringify(input),lease.key,lease.owner,lease.generation]);
  }
 }finally{await releaseLease(lease).catch(()=>{});}
 const row=rows[0];if(!row) return fail(503,"STORAGE_UNAVAILABLE","Operation could not be persisted.");
 if(row.request_hash!==hash) return fail(409,"IDEMPOTENCY_CONFLICT","This key already belongs to different request fields.");
 const claim=await q<Operation>(`UPDATE api_operations SET lease_owner=$2,lease_until=now()+interval '5 minutes',generation=generation+1 WHERE id=$1 AND result IS NULL AND (lease_until IS NULL OR lease_until<now()) RETURNING *`,[row.id,id]);
 return {row:claim[0]??row,created:claim.length===1,leaseOwner:id};
}
async function ownedOperation(ctx:RequestContext,id:unknown,operation="intent") {
 const checked=parse(idSchema,id);const rows=await q<Operation>("SELECT * FROM api_operations WHERE id=$1 AND client_id=$2 AND owner_address=$3 AND operation=$4",[checked,ctx.clientId,ctx.owner,operation]);
 return rows[0]??fail(404,"NOT_FOUND","Operation is unavailable.");
}
export async function createIntent(ctx:RequestContext,body:unknown,key:unknown) {
 const input=parse(z.object({chainId:z.literal(deployedChainId),command:z.string().trim().min(1).max(500),executionMode:z.literal("wallet"),slippageBps:z.number().int().min(0).max(500).default(100)}).strict(),body);
 await costlyAdmission(`interpretation:${ctx.clientId}:${ctx.owner}`);
 const {row}=await reserveOperation(ctx,"intent",key,input);
 return {id:row.id,status:row.status,statusUrl:`/v1/intents/${row.id}`};
}
export async function getIntent(ctx:RequestContext,id:unknown) {
 const row=await ownedOperation(ctx,id);return {id:row.id,status:row.status,interpretation:row.result,error:row.error_code};
}
/** Durable leased jobs: the HTTP request never waits for GenLayer consensus. */
export async function interpretationTick() {
 const {acquireLease,releaseLease}=await import("./leases.js");
 const lease=await acquireLease("interpretation-global",300);if(!lease)return;
 try {
 const owner=randomUUID();
 const rows=await q<Operation & {client_id:string;owner_address:Hex}>(`WITH candidate AS (SELECT id FROM api_operations WHERE operation='intent' AND
   (status='queued' OR (status='interpreting' AND lease_until<now())) AND attempts<3 ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1)
   UPDATE api_operations SET status='interpreting',lease_owner=$1,lease_until=now()+interval '5 minutes',generation=generation+1,attempts=attempts+1,updated_at=now()
   WHERE id IN(SELECT id FROM candidate) RETURNING *`,[owner]);
 for(const row of rows) {
  try {
   const input=row.input as {command:string};
   const result=interpretationSchema.parse(await interpret(row.id,input.command,{chainId:deployedChainId,executionMode:"wallet"}));
   const conditional=/\b(if|when|unless|once|limit|below|above|until)\b/iu.test(input.command);
   const supported=!conditional&&result.ok&&result.kind==="swap"&&!result.amountIsPercent&&result.confidence==="high";
   await q(`UPDATE api_operations SET result=$2::jsonb,status=$3,error_code=$4,updated_at=now() WHERE id=$1 AND lease_owner=$5 AND generation=$6 AND lease_until>now()`,
    [row.id,JSON.stringify(result),supported?"ready":"rejected",supported?null:"UNSUPPORTED_INTENT",owner,row.generation]);
  } catch {
   await q("UPDATE api_operations SET status='failed',error_code='INTERPRETATION_FAILED',updated_at=now() WHERE id=$1 AND lease_owner=$2 AND generation=$3",[row.id,owner,row.generation]);
  }
 }
 await q("UPDATE api_operations SET status='failed',error_code='INTERPRETATION_EXHAUSTED' WHERE operation='intent' AND status='interpreting' AND lease_until<now() AND attempts>=3");
 } finally {await releaseLease(lease).catch(()=>{});}
}
export async function createQuote(ctx:RequestContext,body:unknown,key:unknown) {
 const input=parse(z.object({intentId:idSchema}).strict(),body);
 const reservation=await reserveOperation(ctx,"quote",key,input);if(!reservation.created) return reservation.row.result??fail(409,"OPERATION_PENDING","Retry the same idempotency key after the operation finishes.");
 const intent=await ownedOperation(ctx,input.intentId);if(intent.status!=="ready") return fail(409,"INTENT_NOT_READY","Wait for a supported interpretation.");
 const action=interpretationSchema.parse(intent.result);if(!action.ok||action.kind!=="swap"||action.amountIsPercent||action.confidence!=="high") return fail(422,"UNSUPPORTED_INTENT","Provide an absolute, immediate exact-input swap.");
 const tokenIn=requireToken(action.tokenIn),tokenOut=requireToken(action.tokenOut);decimal.parse(action.amount);
 if((action.amount.split(".")[1]?.length??0)>tokenIn.decimals) return fail(422,"AMOUNT_PRECISION","Amount exceeds token precision.");
 const amountInRaw=parseUnits(action.amount,tokenIn.decimals);if(amountInRaw<=0n||amountInRaw>=2n**256n) return fail(422,"INVALID_AMOUNT","Invalid input amount.");
 const client=publicClient(),block=await client.getBlock();if(!block.hash) return fail(503,"RPC_UNAVAILABLE","A canonical quote block is required.");
 const pool=poolAddressFor(tokenIn.symbol,tokenOut.symbol);
 const [quoted,reserves,token0,fee]=await Promise.all([
  client.readContract({address:addresses.router,abi:abis.router,functionName:"quoteSwap",args:[tokenIn.address,tokenOut.address,amountInRaw],blockNumber:block.number}) as Promise<bigint>,
  client.readContract({address:pool,abi:abis.liquidityPool,functionName:"getReserves",blockNumber:block.number}) as Promise<[bigint,bigint]>,
  client.readContract({address:pool,abi:abis.liquidityPool,functionName:"token0",blockNumber:block.number}) as Promise<Hex>,
  client.readContract({address:pool,abi:abis.liquidityPool,functionName:"feeBps",blockNumber:block.number}) as Promise<bigint>,
 ]);
 const reserveIn=reserves[token0.toLowerCase()===tokenIn.address.toLowerCase()?0:1];
 const impact=Number((amountInRaw*10000n+reserveIn+amountInRaw-1n)/(reserveIn+amountInRaw));
 if(quoted<=0n||impact>500) return fail(422,"PRICE_IMPACT","Trade is too small or exceeds the 5% price impact limit.");
 const slippage=(intent.input as {slippageBps:number}).slippageBps;
 const min=quoted*BigInt(10000-slippage)/10000n;if(min===0n) return fail(422,"INVALID_AMOUNT","Output floor rounds to zero.");
 const quoteId=reservation.row.id,expiresAt=Math.floor(Date.now()/1000)+120;
 const payload={quoteId,intentId:intent.id,chainId:deployedChainId,router:addresses.router,executionAccount:ctx.owner,recipient:ctx.owner,
  tokenIn:tokenIn.address,tokenOut:tokenOut.address,tokenInSymbol:tokenIn.symbol,tokenOutSymbol:tokenOut.symbol,
  tokenInDecimals:tokenIn.decimals,tokenOutDecimals:tokenOut.decimals,amountInRaw:amountInRaw.toString(),quotedAmountOutRaw:quoted.toString(),minAmountOutRaw:min.toString(),
  feeBps:Number(fee),priceImpactBps:impact,quoteBlockNumber:block.number.toString(),quoteBlockHash:block.hash,expiresAt,deadline:expiresAt,deploymentVersion:"sepolia-router-v1"};
 const saved=await q<{result:unknown}>(`WITH quote AS (INSERT INTO swap_quotes(id,intent_id,client_id,owner_address,payload,expires_at)
   SELECT $1,$2,$3,$4,$5::jsonb,to_timestamp($6) WHERE EXISTS(SELECT 1 FROM api_operations WHERE id=$1 AND lease_owner=$7 AND generation=$8 AND lease_until>now())
   ON CONFLICT(id) DO UPDATE SET id=swap_quotes.id RETURNING payload)
   UPDATE api_operations SET result=(SELECT payload FROM quote),status='ready',updated_at=now() WHERE id=$1 AND lease_owner=$7 AND generation=$8 AND EXISTS(SELECT 1 FROM quote) RETURNING result`,
   [quoteId,intent.id,ctx.clientId,ctx.owner,JSON.stringify(payload),expiresAt,reservation.leaseOwner,reservation.row.generation]);
 return saved[0]?.result??fail(409,"OPERATION_PENDING","Operation ownership expired. Retry the same key.");
}
async function ownedPlan(ctx:RequestContext,id:unknown) {
 const rows=await q<{id:string;payload:SwapPlan;status:string;tx_hash:Hex|null;receipt:unknown}>("SELECT * FROM swap_plans WHERE id=$1 AND client_id=$2 AND owner_address=$3",[parse(idSchema,id),ctx.clientId,ctx.owner]);
 return rows[0]??fail(404,"NOT_FOUND","Swap is unavailable.");
}
export async function prepareSwap(ctx:RequestContext,body:unknown,key:unknown):Promise<SwapPlan|unknown> {
 const input=parse(z.object({quoteId:idSchema}).strict(),body);
 const reserved=await reserveOperation(ctx,"prepare",key,input);if(!reserved.created) return reserved.row.result??fail(409,"OPERATION_PENDING","Retry the same key after preparation finishes.");
 const rows=await q<{payload:Omit<SwapPlan,"swapId"|"planHash"|"steps">}>("SELECT payload FROM swap_quotes WHERE id=$1 AND client_id=$2 AND owner_address=$3",[input.quoteId,ctx.clientId,ctx.owner]);
 const quote=rows[0]?.payload;if(!quote) return fail(404,"NOT_FOUND","Quote is unavailable.");
 if(quote.expiresAt<=Date.now()/1000) return fail(410,"QUOTE_EXPIRED","Create and review a fresh quote.");
 const block=await publicClient().getBlock({blockNumber:BigInt(quote.quoteBlockNumber)});if(block.hash!==quote.quoteBlockHash) return fail(409,"QUOTE_ORPHANED","Quote block changed. Review a fresh quote.");
 const swapId=reserved.row.id;const data=encodeFunctionData({abi:walletRouterAbi,functionName:"swapExactTokensForTokens",args:[quote.tokenIn,quote.tokenOut,BigInt(quote.amountInRaw),BigInt(quote.minAmountOutRaw),ctx.owner,BigInt(quote.deadline)]});
 const unhashed:Omit<SwapPlan,"planHash">={...quote,swapId,steps:[
  {kind:"approve",to:quote.tokenIn,data:encodeFunctionData({abi:erc20Abi,functionName:"approve",args:[addresses.router,BigInt(quote.amountInRaw)]}),value:"0",chainId:deployedChainId,summary:`Approve exactly ${quote.amountInRaw} raw ${quote.tokenInSymbol} to the Roque router.`},
  {kind:"swap",to:addresses.router,data,value:"0",chainId:deployedChainId,summary:`Swap into ${quote.tokenOutSymbol} in the same wallet.`},
 ]};
 const plan={...unhashed,planHash:planHash(unhashed)};
 const result=await q<{payload:SwapPlan}>(`WITH plan AS (INSERT INTO swap_plans(id,quote_id,client_id,owner_address,payload)
   SELECT $1,$2,$3,$4,$5::jsonb WHERE EXISTS(SELECT 1 FROM api_operations WHERE id=$6 AND lease_owner=$7 AND generation=$8 AND lease_until>now())
   ON CONFLICT(quote_id) DO UPDATE SET quote_id=swap_plans.quote_id RETURNING payload)
   UPDATE api_operations SET result=(SELECT payload FROM plan),status='ready',updated_at=now() WHERE id=$6 AND lease_owner=$7 AND generation=$8 AND EXISTS(SELECT 1 FROM plan) RETURNING result AS payload`,[swapId,input.quoteId,ctx.clientId,ctx.owner,JSON.stringify(plan),reserved.row.id,reserved.leaseOwner,reserved.row.generation]);
 return result[0]?.payload??fail(503,"STORAGE_UNAVAILABLE","Plan could not be persisted.");
}
export async function reportSubmission(ctx:RequestContext,id:unknown,body:unknown,key:unknown) {
 const input=parse(z.object({txHash:z.string().regex(/^0x[a-fA-F0-9]{64}$/u).transform(s=>s.toLowerCase() as Hex)}).strict(),body);
 const row=await ownedPlan(ctx,id);if(row.tx_hash&&row.tx_hash!==input.txHash) return fail(409,"SUBMISSION_CONFLICT","A different transaction is already recorded.");
 await reserveOperation(ctx,`submission:${row.id}`,key,input);
 await inspectWalletTx(input.txHash,ctx.owner,{...row.payload,data:row.payload.steps[1].data});
 const saved=await q(`UPDATE swap_plans SET tx_hash=$2,status='submitted',updated_at=now() WHERE id=$1 AND (tx_hash IS NULL OR tx_hash=$2) RETURNING id`,[row.id,input.txHash]);
 if(saved.length!==1) return fail(409,"SUBMISSION_CONFLICT","Transaction report conflicts with an earlier report.");
 return getSwap(ctx,row.id);
}
export async function getSwap(ctx:RequestContext,id:unknown) {
 const row=await ownedPlan(ctx,id);
 if(row.tx_hash) {
  try {
   const result=await verifyWalletTrade(row.tx_hash,ctx.owner,{...row.payload,data:row.payload.steps[1].data});
   await q("UPDATE swap_plans SET status=$2,receipt=$3::jsonb,updated_at=now() WHERE id=$1",[row.id,result.status,JSON.stringify(result)]);
   return {id:row.id,status:result.status,plan:row.payload,settlement:result};
  } catch(err) {
   const message=err instanceof Error?err.message:"";
   if(message.includes("reverted")) {await q("UPDATE swap_plans SET status='reverted',receipt=NULL,updated_at=now() WHERE id=$1",[row.id]);return {id:row.id,status:"reverted",plan:row.payload};}
   await q("UPDATE swap_plans SET status='confirming',receipt=NULL,updated_at=now() WHERE id=$1",[row.id]);
   // Missing receipt, RPC outage or reorg never becomes success or permits a new spend.
   return {id:row.id,status:"confirming",plan:row.payload,txHash:row.tx_hash};
  }
 }
 return {id:row.id,status:row.payload.expiresAt<=Date.now()/1000?"expired":row.status,plan:row.payload};
}
export async function approvalLink(ctx:RequestContext,id:unknown,key:unknown) {
 const row=await ownedPlan(ctx,id);if(row.tx_hash||row.payload.expiresAt<=Date.now()/1000) return fail(410,"PLAN_EXPIRED","Prepare a fresh plan.");
 const reserved=await reserveOperation(ctx,`approval:${row.id}`,key,{});if(!reserved.created) return reserved.row.result??{id:reserved.row.id,status:reserved.row.status};
 const token=randomBytes(32).toString("base64url"),expiresAt=Math.min(row.payload.expiresAt,Math.floor(Date.now()/1000)+120);
 const result={url:`${authOrigin()}/approve#${token}`,expiresAt,swapId:row.id};
 await q(`WITH link AS (INSERT INTO approval_links(token_hash,swap_id,client_id,owner_address,expires_at,connection_token_hash) VALUES($1,$2,$3,$4,to_timestamp($5),$8) RETURNING token_hash)
  UPDATE api_operations SET result=$6::jsonb,status='ready' WHERE id=$7 AND EXISTS(SELECT 1 FROM link)`,[tokenHash(token),row.id,ctx.clientId,ctx.owner,expiresAt,JSON.stringify(result),reserved.row.id,tokenHash(ctx.token)]);
 return result;
}

/** A link is an object locator. A separate owner proof is required to use it. */
export async function resolveApprovalLink(linkToken:string,ownerSession:string|undefined,allowExpired=false) {
 const {authenticatedOwner}=await import("./auth.js");
 const owner=await authenticatedOwner(ownerSession);if(!owner) return fail(401,"WALLET_REQUIRED","Connect the wallet that owns this plan.");
 const rows=await q<{swap_id:string;client_id:string;owner_address:Hex}>(`SELECT l.swap_id,l.client_id,l.owner_address FROM approval_links l JOIN api_clients c ON c.id=l.client_id
  JOIN auth_sessions s ON s.token_hash=l.connection_token_hash
  WHERE l.token_hash=$1 AND (l.expires_at>now() OR $3) AND l.owner_address=$2 AND c.revoked_at IS NULL AND s.revoked_at IS NULL AND s.expires_at>now()`,[tokenHash(linkToken),owner,allowExpired]);
 const link=rows[0];if(!link)return fail(404,"NOT_FOUND","Approval link is unavailable or expired.");
 return {ctx:{clientId:link.client_id,owner,scopes:["swaps:prepare","swaps:read"],token:ownerSession!,requestId:randomUUID()} as RequestContext,swapId:link.swap_id};
}

/** Receipt work continues after disconnect; it never submits a wallet transaction. */
export async function walletSettlementTick() {
 const rows=await q<{id:string;client_id:string;owner_address:Hex}>("SELECT id,client_id,owner_address FROM swap_plans WHERE tx_hash IS NOT NULL AND (status IN ('submitted','confirming') OR (status='confirmed' AND updated_at>now()-interval '2 hours')) ORDER BY updated_at LIMIT 20");
 for(const row of rows) await getSwap({clientId:row.client_id,owner:row.owner_address,scopes:[],requestId:randomUUID(),token:""},row.id);
}
