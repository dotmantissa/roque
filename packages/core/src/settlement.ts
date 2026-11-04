import { decodeFunctionData, parseAbi, parseEventLogs, type Hex } from "viem";
import { addresses, deployedChainId } from "@roque/shared";
import { publicClient } from "./chain.js";

export const walletRouterAbi = parseAbi([
 "function swapExactTokensForTokens(address tokenIn,address tokenOut,uint256 amountIn,uint256 minAmountOut,address to,uint256 deadline) returns (uint256)",
 "event RouterSwap(address indexed sender,address indexed tokenIn,address indexed tokenOut,uint256 amountIn,uint256 amountOut,address to)",
]);
export interface WalletTrade {
 tokenIn: string; tokenOut: string; amountInRaw: string; minAmountOutRaw: string; recipient: string;
 data?: Hex; deadline?: number;
 kind?:"swap"|"limit";triggerPrice?:string;triggerAbove?:boolean;expiry?:string;
}
const same = (a:string|undefined|null,b:string)=>a?.toLowerCase()===b.toLowerCase();
export async function inspectWalletTx(hash:Hex,owner:Hex,plan:WalletTrade) {
 const tx=await publicClient().getTransaction({hash});
 if(tx.chainId!==deployedChainId || !same(tx.from,owner) || !same(tx.to,addresses.router) || tx.value!==0n)
   throw new Error("Transaction does not belong to this wallet swap.");
 if(plan.data && tx.input.toLowerCase()!==plan.data.toLowerCase()) throw new Error("Transaction differs from reviewed plan.");
 const decoded=decodeFunctionData({abi:walletRouterAbi,data:tx.input});
 if(decoded.functionName!=="swapExactTokensForTokens") throw new Error("Unexpected transaction action.");
 const [tokenIn,tokenOut,amount,min,to,deadline]=decoded.args;
 if(!same(tokenIn,plan.tokenIn)||!same(tokenOut,plan.tokenOut)||amount!==BigInt(plan.amountInRaw)||
    min!==BigInt(plan.minAmountOutRaw)||!same(to,owner)||!same(to,plan.recipient)||
    (plan.deadline!==undefined && deadline!==BigInt(plan.deadline))) throw new Error("Transaction differs from reviewed plan.");
 return tx;
}
export async function verifyWalletTrade(hash:Hex,owner:Hex,plan:WalletTrade) {
 if(plan.kind==="limit") return verifyWalletLimit(hash,owner,plan);
 await inspectWalletTx(hash,owner,plan);
 const client=publicClient();
 const receipt=await client.getTransactionReceipt({hash});
 const canonical=await client.getBlock({blockNumber:receipt.blockNumber});
 if(canonical.hash!==receipt.blockHash) throw new Error("Transaction observation was orphaned.");
 const depth=await client.getBlockNumber()-receipt.blockNumber+1n;
 if(receipt.status!=="success") {if(depth<3n) throw new Error("Revert observation is still confirming.");throw new Error("Transaction reverted.");}
 const events=parseEventLogs({abi:walletRouterAbi,eventName:"RouterSwap",logs:receipt.logs});
 const event=events.find(e=>same(e.address,addresses.router)&&same(e.args.sender,owner)&&same(e.args.to,plan.recipient)&&
   same(e.args.tokenIn,plan.tokenIn)&&same(e.args.tokenOut,plan.tokenOut)&&e.args.amountIn===BigInt(plan.amountInRaw)&&
   e.args.amountOut>=BigInt(plan.minAmountOutRaw));
 if(!event) throw new Error("Matching settlement event is missing.");
 return {status:depth>=3n?"confirmed":"confirming",txHash:hash,blockNumber:receipt.blockNumber.toString(),
   blockHash:receipt.blockHash,confirmations:depth.toString(),amountOutRaw:event.args.amountOut.toString(),recipient:plan.recipient};
}

