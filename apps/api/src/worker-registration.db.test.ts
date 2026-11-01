import {afterAll,afterEach,beforeAll,describe,expect,test} from 'bun:test';
import {PrismaClient} from '@prisma/client';
import {PrismaPg} from '@prisma/adapter-pg';
import {DatabaseScope} from '@narriflow/db/client';
import {assertExecutionDatabaseTestTarget} from '@narriflow/services/execution-db-test-support';
import {createUploadSessionModule,defaultUploadSessionConfig,prismaUploadSessionPersistence,type UploadSessionStorage} from '@narriflow/services/upload-session.service';
import {withServiceEnvironment} from '@narriflow/services/runtime-environment';
import {executionDispatchIdentity} from '@narriflow/services/execution-dispatch';
import {createMcpTaskRegistry} from '@narriflow/services/mcp-task';
import {getMcpTaskPersistence} from '@narriflow/services/mcp-task-runtime';
import {buildGenerationContentPack} from '@narriflow/validators';
import {NarriflowMcpServer} from '@narriflow/mcp-core/server';
import {installNarriflowTasks} from '@narriflow/mcp-core/tasks';
import {createMcpHandler} from '@modelcontextprotocol/server';
import {z} from 'zod';
import {clipExportService} from '@narriflow/services/clip-export.service';
import {createExportsRoutes} from './domains/exports/routes';
import {createRequestPolicyRuntime} from './http/request-policy-runtime';
import {createInventoryApp} from './test-app';
import {createApiWorker} from './worker';
import {createUploadSessionHttpRoutes} from './domains/ingest/upload-session-http';
import type {ApiWorkerBindings} from './worker-bindings';

const url=process.env.SERVERLESS_TEST_DATABASE_URL;
const suite=process.env.ALLOW_SERVERLESS_DB_TESTS==='1'&&url?describe:describe.skip;
const context={waitUntil(){},passThroughOnException(){}} as unknown as ExecutionContext;
const meta={'io.modelcontextprotocol/protocolVersion':'2026-07-28','io.modelcontextprotocol/clientInfo':{name:'registration-gate',version:'1'},'io.modelcontextprotocol/clientCapabilities':{extensions:{'io.modelcontextprotocol/tasks':{}}}};
function barrier(){let release!:()=>void;const promise=new Promise<void>(resolve=>{release=resolve;});return{promise,release};}
function wire(text:string){return JSON.parse(text.startsWith('{')?text:text.split('\n').find(line=>line.startsWith('data: '))!.slice(6));}

