import {PGlite} from "@electric-sql/pglite";
import {beforeAll,beforeEach,afterAll,it,expect,vi} from "vitest";
const s=vi.hoisted(()=>({db:null as unknown as PGlite,getBlockNumber:vi.fn(),getContractEvents:vi.fn(),getBlock:vi.fn()}));
vi.mock("../src/db/index.js",async orig=>({...await orig<typeof import("../src/db/index.js")>(),q:async(t:string,p:unknown[]=[])=> (await s.db.query(t,p)).rows}));
vi.mock("../src/chain.js",()=>({publicClient:()=>s}));
const {SCHEMA_SQL}=await import("../src/db/index.js");const {migration0002}=await import("../src/db/migrations/0002-public-api.js");
const {indexOnce,DEPLOY_BLOCK}=await import("../src/indexer.js");
const {acquireLease,releaseLease}=await import("../src/leases.js");
beforeAll(async()=>{s.db=new PGlite();await s.db.exec(SCHEMA_SQL+"\n"+migration0002);},30000);afterAll(()=>s.db.close());
beforeEach(async()=>{await s.db.exec("TRUNCATE indexer_state,indexer_blocks,worker_leases,trades");vi.clearAllMocks();s.getBlockNumber.mockResolvedValue(DEPLOY_BLOCK+5000n);s.getContractEvents.mockResolvedValue([]);s.getBlock.mockResolvedValue({hash:"canonical",timestamp:1n});});
it("commits a checkpoint only after a successful scan",async()=>{
 s.getContractEvents.mockRejectedValueOnce(new Error("RPC failed"));await expect(indexOnce()).rejects.toThrow("RPC failed");
 expect((await s.db.query("SELECT * FROM indexer_state")).rows).toHaveLength(0);
 const res=await indexOnce();expect((await s.db.query<{value:string}>("SELECT value FROM indexer_state")).rows[0].value).toBe(res.toBlock.toString());
});
it("leases a range once across workers and recovers expired leases",async()=>{
 const results=await Promise.all([indexOnce(),indexOnce(),indexOnce()]);expect(s.getContractEvents).toHaveBeenCalledTimes(5);
 expect(results.filter(r=>r.toBlock>=r.fromBlock)).toHaveLength(1);
 await s.db.exec("UPDATE worker_leases SET expires_at=now()-interval '1 minute'");await indexOnce();expect(s.getContractEvents).toHaveBeenCalledTimes(10);
});
it("rewinds an orphaned checkpoint for replay",async()=>{
 const first=await indexOnce();s.getBlock.mockResolvedValue({hash:"reorganized",timestamp:1n});const next=await indexOnce();
 expect(next.toBlock).toBeLessThan(first.toBlock);expect(next.rows).toBe(0);
 await indexOnce();expect(s.getContractEvents).toHaveBeenCalledTimes(10);
});
it("reacquires a released lease at the same timestamp and fences its previous owner",async()=>{
 const oldLease=await acquireLease("boundary");expect(oldLease).not.toBeNull();
 await s.db.exec("BEGIN");
 try {
  await releaseLease(oldLease!);
  const {rows:[released]}=await s.db.query<{expired:boolean}>("SELECT expires_at=now() AS expired FROM worker_leases WHERE key='boundary'");
  expect(released.expired).toBe(true);
  const newLease=await acquireLease("boundary");expect(newLease).not.toBeNull();
  expect(newLease!.owner).not.toBe(oldLease!.owner);
  expect(BigInt(newLease!.generation)).toBe(BigInt(oldLease!.generation)+1n);
  await releaseLease(oldLease!);
  expect((await s.db.query<{owner:string,active:boolean}>("SELECT owner,expires_at>now() AS active FROM worker_leases WHERE key='boundary'")).rows[0]).toEqual({owner:newLease!.owner,active:true});
  expect(await acquireLease("boundary")).toBeNull();
 } finally {await s.db.exec("ROLLBACK");}
});
