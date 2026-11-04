import {PGlite} from "@electric-sql/pglite";
import {beforeAll,afterAll,beforeEach,it,expect,vi} from "vitest";
import {privateKeyToAccount} from "viem/accounts";
import {keccak256,parseTransaction} from "viem";
const s=vi.hoisted(()=>({db:null as unknown as PGlite,sendRaw:vi.fn(),prepare:vi.fn(),getCount:vi.fn(),receipt:vi.fn(),block:vi.fn(),height:vi.fn()}));
vi.mock("../src/db/index.js",async orig=>({...await orig<typeof import("../src/db/index.js")>(),q:async(t:string,p:unknown[]=[])=> (await s.db.query(t,p)).rows}));
const account=privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
vi.mock("../src/chain.js",()=>({relayerWallet:()=>({account,chain:{id:11155111},prepareTransactionRequest:s.prepare,signTransaction:account.signTransaction,sendRawTransaction:s.sendRaw}),publicClient:()=>({getTransactionCount:s.getCount,getTransactionReceipt:s.receipt,getBlock:s.block,getBlockNumber:s.height})}));
const {migration0002}=await import("../src/db/migrations/0002-public-api.js");
const {SCHEMA_SQL}=await import("../src/db/index.js");
const {durableSend,reconcileRelayerAttempts}=await import("../src/sender.js");
const to="0x2222222222222222222222222222222222222222" as const,data="0xdeadbeef" as const;
beforeAll(async()=>{s.db=new PGlite();await s.db.exec(SCHEMA_SQL+"\n"+migration0002);},30000);
afterAll(()=>s.db.close());
beforeEach(async()=>{
 await s.db.exec("TRUNCATE execution_attempts,worker_leases,relayer_senders");vi.clearAllMocks();s.getCount.mockResolvedValue(7);
 s.prepare.mockImplementation(async(p)=>({...p,account:undefined,chain:undefined,chainId:11155111,type:"eip1559",gas:100000n,maxFeePerGas:10n,maxPriorityFeePerGas:1n}));
 s.sendRaw.mockImplementation(async({serializedTransaction})=>keccak256(serializedTransaction));
});
it("persists signed bytes and allocates consecutive nonces across restarted senders",async()=>{
 await durableSend({to,data,operationId:"one"});await durableSend({to,data,operationId:"two"});
 const rows=(await s.db.query<{raw_tx:`0x${string}`;nonce:number}>("SELECT raw_tx,nonce FROM execution_attempts ORDER BY nonce")).rows;
 expect(rows.map(r=>parseTransaction(r.raw_tx).nonce)).toEqual([7,8]);expect(s.sendRaw).toHaveBeenCalledTimes(2);
});
it("retains lost responses and retries identical bytes without another business action",async()=>{
 s.sendRaw.mockRejectedValueOnce(new Error("response lost"));const hash=await durableSend({to,data,operationId:"lost"});
 const row=(await s.db.query<{status:string;raw_tx:string}>("SELECT status,raw_tx FROM execution_attempts WHERE id='lost'")).rows[0];expect(row.status).toBe("submission_unknown");
 expect(await durableSend({to,data,operationId:"lost"})).toBe(hash);expect(s.prepare).toHaveBeenCalledTimes(1);
 s.receipt.mockRejectedValue(new Error("not found"));await reconcileRelayerAttempts();
 expect(s.sendRaw.mock.calls[1][0].serializedTransaction).toBe(row.raw_tx);
});
it("fences overlapping processes and frees unsigned reservations after preparation failure",async()=>{
 s.prepare.mockRejectedValueOnce(new Error("prepare interrupted"));
 await expect(durableSend({to,data,operationId:"first"})).rejects.toThrow("interrupted");
 await durableSend({to,data,operationId:"second"});
 expect(s.sendRaw.mock.calls.map(c=>parseTransaction(c[0].serializedTransaction).nonce)).toEqual([7]);
 expect((await s.db.query("SELECT * FROM execution_attempts WHERE id='first'")).rows).toHaveLength(0);
 const overlapping=await Promise.allSettled([durableSend({to,data,operationId:"third"}),durableSend({to,data,operationId:"fourth"})]);
 expect(overlapping.filter(r=>r.status==="fulfilled")).toHaveLength(1);
 expect((await s.db.query("SELECT nonce FROM execution_attempts GROUP BY nonce HAVING count(*)>1")).rows).toHaveLength(0);
});

it("resumes an unsigned reservation after a crash before allocating beyond it",async()=>{
 await s.db.query("INSERT INTO relayer_senders(chain_id,sender,next_nonce) VALUES($1,$2,8)",[11155111,account.address.toLowerCase()]);
 await s.db.query("INSERT INTO execution_attempts(id,chain_id,sender,nonce,target,calldata) VALUES('crash',11155111,$1,7,$2,$3)",[account.address.toLowerCase(),to,data]);
 await durableSend({to,data,operationId:'following'});
 expect(s.sendRaw.mock.calls.map(c=>parseTransaction(c[0].serializedTransaction).nonce)).toEqual([7,8]);
});
