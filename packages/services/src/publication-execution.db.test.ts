import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { assertExecutionDatabaseTestTarget } from "./execution-db-test-support";
import { appendPublicationDispatch,observePublicationSchedule,publicationExecutionInputHash } from "./publication-dispatch";
import { readExecutionDispatch } from "./execution-dispatch";
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
});
