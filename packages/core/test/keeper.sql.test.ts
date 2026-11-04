import {PGlite} from '@electric-sql/pglite';
import {beforeAll,afterAll,it,expect,vi} from 'vitest';
const s=vi.hoisted(()=>({db:null as unknown as PGlite,read:vi.fn(),send:vi.fn(),receipt:vi.fn()}));
vi.mock('../src/db/index.js',async original=>({...await original<typeof import('../src/db/index.js')>(),q:async(t:string,p:unknown[]=[])=> (await s.db.query(t,p)).rows}));
vi.mock('../src/chain.js',()=>({publicClient:()=>({readContract:s.read,getTransactionReceipt:s.receipt}),sendRelayerTx:s.send}));
const {SCHEMA_SQL}=await import('../src/db/index.js');const {migration0002}=await import('../src/db/migrations/0002-public-api.js');const {keeperTick}=await import('../src/keeper.js');
beforeAll(async()=>{s.db=new PGlite();await s.db.exec(SCHEMA_SQL+'\n'+migration0002);s.read.mockImplementation(async(p)=>p.functionName==='nextOrderId'?10001n:p.functionName==='getOrder'?{status:1}:true);s.send.mockResolvedValue(`0x${'12'.repeat(32)}`);s.receipt.mockRejectedValue(new Error('pending'));},30000);
afterAll(()=>s.db.close());
it('bounds each scan, persists the next cursor and never calls a broadcast a fill',async()=>{
 const first=await keeperTick();expect(first.scanned).toBe(50);expect(first.submitted).toHaveLength(50);expect(first.filled).toHaveLength(0);
 const second=await keeperTick();expect(second.submitted[0].id).toBe('51');expect(second.scanned).toBe(50);
 expect(s.send.mock.calls[0][0].operationId).toContain(':order:1');
});
