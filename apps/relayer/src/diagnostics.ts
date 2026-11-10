import type {FastifyInstance,FastifyRequest} from "fastify";

// Log constructed records only. OAuth URLs, bodies, headers and Error objects
// can contain credentials, authorization codes and PKCE material.
const reasons=["success","rejected","invalid_client_metadata","invalid_redirect_uri","invalid_scope","invalid_request","invalid_grant","invalid_client","wallet_required","invalid_target","rate_limited","internal_error"] as const;
type Reason=typeof reasons[number];
const details=new WeakMap<FastifyRequest,{reason:Reason;invalidFields?:string[]}>();
const metadataFields=["client_name","redirect_uris","grant_types","response_types","token_endpoint_auth_method","scope"];
export function diagnosticReason(req:FastifyRequest,reason:Reason,invalidFields?:string[]){
 details.set(req,{reason,...(invalidFields?{invalidFields:metadataFields.filter(field=>invalidFields.includes(field))}:{})});
}
export function registerDiagnostics(app:FastifyInstance){
 app.addHook("onResponse",async(req,reply)=>{
  const oauth=req.url.startsWith("/oauth/");
  const publicFailure=reply.statusCode>=400&&(req.url.startsWith("/v1/")||req.url.split("?",1)[0]==="/mcp");
  if(!oauth&&!publicFailure)return;
  const record=details.get(req);
  // Fastify route templates exclude both query values and dynamic path values.
  const route=req.routeOptions.url??(oauth?"/oauth/*":"/public/*");
  const reason=record?.reason??(reply.statusCode>=500?"internal_error":reply.statusCode===429?"rate_limited":reply.statusCode>=400?"rejected":"success");
  console.info(JSON.stringify({event:oauth?"oauth_request":"public_api_error",timestamp:new Date().toISOString(),requestId:req.id,route,method:req.method,status:reply.statusCode,reason,...(record?.invalidFields?{invalidFields:record.invalidFields}:{})}));
 });
}
