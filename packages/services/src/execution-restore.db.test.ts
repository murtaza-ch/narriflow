import { restoreIngestJobsPage, restoreWorkflowRunsPage, restoreRenderGroupsPage } from "./execution-source-recovery-pages";
import { renderGroupExportIdentity } from "./render-group-contract";
import { restoreBillingPage, restoreLibraryPage } from "./execution-account-recovery-pages";
import { queueLibraryIndex } from "./library-index";
import { queueBillingReconciliation } from "./billing-reconciliation";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { assertExecutionDatabaseTestTarget } from "./execution-db-test-support";
import { createMediaCleanupControl, queueMediaCleanupWithinTransaction } from "./media-cleanup-control";
import { appendExecutionDispatch, readExecutionDispatch } from "./execution-dispatch";
import { revokeRestoredAttemptsPage } from "./execution-restore-pages";
import { ExecutionRestoreService, EXECUTION_RESTORE_PHASES } from "./execution-restore";
import { ExecutionMaintenanceService, HOURLY_MAINTENANCE_PHASES } from "./execution-maintenance";
import { capturedExecutionSnapshotFixture, SNAPSHOT_TEST_WORKER } from "./execution-snapshot-test-support";
import { fenceExecutionSnapshot, executionSnapshotIdentityHash, validateExecutionSnapshotEvidence } from "./execution-snapshot";

