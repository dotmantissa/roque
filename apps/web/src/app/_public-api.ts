import "server-only";
import {after} from "next/server";
import {createMcpServer} from "@roque/mcp";
import {interpretationTick} from "@roque/core/public-api";
let server:ReturnType<typeof createMcpServer>|undefined;
/** The same HTTP implementation runs in Next and the standalone service. */
export async function dispatchPublic(req:Request,path?:string){
 const url=new URL(req.url);
 const headers=Object.fromEntries(req.headers.entries());
 delete headers["content-length"];delete headers["transfer-encoding"];
 headers.host=url.host;
 let payload:string|undefined;
 if(!["GET","HEAD"].includes(req.method)){
  const reader=req.body?.getReader();const chunks:Uint8Array[]=[];let size=0;
  if(reader)try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>16384){await reader.cancel();return new Response(JSON.stringify({error:{code:"BODY_TOO_LARGE",message:"Request exceeds 16 KiB."}}),{status:413,headers:{"content-type":"application/json"}});}chunks.push(value);}}finally{reader.releaseLock();}
  if(size>0)payload=Buffer.concat(chunks).toString("utf8");
 }
 server??=createMcpServer().catch(err=>{server=undefined;throw err;});
 const app=await server;
 const response=await app.inject({method:req.method as "GET"|"POST"|"DELETE"|"OPTIONS",url:path??url.pathname+url.search,headers,payload});
 const out=new Headers();
 for(const [name,value] of Object.entries(response.headers))if(value!==undefined&&!['content-length','transfer-encoding','connection'].includes(name))out.set(name,Array.isArray(value)?value.join(','):String(value));
 // Each invocation drains one durable job. Global SQL leases fence replicas.
 // Next after() keeps the invocation alive; no serverless interval timers.
 if(response.statusCode<300 && ((url.pathname.startsWith('/v1/intents')) || (url.pathname==='/mcp'&&req.method==='POST'))){
  after(async()=>{try{await interpretationTick();}catch{console.error('Public interpretation worker failed; job remains recoverable.');}});
 }
 return new Response([204,304].includes(response.statusCode)?null:response.body,{status:response.statusCode,headers:out});
}
