import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { assertExecutionDatabaseTestTarget } from "./execution-db-test-support";
import { appendPublicationDispatch,observePublicationSchedule,publicationExecutionInputHash } from "./publication-dispatch";
import { createHash } from "node:crypto";
import { createExecutionTransfer } from "./execution-transfer";
import { createExecutorControl } from "./executor-control";
import type { ExecutorDomainControl } from "./executor-domain-control";
import { appendExecutionDispatch, readExecutionDispatch } from "./execution-dispatch";
const url=process.env.SERVERLESS_TEST_DATABASE_URL;
const suite=process.env.ALLOW_SERVERLESS_DB_TESTS==="1"&&url?describe:describe.skip;
suite("Revision-bound publication execution",()=>{
 let db:PrismaClient;
 beforeAll(()=>{
  const schema=process.env.SERVERLESS_TEST_DATABASE_SCHEMA??"public";
  assertExecutionDatabaseTestTarget(url,schema);if(!schema.startsWith("serverless_execution_test_"))throw Error("Disposable schema required");
  db=new PrismaClient({adapter:new PrismaPg({connectionString:url,max:4},{schema})});
 });
 afterAll(async()=>{await db?.$disconnect();});
 async function fixture(ready=true){
  const suffix=crypto.randomUUID(),user=await db.user.create({data:{clerkId:`publication-execution:${suffix}`}});
  const workspace=await db.workspace.create({data:{name:"Native publication",ownerUserId:user.id,personalOwnerUserId:user.id,pricingTier:"business"}});
  const project=await db.project.create({data:{workspaceId:workspace.id,createdByUserId:user.id,title:"Publication",sourceMediaUrl:"r2://test/source"}});
  const run=await db.workflowRun.create({data:{projectId:project.id,idempotencyKey:`publication:${suffix}`,stage:"clip_rendering",status:"completed"}});
  const clip=await db.clip.create({data:{projectId:project.id,workflowRunId:run.id,index:0,startSec:0,endSec:30,hookText:"Fixture",reasoning:"Fixture",category:"hook",transcriptSlice:[],viralityScore:80,hookStrengthScore:80,emotionalIntensityScore:80,pacingScore:80,durationOptimalityScore:80,tiktokScore:80,youtubeScore:80,instagramScore:80,llmProvider:"test",llmModel:"test"}});
  const exp=await db.clipExport.create({data:{projectId:project.id,workspaceId:workspace.id,createdByUserId:user.id,clipId:clip.id,editorRevision:clip.editorRevision,fingerprint:suffix,resolution:"1080p",watermark:false,status:ready?"ready":"queued"}});
  const variant=await db.clipExportVariant.create({data:{exportId:exp.id,aspectRatio:"ratio_9_16",resolution:"1080p",watermark:false,status:ready?"completed":"pending",...(ready?{storageKey:`test/${suffix}.mp4`,sizeBytes:1234n,durationSec:30}:{})}});
  const account=await db.socialAccount.create({data:{userId:user.id,workspaceId:workspace.id,createdByUserId:user.id,platform:"youtube_shorts",providerAccountId:suffix,displayName:"Fixture",accessTokenEncrypted:"sealed"}});
  const due=new Date(Date.now()+60000);
  const post=await db.socialPost.create({data:{workspaceId:workspace.id,projectId:project.id,createdByUserId:user.id,clipId:clip.id,socialAccountId:account.id,platform:"youtube_shorts",status:ready?"scheduled":"preparing_video",clientIdempotencyKey:suffix,immutableRequestHash:suffix,caption:"Frozen private copy",scheduledFor:due,frozenState:{create:{clipExportId:exp.id,clipExportVariantId:variant.id,socialAccountId:account.id,platform:"youtube_shorts",editorRevision:clip.editorRevision,exportFingerprint:suffix,aspectRatio:"ratio_9_16",caption:"Frozen private copy",providerSettings:{},capabilityVersion:"fixture",scheduledFor:due,...(ready?{storageKey:variant.storageKey,sizeBytes:variant.sizeBytes,durationSec:30,mediaReadyAt:new Date()}:{})}}},include:{frozenState:true}});
  const id=await db.$transaction(tx=>appendPublicationDispatch(tx,post.id));
  const record=(await readExecutionDispatch(db,id))!;
  await db.executionDispatch.update({where:{id},data:{acknowledgedAt:new Date()}});
  return {post,record,variant};
 }
 test("registration is eligible now while the Workflow sleeps until the frozen due time",async()=>{
  const f=await fixture();
  expect(f.record.nextDeliveryAt<f.post.scheduledFor!).toBe(true);
  expect(f.record.dueAt).toEqual(f.post.scheduledFor!);
  expect(await observePublicationSchedule(db,f.record.reference)).toEqual({kind:"sleep",dueAt:f.post.scheduledFor!});
  expect(await db.socialPublicationAttempt.count({where:{socialPostId:f.post.id}})).toBe(0);
 });
 test("cancellation while asleep atomically fences the old schedule generation",async()=>{
  const f=await fixture();
  await db.socialPost.update({where:{id:f.post.id},data:{status:"cancelled"}});
  const post=await db.socialPost.findUniqueOrThrow({where:{id:f.post.id}});
  expect(post.scheduleRevision).toBe(f.post.scheduleRevision+1);expect(post.generation).toBe(f.post.generation+1);
  expect(await observePublicationSchedule(db,f.record.reference)).toEqual({kind:"superseded"});
  expect(await db.socialPublicationAttempt.count({where:{socialPostId:f.post.id}})).toBe(0);
 });
 test("a changed schedule cannot reuse the earlier due wake",async()=>{
  const f=await fixture(),later=new Date(Date.now()+120000);
  const id=await db.$transaction(async tx=>{await tx.socialPost.update({where:{id:f.post.id},data:{scheduledFor:later}});return appendPublicationDispatch(tx,f.post.id);});
  const newer=(await readExecutionDispatch(db,id))!;
  expect(newer.reference.generation).toBe(f.record.reference.generation+1);
  expect(await observePublicationSchedule(db,f.record.reference)).toEqual({kind:"superseded"});
  expect(await observePublicationSchedule(db,newer.reference)).toEqual({kind:"sleep",dueAt:later});
  await db.executionDispatch.update({where:{id},data:{acknowledgedAt:new Date()}});
 });
 test("export readiness preserves the frozen cycle and creates a targeted wake",async()=>{
  const f=await fixture(false),due=new Date(Date.now()-1000);
  await db.socialPost.update({where:{id:f.post.id},data:{scheduledFor:due}});
  const id=await db.$transaction(tx=>appendPublicationDispatch(tx,f.post.id));
  const waiting=(await readExecutionDispatch(db,id))!;
  expect(await observePublicationSchedule(db,waiting.reference)).toEqual({kind:"waiting_export",clipExportVariantId:f.variant.id});
  const readyId=await db.$transaction(async tx=>{
   await tx.frozenPublicationState.update({where:{socialPostId:f.post.id},data:{storageKey:"test/sealed.mp4",sizeBytes:1234n,durationSec:30,mediaReadyAt:new Date()}});
   await tx.socialPost.update({where:{id:f.post.id},data:{status:"scheduled"}});
   return appendPublicationDispatch(tx,f.post.id,{wakeKind:"export_ready",dueAt:due});
  });
  const ready=(await readExecutionDispatch(db,readyId))!;
  expect(ready.reference.inputHash).toBe(waiting.reference.inputHash);
  const observed=await observePublicationSchedule(db,ready.reference);
  expect(observed.kind).toBe("ready");
  if(observed.kind==="ready")expect(publicationExecutionInputHash(observed.post)).toBe(ready.reference.inputHash);
  await db.executionDispatch.updateMany({where:{id:{in:[id,readyId]}},data:{acknowledgedAt:new Date()}});
 });
 test("publication commands require a started owner and replay one atomic checkpoint plus wake after a lost ACK",async()=>{
  const f=await fixture(),token=crypto.randomUUID(),owner=crypto.randomUUID();
  const attempt=await db.socialPublicationAttempt.create({data:{socialPostId:f.post.id,frozenStateId:f.post.frozenState!.id,attemptNumber:1,idempotencyKey:`publication:${f.post.id}:1`,phase:"claimed",nextActionAt:new Date(),processingDeadline:new Date(Date.now()+3600000),reconciliationDeadline:new Date(Date.now()+7200000)}});
  const dispatch=await db.$transaction(tx=>appendExecutionDispatch(tx,{deploymentEpoch:f.post.deploymentEpoch,generation:f.post.generation,kind:"modal_execution",subject:{kind:"social_publication",id:f.post.id},inputHash:publicationExecutionInputHash(f.post),dueAt:f.post.createdAt}));
  await db.executionAttempt.create({data:{attemptToken:token,dispatchId:dispatch.reference.dispatchId,deploymentEpoch:f.post.deploymentEpoch,generation:f.post.generation,inputHash:dispatch.reference.inputHash,functionName:"publication",operationDeadlineAt:new Date(Date.now()+600000)}});
  let lostAck=true,deliveries=0;
  const domain:ExecutorDomainControl<{id:string}>={
   lockExecution:async(tx)=>{await tx.$queryRaw`SELECT "id" FROM "SocialPost" WHERE "id"=${f.post.id}::uuid FOR UPDATE`;return {kind:"current",ref:{id:attempt.id}};},
   acquireExecution:async()=>undefined,renewExecution:async()=>undefined,startExecution:async(tx)=>{await tx.socialPublicationAttempt.update({where:{id:attempt.id},data:{nativeStartCount:{increment:1}}});},
   commitArtifactExecution:async()=>undefined,failExecution:async()=>undefined,releaseExecution:async()=>undefined,progressExecution:async()=>undefined,
   publicationCommandExecution:async(tx,ref,_context,command)=>{
    if(command.kind!=="provider_call")throw Error("unexpected command");
    await tx.socialPublicationAttempt.update({where:{id:ref.id},data:{providerCallCount:{increment:1}}});
    const id=await appendPublicationDispatch(tx,f.post.id,{dueAt:f.post.createdAt,wakeKind:"provider_call_saved"});
    return {reply:{kind:"recorded"},dispatchIds:[id]};
   },
  };
  const control=createExecutorControl({database:db,subjectKind:"social_publication",domain,deliverWakes:async ids=>{
   deliveries++;await db.executionDispatch.updateMany({where:{id:{in:[...ids]}},data:{acknowledgedAt:new Date()}});if(lostAck)throw Error("lost_wake_ack");
  }});
  const fence={reference:dispatch.reference,attemptToken:token,owner};
  const execute=(command:unknown,deliveryId=crypto.randomUUID())=>control.execute({command,verifiedRequest:{requestHash:createHash("sha256").update(JSON.stringify(command)).digest("hex"),metadata:{version:1,keyId:"fixture",audience:"executor-control",method:"POST",canonicalTarget:"/api/execution/command",bodySha256:"0".repeat(64),timestamp:Math.floor(Date.now()/1000),deliveryId,signature:"0".repeat(64)}}});
  await execute({action:"acquire",reference:dispatch.reference,attemptToken:token,owner,leaseSeconds:120});
  const command={action:"publication-command",fence,command:{kind:"provider_call",operation:"read"}};
  await expect(execute(command)).rejects.toMatchObject({code:"authority_lost"});
  expect((await db.socialPublicationAttempt.findUniqueOrThrow({where:{id:attempt.id}})).providerCallCount).toBe(0);
  await execute({action:"process-start",fence});
  const deliveryId=crypto.randomUUID();
  await expect(execute(command,deliveryId)).rejects.toThrow("lost_wake_ack");
  lostAck=false;
  expect(await execute(command,deliveryId)).toEqual({disposition:"publication_recorded",result:{kind:"recorded"}});
  expect((await db.socialPublicationAttempt.findUniqueOrThrow({where:{id:attempt.id}})).providerCallCount).toBe(1);
  expect(deliveries).toBe(2);
  await expect(execute({...command,command:{kind:"provider_call",operation:"submit"}},deliveryId)).rejects.toMatchObject({code:"replay_conflict"});
  await expect(execute({...command,fence:{...fence,owner:crypto.randomUUID()}})).rejects.toMatchObject({code:"authority_lost"});
  await db.executionAttempt.update({where:{attemptToken:token},data:{leaseExpiresAt:new Date(Date.now()-1000)}});
  expect((await execute(command)).disposition).toBe("expired");
  expect((await db.socialPublicationAttempt.findUniqueOrThrow({where:{id:attempt.id}})).providerCallCount).toBe(1);
  await db.executionDispatch.update({where:{id:dispatch.reference.dispatchId},data:{acknowledgedAt:new Date()}});
 });

 test("publication OAuth and purpose keys remain fresh work-package data and never enter an inbox",async()=>{
  const f=await fixture(),token=crypto.randomUUID(),owner=crypto.randomUUID();
  const dispatch=await db.$transaction(tx=>appendExecutionDispatch(tx,{deploymentEpoch:f.post.deploymentEpoch,generation:f.post.generation,kind:"modal_execution",subject:{kind:"social_publication",id:f.post.id},inputHash:publicationExecutionInputHash(f.post),dueAt:f.post.createdAt}));
  await db.executionAttempt.create({data:{attemptToken:token,dispatchId:dispatch.reference.dispatchId,deploymentEpoch:f.post.deploymentEpoch,generation:f.post.generation,inputHash:dispatch.reference.inputHash,functionName:"publication",operationDeadlineAt:new Date(Date.now()+600000)}});
  const domain:ExecutorDomainControl<string>={lockExecution:async()=>({kind:"current",ref:f.post.id}),acquireExecution:async()=>undefined,renewExecution:async()=>undefined,startExecution:async()=>undefined,commitArtifactExecution:async()=>undefined,failExecution:async()=>undefined,releaseExecution:async()=>undefined,progressExecution:async()=>undefined};
  const control=createExecutorControl({database:db,subjectKind:"social_publication",domain});
  const fence={reference:dispatch.reference,attemptToken:token,owner};
  const verified=(command:unknown,deliveryId=crypto.randomUUID())=>({requestHash:createHash("sha256").update(JSON.stringify(command)).digest("hex"),metadata:{version:1 as const,keyId:"fixture",audience:"executor-control" as const,method:"POST" as const,canonicalTarget:"/api/execution/transfer",bodySha256:"0".repeat(64),timestamp:Math.floor(Date.now()/1000),deliveryId,signature:"0".repeat(64)}});
  const acquire={action:"acquire",reference:dispatch.reference,attemptToken:token,owner,leaseSeconds:120};
  await control.execute({command:acquire,verifiedRequest:verified(acquire)});
  const scope={deploymentEpoch:f.post.deploymentEpoch,socialPostId:f.post.id,attemptId:crypto.randomUUID(),claimId:token,bindingHash:dispatch.reference.inputHash};
  const publication={version:1 as const,inputKey:{key:Buffer.alloc(32,1).toString("base64url"),scope},checkpointKey:{key:Buffer.alloc(32,2).toString("base64url"),scope},account:{id:f.post.socialAccountId!,userId:f.post.createdByUserId!,platform:"youtube_shorts" as const,providerAccountId:"fixture",displayName:"Fixture",handle:null,accessToken:"private-ephemeral-oauth",scopes:[],metadata:null}};
  let resolves=0;
  const transfer=createExecutionTransfer({database:db,authority:control,storage:{} as never,resolvePackage:async()=>{resolves++;return {input:{kind:"inline",command:{kind:"publication"}},sources:[],outputs:[],publication};}});
  const command={action:"work-package",fence},deliveryId=crypto.randomUUID(),request=verified(command,deliveryId);
  const response=await transfer.execute({command,verifiedRequest:request});
  expect(response.disposition).toBe("work_package");
  if(response.disposition==="work_package")expect(response.publication?.account?.accessToken).toBe("private-ephemeral-oauth");
  const receipt=await db.executionInboxReceipt.findUniqueOrThrow({where:{audience_deliveryId:{audience:"executor-control",deliveryId}}});
  expect(receipt.disposition).toEqual({disposition:"transfer_granted"});
  expect(JSON.stringify(receipt.disposition)).not.toContain("private-ephemeral-oauth");
  await db.executionAttempt.update({where:{attemptToken:token},data:{revokedAt:new Date()}});
  await expect(transfer.execute({command,verifiedRequest:request})).rejects.toMatchObject({code:"authority_lost"});
  expect(resolves).toBe(1);
  await db.executionDispatch.update({where:{id:dispatch.reference.dispatchId},data:{acknowledgedAt:new Date()}});
 });

});
