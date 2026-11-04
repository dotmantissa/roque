/** Authorized testnet release operations. Credentials and signed transaction journals stay outside Git. */
import {readFile,writeFile,rename,stat,mkdir} from 'node:fs/promises';
import {homedir} from 'node:os';
import {resolve,join} from 'node:path';
import {parseEnv} from 'node:util';
import {createHash} from 'node:crypto';
import {createPublicClient,createWalletClient,http,encodeDeployData,encodeFunctionData,keccak256,parseEther,type Abi,type Hex} from 'viem';
import {privateKeyToAccount,generatePrivateKey} from 'viem/accounts';
import {sepolia} from 'viem/chains';
import {createClient,createAccount} from 'genlayer-js';
import {studionet} from 'genlayer-js/chains';
import {assertFinalizedConsensus,ConsensusExecutionError} from "../src/consensus.js";
import {TransactionStatus} from 'genlayer-js/types';
const root=resolve(import.meta.dirname,'../../..'),config=join(homedir(),'.config/roque-deployment');
const statePath=join(config,'release-state.json'),generatedPath=join(config,'generated.production.env');
await mkdir(config,{recursive:true,mode:0o700});
const load=async(path:string)=>{const mode=(await stat(path)).mode&0o777;if(mode&0o077)throw new Error('Private file permissions must be 0600.');Object.assign(process.env,parseEnv(await readFile(path,'utf8')));};
await load(join(config,'vercel.production.env'));
async function atomic(path:string,value:string){await writeFile(path+'.tmp',value,{mode:0o600});await rename(path+'.tmp',path);}
const mode=process.argv[2]??'preflight';
if(mode==='prepare'){
 let current:Record<string,string>={};try{current=Object.fromEntries(Object.entries(parseEnv(await readFile(generatedPath,'utf8'))).filter((entry):entry is [string,string]=>entry[1]!==undefined));}catch{}
 current.RELAYER_PRIVATE_KEY??=generatePrivateKey();current.GENLAYER_CALLER_PRIVATE_KEY??=generatePrivateKey();
 current.AUTH_ORIGIN='https://roque-dex.vercel.app';current.API_ALLOWED_ORIGINS='https://roque-dex.vercel.app';
 current.MCP_RESOURCE_URL='https://roque-dex.vercel.app/mcp';current.OAUTH_ALLOWED_REDIRECTS='https://claude.ai/api/mcp/auth_callback';current.LATCH_REQUIRED='true';
 if(!process.env.CRON_SECRET||process.env.CRON_SECRET.length<32||process.env.CRON_SECRET==='roque-local-cron')current.CRON_SECRET??=generatePrivateKey().slice(2);
 await atomic(generatedPath,Object.entries(current).map(([k,v])=>`${k}=${JSON.stringify(v)}`).join('\n')+'\n');
 console.log('Prepared private production configuration.');process.exit(0);
}
await load(generatedPath);
const deployer=privateKeyToAccount((await readFile(join(config,'deployer.key'),'utf8')).trim() as Hex);
const relayer=privateKeyToAccount(process.env.RELAYER_PRIVATE_KEY as Hex);
const rpc=process.env.SEPOLIA_RPC_URL!;
const client=createPublicClient({chain:sepolia,transport:http(rpc),cacheTime:0});
const wallet=createWalletClient({account:deployer,chain:sepolia,transport:http(rpc)});
const registryPath=join(root,'contracts/deployments/sepolia.json'),sharedPath=join(root,'packages/shared/src/deployment.json');
const registry=JSON.parse(await readFile(registryPath,'utf8'));
type Journal={operations:Record<string,{hash:Hex;raw:Hex;receipt?:{address?:Hex;blockNumber:string}}>;executor?:Hex;genlayerHash?:Hex;interpreter?:Hex;failedGenlayerDeployments?:Hex[];supersededGenlayerDeployments?:Array<{hash:Hex;interpreter?:Hex}>;lastError?:string};
let journal:Journal={operations:{}};try{journal=JSON.parse(await readFile(statePath,'utf8'));}catch{}
const save=()=>atomic(statePath,JSON.stringify(journal,null,2)+'\n');
const artifact=JSON.parse(await readFile(join(root,'contracts/out/AgentExecutor.sol/AgentExecutor.json'),'utf8'));
const abi=artifact.abi as Abi;
async function send(label:string,params:{to?:Hex;data:Hex;value?:bigint}){
 let op=journal.operations[label];
 if(!op){
  const request=await wallet.prepareTransactionRequest({account:deployer,chain:sepolia,...params,nonce:await client.getTransactionCount({address:deployer.address,blockTag:'pending'})});
  const raw=await wallet.signTransaction(request),hash=keccak256(raw);op={hash,raw};journal.operations[label]=op;await save();
 }
 if(!op.receipt){try{await wallet.sendRawTransaction({serializedTransaction:op.raw});}catch{/* Poll the recorded hash; never re-sign an unknown deployment. */}
  const receipt=await client.waitForTransactionReceipt({hash:op.hash,confirmations:3,timeout:180000});
  if(receipt.status!=='success')throw new Error('A recorded release transaction reverted.');
  op.receipt={address:receipt.contractAddress??undefined,blockNumber:receipt.blockNumber.toString()};await save();
 }
 console.log(`${label}: ${op.hash}`);return op.receipt;
}
async function verifyExecutor(address:Hex){
 const code=await client.getCode({address});if(!code)throw new Error('Executor code is absent.');
 let masked=code.slice(2);let expected=artifact.deployedBytecode.object.replace(/^0x/,'');
 for(const refs of Object.values(artifact.deployedBytecode.immutableReferences??{}) as Array<Array<{start:number;length:number}>>){for(const ref of refs){const start=ref.start*2,length=ref.length*2;masked=masked.slice(0,start)+'0'.repeat(length)+masked.slice(start+length);expected=expected.slice(0,start)+'0'.repeat(length)+expected.slice(start+length);}}
 if(masked!==expected)throw new Error('Deployed executor does not match the compiled artifact.');
 for(const [method,expected] of [['router',registry.router],['orderBook',registry.orderBook],['owner',deployer.address]]){
  const actual=await client.readContract({address,abi,functionName:method});if(String(actual).toLowerCase()!==expected.toLowerCase())throw new Error('Executor deployment dependencies differ.');
 }
 console.log(`Verified executor bytecode and dependencies: ${address}`);
}
async function main(){
 if(await client.getChainId()!==11155111||deployer.address.toLowerCase()!==registry.deployer.toLowerCase())throw new Error('Wrong release chain or deployer.');
 if(relayer.address.toLowerCase()===deployer.address.toLowerCase())throw new Error('Relayer must be distinct from deployer.');
 if(mode==='preflight'){
  console.log(`Sepolia deployer: ${deployer.address}; relayer: ${relayer.address}`);
  console.log(`Deployer gas balance: ${await client.getBalance({address:deployer.address})} wei`);
  const latch=createPublicClient({chain:sepolia,transport:http(process.env.LATCH_RPC_URL!,{fetchOptions:{headers:{Authorization:`Bearer ${process.env.LATCH_TOKEN}`}}})});
  if(await latch.getChainId()!==11155111)throw new Error('Latch transport points to another chain.');
  console.log('Configured Latch chain read verified.');return;
 }
 if(mode==='genlayer'){
  const gl=createClient({chain:studionet,account:createAccount(process.env.GENLAYER_CALLER_PRIVATE_KEY as Hex)});
  const source=await readFile(join(root,'packages/genlayer/contracts/roque_interpreter.py'),'utf8');
  if(!journal.genlayerHash){journal.genlayerHash=await gl.deployContract({code:new TextEncoder().encode(source),args:[]});await save();console.log(`Interpreter deployment submitted: ${journal.genlayerHash}`);}
  const receipt=await gl.waitForTransactionReceipt({hash:journal.genlayerHash as Parameters<typeof gl.waitForTransactionReceipt>[0]["hash"],status:TransactionStatus.FINALIZED,retries:100,interval:3000});
  const full=await gl.getTransaction({hash:journal.genlayerHash as Parameters<typeof gl.getTransaction>[0]["hash"]});
  try{assertFinalizedConsensus(full);}catch(err){
   if(err instanceof ConsensusExecutionError && typeof full.data?.contract_code==='string' && Buffer.from(full.data.contract_code,'base64').toString('utf8')!==source){
    journal.failedGenlayerDeployments=[...(journal.failedGenlayerDeployments??[]),journal.genlayerHash!];delete journal.genlayerHash;await save();return main();
   }
   throw err;
  }
  if(typeof full.data?.contract_code==='string' && Buffer.from(full.data.contract_code,'base64').toString('utf8')!==source){
   journal.supersededGenlayerDeployments=[...(journal.supersededGenlayerDeployments??[]),{hash:journal.genlayerHash!,interpreter:journal.interpreter}];
   delete journal.genlayerHash;delete journal.interpreter;await save();return main();
  }
  const data=full.data??{};
  const address=(data.contract_address??data.contractAddress??data.new_contract_address??full.to_address??full.recipient) as Hex;
  if(!/^0x[a-fA-F0-9]{40}$/u.test(address??'')||/^0x0{40}$/u.test(address)||address.toLowerCase()===gl.account!.address.toLowerCase())throw new Error('Deployment receipt lacks an explicit contract address.');
  if(await gl.getContractCode(address)!==source)throw new Error('Deployed interpreter source differs.');
  await gl.getContractSchema(address);
  if(await gl.readContract({address,functionName:"get_interpretation",args:["deployment-probe"]})!=="{}")throw new Error("Interpreter initialized-state probe failed.");
  journal.interpreter=address;await save();
  await atomic(join(root,'packages/genlayer/deployment.json'),JSON.stringify({network:'Genlayer Studio Network',address,deployer:gl.account!.address,transactionHash:journal.genlayerHash,sourceSha256:createHash('sha256').update(source).digest('hex'),finality:'FINALIZED',sourceVerified:true},null,2)+'\n');
  console.log(`Verified finalized interpreter source and schema: ${address}`);return;
 }
 if(mode==='stage'){
  if(await client.getBalance({address:relayer.address})<parseEther('0.002'))await send('fund-dedicated-relayer',{to:relayer.address,data:'0x',value:parseEther('0.015')});
  if(!journal.executor){const receipt=await send('deploy-executor-v2',{data:encodeDeployData({abi,bytecode:artifact.bytecode.object,args:[registry.router,registry.orderBook]})});journal.executor=receipt!.address;await save();}
  const address=journal.executor!;await verifyExecutor(address);
  for(let i=0;i<registry.tokenAddresses.length;i++)await send(`register-${registry.tokenSymbols[i]}`,{to:address,data:encodeFunctionData({abi,functionName:'registerToken',args:[registry.tokenAddresses[i],registry.tokenDecimals[i],registry.tokenIsStable[i],registry.tokenFeeds[i]]})});
  // New metadata stages the next app build. Shared OrderBook authority changes only in cutover mode.
  if(registry.agentExecutor.toLowerCase()!==address.toLowerCase()){
   const previous=registry.agentExecutor;registry.legacyExecutors=[...(registry.legacyExecutors??[]),{address:previous,domainVersion:registry.executorDomainVersion??'1',deploymentBlock:registry.executorDeploymentBlock??null}];registry.previousAgentExecutor=previous;
  }
  registry.agentExecutor=address;registry.executorDomainVersion='2';registry.executorDeploymentBlock=journal.operations['deploy-executor-v2'].receipt!.blockNumber;registry.executorDeploymentTransaction=journal.operations['deploy-executor-v2'].hash;registry.executorRuntimeCodeHash=keccak256((await client.getCode({address}))!);
  await atomic(registryPath,JSON.stringify(registry,null,2)+'\n');await atomic(sharedPath,JSON.stringify(registry,null,2)+'\n');console.log(`Staged executor: ${address}`);return;
 }
 if(mode==='cutover'){
  if(!journal.executor)throw new Error('Stage and verify the executor first.');await verifyExecutor(journal.executor);
  const bookAbi=JSON.parse(await readFile(join(root,'contracts/out/OrderBook.sol/OrderBook.json'),'utf8')).abi as Abi;
  const maxAge=await client.readContract({address:registry.orderBook,abi:bookAbi,functionName:'maxPriceStaleness'}) as bigint;
  if(maxAge===0n||maxAge>86400n)throw new Error('Live OrderBook freshness is disabled or unsupported.');
  await client.readContract({address:registry.orderBook,abi:bookAbi,functionName:'currentPrice'});
  await send('orderbook-executor-cutover',{to:registry.orderBook,data:encodeFunctionData({abi:bookAbi,functionName:'setAgentExecutor',args:[journal.executor]})});
  console.log('OrderBook cutover confirmed. Previous owner exits remain callable.');return;
 }
 throw new Error('Expected prepare, preflight, genlayer, stage or cutover.');
}
await main().catch(async err=>{journal.lastError=String(err);await save();console.error('Release stopped; inspect the private journal and resume the same operation.');process.exitCode=1;});
