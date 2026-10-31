import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {WebSocket} from 'ws';
import {unstable_dev} from 'wrangler';
const workspaceId=randomUUID(),actorUserId=randomUUID(),sessionId=randomUUID(),origin='https://api.narriflow.test';
const worker=await unstable_dev(fileURLToPath(new URL('./gates/local-fetch-runtime-probe.ts',import.meta.url)),{config:fileURLToPath(new URL('./gates/wrangler.local-fetch-runtime-probe.jsonc',import.meta.url)),local:true,ip:'127.0.0.1',port:0,inspectorPort:0,persist:false,logLevel:'error',vars:{HYPERDRIVE:{connectionString:'postgresql://unused.invalid/no_sql'},DEV_DEVICE_KEYS_JSON:JSON.stringify({gate:Buffer.from(new Uint8Array(32).fill(6)).toString('base64')}),APP_ENV:'development',YOUTUBE_FETCH_MODE:'local',API_ORIGIN:origin,LOCAL_FETCH_WORKSPACE_IDS_JSON:JSON.stringify([workspaceId])},experimental:{disableExperimentalWarning:true,disableDevRegistry:true,watch:false}});
const sockets:WebSocket[]=[],checks:string[]=[];
async function post(action:string,body:unknown,space=workspaceId){return worker.fetch(`/control/${space}/${action}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});}
async function json(action:string,body:unknown={}){const r=await post(action,body);assert.equal(r.status,200);return r.json() as Promise<any>;}
function connect(ticket:string){const socket=new WebSocket(`ws://${worker.address}:${worker.port}/api/dev-device/${workspaceId}/socket?ticket=${ticket}`,{headers:{Origin:origin}});sockets.push(socket);const frames:any[]=[];socket.on('message',x=>{try{frames.push(JSON.parse(x.toString()));}catch{frames.push(x.toString());}});const opened=new Promise<number>((resolve,reject)=>{socket.once('open',()=>resolve(101));socket.once('unexpected-response',(_,r)=>{r.resume();resolve(r.statusCode!);});socket.once('error',reject);});return {socket,frames,opened};}
async function until(test:()=>boolean){for(let i=0;i<100&&!test();i++)await new Promise(r=>setTimeout(r,20));assert.ok(test());}
try{
 const issuedAt=Date.now(),claims={version:1,keyId:'gate',sessionId,workspaceId,actorUserId,deploymentEpoch:1,apiOrigin:origin,issuedAt,expiresAt:issuedAt+7200000};
 assert.equal((await post('register',claims,randomUUID())).status,409);checks.push('workspace_allowlist_and_mailbox_identity');
 await json('register',claims);assert.equal((await json('presence')).available,false);
 const ticket=await json('ticket',{sessionId}),live=connect(ticket.ticket);assert.equal(await live.opened,101);await until(()=>live.frames.some(x=>x.type==='connected'));
 assert.equal((await json('presence')).available,true);assert.equal(await connect(ticket.ticket).opened,401);checks.push('one_use_ticket_and_connected_presence');
 const pong=new Promise<string>(resolve=>live.socket.once('message',x=>resolve(x.toString())));live.socket.send('ping');assert.equal(await pong,'pong');assert.equal((await json('presence')).available,true);checks.push('hibernating_ping_without_postgres');
 const reference={dispatchId:randomUUID(),kind:'local_fetch',subject:{kind:'ingest_job',id:randomUUID()},deploymentEpoch:1,generation:1,inputHash:'a'.repeat(64)},invocation={reference,attemptToken:randomUUID()};
 await json('deliver',invocation);await until(()=>live.frames.some(x=>x.type==='fetch'));assert.deepEqual(live.frames.find(x=>x.type==='fetch').reference,reference);
 assert.equal((await post('deliver',{...invocation,reference:{...reference,deploymentEpoch:2}})).status,409);checks.push('reference_only_delivery_and_epoch_fencing');
 await json('revoke',{workspaceId,actorUserId:randomUUID(),authorizedBefore:Date.now()});assert.equal((await json('authorize',{sessionId})).sessionId,sessionId);
 await json('revoke',{workspaceId,actorUserId,authorizedBefore:Date.now()});assert.equal((await post('authorize',{sessionId})).status,409);assert.equal((await json('presence')).available,false);checks.push('membership_revocation_and_wrong_actor_isolation');
 async function signed(action:string,wrongAudience=false){
  const descriptor=await json('signed-request',{action,wrongAudience,actorUserId}) as {target:string;body:string;headers:Record<string,string>};
  return worker.fetch(descriptor.target,{method:'POST',headers:descriptor.headers,body:descriptor.body});
 }
 assert.equal((await signed('command',true)).status,401);
 assert.equal((await signed('reconcile')).status,400);
 assert.deepEqual(await (await worker.fetch('/__gates/database')).json(),{databaseClients:0,databaseReads:0,databaseDisposals:0});
 checks.push('http_signature_and_cursor_before_database');
 const foreign=await signed('command');assert.equal(foreign.status,409);assert.equal((await foreign.json() as {error:string}).error,'invalid_reference');
 assert.deepEqual(await (await worker.fetch('/__gates/database')).json(),{databaseClients:1,databaseReads:1,databaseDisposals:1});
 checks.push('http_service_foreign_workspace_refusal_and_scope_disposal');
 assert.equal((await signed('connect-ticket')).status,200);
 assert.deepEqual(await (await worker.fetch('/__gates/database')).json(),{databaseClients:1,databaseReads:1,databaseDisposals:1});
 checks.push('signed_connect_ticket_uses_real_mailbox_without_sql');
 console.log(JSON.stringify({runtime:'workerd',checks,passed:checks.length,postgresConnections:0,fakeSqlClientScopes:1}));
}finally{for(const s of sockets)s.terminate();await worker.stop();}
