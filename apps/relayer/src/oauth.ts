import OAuth2Server from "@node-oauth/oauth2-server";
import {randomUUID,randomBytes} from "node:crypto";
import {z} from "zod";
import type {FastifyInstance} from "fastify";
import {q} from "@roque/core/db";
import {authOrigin} from "@roque/core/env";
import {API_SCOPES} from "@roque/core/public-api";
import {authenticatedOwner,tokenHash,revokeSession} from "../../../packages/core/src/auth.js";
import {admit} from "../../../packages/core/src/admission.js";
export function mcpResource(){const url=process.env.MCP_RESOURCE_URL??`${authOrigin()}/mcp`;return new URL(url).href;}
const clientModel=async(id:string)=>{
 const rows=await q<{id:string;redirects:string[];scopes:string[]}>("SELECT id,redirects,scopes FROM api_clients WHERE id=$1 AND revoked_at IS NULL",[id]);
 const c=rows[0];return c?{id:c.id,redirectUris:c.redirects,grants:["authorization_code"],scope:c.scopes}:false;
};
export const oauth=new OAuth2Server({accessTokenLifetime:3600,authorizationCodeLifetime:120,
 model:{
  getClient:clientModel,
  getAccessToken:async(token:string)=>{
   const rows=await q<{owner_address:string;client_id:string;expires_at:string;scopes:string[]}>(`SELECT s.owner_address,s.client_id,s.expires_at,s.scopes FROM auth_sessions s JOIN api_clients c ON c.id=s.client_id
    WHERE token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>now() AND s.audience=$2 AND s.session_type='oauth' AND c.revoked_at IS NULL`,[tokenHash(token),mcpResource()]);
   const s=rows[0];return s?{accessToken:token,accessTokenExpiresAt:new Date(s.expires_at),scope:s.scopes,client:{id:s.client_id,grants:["authorization_code"]},user:{id:s.owner_address}}:false;
  },
  saveToken:async(token,client,user)=>{
   await q("INSERT INTO auth_sessions(token_hash,owner_address,client_id,audience,scopes,expires_at,session_type) VALUES($1,$2,$3,$4,$5,$6,'oauth')",
    [tokenHash(token.accessToken),user.id,client.id,mcpResource(),token.scope??[],token.accessTokenExpiresAt?.toISOString()]);
   return {...token,client,user};
  },
  getAuthorizationCode:async(code:string)=>{
   const rows=await q<{payload:{expiresAt:string;redirectUri:string;scope:string[];client:OAuth2Server.Client;user:OAuth2Server.User;codeChallenge?:string;codeChallengeMethod?:string}}>("SELECT payload FROM oauth_codes WHERE code_hash=$1 AND consumed_at IS NULL AND expires_at>now()",[tokenHash(code)]);
   const c=rows[0]?.payload;return c?{...c,authorizationCode:code,expiresAt:new Date(c.expiresAt)}:false;
  },
  saveAuthorizationCode:async(code,client,user)=>{
   const {authorizationCode,...safe}=code;
   await q("INSERT INTO oauth_codes(code_hash,payload,expires_at) VALUES($1,$2::jsonb,$3)",[tokenHash(authorizationCode),JSON.stringify({...safe,client,user}),code.expiresAt.toISOString()]);
   return {...code,client,user};
  },
  revokeAuthorizationCode:async code=>(await q("UPDATE oauth_codes SET consumed_at=now() WHERE code_hash=$1 AND consumed_at IS NULL RETURNING code_hash",[tokenHash(code.authorizationCode)])).length===1,
  validateScope:async(_user,client,scope)=>(scope??[]).every(s=>API_SCOPES.includes(s as typeof API_SCOPES[number])&&(client.scope as string[]).includes(s))?(scope??[]):false,
  verifyScope:async(token,scope)=>scope.every(s=>token.scope?.includes(s)),
 }});
function bearer(header:string|undefined){return header?.match(/^Bearer ([A-Za-z0-9_-]+)$/u)?.[1];}
const authQuery=z.object({client_id:z.string().max(128),redirect_uri:z.string().url().max(2000),response_type:z.literal("code"),
 code_challenge:z.string().regex(/^[A-Za-z0-9_-]{43}$/u),code_challenge_method:z.literal("S256"),state:z.string().min(16).max(500),
 resource:z.string().url(),scope:z.string().max(300).optional()}).strict();
