type Hex = `0x${string}`;
export interface TransactionStep {kind:"approve"|"swap";to:Hex;data:Hex;value:"0";chainId:number;summary:string}
export interface SwapPlan {
 swapId:string;quoteId:string;intentId:string;chainId:number;deploymentVersion:string;router:Hex;
 executionAccount:Hex;recipient:Hex;tokenIn:Hex;tokenOut:Hex;tokenInSymbol:string;tokenOutSymbol:string;
 tokenInDecimals:number;tokenOutDecimals:number;amountInRaw:string;quotedAmountOutRaw:string;minAmountOutRaw:string;
 feeBps:number;priceImpactBps:number;quoteBlockNumber:string;quoteBlockHash:Hex;expiresAt:number;deadline:number;
 planHash:Hex;steps:TransactionStep[];
}
