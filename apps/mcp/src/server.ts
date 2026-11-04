import {pathToFileURL} from "node:url";
import {randomUUID} from "node:crypto";
import {McpServer} from "@modelcontextprotocol/sdk/server/mcp.js";
import {StreamableHTTPServerTransport} from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {z} from "zod";
import {createServer} from "@roque/relayer";
import * as api from "@roque/core/public-api";
import {deployedChainId} from "@roque/shared";
import {mcpResource} from "../../relayer/src/oauth.js";

const content=(value:unknown)=>({content:[{type:"text" as const,text:JSON.stringify(value)}]});
export function connector(ctx:api.RequestContext){
 const server=new McpServer({name:"roque",version:"1.0.0"});
 const scope=(s:string)=>{if(!ctx.scopes.includes(s))throw new Error("Connection lacks the required scope.");};
 server.registerTool("roque_list_tokens",{description:"List Roque's Sepolia test tokens and wallet settlement support.",annotations:{readOnlyHint:true}},async()=>content(api.tokens(deployedChainId)));
 server.registerTool("roque_quote_swap",{description:"Queue interpretation of an immediate exact-input trade; returns an intent to poll. No funds move.",inputSchema:{command:z.string().min(1).max(500),idempotencyKey:z.string().min(8).max(128)},annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:true}},async({command,idempotencyKey})=>{
  scope("intents:write");return content(await api.createIntent(ctx,{chainId:deployedChainId,command,executionMode:"wallet",slippageBps:100},idempotencyKey));
 });
 server.registerTool("roque_prepare_swap",{description:"Poll an interpreted intent and prepare an immutable exact-input wallet trade when ready. The user must review and sign.",inputSchema:{intentId:z.string().uuid(),idempotencyKey:z.string().min(8).max(100)},annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:true}},async({intentId,idempotencyKey})=>{
  scope("intents:read");scope("quotes:read");scope("swaps:prepare");
  const intent=await api.getIntent(ctx,intentId);if(intent.status!=="ready")return content(intent);
  const quote=await api.createQuote(ctx,{intentId},`${idempotencyKey}:quote`) as {quoteId?:string};if(!quote.quoteId)return content(quote);
  return content(await api.prepareSwap(ctx,{quoteId:quote.quoteId},`${idempotencyKey}:prepare`));
 });
 server.registerTool("roque_request_approval",{description:"Create an owner-bound, short-lived approval URL. Opening it requires the connected wallet and an explicit transaction signature.",inputSchema:{swapId:z.string().uuid(),idempotencyKey:z.string().min(8).max(128)},annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:true}},async({swapId,idempotencyKey})=>{scope("swaps:prepare");return content(await api.approvalLink(ctx,swapId,idempotencyKey));});
 server.registerTool("roque_get_swap_status",{description:"Return this connection's plan and actual Sepolia receipt-backed settlement status.",inputSchema:{swapId:z.string().uuid()},annotations:{readOnlyHint:true}},async({swapId})=>{scope("swaps:read");return content(await api.getSwap(ctx,swapId));});
 return server;
}
export async function createMcpServer(){
 const app=await createServer();
 app.post("/mcp",async(req,reply)=>{
  const resource=new URL(mcpResource());
  if(req.headers.host!==resource.host || (req.headers.origin && ![resource.origin,...(process.env.API_ALLOWED_ORIGINS??"").split(",")].includes(req.headers.origin)))return reply.status(403).send({error:"Invalid origin or host."});
  const token=req.headers.authorization?.match(/^Bearer ([A-Za-z0-9_-]+)$/u)?.[1];
  let ctx:api.RequestContext;
  try {ctx=await api.apiContext(undefined,token,"swaps:read",req.id,resource.href);} catch {
   return reply.header("WWW-Authenticate",`Bearer resource_metadata="${resource.origin}/.well-known/oauth-protected-resource/mcp"`).status(401).send({error:"Connect the execution wallet through OAuth."});
  }
  const server=connector(ctx),transport=new StreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});
  await server.connect(transport);reply.hijack();
  reply.raw.on("close",()=>{void transport.close();void server.close();});
  await transport.handleRequest(req.raw,reply.raw,req.body);
 });
 app.get("/mcp",async(_req,reply)=>reply.header("Allow","POST").status(405).send());
 app.delete("/mcp",async(_req,reply)=>reply.header("Allow","POST").status(405).send());
 return app;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){const app=await createMcpServer();await app.listen({host:"0.0.0.0",port:Number(process.env.MCP_PORT??8787)});}