const url = process.env.SERVERLESS_TEST_DATABASE_URL;
const suite = process.env.ALLOW_SERVERLESS_DB_TESTS === "1" && url ? describe : describe.skip;
suite("Execution restore authority", () => {
  let database: PrismaClient;
  beforeAll(() => {
    const schema = process.env.SERVERLESS_TEST_DATABASE_SCHEMA!;
    assertExecutionDatabaseTestTarget(url, schema);
    database = new PrismaClient({ adapter: new PrismaPg({ connectionString: url, max: 4 }, { schema }), transactionOptions: { maxWait: 10_000, timeout: 30_000 } });
  });
  afterAll(async () => { await database?.$disconnect(); });
  test("a validated quiesced snapshot advances once and a lost ACK resumes the same proof-bound obligation", async () => {
    const maintenance = new ExecutionMaintenanceService({ database, register: async () => {}, phases: Object.fromEntries(HOURLY_MAINTENANCE_PHASES.map(phase => [phase, async () => ({ processed: 0, next: null })])) });
    const old = await maintenance.start({ cadence: "hourly", scheduledAt: new Date("2026-10-31T10:00:00.000Z") });
    const input = await capturedExecutionSnapshotFixture(database), targetEpoch = input.expectedEpoch + 1;
    let loseAcknowledgement = true;
    const registered: string[][] = [];
    const restore = new ExecutionRestoreService({ database, register: async ids => {
      expect(await database.executionEpoch.findUniqueOrThrow({ where: { id: 1 } })).toMatchObject({ epoch: targetEpoch, admissionOpen: false });
      expect(await maintenance.run(old)).toMatchObject({ kind: "superseded" });
      registered.push([...ids]); if (loseAcknowledgement) throw new Error("Lost restore acknowledgement");
    } });
    await expect(restore.begin(input)).rejects.toThrow("Lost restore acknowledgement");
    loseAcknowledgement = false;
    const recovered = await restore.begin(input);
    expect(recovered).toMatchObject({ previousEpoch: input.expectedEpoch, deploymentEpoch: targetEpoch });
    expect(registered[1]).toEqual(registered[0]);
    expect(await database.executionDispatch.count({ where: { deploymentEpoch: targetEpoch, subjectId: { startsWith: "rs2." } } })).toBe(1);
    await expect(restore.begin({ ...input, expectedEpoch: input.expectedEpoch + 2 })).rejects.toMatchObject({ code: "restore_snapshot_proof_invalid" });
    expect((await database.executionEpoch.findUniqueOrThrow({ where: { id: 1 } })).admissionOpen).toBe(false);
  });
  test("the begin obligation and epoch fence roll back together when registration intent cannot be persisted", async () => {
    const input = await capturedExecutionSnapshotFixture(database), before = await database.executionEpoch.findUniqueOrThrow({ where: { id: 1 } });
    const restore = new ExecutionRestoreService({ database, register: async () => {} });
    const trigger = `restore_begin_${crypto.randomUUID().replaceAll("-", "")}`;
    await database.$executeRawUnsafe(`CREATE FUNCTION "${trigger}"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."subjectId" LIKE 'rs2.${before.epoch}.${before.epoch}.${before.epoch + 1}.%' THEN RAISE EXCEPTION 'injected_restore_begin_failure'; END IF; RETURN NEW; END $$`);
    await database.$executeRawUnsafe(`CREATE TRIGGER "${trigger}" BEFORE INSERT ON "ExecutionDispatch" FOR EACH ROW EXECUTE FUNCTION "${trigger}"()`);
    try {
      await expect(restore.begin(input)).rejects.toThrow();
      expect(await database.executionEpoch.findUniqueOrThrow({ where: { id: 1 } })).toEqual(before);
      expect(await database.executionDispatch.count({ where: { deploymentEpoch: before.epoch + 1, subjectId: { startsWith: "rs2." } } })).toBe(0);
    } finally {
      await database.$executeRawUnsafe(`DROP TRIGGER "${trigger}" ON "ExecutionDispatch"`);
      await database.$executeRawUnsafe(`DROP FUNCTION "${trigger}"()`);
    }
    expect(await restore.begin(input)).toMatchObject({ deploymentEpoch: before.epoch + 1 });
  });
  test("an epoch fence after cleanup timer confirmation prevents new DELETE HTTP", async () => {
    const before = await database.executionEpoch.findUniqueOrThrow({ where: { id: 1 } });
    const intent = await database.mediaCleanupObligation.create({ data: { origin: "clip_editor_document_persistence", cleanupClass: "mutable_render", objectKey: `projects/${crypto.randomUUID()}/renders/${crypto.randomUUID()}.mp4`, nextAttemptAt: new Date(0) } });
    const reference = (await database.$transaction(tx => queueMediaCleanupWithinTransaction(tx, intent.id)))!; let deletes = 0;
    const control = createMediaCleanupControl({ database, hold: async () => null, register: async () => { await fenceExecutionSnapshot(database, { expectedEpoch: before.epoch, worker: SNAPSHOT_TEST_WORKER }); }, storage: { async deleteExact() { deletes++; } } });
    expect(await control.run(reference)).toMatchObject({ kind: "superseded" }); expect(deletes).toBe(0);
    expect((await database.mediaCleanupObligation.findUniqueOrThrow({ where: { id: intent.id } })).completedAt).toBeNull();
  });
  test("bounded restore pages revoke old execution authority once and replay their committed cursor after ACK loss", async () => {
    const before = await database.executionEpoch.findUniqueOrThrow({ where: { id: 1 } }), tokens: string[] = [];
    for (const status of ["admitted", "running", "completed"]) {
      const record = await database.$transaction(tx => appendExecutionDispatch(tx, { deploymentEpoch: before.epoch, generation: 1, kind: "modal_execution", subject: { kind: "ingest_job", id: crypto.randomUUID() }, inputHash: "a".repeat(64), dueAt: new Date(0) }));
      const token = crypto.randomUUID(); tokens.push(token);
      await database.executionAttempt.create({ data: { attemptToken: token, dispatchId: record.reference.dispatchId, deploymentEpoch: before.epoch, generation: 1, inputHash: record.reference.inputHash, functionName: "fetch_source", status,
        createdAt: new Date(0), operationDeadlineAt: new Date(3), ...(status !== "admitted" ? { owner: crypto.randomUUID(), leaseExpiresAt: new Date(2), processStartedAt: new Date(1) } : {}), ...(status === "completed" ? { finishedAt: new Date(2) } : {}) } });
    }
    const activeBefore = await database.executionAttempt.count({ where: { deploymentEpoch: { lte: before.epoch }, status: { in: ["admitted", "running"] } } });
    const input = await capturedExecutionSnapshotFixture(database); let loseAcknowledgement = false;
    const registered: string[][] = [];
    const restore = new ExecutionRestoreService({ database, limit: 1, register: async ids => { registered.push([...ids]); if (loseAcknowledgement) throw new Error("Restore page ACK lost"); },
      phases: { ...Object.fromEntries(EXECUTION_RESTORE_PHASES.map(phase => [phase, async () => ({ processed: 0, next: null })])), attempts: revokeRestoredAttemptsPage } });
    const begun = await restore.begin(input); loseAcknowledgement = true;
    await expect(restore.run(begun.reference)).rejects.toThrow("Restore page ACK lost");
    expect(await database.executionAttempt.count({ where: { deploymentEpoch: { lte: before.epoch }, status: { in: ["admitted", "running"] } } })).toBe(activeBefore - 1);
    loseAcknowledgement = false; const replay = await restore.run(begun.reference);
    expect(replay.dispatchIds).toEqual(registered[1]!);
    expect(await database.executionAttempt.count({ where: { deploymentEpoch: { lte: before.epoch }, status: { in: ["admitted", "running"] } } })).toBe(activeBefore - 1);
    expect(await database.executionInboxReceipt.findUnique({ where: { audience_deliveryId: { audience: "restore-page", deliveryId: begun.reference.dispatchId } } })).toMatchObject({ wakeDispatchIds: replay.dispatchIds });
    let reference = (await readExecutionDispatch(database, replay.dispatchIds.at(-1)!))!.reference, completed = false;
    for (let index = 0; index < activeBefore + 2; index++) {
      const next = await restore.run(reference); expect(next.processed).toBeLessThanOrEqual(1);
      if (next.kind === "complete") { completed = true; break; }
      reference = (await readExecutionDispatch(database, next.dispatchIds.at(-1)!))!.reference;
    }
    expect(completed).toBe(true);
    expect(await database.executionAttempt.count({ where: { attemptToken: { in: tokens }, status: "superseded", revokedAt: { not: null } } })).toBe(2);
    expect((await database.executionAttempt.findUniqueOrThrow({ where: { attemptToken: tokens[2]! } })).status).toBe("completed");
    expect((await database.executionEpoch.findUniqueOrThrow({ where: { id: 1 } })).admissionOpen).toBe(false);
    await expect(restore.run({ ...reference, inputHash: "0".repeat(64) })).rejects.toMatchObject({ code: "restore_reference_invalid" });
  }, 60_000);
  test("operator inspection proves the current registered source pair and exact page receipt without reopening or resetting work", async () => {
    const input = await capturedExecutionSnapshotFixture(database);
    const restore = new ExecutionRestoreService({ database, register: async () => {}, phases: Object.fromEntries(EXECUTION_RESTORE_PHASES.map(phase => [phase, async () => ({ processed: 0, next: null })])) });
    const begun = await restore.begin(input);
    expect((await restore.inspectCurrent()).restore?.reference).toEqual(begun.reference);
    expect(await restore.inspect(begun.reference.dispatchId)).toMatchObject({ reference: begun.reference, snapshotEpoch: input.expectedEpoch, fenceAboveEpoch: input.expectedEpoch, deploymentEpoch: input.expectedEpoch + 1, admissionOpen: false, receipt: null });
    const boundary=await restore.run(begun.reference);
    expect(await restore.inspect(begun.reference.dispatchId)).toMatchObject({metadataReady:false,receipt:{kind:"continue",processed:0,dispatchIds:boundary.dispatchIds}});
    const next=(await readExecutionDispatch(database,boundary.dispatchIds[0]!))!.reference;expect((await restore.inspect(next.dispatchId)).metadataReady).toBe(true);
    expect(await restore.run(next)).toMatchObject({kind:"complete",processed:0,dispatchIds:[]});
    expect((await database.executionEpoch.findUniqueOrThrow({ where: { id: 1 } })).epoch).toBe(input.expectedEpoch + 1);
  });
  test("higher live epochs, changed migration facts and any source-epoch permission reject before a new restore bump", async () => {
    const input = await capturedExecutionSnapshotFixture(database), restore = new ExecutionRestoreService({ database, register: async () => {} });
    const before = await database.executionEpoch.findUniqueOrThrow({ where: { id: 1 } });
    await expect(restore.begin({ ...input, fenceAboveEpoch: input.expectedEpoch + 1 })).rejects.toMatchObject({ code: "restore_snapshot_history_unknown" });
    const proof = { ...input.evidence.proof, migrationSha256: "c".repeat(64) }; proof.identitySha256 = await executionSnapshotIdentityHash(proof);
    const changed = await validateExecutionSnapshotEvidence({ proof, snapshotSha256: proof.snapshotSha256, localMigrationSha256: proof.migrationSha256, worker: SNAPSHOT_TEST_WORKER });
    await expect(restore.begin({ ...input, evidence: changed })).rejects.toMatchObject({ code: "restore_snapshot_proof_invalid" });
    await database.$transaction(tx => appendExecutionDispatch(tx, { deploymentEpoch: before.epoch, generation: 1, kind: "operation_driver", subject: { kind: "maintenance", id: `unknown-tail-${crypto.randomUUID()}` }, inputHash: "a".repeat(64), dueAt: new Date() }));
    await expect(restore.begin(input)).rejects.toMatchObject({ code: "restore_snapshot_history_unknown" });
    expect(await database.executionEpoch.findUniqueOrThrow({ where: { id: 1 } })).toEqual(before);
  });
  test("bounded account recovery reuses billing identity and paid library progress without extending budgets", async () => {
    const [floor] = await database.$queryRaw<Array<{ at: Date }>>`SELECT clock_timestamp() AT TIME ZONE 'UTC' AS at`;
    const user=await database.user.create({data:{clerkId:`restore-accounts-${crypto.randomUUID()}`}});
    const workspace=await database.workspace.create({data:{name:"Restored account",ownerUserId:user.id}});
    const project=await database.project.create({data:{workspaceId:workspace.id,title:"Restored library",sourceMediaUrl:"https://example.test/source",ingestStatus:"ready"}});
    const transcript=await database.transcript.create({data:{projectId:project.id,status:"completed",completedAt:new Date(),utterancesJson:[],durationSeconds:60}});
    const billing=await database.workspaceBillingAccount.create({data:{workspaceId:workspace.id,providerCustomerId:`cus_${crypto.randomUUID()}`,nextReconcileAt:new Date("2026-01-01T00:00:00.000Z"),attemptCount:7}});
    await database.$transaction(async tx=>{await queueBillingReconciliation(tx,workspace.id);await queueLibraryIndex(tx,transcript.id);});
    await database.transcript.update({where:{id:transcript.id},data:{passagesAttempts:2,passagesIndexedFor:null}});
    const original=await database.transcript.findUniqueOrThrow({where:{id:transcript.id}});
    const source=await capturedExecutionSnapshotFixture(database);
    const restore=new ExecutionRestoreService({database,limit:1,register:async()=>{},phases:{...Object.fromEntries(EXECUTION_RESTORE_PHASES.map(phase=>[phase,async()=>({processed:0,next:null})])),billing:(tx,page)=>restoreBillingPage(tx,{...page,after:page.after??{at:floor!.at,id:"00000000-0000-0000-0000-000000000000"}}),library:(tx,page)=>restoreLibraryPage(tx,{...page,after:page.after??{at:floor!.at,id:"00000000-0000-0000-0000-000000000000"}})}});
    const begun=await restore.begin(source);let reference=begun.reference;
    for(let i=0;i<250;i++){const outcome=await restore.run(reference);if(outcome.kind==="complete")break;reference=(await readExecutionDispatch(database,outcome.dispatchIds.at(-1)!))!.reference;}
    const afterBilling=await database.workspaceBillingAccount.findUniqueOrThrow({where:{id:billing.id}}),afterLibrary=await database.transcript.findUniqueOrThrow({where:{id:transcript.id}});
    expect(afterBilling).toMatchObject({providerCustomerId:billing.providerCustomerId,attemptCount:7,nextReconcileAt:billing.nextReconcileAt,reconcileAttemptId:null,leaseExpiresAt:null,reconciliationEpoch:begun.deploymentEpoch});
    expect(afterLibrary).toMatchObject({passagesAttempts:2,passagesRetryAt:original.passagesRetryAt,passagesSourceHash:original.passagesSourceHash,passagesDeadlineAt:original.passagesDeadlineAt,passagesClaimId:null,passagesLeaseUntil:null,passagesEpoch:begun.deploymentEpoch});
    expect(afterLibrary.passagesGeneration).toBe(original.passagesGeneration+1);
    expect(await database.executionDispatch.count({where:{deploymentEpoch:begun.deploymentEpoch,subjectKind:{in:["workspace_billing","library_index"]}}})).toBe(0);
    await database.workspace.delete({where:{id:workspace.id}});
  });

  test("source and render authority rebind preserves provider lineage, deadlines, frozen membership and charged budgets",async()=>{
    const [floor] = await database.$queryRaw<Array<{ at: Date }>>`SELECT clock_timestamp() AT TIME ZONE 'UTC' AS at`;
    const user=await database.user.create({data:{clerkId:`restore-source-${crypto.randomUUID()}`}}),workspace=await database.workspace.create({data:{name:"Source restore",ownerUserId:user.id}});
    const project=await database.project.create({data:{workspaceId:workspace.id,title:"Source",sourceMediaUrl:"https://example.test/source",ingestStatus:"downloading"}});
    const epoch=(await database.executionEpoch.findUniqueOrThrow({where:{id:1}})).epoch,deadline=new Date(Date.now()+30*60_000),token=crypto.randomUUID();
    const ingest=await database.ingestJob.create({data:{projectId:project.id,jobType:"link_import",payload:{provider:"youtube",mediaId:"abcdefghijk"},deploymentEpoch:epoch,status:"queued",claimId:token,attemptCount:2,operationDeadlineAt:deadline}});
    const sttToken=crypto.randomUUID(),stt=await database.workflowRun.create({data:{projectId:project.id,stage:"stt",status:"waiting",idempotencyKey:crypto.randomUUID(),deploymentEpoch:epoch,attemptId:sttToken,attemptCount:2,operationDeadlineAt:deadline,nextPollAt:deadline}});
    const transcript=await database.transcript.create({data:{projectId:project.id,status:"processing",workflowAttemptId:sttToken,providerRequestId:"captured-request",providerJobId:"captured-job",providerSubmittedAt:new Date(),providerResultDeadlineAt:deadline}});
    const workSet=crypto.randomUUID(),render=await database.workflowRun.create({data:{projectId:project.id,stage:"clip_rendering",status:"waiting",idempotencyKey:crypto.randomUUID(),deploymentEpoch:epoch,renderWorkSetGeneration:workSet,renderWorkSetFrozenAt:new Date(),requestedCount:1}});
    const clip=await database.clip.create({data:{projectId:project.id,workflowRunId:render.id,index:0,startSec:0,endSec:10,hookText:"gate",reasoning:"gate",category:"hook",transcriptSlice:[],viralityScore:50,hookStrengthScore:50,emotionalIntensityScore:50,pacingScore:50,durationOptimalityScore:50,tiktokScore:50,youtubeScore:50,instagramScore:50,llmProvider:"gate",llmModel:"gate"}});
    const variant=await database.clipRender.create({data:{clipId:clip.id,workflowRunId:render.id,aspectRatio:"ratio_9_16"}});
    const prep=await database.clipPreparation.create({data:{projectId:project.id,clipId:clip.id,sourceRevision:1,editorRevision:0,bindingHash:"a".repeat(64),engineHash:"b".repeat(64),inputHash:"c".repeat(64),inputStorageKey:`projects/${project.id}/preparations/${crypto.randomUUID()}/${crypto.randomUUID()}.json`,inputEtag:'"input"',inputByteLength:100n,inputChecksumSha256:"d".repeat(64),deploymentEpoch:epoch,operationDeadlineAt:deadline}});
    const group=await database.renderGroup.create({data:{workflowRunId:render.id,workSetGeneration:workSet,clipId:clip.id,deploymentEpoch:epoch,exportIdentity:renderGroupExportIdentity({clipId:clip.id,exportId:null,editorRevision:0,resolution:"1080p",watermark:true}),preparationId:prep.id,inputStorageKey:`projects/${project.id}/render-groups/${crypto.randomUUID()}/${crypto.randomUUID()}.json`,inputEtag:'"group"',inputByteLength:100n,inputChecksumSha256:"e".repeat(64),operationDeadlineAt:deadline,members:{create:{clipRenderId:variant.id}}}});
    const source=await capturedExecutionSnapshotFixture(database),restore=new ExecutionRestoreService({database,register:async()=>{},phases:{...Object.fromEntries(EXECUTION_RESTORE_PHASES.map(phase=>[phase,async()=>({processed:0,next:null})])),ingest:(tx,page)=>restoreIngestJobsPage(tx,{...page,after:page.after??{at:floor!.at,id:"00000000-0000-0000-0000-000000000000"}}),workflows:(tx,page)=>restoreWorkflowRunsPage(tx,{...page,after:page.after??{at:floor!.at,id:"00000000-0000-0000-0000-000000000000"}}),render_groups:(tx,page)=>restoreRenderGroupsPage(tx,{...page,after:page.after??{at:floor!.at,id:"00000000-0000-0000-0000-000000000000"}})}});
    const begun=await restore.begin(source);let reference=begun.reference;
    for(let i=0;i<20;i++){const result=await restore.run(reference);if(result.kind==="complete")break;reference=(await readExecutionDispatch(database,result.dispatchIds.at(-1)!))!.reference;}
    expect(await database.ingestJob.findUniqueOrThrow({where:{id:ingest.id}})).toMatchObject({deploymentEpoch:begun.deploymentEpoch,generation:2,status:"queued",claimId:null,executorOwner:null,attemptCount:2,operationDeadlineAt:deadline});
    expect(await database.workflowRun.findUniqueOrThrow({where:{id:stt.id}})).toMatchObject({deploymentEpoch:begun.deploymentEpoch,generation:2,status:"waiting",attemptId:sttToken,attemptCount:2,operationDeadlineAt:deadline,nextPollAt:deadline,leaseOwner:null});
    expect(await database.transcript.findUniqueOrThrow({where:{id:transcript.id}})).toMatchObject({providerRequestId:"captured-request",providerJobId:"captured-job",providerResultDeadlineAt:deadline,workflowAttemptId:sttToken});
    expect(await database.renderGroup.findUniqueOrThrow({where:{id:group.id}})).toMatchObject({deploymentEpoch:begun.deploymentEpoch,generation:2,status:"queued",workSetGeneration:workSet,chargedAttemptCount:0,operationDeadlineAt:deadline,preparationId:null,inputStorageKey:null,inputEtag:null,inputByteLength:null,inputChecksumSha256:null});
    expect(await database.renderGroupMember.count({where:{groupId:group.id}})).toBe(1);
    expect(await database.executionDispatch.count({where:{deploymentEpoch:begun.deploymentEpoch,kind:{not:"maintenance"}}})).toBe(0);
    await database.workspace.delete({where:{id:workspace.id}});
  });

  test("restore object preparation runs outside SQL locks and receipt replay never repeats prepared I/O or adoption",async()=>{
    const id=crypto.randomUUID(),task=await database.mcpTask.create({data:{ownerUserId:id,callerId:id,workspaceId:id,toolName:"restore-preflight",domainKind:"generation",domainId:id,projectId:id,originatingOperationId:id,resultContract:{},initialResult:{},expiresAt:new Date(Date.now()+86400000)}});
    const source=await capturedExecutionSnapshotFixture(database);let prepares=0,applies=0,lose=false;const deliveries:string[][]=[];
    const restore=new ExecutionRestoreService({database,phases:Object.fromEntries(EXECUTION_RESTORE_PHASES.map(phase=>[phase,async()=>({processed:0,next:null})])),register:async ids=>{deliveries.push([...ids]);if(lose)throw Error("lost prepared page ACK");},prepare:{selection:async()=>{
      prepares++;await database.$transaction(async tx=>{await tx.$queryRaw`SELECT epoch FROM "ExecutionEpoch" WHERE id=1 FOR UPDATE NOWAIT`;});
      return {apply:async tx=>{applies++;await tx.mcpTask.update({where:{id:task.id},data:{cancellationRequestedAt:new Date(0)}});return {processed:1,next:null,dispatchIds:[]};}};
    }}});
    const begun=await restore.begin(source),boundary=await restore.run(begun.reference);
    expect(boundary).toMatchObject({kind:"continue",processed:0});expect(prepares).toBe(0);
    const selected=(await readExecutionDispatch(database,boundary.dispatchIds[0]!))!.reference;expect(selected.subject.id).toContain(".selection");
    lose=true;await expect(restore.run(selected)).rejects.toThrow("lost prepared page ACK");
    expect((await database.mcpTask.findUniqueOrThrow({where:{id:task.id}})).cancellationRequestedAt).toEqual(new Date(0));
    lose=false;await restore.run(selected);expect(prepares).toBe(1);expect(applies).toBe(1);expect(deliveries.at(-1)).toEqual(deliveries.at(-2));
  });

});
