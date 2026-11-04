import {afterEach,it,expect,vi} from 'vitest';
const env=vi.hoisted(()=>({relayerKey:('0x'+'22'.repeat(32)) as `0x${string}`,latchRpcUrl:'https://latch.example/rpc',latchToken:'test-scoped-token',sepoliaRpcUrl:'https://direct.example/rpc'}));
vi.mock('../src/env.js',()=>({publicEnv:{sepoliaRpcUrl:env.sepoliaRpcUrl},serverEnv:()=>env}));
afterEach(()=>{vi.unstubAllGlobals();vi.resetModules();});
for(const failure of ['policy denial','outage'])it(`keeps all relayer attempts on Latch during ${failure}`,async()=>{
 const calls:Array<{url:string;authorization:string|null}>=[];
 vi.stubGlobal('fetch',async(input:RequestInfo|URL,init?:RequestInit)=>{
  calls.push({url:String(input),authorization:new Headers(init?.headers).get('authorization')});
  if(failure==='outage')throw new TypeError('fetch failed');
  return new Response(JSON.stringify({error:'policy denied'}),{status:403,headers:{'content-type':'application/json'}});
 });
 const {relayerWallet}=await import('../src/chain.js');
 await expect(relayerWallet().request({method:'eth_sendRawTransaction',params:['0xdead']})).rejects.toThrow();
 expect(calls.length).toBeGreaterThan(0);
 expect(calls.every(c=>c.url===env.latchRpcUrl&&c.authorization===`Bearer ${env.latchToken}`)).toBe(true);
},10000);
