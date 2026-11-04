import { describe,it,expect } from "vitest";
import { interpretationSchema, adjudicationSchema, decimal, rawAmount } from "../src/validation.js";
const good={ok:true,kind:"swap",tokenIn:"rUSDC",tokenOut:"rWETH",amount:"100",amountIsPercent:false,triggerPrice:"",triggerAbove:false,confidence:"high",reason:"trade",error:""};
describe("untrusted model and numeric input",()=>{
 it.each(["false","true",0,1,null,[],{}])("rejects coerced boolean %j",value=>{
   expect(interpretationSchema.safeParse({...good,amountIsPercent:value}).success).toBe(false);
   expect(interpretationSchema.safeParse({...good,triggerAbove:value}).success).toBe(false);
   expect(adjudicationSchema.safeParse({met:value,confidence:"high",rationale:"evidence"}).success).toBe(false);
 });
 it("requires complete, confident, supported results",()=>{
   expect(interpretationSchema.safeParse(good).success).toBe(true);
   for(const patch of [{confidence:"low"},{amount:"1e9"},{amount:"0"},{tokenOut:"DOGE"},{kind:"unknown"},{kind:"limit",triggerPrice:"2000",tokenOut:"rWBTC"}])
     expect(interpretationSchema.safeParse({...good,...patch}).success).toBe(false);
   const {amountIsPercent:_,...missing}=good;
   expect(interpretationSchema.safeParse(missing).success).toBe(false);
   expect(adjudicationSchema.safeParse({met:true,confidence:"medium",rationale:"uncertain"}).success).toBe(false);
 });
 it.each(["1e6","NaN","Infinity","-1","0xFF","1".repeat(79)])("rejects unsafe decimal %s",s=>expect(decimal.safeParse(s).success).toBe(false));
 it("bounds uint256",()=>expect(rawAmount.safeParse((2n**256n).toString()).success).toBe(false));
});