suite('Worker postcommit registration boundary',()=>{
 let db:PrismaClient;const fixtures:Array<{userId:string;workspaceId:string;sessionId:string;projectId:string}>=[];
 beforeAll(()=>{const schema=process.env.SERVERLESS_TEST_DATABASE_SCHEMA!;assertExecutionDatabaseTestTarget(url,schema);db=new PrismaClient({adapter:new PrismaPg({connectionString:url,max:6},{schema}),transactionOptions:{maxWait:10000,timeout:30000}});});
 afterEach(async()=>{for(const f of fixtures.splice(0)){const jobs=await db.ingestJob.findMany({where:{uploadSessionId:f.sessionId},select:{id:true}}),events=await db.workflowEvent.findMany({where:{projectId:f.projectId},select:{id:true}});await db.executionDispatch.deleteMany({where:{subjectId:{in:[f.sessionId,...jobs.map(x=>x.id),...events.map(x=>x.id)]}}});await db.mcpTask.deleteMany({where:{ownerUserId:f.userId}});await db.workspace.delete({where:{id:f.workspaceId}});await db.user.delete({where:{id:f.userId}});}});
 afterAll(async()=>{await db?.$disconnect();});
 const scope=<T>(run:()=>Promise<T>)=>new DatabaseScope({createClient:()=>({client:db,dispose:async()=>{}})}).run(()=>withServiceEnvironment({MEDIA_FETCH_TOOLCHAIN_FINGERPRINT:'f'.repeat(64)},run));
 async function fixture(){
  const user=await db.user.create({data:{clerkId:`worker-registration-${crypto.randomUUID()}`}}),workspace=await db.workspace.create({data:{ownerUserId:user.id,name:'Worker registration'}});let uploaded=false,heads=0;
  const object={sizeBytes:2048,contentType:'video/mp4',etag:'"source"'};
  const module=createUploadSessionModule({config:defaultUploadSessionConfig(),persistence:prismaUploadSessionPersistence,storage:{async grantSinglePut(){return{url:'https://grant.invalid/private'};},async headExactObjectIfExists(){return uploaded?object:null;},async headExactObject(){heads++;return object;}} as UploadSessionStorage,admission:{async resolveBrand(){return null;}},now:()=>new Date(),createId:()=>crypto.randomUUID()});
  const actor={actorUserId:user.id,workspaceId:workspace.id},open={...actor,clientIdempotencyKey:crypto.randomUUID(),title:'Source',source:{fileName:'source.mp4',sizeBytes:2048,contentType:'video/mp4',browserFingerprint:'source'},brandTemplateId:null,generation:{languageCode:null,contentPack:buildGenerationContentPack()},declaredDurationSeconds:120};
  const opened=await scope(()=>module.open(open));if(opened.outcome!=='uploading')throw Error('upload_fixture_missing');uploaded=true;fixtures.push({userId:user.id,workspaceId:workspace.id,sessionId:opened.sessionId,projectId:opened.projectId});
  let fail=true,registrations=0;const entered=barrier();let confirmation:Promise<void>|undefined;
  const bindings={HYPERDRIVE:{connectionString:url},MEDIA_FETCH_TOOLCHAIN_FINGERPRINT:'f'.repeat(64),DEV_CLOUD:{async dispatch(reference:any){if(reference.kind==='import_pipeline'){registrations++;entered.release();if(confirmation)await confirmation;if(fail)throw Error('PRIVATE_PROVIDER_FAILURE_MUST_NOT_ESCAPE');}const row=await db.executionDispatch.findUniqueOrThrow({where:{id:reference.dispatchId}});return{status:row.wakeKind!==null||row.deadlineKind!==null?'confirmed_notified':'confirmed_created',destinationId:(await executionDispatchIdentity(reference)).instanceId};}}} as unknown as ApiWorkerBindings;
  const createScope=()=>new DatabaseScope({createClient:()=>({client:db,dispose:async()=>{}})});
  const finalize=()=>module.finalize({...actor,sessionId:opened.sessionId,parts:[]});
  return{user,workspace,module,open,opened,actor,bindings,createScope,finalize,heads:()=>heads,registrations:()=>registrations,entered,confirm:(promise?:Promise<void>)=>{confirmation=promise;},succeed:()=>{fail=false;},async due(){const row=await db.executionDispatch.findFirstOrThrow({where:{subjectKind:'ingest_job',subjectId:(await db.ingestJob.findUniqueOrThrow({where:{uploadSessionId:opened.sessionId}})).id}});await Bun.sleep(Math.max(0,+row.nextDeliveryAt-Date.now())+10);}};
 }
 test('JSON upload registration failure carries its committed receipt and same-key replay waits for confirmation',async()=>{
  const f=await fixture();const worker=createApiWorker({createScope:f.createScope,createApp:()=>({async fetch(request){const routes=createUploadSessionHttpRoutes({getActor:async()=>f.actor,service:{finalize:async()=>({...await f.finalize(),privateGrant:'https://signed.invalid/PRIVATE_GRANT'})} as never});const response=await routes.fetch(request);response.headers.set('X-Request-ID','same-request');response.headers.set('Access-Control-Allow-Origin','https://web.test');response.headers.set('X-Content-Type-Options','nosniff');response.headers.set('Content-Length','9999');return response;}})});
  const request=()=>new Request('https://api.test/upload-sessions/finalize',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:f.opened.sessionId,parts:[]})});
  const response=await worker.fetch(request(),f.bindings,context),body=await response.json();const job=await db.ingestJob.findUniqueOrThrow({where:{uploadSessionId:f.opened.sessionId}});
  expect(response.status).toBe(503);expect(response.headers.get('Retry-After')).toMatch(/^\d+$/);expect(response.headers.get('X-Request-ID')).toBe('same-request');expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://web.test');expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');expect(response.headers.has('Content-Length')).toBe(false);
  expect(body).toMatchObject({error:'scheduler_registration_pending',details:{retryable:true,receipt:{sessionId:f.opened.sessionId,projectId:job.projectId,queuedJobId:job.id}}});expect(JSON.stringify(body)).not.toContain('PRIVATE_');
  await f.due();f.succeed();const retried=await worker.fetch(request(),f.bindings,context);expect(retried.status).toBe(200);expect(await retried.json()).toMatchObject({sessionId:f.opened.sessionId,projectId:job.projectId,queuedJobId:job.id});expect(await db.ingestJob.findUniqueOrThrow({where:{id:job.id}})).toEqual(job);expect(f.heads()).toBe(1);
 });
 function mcp(f:Awaited<ReturnType<typeof fixture>>,mode:'json'|'sse',produce:ReturnType<typeof barrier>){
  const worker=createApiWorker({createScope:f.createScope,createApp:(_environment,run)=>{const handler=createMcpHandler(()=>{const server=new NarriflowMcpServer({name:'registration-gate',version:'1'},undefined,run);installNarriflowTasks(server,{principal:{kind:'oauth',userId:f.user.id,clientId:'fixture',scopes:['processing:write']},registry:()=>createMcpTaskRegistry({persistence:getMcpTaskPersistence(),authorize:async()=>{},resolve:async()=>({status:'working'}),cancel:async()=>{}})});server.registerTool('narriflow_submit_video',{inputSchema:z.strictObject({clientIdempotencyKey:z.string().uuid()})},async()=>{await produce.promise;const accepted=await f.finalize();if(accepted.outcome!=='queued_for_ingest')throw Error('handoff_missing');return{content:[{type:'text',text:'PRIVATE_TRANSCRIPT'}],structuredContent:{data:{projectId:accepted.projectId,operation:{kind:'intake',id:accepted.queuedJobId},privateGrant:'PRIVATE_GRANT'}},_meta:{'narriflow/operation':{workspaceId:f.workspace.id,domainKind:'intake',domainId:accepted.queuedJobId,projectId:accepted.projectId},privateGrant:'PRIVATE_GRANT'}};});return server;},{responseMode:mode});return{fetch:request=>handler.fetch(request)};}});
  const request=()=>new Request('https://api.test/mcp',{method:'POST',headers:{'Content-Type':'application/json','MCP-Protocol-Version':'2026-07-28','MCP-Method':'tools/call','MCP-Name':'narriflow_submit_video'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'narriflow_submit_video',arguments:{clientIdempotencyKey:f.open.clientIdempotencyKey},_meta:meta}})});
  return{worker,request};
 }
 for(const mode of ['json','sse'] as const)test(`actual SDK ${mode} retains the same Task receipt after postcommit registration failure`,async()=>{
  const f=await fixture(),produce=barrier();if(mode==='json')produce.release();
  const {worker,request}=mcp(f,mode,produce);
  const response=await worker.fetch(request(),f.bindings,context);if(mode==='sse'){expect(response.headers.get('Content-Type')).toContain('text/event-stream');expect(f.registrations()).toBe(0);produce.release();}
  const text=await response.text(),result=wire(text),job=await db.ingestJob.findUniqueOrThrow({where:{uploadSessionId:f.opened.sessionId}}),task=await db.mcpTask.findFirstOrThrow({where:{domainId:job.id}});
  expect(f.registrations()).toBe(1);expect(result.result).toBeUndefined();expect(result.error.data).toMatchObject({error:'scheduler_registration_pending',retryable:true,receipt:{taskId:task.id,projectId:job.projectId,operation:{kind:'intake',id:job.id}}});expect(text).not.toContain('PRIVATE_');expect(f.registrations()).toBe(1);
  await f.due();f.succeed();const replay=wire(await(await worker.fetch(request(),f.bindings,context)).text());expect(replay.result.taskId).toBe(task.id);expect(await db.mcpTask.count({where:{domainId:job.id}})).toBe(1);expect(await db.ingestJob.findUniqueOrThrow({where:{id:job.id}})).toEqual(job);expect(f.heads()).toBe(1);
 });
 test('an actual SDK SSE Task produced after stream-open waits for registration before its result',async()=>{
  const f=await fixture(),produce=barrier(),confirmed=barrier();f.succeed();f.confirm(confirmed.promise);const {worker,request}=mcp(f,'sse',produce);
  const response=await worker.fetch(request(),f.bindings,context);expect(response.headers.get('Content-Type')).toContain('text/event-stream');let finished=false;const body=response.text().then(text=>{finished=true;return text;});produce.release();
  try{expect(await Promise.race([f.entered.promise.then(()=> 'registering'),body.then(()=> 'premature_result')])).toBe('registering');expect(finished).toBe(false);const job=await db.ingestJob.findUniqueOrThrow({where:{uploadSessionId:f.opened.sessionId}});expect((await db.executionDispatch.findFirstOrThrow({where:{subjectKind:'ingest_job',subjectId:job.id,kind:'import_pipeline'}})).acknowledgedAt).toBeNull();confirmed.release();const result=wire(await body);expect(result.error).toBeUndefined();expect(result.result.resultType).toBe('task');expect(result.result.taskId).toBe((await db.mcpTask.findFirstOrThrow({where:{domainId:job.id}})).id);expect((await db.executionDispatch.findFirstOrThrow({where:{subjectKind:'ingest_job',subjectId:job.id,kind:'import_pipeline'}})).acknowledgedAt).not.toBeNull();expect(f.registrations()).toBe(1);expect(await db.ingestJob.findUniqueOrThrow({where:{id:job.id}})).toEqual(job);
  }finally{confirmed.release();await body;}
 });

 async function exportFixture(){
  const f=await fixture();
  await db.workspaceMember.create({data:{workspaceId:f.workspace.id,userId:f.user.id,role:'owner'}});
  await db.workspace.update({where:{id:f.workspace.id},data:{pricingTier:'creator'}});
  await db.project.create({data:{id:f.opened.projectId,workspaceId:f.workspace.id,createdByUserId:f.user.id,title:'Export source',sourceMediaUrl:'r2://fixture/source',sourceDurationSeconds:120,ingestStatus:'ready'}});
  const origin=await db.workflowRun.create({data:{projectId:f.opened.projectId,stage:'moment_detection',status:'completed',idempotencyKey:crypto.randomUUID()}});
  const clip=await db.clip.create({data:{projectId:f.opened.projectId,workflowRunId:origin.id,index:0,startSec:0,endSec:10,hookText:'Export',reasoning:'Fixture',category:'hook',transcriptSlice:[],viralityScore:50,hookStrengthScore:50,emotionalIntensityScore:50,pacingScore:50,durationOptimalityScore:50,tiktokScore:50,youtubeScore:50,instagramScore:50,llmProvider:'fixture',llmModel:'fixture'}});
  const key=crypto.randomUUID(),input={expectedRevision:0,aspectRatios:['9:16' as const],resolution:'720p' as const};
  let fail=true,registrations=0;let entered=barrier();let confirmation:Promise<void>|undefined;
  const bindings={...f.bindings,DEV_CLOUD:{async dispatch(reference:any){if(reference.kind==='render_run'){registrations++;entered.release();if(confirmation)await confirmation;if(fail)throw Error('PRIVATE_EXPORT_PROVIDER_FAILURE');}const row=await db.executionDispatch.findUniqueOrThrow({where:{id:reference.dispatchId}});return{status:row.wakeKind!==null||row.deadlineKind!==null?'confirmed_notified':'confirmed_created',destinationId:(await executionDispatchIdentity(reference)).instanceId};}}} as unknown as ApiWorkerBindings;
  const create=()=>clipExportService.create(f.actor,f.opened.projectId,clip.id,input,key);
  return{...f,clip,key,input,create,bindings,get entered(){return entered;},registrations:()=>registrations,succeed:()=>{fail=false;},confirm:(promise:Promise<void>)=>{confirmation=promise;entered=barrier();},async due(){const exported=await db.clipExport.findFirstOrThrow({where:{clipId:clip.id}}),row=await db.executionDispatch.findFirstOrThrow({where:{kind:'render_run',subjectId:exported.workflowRunId!}});await Bun.sleep(Math.max(0,+row.nextDeliveryAt-Date.now())+10);}};
 }
 test('actual first-party export route retains its receipt on registration failure and confirms identical replay',async()=>{
  const f=await exportFixture();
  const policyRuntime=createRequestPolicyRuntime({authenticate:async()=>({status:'authenticated',identity:{clerkUserId:f.user.clerkId,sessionId:'fixture'}} as never),loadAppUser:async()=>f.user as never,resolveScopedWorkspace:async()=>({userId:f.user.id,workspaceId:f.workspace.id,workspaceName:'Fixture',workspaceOwnerUserId:f.user.id,role:'owner',status:'active',pricingTier:'creator',isPersonal:false,workspaceSelectionChanged:false}),staffAllowlist:new Set(),policy:{resolveProject:async()=>({kind:'active',projectId:f.opened.projectId}),rateLimit:async()=>({allowed:true,availability:'available',retryAfterSeconds:1,limit:12,remaining:11}),now:()=>1000}});
  const worker=createApiWorker({createScope:f.createScope,createApp:()=>createInventoryApp({policyRuntime,domains:{exports:createExportsRoutes({clipExportService} as never)}})});
  const request=()=>new Request(`https://api.test/api/projects/${f.opened.projectId}/clips/${f.clip.id}/exports`,{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer fixture','X-Workspace-Id':f.workspace.id,'Idempotency-Key':f.key},body:JSON.stringify(f.input)});
  const response=await worker.fetch(request(),f.bindings,context),body=await response.json(),receipt=await db.operationReceipt.findFirstOrThrow({where:{clientIdempotencyKey:f.key}}),exported=await db.clipExport.findUniqueOrThrow({where:{id:receipt.resourceId}});
  expect(response.status).toBe(503);expect(body).toMatchObject({error:'scheduler_registration_pending',details:{receipt:{exportId:exported.id,receiptId:receipt.id,operation:{kind:'export',id:exported.id}}}});expect(JSON.stringify(body)).not.toContain('PRIVATE_');
  await f.due();f.succeed();const retried=await worker.fetch(request(),f.bindings,context);expect(retried.status).toBe(202);expect(await retried.json()).toMatchObject({receiptId:receipt.id,replayed:true,export:{id:exported.id}});expect(await db.clipExport.findUniqueOrThrow({where:{id:exported.id}})).toEqual(exported);expect(await db.workflowRun.count({where:{projectId:exported.projectId,stage:'clip_rendering'}})).toBe(1);
 });
 for(const mode of ['json','sse'] as const)test(`actual SDK ${mode} export Task preserves receipt on registration failure and waits for confirmed replay`,async()=>{
  const f=await exportFixture(),produce=barrier();if(mode==='json')produce.release();
  const worker=createApiWorker({createScope:f.createScope,createApp:(_environment,run)=>{const handler=createMcpHandler(()=>{const server=new NarriflowMcpServer({name:'export-registration-gate',version:'1'},undefined,run);installNarriflowTasks(server,{principal:{kind:'oauth',userId:f.user.id,clientId:'fixture',scopes:['processing:write']},registry:()=>createMcpTaskRegistry({persistence:getMcpTaskPersistence(),authorize:async()=>{},resolve:async()=>({status:'working'}),cancel:async()=>{}})});server.registerTool('narriflow_create_clip_export',{inputSchema:z.strictObject({clientIdempotencyKey:z.string().uuid()})},async()=>{await produce.promise;const accepted=await f.create();return{content:[{type:'text',text:'PRIVATE_TRANSCRIPT'}],structuredContent:{data:accepted},_meta:{'narriflow/operation':{workspaceId:f.workspace.id,domainKind:'export',domainId:accepted.export.id,projectId:f.opened.projectId},privateGrant:'PRIVATE_GRANT'}};});return server;},{responseMode:mode});return{fetch:request=>handler.fetch(request)};}});
  const request=()=>new Request('https://api.test/mcp',{method:'POST',headers:{'Content-Type':'application/json','MCP-Protocol-Version':'2026-07-28','MCP-Method':'tools/call','MCP-Name':'narriflow_create_clip_export'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'narriflow_create_clip_export',arguments:{clientIdempotencyKey:f.key},_meta:meta}})});
  const response=await worker.fetch(request(),f.bindings,context);if(mode==='sse'){expect(response.headers.get('Content-Type')).toContain('text/event-stream');expect(f.registrations()).toBe(0);produce.release();}
  const text=await response.text(),result=wire(text),exported=await db.clipExport.findFirstOrThrow({where:{clipId:f.clip.id}}),task=await db.mcpTask.findFirstOrThrow({where:{domainId:exported.id}});
  expect(result.result).toBeUndefined();expect(result.error.data).toMatchObject({error:'scheduler_registration_pending',receipt:{taskId:task.id,operation:{kind:'export',id:exported.id}}});expect(text).not.toContain('PRIVATE_');
  await f.due();f.succeed();const confirmed=barrier();f.confirm(confirmed.promise);let finished=false;
  const replay=worker.fetch(request(),f.bindings,context).then(async response=>{const body=await response.text();finished=true;return wire(body);});
  expect(await Promise.race([f.entered.promise.then(()=> 'registering'),replay.then(()=> 'premature_result')])).toBe('registering');expect(finished).toBe(false);confirmed.release();const replayed=await replay;expect(replayed.error).toBeUndefined();expect(replayed.result.taskId).toBe(task.id);expect(await db.mcpTask.count({where:{domainId:exported.id}})).toBe(1);expect(await db.clipExport.findUniqueOrThrow({where:{id:exported.id}})).toEqual(exported);
 });

});
