import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {writeFile,chmod,realpath} from 'node:fs/promises';
import {dirname,resolve,relative,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {q} from '../packages/core/src/db/index.js';
import {API_SCOPES} from '../packages/core/src/public-api.js';
async function main(){
const name=process.env.API_CLIENT_NAME,out=process.env.API_CLIENT_KEY_FILE;
if(!name||!out||!out.startsWith('/'))throw new Error('Set API_CLIENT_NAME and an absolute private API_CLIENT_KEY_FILE outside the repository.');
const project=await realpath(fileURLToPath(new URL('..',import.meta.url))),parent=await realpath(dirname(out));
const rel=relative(project,resolve(parent));if(!rel||(!rel.startsWith('..')&&!isAbsolute(rel)))throw new Error('Credential files must be outside the repository.');
const key=randomBytes(32).toString('base64url'),id=randomUUID();
await writeFile(out,key+'\n',{mode:0o600,flag:'wx'});await chmod(out,0o600);
await q('INSERT INTO api_clients(id,key_hash,name,scopes,origins) VALUES($1,$2,$3,$4,$5)',[id,createHash('sha256').update(key).digest('hex'),name,API_SCOPES,(process.env.API_CLIENT_ORIGINS??'').split(',').filter(Boolean)]);
console.log(`Registered client ${id}. The application credential is in its private key file.`);
}
main().catch(()=>{console.error("Client registration failed; inspect configuration and retained private key file before retrying.");process.exitCode=1;});
