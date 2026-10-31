import { afterAll,beforeAll,describe,expect,test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { assertExecutionDatabaseTestTarget } from "./execution-db-test-support";
import { createHash } from "node:crypto";
import { ExportBundleExecution,createExportBundleExecution } from "./export-bundle-execution";
import { createExecutionStorage } from "./execution-storage";
import { WorkflowRunLifecycle } from "./workflow-run-lifecycle";
import { withServiceEnvironment } from "./runtime-environment";
import { expireExportBundle } from "./export-bundle-expiry";
import { mediaCleanupObjectRetainUntil } from "./media-cleanup-holds";

const url=process.env.SERVERLESS_TEST_DATABASE_URL;
const suite=process.env.ALLOW_SERVERLESS_DB_TESTS==="1"&&url?describe:describe.skip;
suite("Targeted export bundle execution",()=>{
  let db:PrismaClient;
  beforeAll(()=>{
    const schema=process.env.SERVERLESS_TEST_DATABASE_SCHEMA!;
    assertExecutionDatabaseTestTarget(url,schema);
    db=new PrismaClient({adapter:new PrismaPg({connectionString:url,max:4},{schema}),transactionOptions:{timeout:30000,maxWait:10000}});
  });
  afterAll(async()=>{await db?.$disconnect();});
  async function fixture(options:{acceptedAt?:Date;expiresAt?:Date;write?:(storageKey:string,bytes:Uint8Array)=>Promise<void>}={}){
    const acceptedAt=options.acceptedAt??new Date();
    const user=await db.user.create({data:{clerkId:`bundle-execution:${crypto.randomUUID()}`}});
    const workspace=await db.workspace.create({data:{ownerUserId:user.id,name:"Bundle gate",pricingTier:"business"}});
    const project=await db.project.create({data:{workspaceId:workspace.id,title:"Bundle gate",sourceMediaUrl:"r2://frozen/source",ingestStatus:"ready"}});
    const epoch=(await db.executionEpoch.findUniqueOrThrow({where:{id:1}})).epoch;
    const run=await db.workflowRun.create({data:{projectId:project.id,stage:"export_bundle",status:"queued",deploymentEpoch:epoch,idempotencyKey:crypto.randomUUID(),createdAt:acceptedAt}});
    const clip=await db.clip.create({data:{projectId:project.id,workflowRunId:run.id,index:0,startSec:0,endSec:4,hookText:"Bundle fixture",reasoning:"Fixture",category:"hook",transcriptSlice:[],viralityScore:50,hookStrengthScore:50,emotionalIntensityScore:50,pacingScore:50,durationOptimalityScore:50,tiktokScore:50,youtubeScore:50,instagramScore:50,llmProvider:"fixture",llmModel:"fixture",editorRevision:1}});
    const frozen=await db.clipExport.create({data:{projectId:project.id,workspaceId:workspace.id,clipId:clip.id,editorRevision:1,fingerprint:crypto.randomUUID(),resolution:"1080p",watermark:false,status:"ready"}});
    const variant=await db.clipExportVariant.create({data:{exportId:frozen.id,aspectRatio:"ratio_9_16",resolution:"1080p",watermark:false,status:"completed",storageKey:`projects/${project.id}/exports/${frozen.id}.mp4`,sizeBytes:3n,durationSec:4}});
    const operation=await db.campaignOperation.create({data:{workspaceId:workspace.id,projectId:project.id,actorUserId:user.id,action:"export_bundle",idempotencyKey:crypto.randomUUID(),requestFingerprint:"a".repeat(64),validatedOptions:{},pricingTier:"business",requestedCount:1,workflowRunId:run.id,createdAt:acceptedAt}});
    await db.campaignOperationItem.create({data:{operationId:operation.id,requestedClipId:clip.id,clipId:clip.id,expectedEditorRevision:1,exportId:frozen.id,status:"pending"}});
    const bundle=await db.exportBundle.create({data:{operationId:operation.id,workflowRunId:run.id,deploymentEpoch:epoch,createdAt:acceptedAt,expiresAt:options.expiresAt??new Date(Date.now()+86_400_000),operationDeadlineAt:new Date(acceptedAt.getTime()+45*60_000),manifest:{schemaVersion:1,operationId:operation.id,projectId:project.id,createdAt:operation.createdAt.toISOString(),
      included:[{clipId:clip.id,exportId:frozen.id,editorRevision:1,files:[{variantId:variant.id,aspectRatio:"9:16",name:"project/001-fixture/9x16.mp4",sizeBytes:3}]}],excluded:[]}}});
    const workflow=withServiceEnvironment({},()=>new WorkflowRunLifecycle({prisma:db}));
    const reference=(await db.$transaction(tx=>workflow.dispatchRunWithinTransaction(tx,run.id))).reference;
    const objects=new Map<string,Uint8Array>(),registered:string[]=[];
    const service=new ExportBundleExecution(db,{toolchainFingerprint:"a".repeat(64),register:async ids=>{registered.push(...ids);},head:async storageKey=>({storageKey,etag:'"source"',byteLength:3,sha256:createHash("sha256").update("abc").digest("hex")}),
      inputStorage:{write:async(storageKey,bytes)=>{
        await db.$transaction(tx=>tx.$queryRaw`SELECT id FROM "WorkflowRun" WHERE id=${run.id}::uuid FOR UPDATE NOWAIT`);
        expect(await db.executionDispatch.count({where:{subjectId:run.id,deadlineKind:"operation"}})).toBeGreaterThan(0);
        await options.write?.(storageKey,bytes);
        objects.set(storageKey,bytes.slice());return {etag:'"capsule"',byteLength:bytes.length,sha256:createHash("sha256").update(bytes).digest("hex")};
      },read:async object=>objects.get(object.storageKey)!}});
    return {user,workspace,project,run,operation,bundle,variant,service,reference,objects,registered};
  }
  test("concurrent targeted preparation seals one capsule and one Generic Attempt after its absolute watchdog commits",async()=>{
    const f=await fixture();
    try{
      const [first,second]=await withServiceEnvironment({},()=>Promise.all([f.service.prepareExecution(f.reference),f.service.prepareExecution(f.reference)]));
      expect(first.kind).toBe("waiting");expect(second).toEqual(first);
      const row=await db.exportBundle.findUniqueOrThrow({where:{id:f.bundle.id}});
      expect(row.inputStorageKey).not.toBeNull();expect(f.objects.has(row.inputStorageKey!)).toBe(true);
      const attempts=await db.executionAttempt.findMany({where:{dispatch:{subjectId:f.run.id,kind:"modal_execution"}}});
      expect(attempts).toHaveLength(1);expect(attempts[0]).toMatchObject({functionName:"export_bundle",owner:null,status:"admitted",inputStorageKey:row.inputStorageKey,operationDeadlineAt:row.operationDeadlineAt});
      expect(await db.workflowRun.findUniqueOrThrow({where:{id:f.run.id}})).toMatchObject({attemptId:null,leaseOwner:null,attemptCount:0});
      const writes=f.objects.size;expect(await withServiceEnvironment({},()=>f.service.prepareExecution(f.reference))).toEqual(first);expect(f.objects.size).toBe(writes);
    }finally{await db.executionAttempt.deleteMany({where:{dispatch:{subjectId:f.run.id}}});await db.executionDispatch.deleteMany({where:{OR:[{subjectId:f.run.id},{subjectId:f.project.id}]}});await db.workspace.delete({where:{id:f.workspace.id}});await db.user.delete({where:{id:f.user.id}});}
  });
  test("an elapsed accepted deadline settles without a capsule, native token or invented process history",async()=>{
    const f=await fixture({acceptedAt:new Date(Date.now()-46*60_000)});
    try{
      expect(await withServiceEnvironment({},()=>f.service.prepareExecution(f.reference))).toEqual({kind:"terminal"});
      expect(await db.executionDispatch.count({where:{subjectId:f.run.id,deadlineKind:"operation"}})).toBe(1);
      expect(await db.executionAttempt.count({where:{dispatch:{subjectId:f.run.id}}})).toBe(0);
      expect(f.objects.size).toBe(0);
      expect(await db.exportBundle.findUniqueOrThrow({where:{id:f.bundle.id}})).toMatchObject({status:"failed",errorCode:"operation_deadline_exceeded"});
      expect(await db.workflowRun.findUniqueOrThrow({where:{id:f.run.id}})).toMatchObject({status:"failed",attemptCount:0,attemptId:null,leaseOwner:null});
      expect(await db.campaignOperation.findUniqueOrThrow({where:{id:f.operation.id}})).toMatchObject({status:"failed",failedCount:1});
    }finally{await db.executionDispatch.deleteMany({where:{subjectId:f.run.id}});await db.workspace.delete({where:{id:f.workspace.id}});await db.user.delete({where:{id:f.user.id}});}
  });
  test("failed private input I/O leaves an absolute watchdog that settles the accepted row without native history",async()=>{
    const f=await fixture({acceptedAt:new Date(Date.now()-45*60_000+1000),write:async()=>{await Bun.sleep(1100);throw Error('capsule_write_failed');}});
    try{
      await expect(withServiceEnvironment({},()=>f.service.prepareExecution(f.reference))).rejects.toThrow('capsule_write_failed');
      const watch=await db.executionDispatch.findFirstOrThrow({where:{subjectId:f.run.id,deadlineKind:'operation'}});
      const {readExecutionDispatch}=await import('./execution-dispatch');const record=await readExecutionDispatch(db,watch.id);
      expect(await withServiceEnvironment({},()=>f.service.expirePreparationDeadline(record!.reference,{kind:'operation',observedDeadlineAt:watch.observedDeadlineAt!}))).toMatchObject({kind:'expired'});
      expect(await db.exportBundle.findUniqueOrThrow({where:{id:f.bundle.id}})).toMatchObject({status:'failed',inputStorageKey:null,errorCode:'operation_deadline_exceeded'});
      expect(await db.workflowRun.findUniqueOrThrow({where:{id:f.run.id}})).toMatchObject({status:'failed',attemptCount:0,attemptId:null});
      expect(await db.executionAttempt.count({where:{dispatch:{subjectId:f.run.id}}})).toBe(0);
    }finally{await db.executionDispatch.deleteMany({where:{subjectId:f.run.id}});await db.workspace.delete({where:{id:f.workspace.id}});await db.user.delete({where:{id:f.user.id}});}
  });
  test("a private capsule already granted to cleanup cannot be adopted after an unknown delete clears its claim",async()=>{
    const f=await fixture({write:async storageKey=>{await db.mediaCleanupObligation.updateMany({where:{objectKey:storageKey},data:{attemptCount:1,claimId:null,claimExpiresAt:null}});}});
    try{
      await expect(withServiceEnvironment({},()=>f.service.prepareExecution(f.reference))).rejects.toThrow('The tentative object is no longer available for adoption');
      expect(await db.exportBundle.findUniqueOrThrow({where:{id:f.bundle.id}})).toMatchObject({status:'queued',inputStorageKey:null});
      expect(await db.executionAttempt.count({where:{dispatch:{subjectId:f.run.id}}})).toBe(0);
      expect(await db.executionDispatch.count({where:{subjectId:f.run.id,deadlineKind:'operation'}})).toBe(1);
    }finally{await db.executionDispatch.deleteMany({where:{subjectId:f.run.id}});await db.workspace.delete({where:{id:f.workspace.id}});await db.user.delete({where:{id:f.user.id}});}
  });
  test("the assigned ZIP and campaign settle atomically, and a lost wake acknowledgment replays the same committed receipt",async()=>{
    const f=await fixture({expiresAt:new Date(Date.now()-180_000)});const receiptIds:string[]=[];
    try{
      const prepared=await withServiceEnvironment({},()=>f.service.prepareExecution(f.reference));
      if(prepared.kind!=="waiting")throw Error("Expected prepared bundle");
      const owner=crypto.randomUUID(),fence={reference:prepared.deadline.reference,attemptToken:prepared.deadline.attemptToken,owner};
      const verified=(target="/api/execution/command")=>{const deliveryId=crypto.randomUUID();receiptIds.push(deliveryId);return {requestHash:crypto.randomUUID().replaceAll("-","").repeat(2),metadata:{version:1 as const,keyId:"bundle-gate",audience:"executor-control" as const,method:"POST" as const,canonicalTarget:target,bodySha256:"0".repeat(64),timestamp:Math.floor(Date.now()/1000),deliveryId,signature:"0".repeat(64)}};};
      let loseAcknowledgment=false;const wakes:string[]=[];
      const execution=createExportBundleExecution({database:db,domain:f.service,storage:createExecutionStorage({accountId:"a".repeat(32),bucket:"bundle-gate",accessKeyId:"not-a-real-key",secretAccessKey:"not-a-real-secret"}),
        deliverWakes:async ids=>{wakes.push(...ids);if(loseAcknowledgment){loseAcknowledgment=false;throw Error("lost_wake_ack");}},
        artifacts:{head:async assignment=>({etag:'"zip"',contentType:assignment.contentType,byteLength:12345n})}});
      const send=(command:unknown,request=verified())=>withServiceEnvironment({},()=>execution.control.execute({command,verifiedRequest:request}));
      expect((await send({action:"acquire",...fence,leaseSeconds:120})).disposition).toBe("acquired");
      const packageReply=await withServiceEnvironment({},()=>execution.transfer.execute({command:{action:"work-package",fence},verifiedRequest:verified("/api/execution/transfer")}));
      if(packageReply.disposition!=="work_package")throw Error("Expected assigned bundle package");
      expect(packageReply.sources).toEqual([]);expect(packageReply.input.kind).toBe("object");expect(packageReply.outputs).toHaveLength(1);
      const output=packageReply.outputs[0]!;
      expect(output.role).toBe("export_bundle");
      await send({action:"process-start",fence});
      const artifact={artifactId:output.artifactId,role:"export_bundle",bindingHash:output.bindingHash,contentType:"application/zip",byteLength:12345,etag:'"zip"',sha256:"c".repeat(64)};
      const command={action:"commit-artifact",fence,artifact},request=verified();loseAcknowledgment=true;
      await expect(send(command,request)).rejects.toThrow("lost_wake_ack");
      const bundle=await db.exportBundle.findUniqueOrThrow({where:{id:f.bundle.id}});
      const assigned=await db.executionArtifact.findUniqueOrThrow({where:{id:artifact.artifactId}});
      expect(bundle).toMatchObject({status:"completed",storageKey:assigned.storageKey,sizeBytes:12345n,checksumSha256:"c".repeat(64)});
      expect(assigned.committedAt).not.toBeNull();
      expect(await db.campaignOperation.findUniqueOrThrow({where:{id:f.operation.id}})).toMatchObject({status:"completed",succeededCount:1,failedCount:0});
      expect(await db.workflowRun.findUniqueOrThrow({where:{id:f.run.id}})).toMatchObject({status:"completed",attemptCount:1,leaseOwner:null});
      const firstWakes=[...wakes];expect(await send(command,request)).toEqual({disposition:"committed",artifactId:artifact.artifactId});
      expect(wakes.length).toBeGreaterThan(firstWakes.length);
      expect(await db.workflowEvent.count({where:{workflowRunId:f.run.id,status:"completed"}})).toBe(1);
      const expiry=await db.executionDispatch.findMany({where:{subjectKind:'export_bundle',subjectId:f.bundle.id,kind:'maintenance'}});
      expect(expiry).toHaveLength(1);expect(expiry[0]).toMatchObject({dueAt:f.bundle.expiresAt,observedDeadlineAt:f.bundle.expiresAt,deadlineKind:'operation'});
      expect(await db.$transaction(tx=>expireExportBundle(tx,f.bundle.id,new Date(f.bundle.expiresAt!.getTime()+1)))).toEqual({kind:'superseded'});
      expect((await db.exportBundle.findUniqueOrThrow({where:{id:f.bundle.id}})).storageKey).toBe(assigned.storageKey);
      const result=await db.$transaction(tx=>expireExportBundle(tx,f.bundle.id,f.bundle.expiresAt!));
      expect(result.kind).toBe('expired');
      expect(await db.exportBundle.findUniqueOrThrow({where:{id:f.bundle.id}})).toMatchObject({status:'expired',storageKey:null,sizeBytes:12345n,checksumSha256:'c'.repeat(64)});
      const cleanup=await db.mediaCleanupObligation.findUniqueOrThrow({where:{origin_cleanupClass_objectKey:{origin:'assigned_execution_artifact',cleanupClass:'assigned_artifact',objectKey:assigned.storageKey}}});
      expect(cleanup.nextAttemptAt.getTime()).toBeGreaterThanOrEqual(f.bundle.expiresAt!.getTime()+120_000);
      const afterDrain=new Date(prepared.deadline.observedDeadlineAt);afterDrain.setTime(afterDrain.getTime()+121_000);
      expect(await db.$transaction(tx=>mediaCleanupObjectRetainUntil(tx,cleanup,afterDrain))).toBeNull();
      const replay=await db.$transaction(tx=>expireExportBundle(tx,f.bundle.id,f.bundle.expiresAt!));
      expect(replay).toEqual(result);
      expect(await db.mediaCleanupObligation.count({where:{objectKey:assigned.storageKey}})).toBe(1);
    }finally{
      await db.executionInboxReceipt.deleteMany({where:{deliveryId:{in:receiptIds}}});await db.executionArtifact.deleteMany({where:{attempt:{dispatch:{subjectId:f.run.id}}}});await db.executionAttempt.deleteMany({where:{dispatch:{subjectId:f.run.id}}});
      await db.executionDispatch.deleteMany({where:{subjectId:{in:[f.run.id,f.bundle.id]}}});await db.workspace.delete({where:{id:f.workspace.id}});await db.user.delete({where:{id:f.user.id}});
    }
  });
  test("the accepted manifest, deadline and complete input tuple cannot be rewritten",async()=>{
    const f=await fixture();
    try{
      await expect(Promise.resolve(db.exportBundle.update({where:{id:f.bundle.id},data:{inputStorageKey:"projects/partial.json"}}))).rejects.toThrow();
      const input={inputBindingHash:"a".repeat(64),inputStorageKey:`projects/${f.project.id}/export-bundles/${f.bundle.id}/${crypto.randomUUID()}.json`,inputEtag:'"capsule"',inputByteLength:200n,inputChecksumSha256:"b".repeat(64)};
      await db.exportBundle.update({where:{id:f.bundle.id},data:input});
      await expect(Promise.resolve(db.exportBundle.update({where:{id:f.bundle.id},data:{inputEtag:'"replacement"'}}))).rejects.toThrow("immutable");
      await expect(Promise.resolve(db.exportBundle.update({where:{id:f.bundle.id},data:{manifest:{changed:true}}}))).rejects.toThrow("immutable");
      await expect(Promise.resolve(db.exportBundle.update({where:{id:f.bundle.id},data:{operationDeadlineAt:new Date(f.bundle.operationDeadlineAt.getTime()+1000)}}))).rejects.toThrow("immutable");
      expect(await db.exportBundle.findUniqueOrThrow({where:{id:f.bundle.id}})).toMatchObject(input);
    }finally{await db.workspace.delete({where:{id:f.workspace.id}});await db.user.delete({where:{id:f.user.id}});}
  });
  test("revoked actor access or a removed frozen variant fails before any private input is written",async()=>{
    for(const cause of ['actor','variant'] as const){
      const f=await fixture();let replacement:string|null=null;
      try{
        if(cause==='actor'){
          replacement=(await db.user.create({data:{clerkId:`bundle-replacement:${crypto.randomUUID()}`}})).id;
          await db.workspace.update({where:{id:f.workspace.id},data:{ownerUserId:replacement}});
        }else await db.clipExportVariant.delete({where:{id:f.variant.id}});
        expect(await withServiceEnvironment({},()=>f.service.prepareExecution(f.reference))).toEqual({kind:'terminal'});
        expect(f.objects.size).toBe(0);
        expect(await db.executionAttempt.count({where:{dispatch:{subjectId:f.run.id}}})).toBe(0);
        expect(await db.exportBundle.findUniqueOrThrow({where:{id:f.bundle.id}})).toMatchObject({status:'failed',errorCode:cause==='actor'?'export_bundle_access_revoked':'export_bundle_variant_missing'});
        expect(await db.workflowRun.findUniqueOrThrow({where:{id:f.run.id}})).toMatchObject({status:'failed',attemptCount:0,attemptId:null});
      }finally{await db.executionDispatch.deleteMany({where:{subjectId:f.run.id}});await db.workspace.delete({where:{id:f.workspace.id}});await db.user.deleteMany({where:{id:{in:[f.user.id,...(replacement?[replacement]:[])]}}});}
    }
  });
  test("a stale operation observation cannot change bundle projection when its independent lease has expired",async()=>{
    const f=await fixture(),deliveryId=crypto.randomUUID();
    try{
      const prepared=await withServiceEnvironment({},()=>f.service.prepareExecution(f.reference));
      if(prepared.kind!=="waiting")throw Error("Expected bundle admission");
      const execution=createExportBundleExecution({database:db,domain:f.service,storage:createExecutionStorage({accountId:"a".repeat(32),bucket:"bundle-gate",accessKeyId:"not-a-real-key",secretAccessKey:"not-a-real-secret"}),deliverWakes:async()=>{},artifacts:{head:async()=>null}});
      const reference=prepared.deadline.reference,attemptToken=prepared.deadline.attemptToken;
      await withServiceEnvironment({},()=>execution.control.execute({command:{action:'acquire',reference,attemptToken,owner:crypto.randomUUID(),leaseSeconds:1},verifiedRequest:{requestHash:'d'.repeat(64),metadata:{version:1,keyId:'bundle-gate',audience:'executor-control',method:'POST',canonicalTarget:'/api/execution/command',bodySha256:'0'.repeat(64),timestamp:Math.floor(Date.now()/1000),deliveryId,signature:'0'.repeat(64)}}}));
      await Bun.sleep(1100);
      const result=await withServiceEnvironment({},()=>db.$transaction(tx=>f.service.expireExecution(tx,reference,attemptToken,{kind:'operation',observedDeadlineAt:new Date(Date.parse(prepared.deadline.observedDeadlineAt)+1)})));
      expect(result.kind).toBe('superseded');
      expect(await db.exportBundle.findUniqueOrThrow({where:{id:f.bundle.id}})).toMatchObject({status:'building',errorCode:null});
      expect(await db.workflowRun.findUniqueOrThrow({where:{id:f.run.id}})).toMatchObject({status:'running',attemptCount:0});
    }finally{await db.executionInboxReceipt.deleteMany({where:{deliveryId}});await db.executionAttempt.deleteMany({where:{dispatch:{subjectId:f.run.id}}});await db.executionDispatch.deleteMany({where:{subjectId:f.run.id}});await db.workspace.delete({where:{id:f.workspace.id}});await db.user.delete({where:{id:f.user.id}});}
  });
  test("retry waiting cannot park beyond the accepted bundle deadline",async()=>{
    const f=await fixture({acceptedAt:new Date(Date.now()-40*60_000)});
    try{
      await db.workflowRun.update({where:{id:f.run.id},data:{nextAttemptAt:new Date(Date.now()+10*60_000)}});
      expect(await withServiceEnvironment({},()=>f.service.prepareExecution(f.reference))).toEqual({kind:'sleep',dueAt:f.bundle.operationDeadlineAt});
      expect(f.objects.size).toBe(0);expect(await db.executionAttempt.count({where:{dispatch:{subjectId:f.run.id}}})).toBe(0);
    }finally{await db.executionDispatch.deleteMany({where:{subjectId:f.run.id}});await db.workspace.delete({where:{id:f.workspace.id}});await db.user.delete({where:{id:f.user.id}});}
  });
  test("a charged native failure preserves the frozen input and fixed deadline while projecting the bounded retry or terminal result",async()=>{
    for(const retryable of [true,false]){
      const f=await fixture(),receipts:string[]=[];
      try{
        const prepared=await withServiceEnvironment({},()=>f.service.prepareExecution(f.reference));if(prepared.kind!=='waiting')throw Error('Expected native bundle');
        const input=await db.exportBundle.findUniqueOrThrow({where:{id:f.bundle.id}}),fence={reference:prepared.deadline.reference,attemptToken:prepared.deadline.attemptToken,owner:crypto.randomUUID()};
        const execution=createExportBundleExecution({database:db,domain:f.service,storage:createExecutionStorage({accountId:'a'.repeat(32),bucket:'bundle-gate',accessKeyId:'not-a-real-key',secretAccessKey:'not-a-real-secret'}),deliverWakes:async()=>{},artifacts:{head:async()=>null}});
        const send=(command:unknown)=>{const deliveryId=crypto.randomUUID();receipts.push(deliveryId);return withServiceEnvironment({},()=>execution.control.execute({command,verifiedRequest:{requestHash:crypto.randomUUID().replaceAll('-','').repeat(2),metadata:{version:1,keyId:'bundle-gate',audience:'executor-control',method:'POST',canonicalTarget:'/api/execution/command',bodySha256:'0'.repeat(64),timestamp:Math.floor(Date.now()/1000),deliveryId,signature:'0'.repeat(64)}}}));};
        await send({action:'acquire',...fence,leaseSeconds:120});await send({action:'process-start',fence});
        await send({action:'fail',fence,failureCode:'export_bundle_process_failed',retryable});
        const current=await db.exportBundle.findUniqueOrThrow({where:{id:f.bundle.id}}),run=await db.workflowRun.findUniqueOrThrow({where:{id:f.run.id}});
        expect(current).toMatchObject({status:retryable?'queued':'failed',inputStorageKey:input.inputStorageKey,inputEtag:input.inputEtag,inputChecksumSha256:input.inputChecksumSha256,operationDeadlineAt:input.operationDeadlineAt,storageKey:null});
        expect(run).toMatchObject({status:retryable?'queued':'failed',attemptCount:1,generation:retryable?2:1,leaseOwner:null});
        expect(await db.campaignOperation.findUniqueOrThrow({where:{id:f.operation.id}})).toMatchObject({status:retryable?'running':'failed',failedCount:retryable?0:1});
        if(retryable){
          const next=await db.executionDispatch.findFirstOrThrow({where:{subjectId:f.run.id,kind:'operation_driver',generation:2,wakeKind:null,deadlineKind:null}});
          const reference=(await withServiceEnvironment({},()=>db.$transaction(tx=>new WorkflowRunLifecycle({prisma:db}).dispatchRunWithinTransaction(tx,f.run.id)))).reference;
          expect(reference.dispatchId).toBe(next.id);
          expect((await withServiceEnvironment({},()=>f.service.prepareExecution(reference))).kind).toBe('sleep');
          expect(f.objects.size).toBe(1);
        }
      }finally{await db.executionInboxReceipt.deleteMany({where:{deliveryId:{in:receipts}}});await db.executionAttempt.deleteMany({where:{dispatch:{subjectId:f.run.id}}});await db.executionDispatch.deleteMany({where:{subjectId:f.run.id}});await db.workspace.delete({where:{id:f.workspace.id}});await db.user.delete({where:{id:f.user.id}});}
    }
  });
});
