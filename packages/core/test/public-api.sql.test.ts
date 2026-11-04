import {PGlite} from "@electric-sql/pglite";
import {beforeAll,afterAll,it,expect,vi} from "vitest";
import {privateKeyToAccount} from "viem/accounts";
import {tokenList,deployedChainId} from "@roque/shared";
const s=vi.hoisted(()=>({db:null as unknown as PGlite,readContract:vi.fn(),getBlock:vi.fn(),getBlockNumber:vi.fn(),interpret:vi.fn(),approvalFence:null as "expired"|"superseded"|null}));
vi.mock("../src/db/index.js",async original=>{
 const actual=await original<typeof import("../src/db/index.js")>();
 return {...actual,q:async(text:string,params:unknown[]=[])=> {
  if(s.approvalFence&&text.includes("WITH link AS"))await s.db.query(s.approvalFence==="expired"
   ?"UPDATE api_operations SET lease_until=now() WHERE operation LIKE 'approval:%'"
   :"UPDATE api_operations SET lease_owner='11111111-1111-4111-8111-111111111111',generation=generation+1 WHERE operation LIKE 'approval:%'");
  return (await s.db.query(text,params)).rows;
 }};
});
vi.mock("../src/chain.js",()=>({publicClient:()=>s}));
vi.mock("../src/genlayer.js",()=>({interpret:s.interpret}));
const {SCHEMA_SQL}=await import("../src/db/index.js");
const {migration0002}=await import("../src/db/migrations/0002-public-api.js");
const api=await import("../src/public-api.js");
const {tokenHash}=await import("../src/auth.js");
const wallet=privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
let a:api.RequestContext,b:api.RequestContext;
beforeAll(async()=>{
 s.db=new PGlite();await s.db.exec(SCHEMA_SQL+"\n"+migration0002);
 for(const id of ["a","b"]) await s.db.query("INSERT INTO api_clients(id,key_hash,name,scopes) VALUES($1,$2,$1,$3)",[id,tokenHash(`test-key-${id}`),[...api.API_SCOPES]]);
 for(const id of ["a","b"]){
  const challenge=await api.createApiChallenge(`test-key-${id}`,{owner:wallet.address,chainId:deployedChainId});
  const signature=await wallet.signMessage({message:challenge.message});
  const session=await api.createApiSession(`test-key-${id}`,{owner:wallet.address,challengeId:challenge.challengeId,signature});
  const ctx=await api.apiContext(`test-key-${id}`,session.token,"intents:write");if(id==="a")a=ctx;else b=ctx;
  await expect(api.createApiSession(`test-key-${id}`,{owner:wallet.address,challengeId:challenge.challengeId,signature})).rejects.toMatchObject({code:"INVALID_PROOF"});
 }
 s.interpret.mockResolvedValue({ok:true,kind:"swap",tokenIn:"rUSDC",tokenOut:"rWETH",amount:"1",amountIsPercent:false,triggerPrice:"",triggerAbove:false,confidence:"high",reason:"test",error:""});
 s.getBlock.mockResolvedValue({number:100n,hash:`0x${"12".repeat(32)}`});
 s.readContract.mockImplementation(async({functionName}:{functionName:string})=>{
  if(functionName==="quoteSwap")return 1000000000000000n;
  if(functionName==="getReserves")return [1000000000000n,1000000000000000000000n];
  if(functionName==="token0")return tokenList.find(t=>t.symbol==="rUSDC")!.address;
  if(functionName==="feeBps")return 30n;
  throw new Error("Unexpected chain read");
 });
},30000);
afterAll(async()=>s.db.close());
it("isolates applications for the same wallet and enforces one-time domain-bound proof",async()=>{
 const created=await api.createIntent(a,{chainId:deployedChainId,command:"swap 1 USDC for ETH",executionMode:"wallet"},"tenant-test");
 await expect(api.getIntent(b,created.id)).rejects.toMatchObject({code:"NOT_FOUND"});
 await expect(api.apiContext("test-key-b",a.token,"intents:write")).rejects.toMatchObject({code:"CLIENT_MISMATCH"});
});
it("replays identical operations, rejects different payloads and supports durable interpretation",async()=>{
 const input={chainId:deployedChainId,command:"swap 1 USDC for ETH",executionMode:"wallet"};
 const first=await api.createIntent(a,input,"stable-idempotency");
 const second=await api.createIntent(a,input,"stable-idempotency");expect(second.id).toBe(first.id);
 await expect(api.createIntent(a,{...input,command:"swap 2 USDC for ETH"},"stable-idempotency")).rejects.toMatchObject({code:"IDEMPOTENCY_CONFLICT"});
 await api.interpretationTick();await api.interpretationTick();
 expect((await api.getIntent(a,first.id)).status).toBe("ready");
 const quote=await api.createQuote(a,{intentId:first.id},"quote-one") as {quoteId:string};
 const plan=await api.prepareSwap(a,{quoteId:quote.quoteId},"prepare-one") as import("@roque/shared").SwapPlan;
 expect(plan.recipient).toBe(wallet.address.toLowerCase());expect(plan.steps).toHaveLength(2);
 const replay=await api.prepareSwap(a,{quoteId:quote.quoteId},"prepare-one") as typeof plan;expect(replay.planHash).toBe(plan.planHash);
 await expect(api.getSwap(b,plan.swapId)).rejects.toMatchObject({code:"NOT_FOUND"});
 await expect(api.prepareSwap(a,{quoteId:quote.quoteId,recipient:tokenList[0].address},"recipient-change")).rejects.toMatchObject({code:"INVALID_REQUEST"});
});
it("requires wallet ownership even when an application key is valid",async()=>{
 await expect(api.apiContext("test-key-a",undefined,"swaps:prepare")).rejects.toMatchObject({code:"WALLET_REQUIRED"});
 await api.disconnect(b);await expect(api.apiContext("test-key-b",b.token,"swaps:prepare")).rejects.toMatchObject({code:"SESSION_EXPIRED"});
});
it("fences expired interpretation failures and retries at the exact expiry timestamp",async()=>{
 const input={chainId:deployedChainId,command:"swap 1 USDC for ETH",executionMode:"wallet"};
 const intent=await api.createIntent(a,input,"expired-interpretation");
 await s.db.exec("BEGIN");
 try {
  s.interpret.mockImplementationOnce(async()=>{
   await s.db.query("UPDATE api_operations SET lease_until=now() WHERE id=$1",[intent.id]);
   throw new Error("Late provider failure");
  });
  await api.interpretationTick();
  expect((await api.getIntent(a,intent.id)).status).toBe("interpreting");
  const {rows:[old]}=await s.db.query<{generation:string;attempts:number}>("SELECT generation,attempts FROM api_operations WHERE id=$1",[intent.id]);
  await api.interpretationTick();
  expect((await api.getIntent(a,intent.id)).status).toBe("ready");
  const {rows:[retried]}=await s.db.query<{generation:string;attempts:number}>("SELECT generation,attempts FROM api_operations WHERE id=$1",[intent.id]);
  expect(BigInt(retried.generation)).toBe(BigInt(old.generation)+1n);expect(retried.attempts).toBe(old.attempts+1);
 }finally{await s.db.exec("ROLLBACK");}
});
it("terminates exhausted interpretation jobs at the exact expiry timestamp",async()=>{
 const intent=await api.createIntent(a,{chainId:deployedChainId,command:"swap 1 USDC for ETH",executionMode:"wallet"},"exhausted-interpretation");
 await s.db.exec("BEGIN");
 try{
  await s.db.query("UPDATE api_operations SET status='interpreting',attempts=3,lease_until=now() WHERE id=$1",[intent.id]);
  await api.interpretationTick();
  expect(await api.getIntent(a,intent.id)).toMatchObject({status:"failed",error:"INTERPRETATION_EXHAUSTED"});
 }finally{await s.db.exec("ROLLBACK");}
});
it.each(["expired","superseded"] as const)("fences %s approval-link operations and replays one recovered link",async(fence)=>{
 // Earlier tests leave queued jobs after rolling back; finish them first.
 await api.interpretationTick();await api.interpretationTick();
 const {rows:[intent]}=await s.db.query<{id:string}>("SELECT id FROM api_operations WHERE operation='intent' AND status='ready' LIMIT 1");
 const quote=await api.createQuote(a,{intentId:intent.id},`approval-fence-quote:${fence}`) as {quoteId:string};
 const plan=await api.prepareSwap(a,{quoteId:quote.quoteId},`approval-fence-plan:${fence}`) as import("@roque/shared").SwapPlan;
 await s.db.exec("BEGIN");
 try{
  s.approvalFence=fence;
  await expect(api.approvalLink(a,plan.swapId,"approval-fence-link")).rejects.toMatchObject({code:"OPERATION_PENDING"});
  expect((await s.db.query("SELECT * FROM approval_links WHERE swap_id=$1",[plan.swapId])).rows).toHaveLength(0);
  s.approvalFence=null;
  await s.db.query("UPDATE api_operations SET lease_until=now() WHERE operation=$1",[`approval:${plan.swapId}`]);
  const link=await api.approvalLink(a,plan.swapId,"approval-fence-link");
  expect(await api.approvalLink(a,plan.swapId,"approval-fence-link")).toEqual(link);
  expect((await s.db.query("SELECT * FROM approval_links WHERE swap_id=$1",[plan.swapId])).rows).toHaveLength(1);
 }finally{s.approvalFence=null;await s.db.exec("ROLLBACK");}
});
