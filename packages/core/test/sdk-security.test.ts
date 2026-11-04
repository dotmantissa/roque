import {it,expect} from "vitest";
import {encodeFunctionData,erc20Abi,type Hex} from "viem";
import {createSiweMessage} from "viem/siwe";
import {addresses,tokenList,deployedChainId,type SwapPlan} from "@roque/shared";
import {planHash} from "../src/public-api.js";
import {walletRouterAbi} from "../src/settlement.js";
import {validatePlan,validateWalletChallenge} from "../../sdk/src/index.js";
const owner="0x1111111111111111111111111111111111111111" as Hex;
function fixture():SwapPlan{
 const input=tokenList.find(t=>t.symbol==='rUSDC')!,output=tokenList.find(t=>t.symbol==='rWETH')!,deadline=Math.floor(Date.now()/1000)+120;
 const p={swapId:'11111111-1111-4111-8111-111111111111',quoteId:'22222222-2222-4222-8222-222222222222',intentId:'33333333-3333-4333-8333-333333333333',chainId:deployedChainId,router:addresses.router,executionAccount:owner,recipient:owner,tokenIn:input.address,tokenOut:output.address,tokenInSymbol:input.symbol,tokenOutSymbol:output.symbol,tokenInDecimals:input.decimals,tokenOutDecimals:output.decimals,amountInRaw:'1000000',quotedAmountOutRaw:'1000000000000000',minAmountOutRaw:'990000000000000',deadline,expiresAt:deadline,quoteBlockNumber:'100',quoteBlockHash:`0x${'12'.repeat(32)}` as Hex,feeBps:30,priceImpactBps:5,deploymentVersion:'sepolia-router-v1',steps:[{kind:'approve' as const,to:input.address,data:encodeFunctionData({abi:erc20Abi,functionName:'approve',args:[addresses.router,1000000n]}),value:'0',chainId:deployedChainId,summary:'Exact allowance'},{kind:'swap' as const,to:addresses.router,data:encodeFunctionData({abi:walletRouterAbi,functionName:'swapExactTokensForTokens',args:[input.address,output.address,1000000n,990000000000000n,owner,BigInt(deadline)]}),value:'0',chainId:deployedChainId,summary:'Swap'}]};return {...p,planHash:planHash(p)};
}
it('accepts an independently decoded valid plan',()=>expect(()=>validatePlan(fixture(),owner)).not.toThrow());
it.each(['recipient','chain','allowance','calldata','expiry','floor','metadata','uint256'])('rejects %s tampering even with a recomputed hash',kind=>{
 const p=fixture();
 if(kind==='recipient')p.recipient=addresses.router;
 if(kind==='chain')p.chainId=1;
 if(kind==='allowance')p.steps[0].data=encodeFunctionData({abi:erc20Abi,functionName:'approve',args:[addresses.router,2n**256n-1n]});
 if(kind==='calldata')p.steps[1].data=p.steps[0].data;
 if(kind==='expiry')p.expiresAt=1;
 if(kind==='floor')p.minAmountOutRaw='1';
 if(kind==='metadata')p.tokenInDecimals=18;
 if(kind==='uint256')p.amountInRaw=(2n**256n).toString();
 const {planHash:_,...rest}=p;p.planHash=planHash(rest);expect(()=>validatePlan(p,owner)).toThrow();
});
it('refuses wallet challenges for another relying party before signing',()=>{
 const issuedAt=new Date(),expirationTime=new Date(Date.now()+120000);
 const message=createSiweMessage({domain:'evil.example',address:owner,statement:'Connect to Roque (partner).',uri:'https://evil.example',version:'1',chainId:deployedChainId,nonce:'12345678abcdefgh',issuedAt,expirationTime});
 expect(()=>validateWalletChallenge(message,owner,'https://roque.example')).toThrow();
 expect(()=>validateWalletChallenge(message,owner,'https://evil.example')).not.toThrow();
});
