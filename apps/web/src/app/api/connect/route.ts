import {z} from 'zod';
import {ApiError} from '@roque/core/api';
import {run,body,bearerToken} from '../_util';
import {dispatchPublic} from '../../_public-api';
export const runtime='nodejs';
export async function GET(req:Request){return run(async()=>{
 const id=z.string().uuid().parse(new URL(req.url).searchParams.get('request'));
 const response=await dispatchPublic(new Request(new URL(`/oauth/requests/${id}`,req.url)));
 if(!response.ok)throw new Error('Connection request unavailable.');return response.json();
});}
export async function POST(req:Request){
 return run(async()=>{
  const input=z.object({requestId:z.string().uuid(),approve:z.literal(true)}).strict().parse(await body(req));
  const token=bearerToken(req);if(!token)throw new ApiError(401,'Wallet proof required.');
  const response=await dispatchPublic(new Request(new URL('/oauth/consent',req.url),{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${token}`},body:JSON.stringify(input)}));
  if(!response.ok)throw new Error('Consent could not be completed.');return response.json();
 });
}