/** Creation confirms escrow; it does not claim that a resting limit has filled. */
async function verifyWalletLimit(hash:Hex,owner:Hex,plan:WalletTrade) {
 const {abis}=await import("@roque/shared");
 const client=publicClient(),tx=await client.getTransaction({hash});
 if(tx.chainId!==deployedChainId||!same(tx.from,owner)||!same(tx.to,addresses.orderBook)||tx.value!==0n) throw new Error("Transaction does not belong to this wallet limit.");
 const decoded=decodeFunctionData({abi:abis.orderBook,data:tx.input});
 const args=decoded.args as readonly unknown[];
 if(decoded.functionName!=="createOrder"||!same(String(args[0]),plan.tokenIn)||!same(String(args[1]),plan.tokenOut)||
   args[2]!==BigInt(plan.amountInRaw)||args[3]!==BigInt(plan.minAmountOutRaw)||args[4]!==BigInt(plan.triggerPrice!)||
   args[5]!==plan.triggerAbove||args[6]!==BigInt(plan.expiry!)) throw new Error("Transaction differs from reviewed limit.");
 const receipt=await client.getTransactionReceipt({hash});
 if((await client.getBlock({blockNumber:receipt.blockNumber})).hash!==receipt.blockHash) throw new Error("Transaction observation was orphaned.");
 const depth=await client.getBlockNumber()-receipt.blockNumber+1n;
 if(receipt.status!=="success") throw new Error(depth>=3n?"Transaction reverted.":"Revert is still confirming.");
 const events=parseEventLogs({abi:abis.orderBook,eventName:"OrderCreated",logs:receipt.logs});
 const event=events.find(e=>{const a=(e as unknown as {args:unknown}).args as {owner:string;tokenIn:string;tokenOut:string;amountIn:bigint;minAmountOut:bigint;triggerPrice:bigint;triggerAbove:boolean;expiry:bigint};
   return same(e.address,addresses.orderBook)&&same(a.owner,owner)&&same(a.tokenIn,plan.tokenIn)&&same(a.tokenOut,plan.tokenOut)&&a.amountIn===BigInt(plan.amountInRaw)&&a.minAmountOut===BigInt(plan.minAmountOutRaw)&&a.triggerPrice===BigInt(plan.triggerPrice!)&&a.triggerAbove===plan.triggerAbove&&a.expiry===BigInt(plan.expiry!);});
 if(!event) throw new Error("Matching order creation event is missing.");
 return {status:depth>=3n?"confirmed":"confirming",txHash:hash,blockNumber:receipt.blockNumber.toString(),blockHash:receipt.blockHash,confirmations:depth.toString(),amountOutRaw:"0",recipient:owner};
}

/** Reconcile a named autonomous business operation from its durable signed attempt. */
export async function vaultSettlement(operationId:string) {
 const {q}=await import("./db/index.js");
 const rows=await q<{tx_hash:Hex|null;calldata:Hex;target:Hex}>("SELECT tx_hash,calldata,target FROM execution_attempts WHERE id=$1",[operationId]);
 const attempt=rows[0];if(!attempt?.tx_hash) return {status:"pending" as const};
 if(!same(attempt.target,addresses.agentExecutor)) throw new Error("Wrong execution deployment.");
 try {
  const {abis}=await import("@roque/shared");
  const decoded=decodeFunctionData({abi:abis.agentExecutor,data:attempt.calldata});
  if(decoded.functionName!=="executeSwap") throw new Error("Wrong execution action.");
  const intent=(decoded.args as unknown as [{user:Hex;tokenIn:Hex;tokenOut:Hex;amountIn:bigint;minAmountOut:bigint}])[0];
  const receipt=await publicClient().getTransactionReceipt({hash:attempt.tx_hash});
  const block=await publicClient().getBlock({blockNumber:receipt.blockNumber});
  if(block.hash!==receipt.blockHash || await publicClient().getBlockNumber()-receipt.blockNumber+1n<3n)
    return {status:"pending" as const,txHash:attempt.tx_hash};
  if(receipt.status!=="success") return {status:"reverted" as const,txHash:attempt.tx_hash};
  const events=parseEventLogs({abi:parseAbi(["event AgentSwap(address indexed user,address indexed tokenIn,address indexed tokenOut,uint256 amountIn,uint256 amountOut,uint256 usdValue)"]),eventName:"AgentSwap",logs:receipt.logs});
  const event=events.find(e=>same(e.address,attempt.target)&&same(e.args.user,intent.user)&&same(e.args.tokenIn,intent.tokenIn)&&same(e.args.tokenOut,intent.tokenOut)&&e.args.amountIn===intent.amountIn&&e.args.amountOut>=intent.minAmountOut);
  if(!event) throw new Error("Matching vault settlement event missing.");
  return {status:"confirmed" as const,txHash:attempt.tx_hash,amountOutRaw:event.args.amountOut.toString()};
 } catch {return {status:"pending" as const,txHash:attempt.tx_hash};}
}
