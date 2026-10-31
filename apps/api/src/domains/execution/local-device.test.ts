import {describe,expect,test} from 'bun:test';
import {Hono} from 'hono';
import {createDatabaseScope,withDatabaseScope} from '@narriflow/db/client';
import {withServiceEnvironment} from '@narriflow/services/runtime-environment';
import {createLocalFetchDeviceCodec} from '@narriflow/services/local-fetch-device';
import {signExecutionRequest} from '@narriflow/services/execution-signature';
import {createLocalDeviceRoutes} from './local-device';
const origin='https://api.narriflow.test',rootKey=new Uint8Array(32).fill(6),workspaceId=crypto.randomUUID(),actorUserId=crypto.randomUUID();
const environment={API_ORIGIN:origin,APP_ENV:'development',YOUTUBE_FETCH_MODE:'local',LOCAL_FETCH_WORKSPACE_IDS_JSON:JSON.stringify([workspaceId]),DEV_DEVICE_KEYS_JSON:JSON.stringify({gate:Buffer.from(rootKey).toString('base64')})};
describe('Scoped device HTTP execution',()=>{
 test('wrong audience and tampered credentials reach no PostgreSQL client',async()=>{
  const issued=await createLocalFetchDeviceCodec(new Map([['gate',rootKey]])).issue({workspaceId,actorUserId,apiOrigin:origin,deploymentEpoch:1},'gate');let clients=0;
  const bindings={LOCAL_FETCH_MAILBOX:{getByName:(id:string)=>{expect(id).toBe(workspaceId);return {authorize:async()=>issued.claims};}}};
  const body=new TextEncoder().encode(JSON.stringify({action:'process-start',fence:{reference:{dispatchId:crypto.randomUUID(),deploymentEpoch:1,kind:'local_fetch',subject:{kind:'ingest_job',id:crypto.randomUUID()},generation:1,inputHash:'a'.repeat(64)},attemptToken:crypto.randomUUID(),owner:crypto.randomUUID()}}));
  const target='/api/dev-device/execution/command';
  const signature=await signExecutionRequest({keyId:issued.claims.sessionId,key:issued.key,audience:'executor-control',method:'POST',target,body,timestamp:Math.floor(Date.now()/1000),deliveryId:crypto.randomUUID()});
  const request=(token:string)=>new Request(origin+target,{method:'POST',body,headers:{'Content-Type':'application/json','X-Local-Fetch-Session':token,'X-Execution-Signature':JSON.stringify(signature)}});
  const app=new Hono().route('/api',createLocalDeviceRoutes());
  await withServiceEnvironment(environment,()=>withDatabaseScope(createDatabaseScope({createClient(){clients++;throw new Error('database must not open');}}),async()=>{
   expect((await app.fetch(request(issued.token),bindings)).status).toBe(401);
   expect((await app.fetch(request('invalid.token'),bindings)).status).toBe(401);
  }));expect(clients).toBe(0);
 });
 test('a valid device signature still cannot acquire a job from another workspace',async()=>{
  const issued=await createLocalFetchDeviceCodec(new Map([['gate',rootKey]])).issue({workspaceId,actorUserId,apiOrigin:origin,deploymentEpoch:1},'gate');let reads=0,disposed=0;
  const bindings={LOCAL_FETCH_MAILBOX:{getByName:()=>({authorize:async()=>issued.claims})}};
  const body=new TextEncoder().encode(JSON.stringify({action:'acquire',reference:{dispatchId:crypto.randomUUID(),deploymentEpoch:1,kind:'local_fetch',subject:{kind:'ingest_job',id:crypto.randomUUID()},generation:1,inputHash:'a'.repeat(64)},attemptToken:crypto.randomUUID(),owner:crypto.randomUUID(),leaseSeconds:120}));
  const target='/api/dev-device/execution/command',signature=await signExecutionRequest({keyId:issued.claims.sessionId,key:issued.key,audience:'dev-device',method:'POST',target,body,timestamp:Math.floor(Date.now()/1000),deliveryId:crypto.randomUUID()});
  const app=new Hono().route('/api',createLocalDeviceRoutes());
  await withServiceEnvironment(environment,()=>withDatabaseScope(createDatabaseScope({createClient:()=>({client:{ingestJob:{findUnique:async()=>{reads++;return {project:{workspaceId:crypto.randomUUID()},generation:1,jobType:'link_import',payload:{provider:'youtube'}};}}} as never,async dispose(){disposed++;}})}),async()=>{
   const result=await app.fetch(new Request(origin+target,{method:'POST',body,headers:{'Content-Type':'application/json','X-Local-Fetch-Session':issued.token,'X-Execution-Signature':JSON.stringify(signature)}}),bindings);
   expect(result.status).toBe(409);expect((await result.json()).error).toBe('invalid_reference');
  }));expect(reads).toBe(1);expect(disposed).toBe(1);
 });
});
