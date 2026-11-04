// A separate app: its backend identifies the partner; its user's wallet signs.
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
const upstream=new URL(process.env.ROQUE_API_URL??'http://localhost:8787');
const apiKey=process.env.ROQUE_API_KEY;
if(!apiKey)throw new Error('Set ROQUE_API_KEY on the partner backend.');
if(upstream.protocol!=='https:'&&!(upstream.protocol==='http:'&&['localhost','127.0.0.1'].includes(upstream.hostname)))throw new Error('Use HTTPS for the upstream API.');
const origin=`http://localhost:${Number(process.env.PORT??3100)}`;
const paths=/^\/v1\/(?:tokens|chains|auth\/(?:challenges|sessions|session)|intents(?:\/[a-f0-9-]{36})?|quotes|swaps(?:\/prepare|\/[a-f0-9-]{36}(?:\/submissions)?)?)$/u;
const budgets=new Map();
createServer(async(req,res)=>{try{
 const now=Math.floor(Date.now()/60000),ip=req.socket.remoteAddress??'unknown';
 for(const [key,b]of budgets)if(b.minute!==now)budgets.delete(key);
 const b=budgets.get(ip)??{minute:now,count:0};if(budgets.size>2048||++b.count>120){res.writeHead(429);res.end('Quota exceeded');return;}budgets.set(ip,b);
 res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
 const url=new URL(req.url??'/',origin);
 if(paths.test(url.pathname)){
  if(req.headers.origin&&req.headers.origin!==origin){res.writeHead(403);res.end();return;}
  let body='',size=0;for await(const chunk of req){size+=chunk.length;if(size>16384){res.writeHead(413);res.end();return;}body+=chunk;}
  const headers={'content-type':'application/json','x-api-key':apiKey};for(const name of ['authorization','idempotency-key'])if(typeof req.headers[name]==='string')headers[name]=req.headers[name];
  const r=await fetch(new URL(url.pathname+url.search,upstream),{method:req.method,headers,body:['GET','DELETE'].includes(req.method)?undefined:body,redirect:'error',signal:AbortSignal.timeout(20000)});
  res.writeHead(r.status,{'content-type':'application/json'});res.end(await r.text());return;
 }
 if(url.pathname==='/config.json'&&req.method==='GET'){res.setHeader('content-type','application/json');res.end(JSON.stringify({authOrigin:process.env.ROQUE_AUTH_ORIGIN??'http://localhost:3000'}));return;}
 if(req.method!=='GET'||!['/','/sdk.js'].includes(url.pathname)){res.writeHead(404);res.end();return;}
 const file=url.pathname==='/'?'index.html':'sdk.js';res.setHeader('content-type',file.endsWith('.html')?'text/html':'text/javascript');res.end(await readFile(new URL(file,import.meta.url)));
}catch{res.writeHead(502);res.end('Request failed. Check swap status before retrying.');}}).listen(Number(process.env.PORT??3100),'127.0.0.1',()=>console.log(`Partner app: ${origin}`));
