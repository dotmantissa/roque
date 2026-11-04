import {createPublicClient,custom,decodeFunctionData,erc20Abi,keccak256,stringToHex,type Hex,type WalletClient} from "viem";
import {parseSiweMessage} from "viem/siwe";
import {addresses,deployedChainId,tokenByAddress,type SwapPlan} from "@roque/shared";
const routerAbi=[{type:"function",name:"swapExactTokensForTokens",stateMutability:"nonpayable",inputs:[{name:"tokenIn",type:"address"},{name:"tokenOut",type:"address"},{name:"amountIn",type:"uint256"},{name:"minAmountOut",type:"uint256"},{name:"to",type:"address"},{name:"deadline",type:"uint256"}],outputs:[{name:"amountOut",type:"uint256"}]}] as const;
function canonical(value:unknown):string {
 if(Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
 if(value!==null&&typeof value==="object") return `{${Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
 return JSON.stringify(value);
}
export function validatePlan(plan:SwapPlan,account:Hex):void {
 const {planHash,...unhashed}=plan;
 if(keccak256(stringToHex(canonical(unhashed)))!==planHash) throw new Error("Plan integrity check failed.");
 const same=(a:string,b:string)=>a.toLowerCase()===b.toLowerCase();
 if(plan.chainId!==deployedChainId||!same(plan.router,addresses.router)||!same(plan.executionAccount,account)||!same(plan.recipient,account)) throw new Error("Wrong chain, wallet or deployment.");
 const input=tokenByAddress(plan.tokenIn),output=tokenByAddress(plan.tokenOut);
 if(!input||!output||input.symbol!==plan.tokenInSymbol||output.symbol!==plan.tokenOutSymbol||input.decimals!==plan.tokenInDecimals||output.decimals!==plan.tokenOutDecimals||same(input.address,output.address)) throw new Error("Unsupported or mismatched tokens.");
 if(plan.expiresAt<=Date.now()/1000||plan.deadline!==plan.expiresAt||plan.expiresAt>Date.now()/1000+180) throw new Error("Plan expired or has an invalid deadline.");
 for(const amount of [plan.amountInRaw,plan.quotedAmountOutRaw,plan.minAmountOutRaw]) if(!/^[1-9]\d{0,77}$/u.test(amount)||BigInt(amount)>=2n**256n) throw new Error("Invalid plan amount.");
 if(plan.deploymentVersion!=="sepolia-router-v1"||!/^0x[a-fA-F0-9]{64}$/u.test(plan.quoteBlockHash)||!/^\d{1,20}$/u.test(plan.quoteBlockNumber)||![plan.expiresAt,plan.deadline,plan.feeBps,plan.priceImpactBps].every(Number.isSafeInteger)||plan.feeBps<0||plan.feeBps>1000) throw new Error("Invalid deployment or quote metadata.");
 if(BigInt(plan.minAmountOutRaw)*10000n<BigInt(plan.quotedAmountOutRaw)*9500n) throw new Error("Minimum receive exceeds the supported slippage budget.");
 if(BigInt(plan.minAmountOutRaw)>BigInt(plan.quotedAmountOutRaw)||plan.priceImpactBps>500||plan.priceImpactBps<0) throw new Error("Invalid economic bounds.");
 if(plan.steps.length!==2) throw new Error("Unexpected transaction steps.");
 const [approval,swap]=plan.steps;
 if(approval.kind!=="approve"||!same(approval.to,input.address)||swap.kind!=="swap"||!same(swap.to,addresses.router)||plan.steps.some(s=>s.chainId!==deployedChainId||s.value!=="0")) throw new Error("Unexpected transaction target or value.");
 const approve=decodeFunctionData({abi:erc20Abi,data:approval.data});
 if(approve.functionName!=="approve"||!same(approve.args[0],addresses.router)||approve.args[1]!==BigInt(plan.amountInRaw)) throw new Error("Unexpected allowance.");
 const trade=decodeFunctionData({abi:routerAbi,data:swap.data});
 const [from,to,amount,min,recipient,deadline]=trade.args;
 if(!same(from,input.address)||!same(to,output.address)||amount!==BigInt(plan.amountInRaw)||min!==BigInt(plan.minAmountOutRaw)||!same(recipient,account)||deadline!==BigInt(plan.deadline)) throw new Error("Transaction differs from reviewed plan.");
}
export function validateWalletChallenge(message:string,owner:Hex,origin:string){
  const fields=parseSiweMessage(message),expected=new URL(origin);
  if(fields.domain!==expected.host||fields.uri!==expected.origin||fields.address?.toLowerCase()!==owner.toLowerCase()||fields.chainId!==deployedChainId||fields.version!=="1"||!fields.nonce||!fields.issuedAt||!fields.expirationTime||fields.expirationTime.getTime()<=Date.now()||fields.expirationTime.getTime()>Date.now()+5*60000+1000||fields.issuedAt.getTime()>Date.now()+1000||!fields.statement?.startsWith("Connect to Roque (")) throw new Error("Wallet challenge does not match the trusted application.");
}
export class SubmittedTradeError extends Error {
 constructor(public txHash:Hex){super("Swap was submitted. Its report is pending; check this hash before retrying.");}
}
export class RoqueClient {
 private token?:string;
 constructor(private baseUrl:string,private options:{apiKey?:string;accessToken?:string;authOrigin?:string;onSubmitted?:(hash:Hex)=>void;fetch?:typeof fetch}={}) {
  const url=new URL(baseUrl);if(url.protocol!=="https:"&&!(["localhost","127.0.0.1"].includes(url.hostname)&&url.protocol==="http:")) throw new Error("Use HTTPS for the Roque API.");
  this.token=options.accessToken;
 }
 private async request<T>(path:string,method="GET",body?:unknown,key?:string):Promise<T>{
  const response=await(this.options.fetch??fetch)(new URL(path,this.baseUrl),{method,redirect:"error",headers:{...(body===undefined?{}:{"content-type":"application/json"}),...(this.options.apiKey?{"x-api-key":this.options.apiKey}:{}),...(this.token?{authorization:`Bearer ${this.token}`}:{ }),...(key?{"idempotency-key":key}:{})},body:body===undefined?undefined:JSON.stringify(body)});
  const result=await response.json();if(!response.ok) throw new Error(result.error?.message??"Request failed; check status before retrying.");return result as T;
 }
 tokens(){return this.request("/v1/tokens");}
 async connect(owner:Hex,signMessage:(message:string)=>Promise<Hex>){
  const challenge=await this.request<{challengeId:string;message:string}>("/v1/auth/challenges","POST",{owner,chainId:deployedChainId});
  validateWalletChallenge(challenge.message,owner,this.options.authOrigin??this.baseUrl);
  const session=await this.request<{token:string;owner:Hex}>("/v1/auth/sessions","POST",{challengeId:challenge.challengeId,owner,signature:await signMessage(challenge.message)});
  if(session.owner.toLowerCase()!==owner.toLowerCase()) throw new Error("Session belongs to another wallet.");this.token=session.token;
 }
 createIntent(command:string,key:string,slippageBps=100){return this.request<{id:string;status:string}>("/v1/intents","POST",{command,chainId:deployedChainId,executionMode:"wallet",slippageBps},key);}
 intent(id:string){return this.request<{id:string;status:string;interpretation:unknown}>(`/v1/intents/${encodeURIComponent(id)}`);}
 quote(intentId:string,key:string){return this.request<{quoteId:string;expiresAt:number}>("/v1/quotes","POST",{intentId},key);}
 prepare(quoteId:string,key:string){return this.request<SwapPlan>("/v1/swaps/prepare","POST",{quoteId},key);}
 swap(id:string){return this.request<{id:string;status:string;plan:SwapPlan;settlement?:{amountOutRaw:string}}>(`/v1/swaps/${encodeURIComponent(id)}`);}
 report(swapId:string,txHash:Hex,key:string){return this.request(`/v1/swaps/${encodeURIComponent(swapId)}/submissions`,"POST",{txHash},key);}
 async disconnect(){await this.request("/v1/auth/session","DELETE");this.token=undefined;}
 /** The caller supplies the wallet and independently reviews the returned plan. */
 async executeReviewedPlan(plan:SwapPlan,wallet:WalletClient,account:Hex){
  validatePlan(plan,account);
  if(await wallet.getChainId()!==deployedChainId) throw new Error("Switch the wallet to Sepolia.");
  const [approval,swap]=plan.steps;
  const approvalHash=await wallet.sendTransaction({account,chain:wallet.chain,to:approval.to,data:approval.data,value:0n});
  // Use the wallet provider's read transport; a successful receipt is required.
  const publicClient=createPublicClient({chain:wallet.chain,transport:custom({request:(args)=>wallet.request(args as Parameters<typeof wallet.request>[0])})});
  const receipt=await publicClient.waitForTransactionReceipt({hash:approvalHash,timeout:120000});if(receipt.status!=="success") throw new Error("Approval reverted.");
  validatePlan(plan,account);
  await publicClient.call({account,to:swap.to,data:swap.data,value:0n,blockTag:"pending"});
  const txHash=await wallet.sendTransaction({account,chain:wallet.chain,to:swap.to,data:swap.data,value:0n});
  try {this.options.onSubmitted?.(txHash);}catch{/* Returned hash remains authoritative even if local journaling fails. */}
  try {await this.report(plan.swapId,txHash,`submission:${plan.swapId}`);} catch {throw new SubmittedTradeError(txHash);}
  return txHash;
 }
}

export {createWalletClient,custom,formatUnits} from "viem";
