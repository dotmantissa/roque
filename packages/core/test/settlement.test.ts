import {it,expect,vi,beforeEach} from "vitest";
import {encodeFunctionData,encodeEventTopics,encodeAbiParameters,parseAbiParameters} from "viem";
import {addresses,deployedChainId} from "@roque/shared";
const s=vi.hoisted(()=>({getTransaction:vi.fn(),getTransactionReceipt:vi.fn(),getBlock:vi.fn(),getBlockNumber:vi.fn()}));
vi.mock("../src/chain.js",()=>({publicClient:()=>s}));
const {inspectWalletTx,verifyWalletTrade,walletRouterAbi}=await import("../src/settlement.js");
const owner="0x1111111111111111111111111111111111111111" as const;
const tokenIn="0x2222222222222222222222222222222222222222" as const, tokenOut="0x3333333333333333333333333333333333333333" as const;
const hash=("0x"+"ab".repeat(32)) as `0x${string}`,blockHash=("0x"+"cd".repeat(32)) as `0x${string}`;
const plan={tokenIn,tokenOut,amountInRaw:"100",minAmountOutRaw:"90",recipient:owner,deadline:2000000000};
beforeEach(()=>{
 vi.clearAllMocks();
 const input=encodeFunctionData({abi:walletRouterAbi,functionName:"swapExactTokensForTokens",args:[tokenIn,tokenOut,100n,90n,owner,2000000000n]});
 s.getTransaction.mockResolvedValue({chainId:deployedChainId,from:owner,to:addresses.router,value:0n,input});
 s.getBlock.mockResolvedValue({hash:blockHash});s.getBlockNumber.mockResolvedValue(102n);
 const log={address:addresses.router,data:encodeAbiParameters(parseAbiParameters("uint256,uint256,address"),[100n,95n,owner]),topics:encodeEventTopics({abi:walletRouterAbi,eventName:"RouterSwap",args:{sender:owner,tokenIn,tokenOut}}),logIndex:0,transactionIndex:0,transactionHash:hash,blockHash,blockNumber:100n,removed:false};
 s.getTransactionReceipt.mockResolvedValue({status:"success",blockNumber:100n,blockHash,logs:[log]});
});
it("requires owner, target, chain and reviewed calldata",async()=>{
 for(const patch of [{from:tokenIn},{to:tokenIn},{chainId:1},{value:1n}]){
  const base=await s.getTransaction();s.getTransaction.mockResolvedValueOnce({...base,...patch});
  await expect(inspectWalletTx(hash,owner,plan)).rejects.toThrow();
 }
 await expect(inspectWalletTx(hash,owner,{...plan,minAmountOutRaw:"0"})).rejects.toThrow();
});
it("requires matching successful canonical settlement at confirmation depth",async()=>{
 await expect(verifyWalletTrade(hash,owner,plan)).resolves.toMatchObject({status:"confirmed",amountOutRaw:"95"});
 s.getBlockNumber.mockResolvedValue(100n);
 await expect(verifyWalletTrade(hash,owner,plan)).resolves.toMatchObject({status:"confirming"});
 s.getBlockNumber.mockResolvedValue(102n);
 s.getTransactionReceipt.mockResolvedValueOnce({status:"reverted",blockNumber:100n,blockHash,logs:[]});
 await expect(verifyWalletTrade(hash,owner,plan)).rejects.toThrow("reverted");
 s.getBlock.mockResolvedValueOnce({hash});await expect(verifyWalletTrade(hash,owner,plan)).rejects.toThrow("orphaned");
 s.getTransactionReceipt.mockResolvedValueOnce({status:"success",blockNumber:100n,blockHash,logs:[]});
 await expect(verifyWalletTrade(hash,owner,plan)).rejects.toThrow("missing");
});
