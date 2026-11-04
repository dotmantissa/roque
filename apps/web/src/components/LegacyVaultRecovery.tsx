"use client";
import {useEffect,useState} from "react";
import {encodeFunctionData,formatUnits,type Hex} from "viem";
import {legacyExecutors,tokenList,requireToken} from "@roque/shared";
import {publicClient} from "@/lib/chain";
import {useWallet} from "@/lib/useWallet";
export function LegacyVaultRecovery(){
 const wallet=useWallet();const [index,setIndex]=useState(0),[token,setToken]=useState(tokenList[0].symbol),[balance,setBalance]=useState<bigint>(),[locked,setLocked]=useState<bigint>(),[commitment,setCommitment]=useState(''),[busy,setBusy]=useState(false),[message,setMessage]=useState(''),[hash,setHash]=useState<Hex>(),[refresh,setRefresh]=useState(0);
 const legacy=legacyExecutors[index],meta=requireToken(token);
 useEffect(()=>{let active=true;setBalance(undefined);setLocked(undefined);if(legacy&&wallet.address)void publicClient.multicall({contracts:[{address:legacy.address,abi:legacy.abi,functionName:'vaultBalance',args:[wallet.address,meta.address]},{address:legacy.address,abi:legacy.abi,functionName:'lockedBalance',args:[wallet.address,meta.address]}],allowFailure:false}).then(rows=>{if(active){setBalance(BigInt(String(rows[0])));setLocked(BigInt(String(rows[1])));}}).catch(()=>{if(active)setMessage('Legacy balances are unavailable. Retry the read before signing.');});return()=>{active=false;};},[legacy,meta,wallet.address,refresh]);
 if(!legacy)return null;
 async function move(action:'revokeCapability'|'withdraw'|'releaseOwnCommitment'){
  if(busy)return;setBusy(true);setMessage('');
  try{const {client,address}=await wallet.getClient();const args=action==='withdraw'?[meta.address,balance!-locked!]:action==='releaseOwnCommitment'?[commitment]:[];
   if(action==='releaseOwnCommitment'&&!/^0x[a-fA-F0-9]{64}$/u.test(commitment))throw new Error('Enter a 32-byte commitment ID from the old vault.');
   if(action==='withdraw'&&(balance===undefined||locked===undefined||balance<=locked))throw new Error('No available legacy balance to withdraw.');
   const data=encodeFunctionData({abi:legacy.abi,functionName:action,args});
   await publicClient.call({account:address,to:legacy.address,data});
   const tx=await client.sendTransaction({account:address,chain:client.chain,to:legacy.address,data,value:0n});setHash(tx);
   const receipt=await publicClient.waitForTransactionReceipt({hash:tx});if(receipt.status!=='success')throw new Error('Legacy recovery transaction reverted.');
   setMessage('Recovery transaction confirmed. Withdrawn tokens are in your wallet.');setRefresh(v=>v+1);
  }catch(err){setMessage((err as Error).message);}finally{setBusy(false);}
 }
 return <section className="panel card mt-4 p-4"><h3>Recover an earlier agent vault</h3><p>Earlier vaults retain their balances and holds. Revoke earlier authority, release your holds, then withdraw available tokens before funding the current vault.</p>
 <label className="block mt-3">Earlier executor <select value={index} onChange={e=>setIndex(Number(e.target.value))}>{legacyExecutors.map((e,i)=><option key={e.address} value={i}>{e.address} (domain {e.domainVersion})</option>)}</select></label>
 <label className="block mt-3">Token <select value={token} onChange={e=>setToken(e.target.value)}>{tokenList.map(t=><option key={t.symbol}>{t.symbol}</option>)}</select></label>
 <p>Balance: {balance===undefined?'Loading…':formatUnits(balance,meta.decimals)} · Held: {locked===undefined?'Loading…':formatUnits(locked,meta.decimals)} {token}</p>
 <button className="border rounded px-3 py-2 mr-2" disabled={busy||!wallet.address} onClick={()=>void move('revokeCapability')}>Revoke earlier authority</button>
 <button className="border rounded px-3 py-2" disabled={busy||balance===undefined||locked===undefined||balance<=locked} onClick={()=>void move('withdraw')}>Withdraw available {token}</button>
 <label className="block mt-3">Held commitment ID <input className="border p-2 w-full" value={commitment} onChange={e=>setCommitment(e.target.value)} placeholder="0x…"/></label>
 <button className="border rounded px-3 py-2 mt-2" disabled={busy||!wallet.address} onClick={()=>void move('releaseOwnCommitment')}>Release my earlier hold</button>
 <p role="status">{busy?'Waiting for your wallet or receipt…':message}</p>{hash&&<a className="underline break-all" href={`https://sepolia.etherscan.io/tx/${hash}`} target="_blank" rel="noreferrer">View recovery transaction</a>}
 <a className="block underline" href={`https://sepolia.etherscan.io/address/${legacy.address}#events`} target="_blank" rel="noreferrer">Find commitment IDs in the earlier vault’s Committed events</a></section>;
}
