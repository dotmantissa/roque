import {beforeEach,expect,it,vi} from "vitest";
import {requireToken,tokenList} from "@roque/shared";
const state=vi.hoisted(()=>({readContract:vi.fn()}));
vi.mock("../src/chain.js",()=>({publicClient:()=>state}));
const {feedUsd,tokenUsd,allTokenUsd}=await import("../src/prices.js");
const {handlePrice}=await import("../src/api.js");
const now=Math.floor(Date.now()/1000),eur=requireToken("rEURC");
beforeEach(()=>{
 state.readContract.mockReset();
 state.readContract.mockImplementation(async({address,functionName}:{address:string;functionName:string})=>{
  if(functionName==="decimals")return 8;
  return [1n,2000_00000000n,BigInt(now-30),BigInt(address.toLowerCase()===eur.feed.toLowerCase()?now-7200:now-20),1n];
 });
});
it("keeps healthy public prices available and marks the unavailable asset without a stale fallback",async()=>{
 const prices=await allTokenUsd();expect(prices.rUSDC).toBe(1);expect(prices.rWETH).toBe(2000);
 expect(prices).not.toHaveProperty("rEURC");expect(Object.keys(prices)).toHaveLength(tokenList.length-1);
 expect(await handlePrice()).toMatchObject({ethUsd:2000,prices,unavailableTokens:["rEURC"]});
 await expect(tokenUsd("rEURC")).rejects.toThrow("invalid or stale");
});
it.each([
 [0n,1n,BigInt(now-20),2000_00000000n,8],
 [2n,1n,BigInt(now-20),2000_00000000n,8],
 [1n,1n,BigInt(now+60),2000_00000000n,8],
 [1n,1n,BigInt(now-7200),2000_00000000n,8],
 [1n,1n,0n,2000_00000000n,8],
 [1n,1n,BigInt(now-20),0n,8],
 [1n,1n,BigInt(now-20),2000_00000000n,19],
])("rejects malformed, incomplete or stale oracle data (%s, %s, %s, %s, %s)",async(roundId,answered,updated,answer,decimals)=>{
 state.readContract.mockImplementation(async({functionName}:{functionName:string})=>functionName==="decimals"?decimals:[roundId,answer,updated,updated,answered]);
 await expect(feedUsd(requireToken("rWETH").feed)).rejects.toThrow("invalid or stale");
});
