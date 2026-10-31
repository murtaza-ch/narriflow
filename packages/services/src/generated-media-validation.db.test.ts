import { planGeneratedValidationSource } from "./generated-media-validation";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { assertExecutionDatabaseTestTarget } from "./execution-db-test-support";
import { NativeValidationService } from "./native-validation";
import { reserveGenerationUsage } from "./generated-media-usage-ledger";
import { readExecutionDispatch } from "./execution-dispatch";
import { createExecutorControl } from "./executor-control";

const url = process.env.SERVERLESS_TEST_DATABASE_URL;
const dbDescribe = process.env.ALLOW_SERVERLESS_DB_TESTS === "1" && url ? describe : describe.skip;
dbDescribe("Generated image validation and usage settlement", () => {
 let db: PrismaClient;
 beforeAll(()=>{const schema=process.env.SERVERLESS_TEST_DATABASE_SCHEMA??"public";assertExecutionDatabaseTestTarget(url,schema);if(!schema.startsWith("serverless_execution_test_"))throw new Error("Disposable schema required");db=new PrismaClient({adapter:new PrismaPg({connectionString:url,max:4},{schema})});});
 afterAll(async()=>{await db?.$disconnect();});
 async function fixture(){
  const user=await db.user.create({data:{clerkId:`generated-validation:${crypto.randomUUID()}`}});
  const workspace=await db.workspace.create({data:{name:"Generated validation",ownerUserId:user.id,personalOwnerUserId:user.id,pricingTier:"business"}});
  const project=await db.project.create({data:{workspaceId:workspace.id,title:"Generated validation",sourceMediaUrl:"r2://gate/source",ingestStatus:"ready"}});
  const id=crypto.randomUUID(),claimId=crypto.randomUUID();
  const reservation=await db.$transaction(tx=>reserveGenerationUsage(tx,{kind:"image",jobId:id,workspaceId:workspace.id,actorUserId:user.id,pricingTier:"business",now:new Date(),attached:true}));
  await db.generatedMediaJob.create({data:{id,workspaceId:workspace.id,projectId:project.id,createdByUserId:user.id,workspaceOwnerUserId:user.id,actorRole:"owner",actorStatus:"active",pricingTier:"business",isPersonalWorkspace:true,
    idempotencyKey:crypto.randomUUID(),requestFingerprint:"f".repeat(64),protectedPrompt:"protected",promptFingerprint:"p",promptOrigin:"manual",aspectRatio:"9:16",style:"editorial",title:"Generated frame",status:"running",moderationStatus:"pending",usageStatus:"reserved",usageReservationId:reservation.reservationId,
    provider:"openai",providerModel:"gate",providerRef:"openai:gate:1",providerUsageImages:1,providerResultContentType:"image/png",attempt:1,claimId,claimExpiresAt:new Date(Date.now()+120000),promptExpiresAt:new Date(Date.now()+86400000)}});
  const scope={actorUserId:user.id,workspaceId:workspace.id,workspaceOwnerUserId:user.id,isPersonalWorkspace:true,role:"owner" as const,status:"active" as const,pricingTier:"business"};
  const dispatches:string[]=[];
  const service=new NativeValidationService(db,{head:async()=>({contentType:"image/png",sizeBytes:1234,etag:'"staged"'}),register:async ids=>{dispatches.push(...ids);}});
  const input={kind:"visual" as const,key:`workspaces/${workspace.id}/generated-media-attempts/${id}/${claimId}/image.png`,contentType:"image/png" as const,sizeBytes:1234,fingerprint:"a".repeat(64),title:"Generated frame",provenance:"generated" as const};
  await planGeneratedValidationSource(db,{jobId:id,claimId,source:{key:input.key,fingerprint:input.fingerprint,contentType:input.contentType,sizeBytes:input.sizeBytes,sourceClaimLineage:claimId,parentAttempt:1,providerRef:"openai:gate:1"}});
  return {id,claimId,reservation,scope,service,input,dispatches};
 }
 async function prepare(f:Awaited<ReturnType<typeof fixture>>){
  const opened=await f.service.admitGenerated(f.scope,{jobId:f.id,claimId:f.claimId,input:f.input});
  const parent=await db.generatedMediaJob.findUniqueOrThrow({where:{id:f.id}});
  expect(parent.validationJobId).toBe(opened.jobId);expect(parent.status).toBe("waiting");expect(parent.claimId).toBeNull();expect(parent.claimExpiresAt).toBeNull();
  const planned=await f.service.prepareExecution((await readExecutionDispatch(db,f.dispatches[0]!))!.reference);
  if(planned.kind!=="waiting")throw new Error("Expected child wait");
  const {reference,attemptToken}=planned.deadline,owner=crypto.randomUUID(),fence={reference,attemptToken,owner};
  const evidence={kind:"visual" as const,sha256:f.input.fingerprint,byteLength:1234,contentType:"image/png" as const,mediaKind:"image" as const,width:32,height:24,durationSec:null};
  const control=createExecutorControl({database:db,subjectKind:"native_validation",domain:f.service,deliverWakes:async()=>{},artifacts:{head:async assignment=>({etag:'"sealed"',contentType:assignment.contentType,byteLength:assignment.role==="probe"?512n:1234n,sha256:assignment.role==="probe"?"b".repeat(64):f.input.fingerprint}),prepare:async(_assignment,artifact)=>({...artifact,...(artifact.role==="probe"?{evidence}:{})})}});
  const execute=(command:unknown)=>control.execute({command,verifiedRequest:{requestHash:crypto.randomUUID().replaceAll("-","").repeat(2),metadata:{version:1,keyId:"generated-gate",audience:"executor-control",method:"POST",canonicalTarget:"/api/execution/command",bodySha256:"0".repeat(64),timestamp:Math.floor(Date.now()/1000),deliveryId:crypto.randomUUID(),signature:"0".repeat(64)}}});
  await execute({action:"acquire",reference,attemptToken,owner,leaseSeconds:120});await execute({action:"process-start",fence});
  const binary=await db.executionArtifact.create({data:{attemptToken,owner,role:"validated_asset",bindingHash:reference.inputHash,storageKey:`execution/${reference.deploymentEpoch}/${attemptToken}/${owner}/image.png`,contentType:"image/png",maxBytes:1234n,grantExpiresAt:new Date(Date.now()+60000)}});
  const probe=await db.executionArtifact.create({data:{attemptToken,owner,role:"probe",bindingHash:reference.inputHash,storageKey:`execution/${reference.deploymentEpoch}/${attemptToken}/${owner}/probe.json`,contentType:"application/json",maxBytes:65536n,grantExpiresAt:new Date(Date.now()+60000)}});
  const commit=(artifact:typeof binary)=>execute({action:"commit-artifact",fence,artifact:{artifactId:artifact.id,role:artifact.role,bindingHash:reference.inputHash,contentType:artifact.contentType,byteLength:artifact.role==="probe"?512:1234,sha256:artifact.role==="probe"?"b".repeat(64):f.input.fingerprint,etag:'"sealed"'}});
  return {opened,commit,binary,probe};
 }
 test("the child parks its parent without a lease, then publishes and finalizes one reserved generation atomically",async()=>{
  const f=await fixture(),p=await prepare(f);
  await p.commit(p.binary);
  expect(await db.visualAsset.count({where:{createdByUserId:f.scope.actorUserId}})).toBe(0);
  expect((await db.generatedMediaUsageReservation.findUniqueOrThrow({where:{id:f.reservation.reservationId}})).status).toBe("reserved");
  await p.commit(p.probe);
  const parent=await db.generatedMediaJob.findUniqueOrThrow({where:{id:f.id}}),usage=await db.generatedMediaUsageReservation.findUniqueOrThrow({where:{id:f.reservation.reservationId}});
  expect(parent.status).toBe("completed");expect(parent.resultAssetId).not.toBeNull();expect(parent.usageStatus).toBe("finalized");expect(usage.status).toBe("finalized");expect(usage.actualUnits).toBe(1);expect(parent.claimId).toBeNull();
  expect(await db.visualAsset.count({where:{id:parent.resultAssetId!}})).toBe(1);
 });
 test("a restricted Workspace cancels the child and parent before publishing or spending its reservation",async()=>{
  const f=await fixture(),p=await prepare(f);
  await db.workspace.update({where:{id:f.scope.workspaceId},data:{status:"restricted"}});
  await p.commit(p.binary);
  expect((await db.generatedMediaJob.findUniqueOrThrow({where:{id:f.id}})).status).toBe("cancelled");
  expect((await db.generatedMediaUsageReservation.findUniqueOrThrow({where:{id:f.reservation.reservationId}})).status).toBe("released");
  expect(await db.visualAsset.count({where:{createdByUserId:f.scope.actorUserId}})).toBe(0);
 });
 test("a sealed native result and cancellation serialize to one terminal outcome and one credit decision",async()=>{
  const f=await fixture(),p=await prepare(f);
  await p.commit(p.binary);
  await Promise.all([p.commit(p.probe),f.service.cancelGenerated(f.scope,f.id)]);
  const parent=await db.generatedMediaJob.findUniqueOrThrow({where:{id:f.id}}),usage=await db.generatedMediaUsageReservation.findUniqueOrThrow({where:{id:f.reservation.reservationId}});
  const count=await db.visualAsset.count({where:{createdByUserId:f.scope.actorUserId}});
  if(parent.status==="completed"){expect(count).toBe(1);expect(usage.status).toBe("finalized");expect(parent.usageStatus).toBe("finalized");}
  else {expect(parent.status).toBe("cancelled");expect(count).toBe(0);expect(usage.status).toBe("released");expect(parent.usageStatus).toBe("released");}
  await expect((async()=>await db.generatedMediaJob.update({where:{id:f.id},data:{attempt:2}}))()).rejects.toThrow();
 });
 test("a replacement coordinator claim reattaches the original planned source and freezes both lineages",async()=>{
  const f=await fixture(),freshClaim=crypto.randomUUID();
  await db.generatedMediaJob.update({where:{id:f.id},data:{claimId:freshClaim,claimExpiresAt:new Date(Date.now()+120000)}});
  const p=await prepare({...f,claimId:freshClaim});
  const child=await db.nativeValidationJob.findUniqueOrThrow({where:{id:p.opened.jobId}});
  expect(child.input).toMatchObject({generated:{claimLineage:f.claimId,admittingClaimLineage:freshClaim,attempt:1,providerRef:"openai:gate:1"}});
  await f.service.cancelGenerated(f.scope,f.id);
 });
 test("cancelling parked work releases its reservation and rejects every late native commit",async()=>{
  const f=await fixture(),p=await prepare(f);
  await f.service.cancelGenerated(f.scope,f.id);
  expect((await db.generatedMediaJob.findUniqueOrThrow({where:{id:f.id}})).status).toBe("cancelled");
  expect((await db.generatedMediaUsageReservation.findUniqueOrThrow({where:{id:f.reservation.reservationId}})).status).toBe("released");
  await p.commit(p.binary);
  expect(await db.visualAsset.count({where:{createdByUserId:f.scope.actorUserId}})).toBe(0);
  expect((await db.nativeValidationJob.findUniqueOrThrow({where:{id:p.opened.jobId}})).status).toBe("cancelled");
 });
});