export async function registerOAuth(app:FastifyInstance){

 const issuer=new URL(mcpResource()).origin;
 app.get("/.well-known/oauth-protected-resource/mcp",async()=>({resource:mcpResource(),authorization_servers:[issuer],scopes_supported:[...API_SCOPES],bearer_methods_supported:["header"]}));
 app.get("/.well-known/oauth-authorization-server",async()=>({issuer,authorization_endpoint:`${issuer}/oauth/authorize`,token_endpoint:`${issuer}/oauth/token`,registration_endpoint:`${issuer}/oauth/register`,revocation_endpoint:`${issuer}/oauth/revoke`,response_types_supported:["code"],grant_types_supported:["authorization_code"],token_endpoint_auth_methods_supported:["none"],code_challenge_methods_supported:["S256"],scopes_supported:[...API_SCOPES]}));
 app.post("/oauth/register",async(req,reply)=>{
  await admit(`oauth-register:${req.ip}`,10);
  const input=z.object({client_name:z.string().min(1).max(100),redirect_uris:z.array(z.string().url().max(2000)).min(1).max(5),grant_types:z.array(z.literal("authorization_code")).optional(),response_types:z.array(z.literal("code")).optional(),token_endpoint_auth_method:z.literal("none").optional()}).strict().parse(req.body);
  const allowed=(process.env.OAUTH_ALLOWED_REDIRECTS??"").split(",").filter(Boolean);
  if(input.redirect_uris.some(u=>!allowed.includes(u))) return reply.status(400).send({error:"invalid_redirect_uri"});
  const id=randomUUID();await q("INSERT INTO api_clients(id,key_hash,name,scopes,redirects) VALUES($1,$2,$3,$4,$5)",[id,tokenHash(randomBytes(32).toString("base64url")),input.client_name,[...API_SCOPES],input.redirect_uris]);
  return reply.status(201).send({client_id:id,client_name:input.client_name,redirect_uris:input.redirect_uris,grant_types:["authorization_code"],response_types:["code"],token_endpoint_auth_method:"none"});
 });
 app.get("/oauth/authorize",async(req,reply)=>{
  await admit(`oauth-authorize:${req.ip}`,20);const query=authQuery.parse(req.query);
  const client=await clientModel(query.client_id);if(!client||!client.redirectUris.includes(query.redirect_uri)||query.resource!==mcpResource())return reply.status(400).send({error:"invalid_request"});
  query.scope=query.scope??API_SCOPES.join(" ");
  const requestId=randomUUID();await q("INSERT INTO oauth_requests(id,query,expires_at) VALUES($1,$2::jsonb,now()+interval '5 minutes')",[requestId,JSON.stringify(query)]);
  return reply.redirect(`${authOrigin()}/connect?request=${requestId}`);
 });
 app.get<{Params:{id:string}}>("/oauth/requests/:id",async(req,reply)=>{
  const rows=await q<{name:string;scopes:string[];resource:string}>(`SELECT c.name,string_to_array(r.query->>'scope',' ') AS scopes,r.query->>'resource' AS resource FROM oauth_requests r JOIN api_clients c ON c.id=r.query->>'client_id' WHERE r.id=$1 AND r.expires_at>now() AND r.consumed_at IS NULL AND c.revoked_at IS NULL`,[z.string().uuid().parse(req.params.id)]);
  return rows[0]??reply.status(404).send({error:"Request unavailable."});
 });
 app.post("/oauth/consent",async(req,reply)=>{
  const input=z.object({requestId:z.string().uuid(),approve:z.literal(true)}).strict().parse(req.body);
  const owner=await authenticatedOwner(bearer(req.headers.authorization));if(!owner)return reply.status(401).send({error:"wallet_required"});
  const rows=await q<{query:Record<string,string>}>("UPDATE oauth_requests SET consumed_at=now() WHERE id=$1 AND consumed_at IS NULL AND expires_at>now() RETURNING query",[input.requestId]);
  if(!rows[0]) return reply.status(400).send({error:"invalid_request"});
  const query=rows[0].query;if(query.resource!==mcpResource())return reply.status(400).send({error:"invalid_target"});
  const response=new OAuth2Server.Response();
  await oauth.authorize(new OAuth2Server.Request({method:"GET",headers:{},query}),response,{authenticateHandler:{handle:async()=>({id:owner})}});
  return {redirectUrl:response.get("location")};
 });
 app.post("/oauth/token",async(req,reply)=>{
  await admit(`oauth-token:${req.ip}`,30);
  const body=z.object({grant_type:z.literal("authorization_code"),client_id:z.string().max(128),code:z.string().max(512),redirect_uri:z.string().url(),code_verifier:z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/u),resource:z.literal(mcpResource())}).strict().parse(req.body);
  const response=new OAuth2Server.Response();
  await oauth.token(new OAuth2Server.Request({method:"POST",headers:Object.fromEntries(Object.entries(req.headers).filter((entry):entry is [string,string]=>typeof entry[1]==="string")),query:{},body}),response,{requireClientAuthentication:{authorization_code:false}});
  reply.header("Cache-Control","no-store");return response.body;
 });
 app.post("/oauth/revoke",async(req)=>{const input=z.object({token:z.string().max(512),token_type_hint:z.string().optional(),client_id:z.string().optional()}).strict().parse(req.body);await revokeSession(input.token);return {};});
}
