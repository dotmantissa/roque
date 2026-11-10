import {PGlite} from '@electric-sql/pglite';
import {beforeAll,afterAll,afterEach,it,expect,vi} from 'vitest';
import {createHash} from 'node:crypto';
import {privateKeyToAccount} from 'viem/accounts';
const s=vi.hoisted(()=>({db:null as unknown as PGlite,failRegistration:false}));
vi.mock('../src/db/index.js',async original=>({...await original<typeof import('../src/db/index.js')>(),q:async(t:string,p:unknown[]=[])=>{
 if(s.failRegistration&&t.startsWith('INSERT INTO api_clients'))throw new Error('do-not-log-database-credentials');
 return (await s.db.query(t,p)).rows;
}}));
const {SCHEMA_SQL}=await import('../src/db/index.js');
const {migration0002}=await import('../src/db/migrations/0002-public-api.js');
const {createMcpServer}=await import('../../../apps/mcp/src/server.js');
let app:Awaited<ReturnType<typeof createMcpServer>>;
const wallet=privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
beforeAll(async()=>{s.db=new PGlite();await s.db.exec(SCHEMA_SQL+'\n'+migration0002);process.env.OAUTH_ALLOWED_REDIRECTS='https://claude.example/callback';app=await createMcpServer();},30000);
afterAll(async()=>{await app.close();await s.db.close();});
afterEach(()=>{s.failRegistration=false;vi.restoreAllMocks();});
const callback='https://claude.example/callback';
it('accepts optional names and extra metadata without leaking or granting it',async()=>{
 const reg=await app.inject({method:'POST',url:'/oauth/register',payload:{redirect_uris:[callback],scope:'swaps:read intents:read swaps:read',client_uri:'https://claude.example',software_version:'1.0',client_secret:'ignored-secret',unknown_metadata:{private:'ignored'}}});
 expect(reg.statusCode,reg.body).toBe(201);
 const result=reg.json();expect(result.client_name).toBeTruthy();expect(result.scope).toBe('swaps:read intents:read');
 expect(result.client_secret).toBeUndefined();expect(result.api_key).toBeUndefined();expect(result.client_uri).toBeUndefined();
 const stored=await s.db.query<{scopes:string[];name:string}>('SELECT scopes,name FROM api_clients WHERE id=$1',[result.client_id]);
 expect(stored.rows[0].scopes).toEqual(['swaps:read','intents:read']);expect(stored.rows[0].name).toBe(result.client_name);
 const verifier='x'.repeat(64),challenge=createHash('sha256').update(verifier).digest('base64url');
 const query=new URLSearchParams({client_id:result.client_id,redirect_uri:callback,response_type:'code',code_challenge:challenge,code_challenge_method:'S256',state:'state-with-at-least-16-bytes',resource:'http://localhost:3000/mcp'});
 const auth=await app.inject({method:'GET',url:'/oauth/authorize?'+query});expect(auth.statusCode,auth.body).toBe(302);
 const requestId=new URL(auth.headers.location!).searchParams.get('request');
 const pending=await s.db.query<{scope:string}>("SELECT query->>'scope' AS scope FROM oauth_requests WHERE id=$1",[requestId]);expect(pending.rows[0].scope).toBe(result.scope);
 query.set('scope','swaps:read swaps:prepare');const escalated=await app.inject({method:'GET',url:'/oauth/authorize?'+query});expect(escalated.statusCode).toBe(400);expect(escalated.json().error).toBe('invalid_scope');
});
it('uses all beta scopes when scope is omitted and ignores unsupported metadata',async()=>{
 const reg=await app.inject({method:'POST',url:'/oauth/register',payload:{client_name:'Claude',redirect_uris:[callback],client_uri:'https://claude.example',logo_uri:'https://claude.example/logo.svg'}});
 expect(reg.statusCode,reg.body).toBe(201);expect(reg.json().scope.split(' ')).toEqual(['intents:write','intents:read','quotes:read','swaps:prepare','swaps:read']);
});
it('returns standard registration errors and retains metadata and redirect restrictions',async()=>{
 // Use a separate IP so this validation matrix does not exhaust the registration quota.
 for(const metadata of [{scope:'admin'},{scope:'swaps:read\nintents:read'},{scope:''},{client_name:''},{redirect_uris:[]},{grant_types:[]},{grant_types:['refresh_token']},{response_types:['token']},{token_endpoint_auth_method:'client_secret_basic'}]){
  const r=await app.inject({method:'POST',url:'/oauth/register',remoteAddress:'127.0.0.2',payload:{client_name:'Invalid',redirect_uris:[callback],...metadata}});
  expect(r.statusCode,r.body).toBe(400);expect(r.json().error).toBe('invalid_client_metadata');expect(r.json().error_description).toEqual(expect.any(String));
 }
 const redirect=await app.inject({method:'POST',url:'/oauth/register',remoteAddress:'127.0.0.3',payload:{redirect_uris:[callback,'https://evil.example/callback']}});
 expect(redirect.statusCode).toBe(400);expect(redirect.json().error).toBe('invalid_redirect_uri');
 for(const payload of ['', '{']){
  const r=await app.inject({method:'POST',url:'/oauth/register',remoteAddress:'127.0.0.3',headers:{'content-type':'application/json'},payload});
  expect(r.statusCode).toBe(400);expect(r.json().error).toBe('invalid_client_metadata');
 }
});
it('logs safe correlated registration diagnostics without request secrets or metadata values',async()=>{
 const log=vi.spyOn(console,'info').mockImplementation(()=>{});
 const secret='do-not-log-this-secret';
 const r=await app.inject({method:'POST',url:'/oauth/register?code='+secret,remoteAddress:'127.0.0.4',headers:{authorization:'Bearer '+secret,'x-api-key':secret,'x-request-id':secret},payload:{client_name:secret,redirect_uris:['https://evil.example/callback?token='+secret],client_secret:secret,code_verifier:secret,[secret]:secret}});
 expect(r.statusCode).toBe(400);expect(r.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/u);expect(r.headers['x-request-id']).not.toBe(secret);
 const output=log.mock.calls.flat().join('\n');expect(output).not.toContain(secret);expect(output).not.toContain('evil.example');
 const entry=log.mock.calls.flat().map(value=>JSON.parse(String(value))).find(value=>value.event==='oauth_request');
 expect(entry).toMatchObject({requestId:r.headers['x-request-id'],route:'/oauth/register',method:'POST',status:400,reason:'invalid_redirect_uri'});expect(entry.timestamp).toEqual(expect.any(String));
});
it('reports registration outages safely and generates distinct request IDs',async()=>{
 const log=vi.spyOn(console,'info').mockImplementation(()=>{});s.failRegistration=true;
 const r=await app.inject({method:'POST',url:'/oauth/register',remoteAddress:'127.0.0.6',payload:{redirect_uris:[callback]}});
 expect(r.statusCode).toBe(500);expect(r.json()).toEqual({error:'server_error',error_description:'Registration service unavailable.'});
 expect(log.mock.calls.flat().join('\n')).not.toContain('do-not-log-database-credentials');
 expect(log.mock.calls.flat().map(value=>JSON.parse(String(value)))).toContainEqual(expect.objectContaining({status:500,reason:'internal_error',requestId:r.headers['x-request-id']}));
 const health=await app.inject({method:'GET',url:'/v1/health'});expect(health.headers['x-request-id']).not.toBe(r.headers['x-request-id']);
});
it('preserves the registration quota with a retryable OAuth error',async()=>{
 for(let n=0;n<10;n++)expect((await app.inject({method:'POST',url:'/oauth/register',remoteAddress:'127.0.0.5',payload:{redirect_uris:[callback]}})).statusCode).toBe(201);
 const r=await app.inject({method:'POST',url:'/oauth/register',remoteAddress:'127.0.0.5',payload:{redirect_uris:[callback]}});
 expect(r.statusCode).toBe(429);expect(r.headers['retry-after']).toBe('60');expect(r.json().error).toBe('temporarily_unavailable');
});
it('rejects unregistered redirects, malformed input and unconnected MCP access',async()=>{
 const r=await app.inject({method:'POST',url:'/oauth/register',payload:{client_name:'Bad',redirect_uris:['https://evil.example']}});expect(r.statusCode).toBe(400);
 const invalid=await app.inject({method:'POST',url:'/v1/intents',payload:{bad:true}});expect(invalid.statusCode).toBe(401);
 const unauth=await app.inject({method:'POST',url:'/mcp',headers:{host:'localhost:3000'},payload:{jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'test',version:'1'}}}});expect(unauth.statusCode).toBe(401);expect(unauth.headers['www-authenticate']).toContain('resource_metadata');
});
it('links a wallet, exchanges a PKCE code once, enforces audience and revokes MCP',async()=>{
 const reg=await app.inject({method:'POST',url:'/oauth/register',payload:{client_name:'Connector',redirect_uris:['https://claude.example/callback']}});expect(reg.statusCode).toBe(201);const client=reg.json().client_id;
 const verifier='a'.repeat(64),challenge=createHash('sha256').update(verifier).digest('base64url');
 const query=new URLSearchParams({client_id:client,redirect_uri:'https://claude.example/callback',response_type:'code',code_challenge:challenge,code_challenge_method:'S256',state:'state-with-at-least-16-bytes',resource:'http://localhost:3000/mcp',scope:'intents:write intents:read quotes:read swaps:prepare swaps:read'});
 const auth=await app.inject({method:'GET',url:'/oauth/authorize?'+query});expect(auth.statusCode).toBe(302);const requestId=new URL(auth.headers.location!).searchParams.get('request');
 const c=await app.inject({method:'POST',url:'/auth/challenge',payload:{owner:wallet.address}});expect(c.statusCode).toBe(200);const login=c.json();
 const signature=await wallet.signMessage({message:login.message});
 const sess=await app.inject({method:'POST',url:'/auth/session',payload:{owner:wallet.address,challengeId:login.challengeId,signature}});expect(sess.statusCode).toBe(200);const walletToken=sess.json().token;
 const consent=await app.inject({method:'POST',url:'/oauth/consent',headers:{authorization:'Bearer '+walletToken},payload:{requestId,approve:true}});expect(consent.statusCode,consent.body).toBe(200);
 const redirect=new URL(consent.json().redirectUrl);expect(redirect.searchParams.get('state')).toBe('state-with-at-least-16-bytes');const code=redirect.searchParams.get('code');
 const input={grant_type:'authorization_code',client_id:client,code,redirect_uri:'https://claude.example/callback',code_verifier:verifier,resource:'http://localhost:3000/mcp'};
 const bad=await app.inject({method:'POST',url:'/oauth/token',headers:{'content-type':'application/x-www-form-urlencoded'},payload:new URLSearchParams({...input,code_verifier:'b'.repeat(64)} as Record<string,string>).toString()});expect(bad.statusCode).toBeGreaterThanOrEqual(400);
 // Failed PKCE redemption burns the intercepted code; a new consent is required.
 const again=await app.inject({method:'GET',url:'/oauth/authorize?'+query});
 const freshId=new URL(again.headers.location!).searchParams.get('request');
 const fresh=await app.inject({method:'POST',url:'/oauth/consent',headers:{authorization:'Bearer '+walletToken},payload:{requestId:freshId,approve:true}});
 input.code=new URL(fresh.json().redirectUrl).searchParams.get('code');
 const log=vi.spyOn(app.log,'error');const token=await app.inject({method:'POST',url:'/oauth/token',headers:{'content-type':'application/x-www-form-urlencoded'},payload:new URLSearchParams(input as Record<string,string>).toString()});expect(token.statusCode,token.body+log.mock.calls.map(c=>(c[0] as unknown as Error)?.message).join()).toBe(200);const access=token.json().access_token;expect(access).toBeTruthy();
 expect((await app.inject({method:'POST',url:'/oauth/token',headers:{'content-type':'application/x-www-form-urlencoded'},payload:new URLSearchParams(input as Record<string,string>).toString()})).statusCode).toBeGreaterThanOrEqual(400);
 const {apiContext}=await import('../src/public-api.js');await expect(apiContext(undefined,access,'swaps:read')).rejects.toMatchObject({code:'SESSION_EXPIRED'});
 const headers={host:'localhost:3000',authorization:'Bearer '+access,accept:'application/json, text/event-stream'};
 const init=await app.inject({method:'POST',url:'/mcp',headers,payload:{jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'test',version:'1'}}}});expect(init.statusCode,init.body).toBe(200);
 const list=await app.inject({method:'POST',url:'/mcp',headers,payload:{jsonrpc:'2.0',id:2,method:'tools/list'}});expect(list.statusCode,list.body).toBe(200);expect(list.json().result.tools).toHaveLength(5);
 const tools=await app.inject({method:'POST',url:'/mcp',headers,payload:{jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'roque_list_tokens',arguments:{}}}});expect(tools.statusCode,tools.body).toBe(200);expect(tools.json().result.content[0].text).toContain('rUSDC');
 await app.inject({method:'POST',url:'/oauth/revoke',payload:{token:access}});
 expect((await app.inject({method:'POST',url:'/mcp',headers,payload:{jsonrpc:'2.0',id:4,method:'tools/list'}})).statusCode).toBe(401);
});

it('returns client errors for empty and malformed JSON bodies',async()=>{
 for(const payload of ['', '{']){
  const r=await app.inject({method:'POST',url:'/v1/intents',headers:{'content-type':'application/json'},payload});
  expect(r.statusCode).toBe(400);
  expect(r.json().error.code).toBe('INVALID_REQUEST');
 }
});
