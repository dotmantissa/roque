'use client';
import {useEffect,useRef,useState} from 'react';
import {createWalletClient,custom,formatUnits,type EIP1193Provider,type Hex} from 'viem';
import {sepolia} from 'viem/chains';
import {RoqueClient,SubmittedTradeError,validatePlan,validateWalletChallenge} from '@roque/sdk';
import type {SwapPlan} from '@roque/shared';

type Connection={name:string;scopes:string[];resource:string};
async function json(path:string,body?:unknown,token?:string){
 const r=await fetch(path,{method:body===undefined?'GET':'POST',headers:{'content-type':'application/json',...(token?{authorization:`Bearer ${token}`}:{})},body:body===undefined?undefined:JSON.stringify(body),cache:'no-store'});
 const data=await r.json();if(!r.ok)throw new Error(data.error?.message??data.error??'Request could not be completed.');return data;
}
export function WalletApproval({mode}:{mode:'approve'|'connect'}){
 const [locator,setLocator]=useState(''),[connection,setConnection]=useState<Connection>(),[plan,setPlan]=useState<SwapPlan>(),[owner,setOwner]=useState<Hex>(),[session,setSession]=useState(''),[busy,setBusy]=useState(false),[message,setMessage]=useState(''),[hash,setHash]=useState<Hex>();
 const gate=useRef(false);
 useEffect(()=>{const value=mode==='approve'?window.location.hash.slice(1):new URL(window.location.href).searchParams.get('request')??'';setLocator(value);
   if(mode==='approve'){const recorded=localStorage.getItem(`roque-submission:${value}`);if(recorded&&/^0x[a-fA-F0-9]{64}$/u.test(recorded))setHash(recorded as Hex);}
   if(mode==='connect'&&value)void json(`/api/connect?request=${encodeURIComponent(value)}`).then(setConnection).catch(e=>setMessage(String(e.message)));
 },[mode]);
 async function wallet(){const provider=(window as unknown as {ethereum?:EIP1193Provider}).ethereum;if(!provider)throw new Error('Open this page in a browser with your linked Sepolia wallet.');
   const client=createWalletClient({chain:sepolia,transport:custom(provider)});const [address]=await client.requestAddresses();if(!address)throw new Error('Connect a wallet.');await client.switchChain({id:sepolia.id});return {client,address};}
 async function connect(){if(gate.current)return;gate.current=true;setBusy(true);setMessage('');try{
   const {client,address}=await wallet();const challenge=await json('/api/auth/challenge',{owner:address});
   validateWalletChallenge(challenge.message,address,window.location.origin);
   const signature=await client.signMessage({account:address,message:challenge.message});const proof=await json('/api/auth/session',{owner:address,challengeId:challenge.challengeId,signature});
   setOwner(address);setSession(proof.token);
   if(mode==='approve'){const result=await json('/api/approval',{token:locator},proof.token);validatePlan(result.plan,address);setPlan(result.plan);}
 }catch(e){setMessage((e as Error).message);}finally{gate.current=false;setBusy(false);}}
 async function approve(){if(gate.current||!owner||!session)return;gate.current=true;setBusy(true);setMessage('');try{
   if(mode==='connect'){
    const result=await json('/api/connect',{requestId:locator,approve:true},session);
    const target=new URL(result.redirectUrl);if(target.protocol!=='https:')throw new Error('Invalid connector callback.');window.location.assign(target.href);
   }else if(plan){
    const {client,address}=await wallet();validatePlan(plan,address);
    const sdk=new RoqueClient(window.location.origin,{accessToken:session,onSubmitted:tx=>{setHash(tx);localStorage.setItem(`roque-submission:${locator}`,tx);},fetch:async(_input,init)=>{
      const submission=JSON.parse(String(init?.body));return fetch('/api/approval',{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${session}`},body:JSON.stringify({token:locator,txHash:submission.txHash})});}});
    const tx=await sdk.executeReviewedPlan(plan,client,address);setHash(tx);setMessage('Submitted to Sepolia. Confirmed output appears in swap status.');
   }
 }catch(e){if(e instanceof SubmittedTradeError){setHash(e.txHash);setMessage(e.message);}else setMessage((e as Error).message);}finally{gate.current=false;setBusy(false);}}
 return <main className="mx-auto max-w-xl px-6 py-16"><h1 className="text-2xl font-semibold">{mode==='connect'?'Connect your wallet to an agent':'Review your swap'}</h1>
 <p className="mt-4">Ethereum Sepolia · Test tokens · Output goes to your connected wallet.</p>
 {connection&&<div className="mt-6"><p>Application: {connection.name}</p><p>Requested access: {connection.scopes.join(', ')}</p><p>Service: {connection.resource}</p><p className="mt-3">Connection permits preparation and status reads. Each trade requires your wallet signature.</p></div>}
 {owner&&<p className="mt-4 break-all">Wallet: {owner}</p>}
 {plan&&<dl className="mt-6 space-y-3"><div><dt>Spend</dt><dd>{formatUnits(BigInt(plan.amountInRaw),plan.tokenInDecimals)} {plan.tokenInSymbol}</dd></div><div><dt>Minimum receive</dt><dd>{formatUnits(BigInt(plan.minAmountOutRaw),plan.tokenOutDecimals)} {plan.tokenOutSymbol}</dd></div><div><dt>Recipient</dt><dd className="break-all">{plan.recipient}</dd></div><div><dt>Price impact / fee</dt><dd>{plan.priceImpactBps/100}% / {plan.feeBps/100}%</dd></div><div><dt>Expires</dt><dd>{new Date(plan.expiresAt*1000).toLocaleString()}</dd></div></dl>}
 {!session?<button className="mt-6 rounded border px-4 py-2" disabled={busy||!locator||(mode==='connect'&&!connection)} onClick={()=>void connect()}>Connect and prove wallet ownership</button>:<button className="mt-6 rounded border px-4 py-2" disabled={busy||Boolean(hash)||(mode==='approve'&&!plan)} onClick={()=>void approve()}>{mode==='connect'?'Allow this connection':'Approve exact allowance and sign swap'}</button>}
 <a className="ml-4" href="/">Cancel</a><p role="status" className="mt-4">{busy?'Waiting for your wallet or network…':message}</p>
 {hash&&<a className="mt-4 block break-all underline" href={`https://sepolia.etherscan.io/tx/${hash}`} target="_blank" rel="noreferrer">View transaction {hash}</a>}
 </main>;
}
