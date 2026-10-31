import type { LocalFetchMailbox } from '../../src/durable-objects/local-fetch-mailbox';
export { LocalFetchMailbox } from '../../src/durable-objects/local-fetch-mailbox';
import { createDatabaseScope } from '@narriflow/db/client';
import { createLocalFetchDeviceCodec } from '@narriflow/services/local-fetch-device';
import { signExecutionRequest } from '@narriflow/services/execution-signature';
import { Hono } from 'hono';
import { createLocalDeviceRoutes } from '../../src/domains/execution/local-device';
import { createApiWorker } from '../../src/worker';
import type { ApiWorkerBindings } from '../../src/worker-bindings';

let databaseClients=0, databaseReads=0, databaseDisposals=0;
const api=createApiWorker({
 createApp:()=>new Hono().route('/api',createLocalDeviceRoutes()),
 createScope:()=>createDatabaseScope({createClient(){
  databaseClients++;
  return {client:{ingestJob:{findUnique:async()=>{databaseReads++;return {project:{workspaceId:'00000000-0000-4000-8000-000000000001'},generation:1,jobType:'link_import',payload:{provider:'youtube'}};}}} as never,
   async dispose(){databaseDisposals++;}};
 }}),
});

/** Local-only controls and fixed fake SQL results; all HTTP authentication and
 * the new service's eligibility policy execute inside actual workerd. */
export default {async fetch(request:Request,env:ApiWorkerBindings,ctx:ExecutionContext){
 const url=new URL(request.url);
 if(url.pathname==='/__gates/database')return Response.json({databaseClients,databaseReads,databaseDisposals});
 if(url.pathname==='/api/dev-device/execution/command'||url.pathname==='/api/dev-device/reconcile'||url.pathname==='/api/dev-device/connect-ticket')return api.fetch(request,env,ctx);
 const workspaceId=url.pathname.split('/')[url.pathname.endsWith('/socket')?3:2]!;
 const stub=(env.LOCAL_FETCH_MAILBOX as DurableObjectNamespace<LocalFetchMailbox>).getByName(workspaceId);
 if(url.pathname.endsWith('/socket'))return stub.fetch(request);
 const body=request.method==='POST'?await request.json() as any:{};
 try{
 if(url.pathname.endsWith('/signed-request')){
  const origin=String(env.API_ORIGIN),key=new Uint8Array(32).fill(6);
  const issued=await createLocalFetchDeviceCodec(new Map([['gate',key]])).issue({workspaceId,actorUserId:body.actorUserId,deploymentEpoch:1,apiOrigin:origin},'gate');
  await stub.register(issued.claims);
  const target=body.action==='reconcile'?'/api/dev-device/reconcile':body.action==='connect-ticket'?'/api/dev-device/connect-ticket':'/api/dev-device/execution/command';
  const command=body.action==='reconcile'?{after:'invalid-cursor'}:body.action==='connect-ticket'?{}:{action:'acquire',reference:{dispatchId:crypto.randomUUID(),kind:'local_fetch',subject:{kind:'ingest_job',id:crypto.randomUUID()},deploymentEpoch:1,generation:1,inputHash:'a'.repeat(64)},attemptToken:crypto.randomUUID(),owner:crypto.randomUUID(),leaseSeconds:120};
  const raw=JSON.stringify(command),bytes=new TextEncoder().encode(raw);
  const signature=await signExecutionRequest({keyId:issued.claims.sessionId,key:issued.key,audience:body.wrongAudience?'executor-control':'dev-device',method:'POST',target,body:bytes,timestamp:Math.floor(Date.now()/1000),deliveryId:crypto.randomUUID()});
  return Response.json({target,body:raw,headers:{'Content-Type':'application/json','X-Local-Fetch-Session':issued.token,'X-Execution-Signature':JSON.stringify(signature)}});
 }
 if(url.pathname.endsWith('/register')){await stub.register(body);return Response.json({ok:true});}
 if(url.pathname.endsWith('/ticket'))return Response.json(await stub.connectTicket(body.sessionId));
 if(url.pathname.endsWith('/presence'))return Response.json(await stub.presence());
 if(url.pathname.endsWith('/authorize'))return Response.json(await stub.authorize(body.sessionId));
 if(url.pathname.endsWith('/deliver'))return Response.json(await stub.deliver(body));
 if(url.pathname.endsWith('/revoke')){await stub.revoke(body);return Response.json({ok:true});}
 return new Response(null,{status:404});
 }catch{return Response.json({error:'device_refused'},{status:409});}
}};
