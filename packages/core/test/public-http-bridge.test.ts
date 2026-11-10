import {afterEach,it,expect,vi} from 'vitest';
vi.mock('server-only',()=>({}));
vi.mock('next/server',()=>({after:vi.fn()}));
vi.mock('@roque/mcp',()=>({createMcpServer:vi.fn()}));
const {dispatchPublic}=await import('../../../apps/web/src/app/_public-api.js');
afterEach(()=>vi.restoreAllMocks());
it('rejects oversized OAuth registration before dispatch with a standard correlated, redacted error',async()=>{
 const log=vi.spyOn(console,'info').mockImplementation(()=>{}),secret='never-log-request-secrets';
 const request=new Request('https://roque.example/oauth/register?code='+secret,{method:'POST',headers:{authorization:'Bearer '+secret,'x-api-key':secret},body:secret.repeat(1000)});
 const response=await dispatchPublic(request);
 expect(response.status).toBe(413);expect(await response.json()).toEqual({error:'invalid_client_metadata',error_description:'Registration body exceeds 16 KiB.'});
 expect(response.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/u);
 const output=log.mock.calls.flat().join('\n');expect(output).not.toContain(secret);
 expect(JSON.parse(String(log.mock.calls[0][0]))).toMatchObject({requestId:response.headers.get('x-request-id'),route:'/oauth/register',status:413,reason:'invalid_client_metadata'});
 const {createMcpServer}=await import('@roque/mcp');expect(createMcpServer).not.toHaveBeenCalled();
});
