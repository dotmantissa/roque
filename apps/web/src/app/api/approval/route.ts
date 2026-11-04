import {z} from 'zod';
import {resolveApprovalLink,getSwap,reportSubmission} from '@roque/core/public-api';
import {run,body,bearerToken} from '../_util';
export const runtime='nodejs';
export async function POST(req:Request){return run(async()=>{
 const input=z.object({token:z.string().regex(/^[A-Za-z0-9_-]{43}$/u),txHash:z.string().regex(/^0x[a-fA-F0-9]{64}$/u).optional()}).strict().parse(await body(req));
 const {ctx,swapId}=await resolveApprovalLink(input.token,bearerToken(req),Boolean(input.txHash));
 return input.txHash?reportSubmission(ctx,swapId,{txHash:input.txHash},`approval:${swapId}`):getSwap(ctx,swapId);
});}
