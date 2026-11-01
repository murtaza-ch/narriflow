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
import {clipService} from '@narriflow/services/clip.service';
import {campaignOperationService} from '@narriflow/services/campaign-operation.service';
import {createClipsRoutes} from './domains/clips/routes';
import {RenderFixtureLifecycle} from '@narriflow/services/render-group-test-fixture';
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
const fixtureReleases=new Set<()=>void>();
function barrier(){let resolve!:()=>void;const promise=new Promise<void>(settle=>{resolve=settle;});const release=()=>{fixtureReleases.delete(release);resolve();};fixtureReleases.add(release);return{promise,release};}
function wire(text:string){return JSON.parse(text.startsWith('{')?text:text.split('\n').find(line=>line.startsWith('data: '))!.slice(6));}

suite('Worker postcommit registration boundary',()=>{
 const activeScopes=new Set<Promise<unknown>>();
 class FixtureDatabaseScope extends DatabaseScope{
  override run<T>(operation:()=>T|Promise<T>):Promise<T>{const pending=super.run(operation);activeScopes.add(pending);pending.then(()=>activeScopes.delete(pending),()=>activeScopes.delete(pending));return pending;}
 }
 let db:PrismaClient;const fixtures:Array<{userId:string;workspaceId:string;sessionId:string;projectId:string}>=[];
 beforeAll(()=>{const schema=process.env.SERVERLESS_TEST_DATABASE_SCHEMA!;assertExecutionDatabaseTestTarget(url,schema);db=new PrismaClient({adapter:new PrismaPg({connectionString:url,max:6},{schema}),transactionOptions:{maxWait:10000,timeout:30000}});});
 async function cleanupFixtures(){const owned=fixtures.splice(0),pending=[...activeScopes];for(const release of [...fixtureReleases])release();await Promise.allSettled(pending);for(const f of owned){const jobs=await db.ingestJob.findMany({where:{uploadSessionId:f.sessionId},select:{id:true}}),events=await db.workflowEvent.findMany({where:{projectId:f.projectId},select:{id:true}});await db.executionDispatch.deleteMany({where:{subjectId:{in:[f.sessionId,...jobs.map(x=>x.id),...events.map(x=>x.id)]}}});await db.mcpTask.deleteMany({where:{ownerUserId:f.userId}});await db.workspace.delete({where:{id:f.workspaceId}});await db.user.delete({where:{id:f.userId}});}}
 afterEach(cleanupFixtures);
 afterAll(async()=>{await db?.$disconnect();});
 // Registration tests control only dispatch retry eligibility in their disposable
 // fixture. Production backoff and all domain clocks/budgets remain unchanged.
 async function readyDispatch(id:string){
  const row=await db.executionDispatch.findUniqueOrThrow({where:{id}});
  expect(row.acknowledgedAt).toBeNull();expect(row.deliveryToken).toBeNull();expect(row.deliveryAttempts).toBeGreaterThan(0);expect(row.errorCode).toBe('scheduler_unavailable');expect(row.nextDeliveryAt.getTime()).toBeGreaterThan(row.createdAt.getTime());
  await db.executionDispatch.update({where:{id},data:{nextDeliveryAt:new Date(0)}});
 }
 const scope=<T>(run:()=>Promise<T>)=>new FixtureDatabaseScope({createClient:()=>({client:db,dispose:async()=>{}})}).run(()=>withServiceEnvironment({MEDIA_FETCH_TOOLCHAIN_FINGERPRINT:'f'.repeat(64)},run));
 async function fixture(){
  const user=await db.user.create({data:{clerkId:`worker-registration-${crypto.randomUUID()}`}}),workspace=await db.workspace.create({data:{ownerUserId:user.id,name:'Worker registration'}});let uploaded=false,heads=0;
  const object={sizeBytes:2048,contentType:'video/mp4',etag:'"source"'};
  const module=createUploadSessionModule({config:defaultUploadSessionConfig(),persistence:prismaUploadSessionPersistence,storage:{async grantSinglePut(){return{url:'https://grant.invalid/private'};},async headExactObjectIfExists(){return uploaded?object:null;},async headExactObject(){heads++;return object;}} as UploadSessionStorage,admission:{async resolveBrand(){return null;}},now:()=>new Date(),createId:()=>crypto.randomUUID()});
  const actor={actorUserId:user.id,workspaceId:workspace.id},open={...actor,clientIdempotencyKey:crypto.randomUUID(),title:'Source',source:{fileName:'source.mp4',sizeBytes:2048,contentType:'video/mp4',browserFingerprint:'source'},brandTemplateId:null,generation:{languageCode:null,contentPack:buildGenerationContentPack()},declaredDurationSeconds:120};
  const opened=await scope(()=>module.open(open));if(opened.outcome!=='uploading')throw Error('upload_fixture_missing');uploaded=true;fixtures.push({userId:user.id,workspaceId:workspace.id,sessionId:opened.sessionId,projectId:opened.projectId});
  let fail=true,registrations=0;const entered=barrier();let confirmation:Promise<void>|undefined;
  const bindings={HYPERDRIVE:{connectionString:url},MEDIA_FETCH_TOOLCHAIN_FINGERPRINT:'f'.repeat(64),DEV_CLOUD:{async dispatch(reference:any){if(reference.kind==='import_pipeline'){registrations++;entered.release();if(confirmation)await confirmation;if(fail)throw Error('PRIVATE_PROVIDER_FAILURE_MUST_NOT_ESCAPE');}const row=await db.executionDispatch.findUniqueOrThrow({where:{id:reference.dispatchId}});return{status:row.wakeKind!==null||row.deadlineKind!==null?'confirmed_notified':'confirmed_created',destinationId:(await executionDispatchIdentity(reference)).instanceId};}}} as unknown as ApiWorkerBindings;
  const createScope=()=>new FixtureDatabaseScope({createClient:()=>({client:db,dispose:async()=>{}})});
  const finalize=()=>module.finalize({...actor,sessionId:opened.sessionId,parts:[]});
  return{user,workspace,module,open,opened,actor,bindings,createScope,finalize,heads:()=>heads,registrations:()=>registrations,entered,confirm:(promise?:Promise<void>)=>{confirmation=promise;},succeed:()=>{fail=false;},async due(){const job=await db.ingestJob.findUniqueOrThrow({where:{uploadSessionId:opened.sessionId}}),row=await db.executionDispatch.findFirstOrThrow({where:{kind:'import_pipeline',subjectKind:'ingest_job',subjectId:job.id,deploymentEpoch:job.deploymentEpoch,generation:job.generation,wakeKind:null,deadlineKind:null}});await readyDispatch(row.id);}};
 }
 test('fixture cleanup waits for an owned request before deleting its Workspace',async()=>{
  const f=await fixture();let resume!:()=>void;const external=new Promise<void>(resolve=>{resume=resolve;});let completed=false;
  const pending=scope(async()=>{await external;await db.workspace.update({where:{id:f.workspace.id},data:{name:'Completed owned request'}});completed=true;});
  const cleanup=cleanupFixtures();let observation:string;
  try{observation=await Promise.race([cleanup.then(()=> 'cleanup_finished'),Bun.sleep(25).then(()=> 'request_pending')]);}
  finally{resume();await Promise.allSettled([pending,cleanup]);}
  expect(observation!).toBe('request_pending');expect(completed).toBe(true);expect(await db.workspace.findUnique({where:{id:f.workspace.id}})).toBeNull();expect(activeScopes.size).toBe(0);
 });
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
  await f.due();f.succeed();const replay=wire(await(await worker.fetch(request(),f.bindings,context)).text());expect(replay.error && {code:replay.error.code,error:replay.error.data?.error}).toBeUndefined();expect(replay.result.taskId).toBe(task.id);expect(await db.mcpTask.count({where:{domainId:job.id}})).toBe(1);expect(await db.ingestJob.findUniqueOrThrow({where:{id:job.id}})).toEqual(job);expect(f.heads()).toBe(1);
 });
 test('an actual SDK SSE Task produced after stream-open waits for registration before its result',async()=>{
  const f=await fixture(),produce=barrier(),confirmed=barrier();f.succeed();f.confirm(confirmed.promise);const {worker,request}=mcp(f,'sse',produce);
  const response=await worker.fetch(request(),f.bindings,context);expect(response.headers.get('Content-Type')).toContain('text/event-stream');let finished=false;const body=response.text().then(text=>{finished=true;return text;});produce.release();
  try{expect(await Promise.race([f.entered.promise.then(()=> 'registering'),body.then(()=> 'premature_result')])).toBe('registering');expect(finished).toBe(false);const job=await db.ingestJob.findUniqueOrThrow({where:{uploadSessionId:f.opened.sessionId}});expect((await db.executionDispatch.findFirstOrThrow({where:{subjectKind:'ingest_job',subjectId:job.id,kind:'import_pipeline'}})).acknowledgedAt).toBeNull();confirmed.release();const result=wire(await body);expect(result.error).toBeUndefined();expect(result.result.resultType).toBe('task');expect(result.result.taskId).toBe((await db.mcpTask.findFirstOrThrow({where:{domainId:job.id}})).id);expect((await db.executionDispatch.findFirstOrThrow({where:{subjectKind:'ingest_job',subjectId:job.id,kind:'import_pipeline'}})).acknowledgedAt).not.toBeNull();expect(f.registrations()).toBe(1);expect(await db.ingestJob.findUniqueOrThrow({where:{id:job.id}})).toEqual(job);
  }finally{confirmed.release();await body;}
 });

 async function exportFixture(kind: "render_run" | "operation_driver" = "render_run"){
  const f=await fixture();
  await db.workspaceMember.create({data:{workspaceId:f.workspace.id,userId:f.user.id,role:'owner'}});
  await db.workspace.update({where:{id:f.workspace.id},data:{pricingTier:'creator'}});
  await db.project.create({data:{id:f.opened.projectId,workspaceId:f.workspace.id,createdByUserId:f.user.id,title:'Export source',sourceMediaUrl:'r2://fixture/source',sourceDurationSeconds:120,ingestStatus:'ready'}});
  const origin=await db.workflowRun.create({data:{projectId:f.opened.projectId,stage:'moment_detection',status:'completed',idempotencyKey:crypto.randomUUID()}});
  const clip=await db.clip.create({data:{projectId:f.opened.projectId,workflowRunId:origin.id,index:0,startSec:0,endSec:10,hookText:'Export',reasoning:'Fixture',category:'hook',transcriptSlice:[],viralityScore:50,hookStrengthScore:50,emotionalIntensityScore:50,pacingScore:50,durationOptimalityScore:50,tiktokScore:50,youtubeScore:50,instagramScore:50,llmProvider:'fixture',llmModel:'fixture'}});
  const key=crypto.randomUUID(),input={expectedRevision:0,aspectRatios:['9:16' as const],resolution:'720p' as const};
  let fail=true,registrations=0;let entered=barrier();let confirmation:Promise<void>|undefined;
  const bindings={...f.bindings,DEV_CLOUD:{async dispatch(reference:any){if(reference.kind===kind){registrations++;entered.release();if(confirmation)await confirmation;if(fail)throw Error('PRIVATE_EXPORT_PROVIDER_FAILURE');}const row=await db.executionDispatch.findUniqueOrThrow({where:{id:reference.dispatchId}});return{status:row.wakeKind!==null||row.deadlineKind!==null?'confirmed_notified':'confirmed_created',destinationId:(await executionDispatchIdentity(reference)).instanceId};}}} as unknown as ApiWorkerBindings;
  const create=()=>clipExportService.create(f.actor,f.opened.projectId,clip.id,input,key);
  return{...f,clip,key,input,create,bindings,get entered(){return entered;},registrations:()=>registrations,succeed:()=>{fail=false;},fail:()=>{fail=true;entered=barrier();confirmation=undefined;},confirm:(promise:Promise<void>)=>{confirmation=promise;entered=barrier();},async due(){const exported=await db.clipExport.findFirstOrThrow({where:{clipId:clip.id}}),run=await db.workflowRun.findUniqueOrThrow({where:{id:exported.workflowRunId!}}),row=await db.executionDispatch.findFirstOrThrow({where:{kind:'render_run',subjectKind:'workflow_run',subjectId:run.id,deploymentEpoch:run.deploymentEpoch,generation:run.generation,wakeKind:null,deadlineKind:null}});await readyDispatch(row.id);}};
 }
 test('actual bundle route retains its accepted receipt and waits for same-driver replay confirmation',async()=>{
  const f=await exportFixture('operation_driver');await db.workspace.update({where:{id:f.workspace.id},data:{pricingTier:'business'}});
  const frozen=await db.clipExport.create({data:{projectId:f.opened.projectId,clipId:f.clip.id,editorRevision:0,fingerprint:crypto.randomUUID(),resolution:'1080p',watermark:false,status:'ready'}});
  await db.clipExportVariant.create({data:{exportId:frozen.id,aspectRatio:'ratio_9_16',resolution:'1080p',watermark:false,status:'completed',storageKey:'fixture/frozen.mp4',sizeBytes:3n,durationSec:10}});
  const policyRuntime=createRequestPolicyRuntime({authenticate:async()=>({status:'authenticated',identity:{clerkUserId:f.user.clerkId,sessionId:'fixture'}} as never),loadAppUser:async()=>f.user as never,resolveScopedWorkspace:async()=>({userId:f.user.id,workspaceId:f.workspace.id,workspaceName:'Fixture',workspaceOwnerUserId:f.user.id,role:'owner',status:'active',pricingTier:'business',isPersonal:false,workspaceSelectionChanged:false}),staffAllowlist:new Set(),policy:{resolveProject:async()=>({kind:'active',projectId:f.opened.projectId}),rateLimit:async()=>({allowed:true,availability:'available',retryAfterSeconds:1,limit:12,remaining:11}),now:()=>1000}});
  const worker=createApiWorker({createScope:f.createScope,createApp:()=>createInventoryApp({policyRuntime,domains:{exports:createExportsRoutes({campaignOperationService} as never)}})});
  const request=()=>new Request(`https://api.test/api/projects/${f.opened.projectId}/export-bundles`,{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer fixture','X-Workspace-Id':f.workspace.id,'Idempotency-Key':f.key},body:JSON.stringify({clips:[{clipId:f.clip.id,expectedEditorRevision:0}],aspectRatios:['9:16'],resolution:'1080p'})});
  const failed=await worker.fetch(request(),f.bindings,context),body=await failed.json();
  const operation=await db.campaignOperation.findFirstOrThrow({where:{workspaceId:f.workspace.id,idempotencyKey:f.key}}),bundle=await db.exportBundle.findUniqueOrThrow({where:{operationId:operation.id}}),run=await db.workflowRun.findUniqueOrThrow({where:{id:bundle.workflowRunId}});
  expect(failed.status).toBe(503);expect(body).toMatchObject({error:'scheduler_registration_pending',details:{receipt:{operationId:operation.id,workflowRunId:run.id}}});expect(JSON.stringify(body)).not.toContain('PRIVATE_');
  const dispatch=await db.executionDispatch.findFirstOrThrow({where:{kind:'operation_driver',subjectId:run.id,wakeKind:null,deadlineKind:null}});await readyDispatch(dispatch.id);f.succeed();const confirmed=barrier();f.confirm(confirmed.promise);let finished=false;
  const replay=worker.fetch(request(),f.bindings,context).then(async response=>{const body=await response.json();finished=true;return{status:response.status,body};});
  try{expect(await Promise.race([f.entered.promise.then(()=> 'registering'),replay.then(()=> 'premature_result')])).toBe('registering');expect(finished).toBe(false);}finally{confirmed.release();}
  const result=await replay;expect(result.status).toBe(202);expect(result.body).toMatchObject({operationId:operation.id,workflowRunId:run.id,replayed:true});expect(await db.campaignOperation.findUniqueOrThrow({where:{id:operation.id}})).toEqual(operation);expect(await db.exportBundle.findUniqueOrThrow({where:{id:bundle.id}})).toEqual(bundle);expect(await db.workflowRun.findUniqueOrThrow({where:{id:run.id}})).toEqual(run);expect(await db.executionAttempt.count({where:{dispatch:{subjectId:run.id}}})).toBe(0);expect((await db.executionDispatch.findUniqueOrThrow({where:{id:dispatch.id}})).acknowledgedAt).not.toBeNull();
 });
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

 test('actual retry route sequential replay recollects the committed retry run before a positive response',async()=>{
  const f=await exportFixture(),accepted=await scope(f.create),lifecycle=new RenderFixtureLifecycle({prisma:db});
  await scope(async()=>{const exported=await db.clipExport.findUniqueOrThrow({where:{id:accepted.export.id}}),parent=await lifecycle.renderParent(exported.workflowRunId!),member=await db.clipRender.findFirstOrThrow({where:{clipId:f.clip.id}});await lifecycle.failClipRenderVariant(parent,member.id,'render_output_invalid','permanent');await lifecycle.settleRenderWorkSet(parent);});
  const policyRuntime=createRequestPolicyRuntime({authenticate:async()=>({status:'authenticated',identity:{clerkUserId:f.user.clerkId,sessionId:'fixture'}} as never),loadAppUser:async()=>f.user as never,resolveScopedWorkspace:async()=>({userId:f.user.id,workspaceId:f.workspace.id,workspaceName:'Fixture',workspaceOwnerUserId:f.user.id,role:'owner',status:'active',pricingTier:'creator',isPersonal:false,workspaceSelectionChanged:false}),staffAllowlist:new Set(),policy:{resolveProject:async()=>({kind:'active',projectId:f.opened.projectId}),rateLimit:async()=>({allowed:true,availability:'available',retryAfterSeconds:1,limit:12,remaining:11}),now:()=>1000}});
  const worker=createApiWorker({createScope:f.createScope,createApp:()=>createInventoryApp({policyRuntime,domains:{exports:createExportsRoutes({clipExportService} as never)}})});
  const request=()=>new Request(`https://api.test/api/projects/${f.opened.projectId}/clips/${f.clip.id}/exports/${accepted.export.id}/retry`,{method:'POST',headers:{'Authorization':'Bearer fixture','X-Workspace-Id':f.workspace.id}});
  const failed=await worker.fetch(request(),f.bindings,context);expect(failed.status).toBe(503);expect(await failed.json()).toMatchObject({error:'scheduler_registration_pending',details:{receipt:{exportId:accepted.export.id,operation:{kind:'export',id:accepted.export.id}}}});
  const exported=await db.clipExport.findUniqueOrThrow({where:{id:accepted.export.id}}),run=await db.workflowRun.findUniqueOrThrow({where:{id:exported.workflowRunId!}}),render=await db.clipRender.findFirstOrThrow({where:{clipId:f.clip.id}});
  expect(exported.retryCount).toBe(1);await f.due();f.succeed();const confirmed=barrier();f.confirm(confirmed.promise);let finished=false;
  const replay=worker.fetch(request(),f.bindings,context).then(async response=>{const body=await response.json();finished=true;return{status:response.status,body};});
  try{expect(await Promise.race([f.entered.promise.then(()=> 'registering'),replay.then(()=> 'premature_result')])).toBe('registering');expect(finished).toBe(false);}finally{confirmed.release();}
  const result=await replay;expect(result.status).toBe(202);expect(result.body.id).toBe(exported.id);expect(await db.clipExport.findUniqueOrThrow({where:{id:exported.id}})).toEqual(exported);expect(await db.workflowRun.findUniqueOrThrow({where:{id:run.id}})).toEqual(run);expect(await db.clipRender.findUniqueOrThrow({where:{id:render.id}})).toEqual(render);
 });

 function renderWorker(f:Awaited<ReturnType<typeof exportFixture>>,actor=f.user){
  const policyRuntime=createRequestPolicyRuntime({authenticate:async()=>({status:'authenticated',identity:{clerkUserId:actor.clerkId,sessionId:'fixture'}} as never),loadAppUser:async()=>actor as never,resolveScopedWorkspace:async()=>({userId:actor.id,workspaceId:f.workspace.id,workspaceName:'Fixture',workspaceOwnerUserId:f.user.id,role:actor.id===f.user.id?'owner':'editor',status:'active',pricingTier:'creator',isPersonal:false,workspaceSelectionChanged:false}),staffAllowlist:new Set(),policy:{resolveProject:async()=>({kind:'active',projectId:f.opened.projectId}),rateLimit:async()=>({allowed:true,availability:'available',retryAfterSeconds:1,limit:20,remaining:19}),now:()=>1000}});
  return createApiWorker({createScope:f.createScope,createApp:()=>createInventoryApp({policyRuntime,domains:{clips:createClipsRoutes({clipService,campaignOperationService} as never)}})});
 }
 function renderRequest(f:Awaited<ReturnType<typeof exportFixture>>,key:string,selected=false){return new Request(`https://api.test/api/projects/${f.opened.projectId}/clips/render`,{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer fixture','X-Workspace-Id':f.workspace.id,'Idempotency-Key':key},body:JSON.stringify({aspectRatios:['9:16'],resolution:'720p',...(selected?{clipIds:[f.clip.id]}:{})})});}
 for(const selected of [false,true])test(`actual ${selected?'selected CampaignOperation':'all-clips'} render route confirms the same receipt after registration failure`,async()=>{
  const f=await exportFixture(),worker=renderWorker(f),key=crypto.randomUUID();
  const first=await worker.fetch(renderRequest(f,key,selected),f.bindings,context),body=await first.json();expect(first.status).toBe(503);expect(JSON.stringify(body)).not.toContain('PRIVATE_');
  const receipt=await db.operationReceipt.findFirstOrThrow({where:{workspaceId:f.workspace.id,command:'render_clips',clientIdempotencyKey:key}}),run=await db.workflowRun.findUniqueOrThrow({where:{id:receipt.resourceId}}),native=selected?await db.campaignOperation.findFirstOrThrow({where:{workspaceId:f.workspace.id,action:'render_selected'}}):null;
  expect(body).toMatchObject({error:'scheduler_registration_pending',details:{receipt:{workflowRunId:run.id}}});if(native)expect(native.status).toBe('completed');
  const dispatch=await db.executionDispatch.findFirstOrThrow({where:{kind:'render_run',subjectId:run.id}});await readyDispatch(dispatch.id);f.succeed();const confirmed=barrier();f.confirm(confirmed.promise);let finished=false;
  const replay=worker.fetch(renderRequest(f,key,selected),f.bindings,context).then(async response=>{const body=await response.json();finished=true;return{status:response.status,body};});
  try{expect(await Promise.race([f.entered.promise.then(()=> 'registering'),replay.then(()=> 'premature_result')])).toBe('registering');expect(finished).toBe(false);}finally{confirmed.release();}
  const result=await replay;expect(result.status).toBe(202);expect(result.body.workflowRunId).toBe(run.id);expect(await db.workflowRun.findUniqueOrThrow({where:{id:run.id}})).toEqual(run);expect(await db.operationReceipt.count({where:{workspaceId:f.workspace.id,command:'render_clips'}})).toBe(1);if(native)expect(await db.campaignOperation.findUniqueOrThrow({where:{id:native.id}})).toEqual(native);
 });
 test('actual unwrapped all-clips HTTP alias replay after terminal retains one charged start',async()=>{
  const f=await exportFixture(),worker=renderWorker(f),initial=crypto.randomUUID(),alias=crypto.randomUUID();f.succeed();
  const first=await worker.fetch(renderRequest(f,initial),f.bindings,context);expect(first.status).toBe(202);const original=await first.json();
  const sharedResponse=await worker.fetch(renderRequest(f,alias),f.bindings,context);expect(sharedResponse.status).toBe(202);const shared=await sharedResponse.json();expect(shared.workflowRunId).toBe(original.workflowRunId);
  const lifecycle=new RenderFixtureLifecycle({prisma:db});await scope(async()=>{const parent=await lifecycle.renderParent(original.workflowRunId),member=await db.clipRender.findFirstOrThrow({where:{clipId:f.clip.id}});await lifecycle.markClipRenderVariantRendering(parent,member.id);await lifecycle.completeClipRenderVariant(parent,member.id,{storageKey:'fixture/completed',sizeBytes:1000,durationSec:10});await lifecycle.settleRenderWorkSet(parent);});
  const completed=await db.clipRender.findFirstOrThrow({where:{clipId:f.clip.id}});expect(completed.status).toBe('completed');expect(completed.storageKey).toBeTruthy();
  const replay=await worker.fetch(renderRequest(f,alias),f.bindings,context);expect(replay.status).toBe(202);expect(await replay.json()).toEqual(shared);
  expect(await db.workflowRun.count({where:{projectId:f.opened.projectId,stage:'clip_rendering'}})).toBe(1);expect((await db.renderGroup.findMany({where:{workflowRunId:original.workflowRunId}})).reduce((sum,group)=>sum+group.chargedAttemptCount,0)).toBe(1);expect(await db.clipRender.findFirstOrThrow({where:{clipId:f.clip.id}})).toEqual(completed);
 });

 for(const selected of [false,true])test(`actual ${selected?'CampaignOperation':'all-clips'} replay repairs only its queued/unfrozen exact drain before positive response`,async()=>{
  const f=await exportFixture(),worker=renderWorker(f),key=crypto.randomUUID(),lifecycle=new RenderFixtureLifecycle({prisma:db});f.succeed();
  const parent=await scope(async()=>{const active=await lifecycle.admit({projectId:f.opened.projectId,stage:'clip_rendering',idempotencyKey:'frozen-parent'}),parent=await lifecycle.renderParent(active.id);expect((await lifecycle.beginRenderWorkSet(parent)).variantIds).toEqual([]);return parent;});
  const initial=await worker.fetch(renderRequest(f,key,selected),f.bindings,context);expect(initial.status).toBe(202);const accepted=await initial.json();expect(accepted.workflowRunId).toBe(parent.workflowRunId);
  const outcome=await scope(()=>lifecycle.settleRenderWorkSet(parent)),drain=await db.workflowRun.findUniqueOrThrow({where:{id:outcome.followUpWorkflowRunId!}}),member=await db.clipRender.findFirstOrThrow({where:{clipId:f.clip.id}});
  expect(drain.renderWorkSetFrozenAt).toBeNull();expect(member.workflowRunId).toBeNull();f.fail();
  const failed=await worker.fetch(renderRequest(f,key,selected),f.bindings,context),failure=await failed.json();expect(failed.status).toBe(503);expect(failure).toMatchObject({error:'scheduler_registration_pending',details:{receipt:{workflowRunId:parent.workflowRunId}}});
  const dispatch=await db.executionDispatch.findFirstOrThrow({where:{kind:'render_run',subjectId:drain.id}});expect(dispatch.acknowledgedAt).toBeNull();await readyDispatch(dispatch.id);f.succeed();const confirmed=barrier();f.confirm(confirmed.promise);let finished=false;
  const replay=worker.fetch(renderRequest(f,key,selected),f.bindings,context).then(async response=>{const body=await response.json();finished=true;return{status:response.status,body};});
  try{expect(await Promise.race([f.entered.promise.then(()=> 'registering'),replay.then(()=> 'premature_result')])).toBe('registering');expect(finished).toBe(false);}finally{confirmed.release();}
  const result=await replay;expect(result.status).toBe(202);expect(result.body.workflowRunId).toBe(accepted.workflowRunId);expect(await db.workflowRun.findUniqueOrThrow({where:{id:drain.id}})).toEqual(drain);expect(await db.clipRender.findUniqueOrThrow({where:{id:member.id}})).toEqual(member);expect(await db.renderGroup.count({where:{workflowRunId:drain.id}})).toBe(0);expect((await db.executionDispatch.findUniqueOrThrow({where:{id:dispatch.id}})).acknowledgedAt).not.toBeNull();
 });

 test('actual HTTP refuses another authorized actor continuing a pending campaign after caller loss and terminal render',async()=>{
  const f=await exportFixture(),worker=renderWorker(f),initial=crypto.randomUUID(),key=crypto.randomUUID();f.succeed();const first=await worker.fetch(renderRequest(f,initial),f.bindings,context),accepted=await first.json();expect(first.status).toBe(202);
  const base=db;db=base.$extends({query:{campaignOperation:{updateMany:async({args,query})=>{if(['completed','partial','failed'].includes(String(args.data.status)))throw Error('caller lost before campaign result');return query(args);}}}}) as unknown as PrismaClient;
  try{await expect(scope(()=>campaignOperationService.renderSelected({...f.actor,projectId:f.opened.projectId,pricingTier:'creator',idempotencyKey:key,clipIds:[f.clip.id],aspectRatios:['9:16'],resolution:'720p',execute:ids=>clipService.triggerClipRendering(f.actor,f.opened.projectId,key,ids,['9:16'],'720p')}))).rejects.toThrow('caller lost before campaign result');}finally{db=base;}
  const lifecycle=new RenderFixtureLifecycle({prisma:db});await scope(async()=>{const parent=await lifecycle.renderParent(accepted.workflowRunId),member=await db.clipRender.findFirstOrThrow({where:{clipId:f.clip.id}});await lifecycle.completeClipRenderVariant(parent,member.id,{storageKey:'fixture/completed',sizeBytes:1000,durationSec:10});await lifecycle.settleRenderWorkSet(parent);});
  const pending=await db.campaignOperation.findFirstOrThrow({where:{workspaceId:f.workspace.id,action:'render_selected'}});await db.campaignOperation.update({where:{id:pending.id},data:{leaseExpiresAt:new Date(Date.now()-1)}});const before=await db.campaignOperation.findUniqueOrThrow({where:{id:pending.id}});
  const other=await db.user.create({data:{clerkId:`other-render-actor:${crypto.randomUUID()}`}});await db.workspaceMember.create({data:{workspaceId:f.workspace.id,userId:other.id,role:'editor'}});
  const otherWorker=renderWorker(f,other),refused=await otherWorker.fetch(renderRequest(f,key,true),f.bindings,context);expect(refused.status).toBe(403);expect(await refused.json()).toMatchObject({error:'campaign_operation_forbidden'});expect(await db.campaignOperation.findUniqueOrThrow({where:{id:pending.id}})).toEqual(before);expect(await db.operationReceipt.count({where:{workspaceId:f.workspace.id,actorUserId:other.id}})).toBe(0);
  const recovered=await worker.fetch(renderRequest(f,key,true),f.bindings,context);expect(recovered.status).toBe(202);expect(await recovered.json()).toMatchObject({workflowRunId:accepted.workflowRunId,operationId:pending.id});
  const sharedCompleted=await otherWorker.fetch(renderRequest(f,key,true),f.bindings,context);expect(sharedCompleted.status).toBe(202);expect(await sharedCompleted.json()).toMatchObject({workflowRunId:accepted.workflowRunId,operationId:pending.id});expect(await db.workflowRun.count({where:{projectId:f.opened.projectId,stage:'clip_rendering'}})).toBe(1);expect((await db.renderGroup.findMany({where:{workflowRunId:accepted.workflowRunId}})).reduce((sum,group)=>sum+group.chargedAttemptCount,0)).toBe(1);
 });

});
