import {spawn,type ChildProcess} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
import {beforeAll,afterAll,it,expect,vi} from 'vitest';
import {createPublicClient,createWalletClient,http,erc20Abi,type Hex,type Abi} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';
import {sepolia} from 'viem/chains';
const s=vi.hoisted(()=>({db:null as unknown as PGlite,client:null as unknown as ReturnType<typeof createPublicClient>,tokens:[] as Array<{symbol:string;address:Hex;decimals:number}>,router:'' as Hex,pool:'' as Hex}));
vi.mock('../src/db/index.js',async original=>({...await original<typeof import('../src/db/index.js')>(),q:async(t:string,p:unknown[]=[])=> (await s.db.query(t,p)).rows}));
vi.mock('../src/chain.js',()=>({publicClient:()=>s.client}));
vi.mock('@roque/shared',async original=>{const actual=await original<typeof import('@roque/shared')>();return {...actual,addresses:new Proxy(actual.addresses,{get:(target,prop)=>prop==='router'?s.router:Reflect.get(target,prop)}),tokenList:s.tokens,requireToken:(symbol:string)=>{const t=s.tokens.find(t=>t.symbol===symbol);if(!t)throw new Error('Unsupported token');return t;},tokenByAddress:(a:string)=>s.tokens.find(t=>t.address.toLowerCase()===a.toLowerCase()),poolAddressFor:()=>s.pool};});
vi.mock('../src/genlayer.js',()=>({interpret:async()=>({ok:true,kind:'swap',tokenIn:'rUSDC',tokenOut:'rWETH',amount:'10',amountIsPercent:false,triggerPrice:'',triggerAbove:false,confidence:'high',reason:'deterministic English fixture',error:''})}));
const {SCHEMA_SQL}=await import('../src/db/index.js');const {migration0002}=await import('../src/db/migrations/0002-public-api.js');
const api=await import('../src/public-api.js');const {tokenHash}=await import('../src/auth.js');const {RoqueClient,validatePlan}=await import('../../sdk/src/index.js');
let anvil:ChildProcess,app:Awaited<ReturnType<typeof import('../../../apps/relayer/src/server.js').createServer>>;
const admin=privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
const user=privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
let wallet:ReturnType<typeof createWalletClient>,sdk:InstanceType<typeof RoqueClient>;
const artifact=(name:string)=>JSON.parse(readFileSync(new URL(`../../../contracts/out/${name}.sol/${name}.json`,import.meta.url),'utf8')) as {abi:Abi;bytecode:{object:Hex}};
beforeAll(async()=>{
 const port=19500+Math.floor(Math.random()*1000),url=`http://127.0.0.1:${port}`;
 const bin=process.env.ANVIL_BIN??'anvil';
 anvil=spawn(bin,['--port',String(port),'--chain-id','11155111','--silent'],{stdio:'ignore'});
 s.client=createPublicClient({chain:sepolia,transport:http(url),cacheTime:0,pollingInterval:20});
 for(let n=0;n<50;n++){try{await s.client.getBlockNumber();break;}catch{if(n===49)throw new Error('Anvil did not start');await new Promise(r=>setTimeout(r,100));}}
 const deployer=createWalletClient({account:admin,chain:sepolia,transport:http(url)});wallet=createWalletClient({account:user,chain:sepolia,transport:http(url)});
 async function deploy(name:string,args:unknown[]=[]){const a=artifact(name),hash=await deployer.deployContract({abi:a.abi,bytecode:a.bytecode.object,args});const receipt=await s.client.waitForTransactionReceipt({hash});return receipt.contractAddress!;}
 async function write(address:Hex,abi:Abi,functionName:string,args:unknown[]){const hash=await deployer.writeContract({address,abi,functionName,args});expect((await s.client.waitForTransactionReceipt({hash})).status).toBe('success');}
 const token=artifact('TestToken'),pool=artifact('LiquidityPool'),router=artifact('DEXRouter');
 const input=await deploy('TestToken',['Roque USD','rUSDC',6,1000_000000n]),output=await deploy('TestToken',['Roque Ether','rWETH',18,10n**18n]);
 s.tokens.push({symbol:'rUSDC',address:input,decimals:6},{symbol:'rWETH',address:output,decimals:18});s.router=await deploy('DEXRouter');s.pool=await deploy('LiquidityPool',[input,output,30]);
 await write(input,token.abi,'mint',[admin.address,100000_000000n]);await write(output,token.abi,'mint',[admin.address,100n*10n**18n]);await write(input,token.abi,'mint',[user.address,1000_000000n]);
 await write(input,erc20Abi,'approve',[s.pool,100000_000000n]);await write(output,erc20Abi,'approve',[s.pool,100n*10n**18n]);
 const t0=await s.client.readContract({address:s.pool,abi:pool.abi,functionName:'token0'});
 await write(s.pool,pool.abi,'addLiquidity',[...(String(t0).toLowerCase()===input.toLowerCase()?[100000_000000n,100n*10n**18n]:[100n*10n**18n,100000_000000n]),admin.address]);
 await write(s.router,router.abi,'registerPool',[input,output,s.pool]);
 s.db=new PGlite();await s.db.exec(SCHEMA_SQL+'\n'+migration0002);await s.db.query('INSERT INTO api_clients(id,key_hash,name,scopes) VALUES($1,$2,$3,$4)',['partner',tokenHash('local-partner-key'),'Independent app',[...api.API_SCOPES]]);
 const {createServer}=await import('../../../apps/relayer/src/server.js');app=await createServer();
 sdk=new RoqueClient('http://localhost:3000',{apiKey:'local-partner-key',fetch:async(input,init)=>{const url=new URL(String(input));const response=await app.inject({method:(init?.method??'GET') as 'GET',url:url.pathname,headers:init?.headers as Record<string,string>,payload:init?.body as string});return new Response(response.body,{status:response.statusCode,headers:{'content-type':'application/json'}});}});
 await sdk.connect(user.address,message=>user.signMessage({message}));
},60000);
afterAll(async()=>{await app?.close();await s.db?.close();anvil?.kill();});
it('settles an independent app wallet through HTTP, SQL, SDK and real EVM receipts',async()=>{
 const intent=await sdk.createIntent('Swap 10 rUSDC for rWETH','evm-wallet-flow');await api.interpretationTick();expect((await sdk.intent(intent.id)).status).toBe('ready');
 const quote=await sdk.quote(intent.id,'evm-quote'),plan=await sdk.prepare(quote.quoteId,'evm-prepare');validatePlan(plan,user.address);
 const before=await s.client.readContract({address:s.tokens[1].address,abi:erc20Abi,functionName:'balanceOf',args:[user.address]});
 const hash=await sdk.executeReviewedPlan(plan,wallet,user.address);await s.client.waitForTransactionReceipt({hash});
 await (s.client as unknown as {request:(a:unknown)=>Promise<unknown>}).request({method:'anvil_mine',params:['0x3']});
 const settled=await sdk.swap(plan.swapId);expect(settled.status).toBe('confirmed');
 const after=await s.client.readContract({address:s.tokens[1].address,abi:erc20Abi,functionName:'balanceOf',args:[user.address]});
 expect(after-before).toBe(BigInt(settled.settlement!.amountOutRaw));expect(after-before).toBeGreaterThanOrEqual(BigInt(plan.minAmountOutRaw));
 expect((await s.client.readContract({address:s.tokens[0].address,abi:erc20Abi,functionName:'balanceOf',args:[user.address]}))).toBe(990_000000n);
 expect((await s.db.query('SELECT * FROM swap_plans WHERE tx_hash=$1',[hash])).rows).toHaveLength(1);
},30000);
