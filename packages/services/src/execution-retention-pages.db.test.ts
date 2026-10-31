import { admitMediaCleanupObligations } from "./media-cleanup-admission";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { assertExecutionDatabaseTestTarget } from "./execution-db-test-support";
import * as safety from "./execution-safety-pages";
import { recoverOutboundProbeWakePage } from "./execution-safety-pages";
import { appendWorkflowRunDispatch } from "./workflow-dispatch";
import { appendExecutionDispatch, readExecutionDispatch } from "./execution-dispatch";
import { expireWorkflowEventPage, expireWorkspaceEventPage, expireWebhookLogPage, recoverMediaCleanupPage,retireSourceMediaPage } from "./execution-retention-pages";
const url = process.env.SERVERLESS_TEST_DATABASE_URL;
const suite = process.env.ALLOW_SERVERLESS_DB_TESTS === "1" && url ? describe : describe.skip;
suite("Production retention pages", () => {
  let db: PrismaClient;
  beforeAll(() => { const schema = process.env.SERVERLESS_TEST_DATABASE_SCHEMA!; assertExecutionDatabaseTestTarget(url, schema); db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url, max: 4 }, { schema }), transactionOptions: { maxWait: 10_000, timeout: 30_000 } }); });
  afterAll(async () => { await db?.$disconnect(); });
  async function fixture() { const user = await db.user.create({ data: { clerkId: `maintenance-${crypto.randomUUID()}` } }); const workspace = await db.workspace.create({ data: { name: "Maintenance", ownerUserId: user.id } }); return { workspace, project: await db.project.create({ data: { workspaceId: workspace.id, title: "Retention", sourceMediaUrl: "https://example.test/source" } }) }; }
  const cutoff = new Date("2026-10-31T00:00:00.000Z"), old = new Date("2026-01-01T00:00:00.000Z");
  async function page(after: { at: Date; id: string } | null = null) { return { deploymentEpoch: (await db.executionEpoch.findUniqueOrThrow({ where: { id: 1 } })).epoch, cutoff, after, limit: 2 }; }
  test("strict event pages retain unfinished delivery, fresh events and permanent dedupe keys", async () => {
    const { workspace, project } = await fixture();
    try {
      await db.workflowEvent.createMany({ data: Array.from({ length: 5 }, (_, i) => ({ projectId: project.id, workflowRunId: crypto.randomUUID(), seq: i + 1, stage: "ingest", status: "completed", emittedAt: i === 4 ? cutoff : old, dedupeKey: crypto.randomUUID(), notificationRequired: i === 3 })) });
      const first = await db.$transaction(async tx => expireWorkflowEventPage(tx, await page()));
      expect(first).toMatchObject({ processed: 2, dispatchIds: [] }); expect(first.next).not.toBeNull();
      const second = await db.$transaction(async tx => expireWorkflowEventPage(tx, await page(first.next)));
      expect(second.processed).toBe(1); expect(second.next).toBeNull();
      expect(await db.workflowEvent.count({ where: { projectId: project.id } })).toBe(2);
      const key = `retained-${crypto.randomUUID()}`;
      await db.workspaceEventKey.create({ data: { dedupeKey: key, workspaceId: workspace.id, projectId: project.id } });
      await db.workspaceEvent.create({ data: { workspaceId: workspace.id, seq: 1, type: "project.completed", subject: {}, occurredAt: old, createdAt: old, dedupeKey: key } });
      expect((await db.$transaction(async tx => expireWorkspaceEventPage(tx, await page()))).processed).toBe(1);
      expect(await db.workspaceEventKey.findUnique({ where: { dedupeKey: key } })).not.toBeNull();
    } finally { await db.workspace.delete({ where: { id: workspace.id } }); }
  });
  test("log deletion is bounded and cleanup repair schedules known due intents without completing future holds", async () => {
    const marker = crypto.randomUUID();
    await db.webhookDeliveryLog.createMany({ data: Array.from({ length: 3 }, (_, i) => ({ provider: "stripe", eventId: `${marker}-${i}`, eventType: "test", status: "processed", createdAt: old })) });
    const result = await db.$transaction(async tx => expireWebhookLogPage(tx, await page()));
    expect(result.processed).toBe(2); expect(result.next).not.toBeNull();
    await db.webhookDeliveryLog.deleteMany({ where: { eventId: { startsWith: marker } } });
    const intents = await db.mediaCleanupObligation.createManyAndReturn({ data: [old, old, new Date("2027-01-01T00:00:00.000Z")].map((at, i) => ({ origin: "clip_preparation_input", cleanupClass: "execution_input", objectKey: `projects/${marker}/preparations/${crypto.randomUUID()}/${i}.json`, nextAttemptAt: at })) });
    const cleanup = await db.$transaction(async tx => recoverMediaCleanupPage(tx, await page()));
    expect(cleanup.processed).toBe(2); expect(cleanup.dispatchIds).toHaveLength(2);
    expect(await db.mediaCleanupObligation.count({ where: { id: { in: intents.map(row => row.id) }, completedAt: null } })).toBe(3);
  });
  test("an hourly observation repairs an acknowledged current driver without new ownership, retry generation or charge", async () => {
    const { workspace } = await fixture();
    const epoch = (await page()).deploymentEpoch;
    const row = await db.outboundProbe.create({ data: { workspaceId: workspace.id, createdByUserId: workspace.ownerUserId, kind: "rss_feed", requestFingerprint: "1".repeat(64), input: { url: "https://example.test/feed" }, inputHash: "2".repeat(64), deploymentEpoch: epoch, operationDeadlineAt: new Date("2027-01-01T00:00:00.000Z"), createdAt: old } });
    const base = await db.$transaction(tx => appendExecutionDispatch(tx, { kind: "operation_driver", subject: { kind: "outbound_probe", id: row.id }, generation: 1, deploymentEpoch: epoch, inputHash: row.inputHash, dueAt: old }));
    await db.executionDispatch.update({ where: { id: base.reference.dispatchId }, data: { acknowledgedAt: old, destinationId: "old-completed-instance" } });
    const observed = await db.$transaction(async tx => recoverOutboundProbeWakePage(tx, await page()));
    expect(observed.processed).toBe(1); expect(observed.dispatchIds).toHaveLength(1);
    const delivery = await readExecutionDispatch(db, observed.dispatchIds![0]!);
    expect(delivery).toMatchObject({ reference: { generation: 1, inputHash: row.inputHash }, wakeKind: `hourly_${cutoff.getTime()}`, dueAt: cutoff });
    expect(await db.outboundProbe.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({ generation: 1, chargedAttempts: 0, attemptToken: null, executorOwner: null });
    expect(await db.$transaction(async tx => recoverOutboundProbeWakePage(tx, await page()))).toEqual(observed);
    await db.outboundProbe.delete({ where: { id: row.id } }); await db.workspace.delete({ where: { id: workspace.id } });
  });

  test("every fixed domain safety selector terminates on an empty cutoff and has valid PostgreSQL predicates", async () => {
    for (const handler of Object.values(safety)) {
      const empty = { ...(await page()), cutoff: new Date(0) };
      expect(await db.$transaction(tx => handler(tx, empty))).toEqual({ processed: 0, next: null, dispatchIds: [] });
    }
  });

  test("accepted STT waiting is recovered by its current driver with provider lineage and deadlines intact",async()=>{
    const {workspace,project}=await fixture(),epoch=(await page()).deploymentEpoch;
    const run=await db.workflowRun.create({data:{projectId:project.id,stage:"stt",status:"waiting",idempotencyKey:crypto.randomUUID(),deploymentEpoch:epoch,attemptId:crypto.randomUUID(),createdAt:old,operationDeadlineAt:new Date("2027-01-01T00:00:00.000Z"),attemptCount:2}});
    await db.$transaction(tx=>appendWorkflowRunDispatch(tx,run.id));
    const observation=await db.$transaction(async tx=>safety.recoverProviderWaitPage(tx,await page()));
    expect(observation.processed).toBe(1);expect(observation.dispatchIds).toHaveLength(1);
    expect(await db.workflowRun.findUniqueOrThrow({where:{id:run.id}})).toMatchObject({status:"waiting",attemptId:run.attemptId,attemptCount:2,operationDeadlineAt:run.operationDeadlineAt,leaseOwner:null,leaseExpiresAt:null});
    await db.workspace.delete({where:{id:workspace.id}});
  });

  test("restore object planning refuses open admission before creating a deferred cleanup intent",async()=>{
    const key=`projects/${crypto.randomUUID()}/preparations/${crypto.randomUUID()}/${crypto.randomUUID()}.json`;
    await expect(db.$transaction(tx=>admitMediaCleanupObligations(tx,[{origin:"clip_preparation_input",cleanupClass:"execution_input",objectKey:key}],{deferDispatch:true}))).rejects.toThrow("cleanup_restore_requires_closed_admission");
    expect(await db.mediaCleanupObligation.count({where:{objectKey:key}})).toBe(0);
  });

  async function sourceFixture() {
    const {workspace,project}=await fixture(),epoch=(await page()).deploymentEpoch;
    const completed=new Date("2026-01-01T00:00:00.000Z"),videoKey=`execution/${epoch}/${crypto.randomUUID()}/source_video`,audioKey=`execution/${epoch}/${crypto.randomUUID()}/source_audio`;
    const job=await db.ingestJob.create({data:{projectId:project.id,jobType:"link_import",payload:{},status:"completed",completedAt:completed,generationHandoffAt:completed,deploymentEpoch:epoch}}),reference=(await db.$transaction(tx=>appendExecutionDispatch(tx,{kind:"modal_execution",subject:{kind:"ingest_job",id:job.id},generation:1,deploymentEpoch:epoch,inputHash:"a".repeat(64),dueAt:completed}))).reference,token=crypto.randomUUID(),owner=crypto.randomUUID();
    await db.executionAttempt.create({data:{attemptToken:token,dispatchId:reference.dispatchId,generation:1,deploymentEpoch:epoch,inputHash:reference.inputHash,functionName:"fetch_source",status:"completed",owner,leaseExpiresAt:completed,processStartedAt:completed,finishedAt:completed,createdAt:new Date("2025-12-31T00:00:00.000Z"),operationDeadlineAt:completed}});
    await db.executionArtifact.create({data:{attemptToken:token,owner,role:"source_video",bindingHash:"b".repeat(64),storageKey:videoKey,contentType:"video/mp4",maxBytes:100n,byteLength:100n,checksumSha256:"c".repeat(64),etag:'"video"',grantExpiresAt:new Date(completed.getTime()+1000),committedAt:completed,createdAt:completed}});
    await db.project.update({where:{id:project.id},data:{sourceStorageKey:videoKey,ingestStatus:"ready",ingestCompletedAt:completed}});
    const run=await db.workflowRun.create({data:{projectId:project.id,stage:"stt",status:"queued",idempotencyKey:crypto.randomUUID(),deploymentEpoch:epoch}});
    const clip=await db.clip.create({data:{projectId:project.id,workflowRunId:run.id,transcriptSlice:[],index:0,title:"Retained clip",startSec:0,endSec:10,hookText:"fixture",reasoning:"fixture",category:"hook",viralityScore:50,hookStrengthScore:50,emotionalIntensityScore:50,pacingScore:50,durationOptimalityScore:50,tiktokScore:50,youtubeScore:50,instagramScore:50,llmProvider:"fixture",llmModel:"fixture",previewStorageKey:`projects/${project.id}/preview.mp4`}});
    await db.clipRender.create({data:{clipId:clip.id,aspectRatio:"ratio_9_16",status:"completed",storageKey:`projects/${project.id}/render.mp4`}});
    const audio = await db.sourceAudio.create({data:{projectId:project.id,sourceRevision:project.sourceRevision,mediaProvider:"upload",mediaId:project.id,
      audioTrack:{id:"0",codec:"aac",sampleRate:48000,channels:2},bindingHash:"d".repeat(64),storageKey:audioKey,etag:'"audio"',byteLength:100n,
      checksumSha256:"c".repeat(64),durationSeconds:60,audioStartTimeSec:0,probeVersion:"normalized-probe-v1",toolchainFingerprint:"e".repeat(64)}});
    return {workspace,project,run,clip,videoKey,audioKey,audio,completed};
  }
  test("source retirement keeps active pipelines and exact source audio while planning only the completed retired video key",async()=>{
    const {workspace,project,run,videoKey,audioKey,audio}=await sourceFixture();
    expect((await db.$transaction(async tx=>retireSourceMediaPage(tx,await page()))).processed).toBe(0);expect((await db.project.findUniqueOrThrow({where:{id:project.id}})).sourceStorageKey).toBe(videoKey);
    await db.workflowRun.update({where:{id:run.id},data:{status:"completed"}});
    const retired=await db.$transaction(async tx=>retireSourceMediaPage(tx,await page()));expect(retired).toMatchObject({processed:1});expect((await db.project.findUniqueOrThrow({where:{id:project.id}})).sourceStorageKey).toBeNull();
    const intent=await db.mediaCleanupObligation.findFirstOrThrow({where:{objectKey:videoKey}});expect(intent.cleanupClass).toBe("assigned_artifact");expect(await db.mediaCleanupObligation.count({where:{objectKey:audioKey}})).toBe(0);expect(await db.sourceAudio.findUnique({where:{id:audio.id}})).not.toBeNull();
    await db.workspace.delete({where:{id:workspace.id}});
  });

  test("current source retirement preserves every live hold and the exclusive ninety-day boundary", async()=>{
    const cutoffAt=new Date(cutoff.getTime()-90*86400000);
    for(const condition of ["missing_key","not_ready","workflow","ingest","no_render","preview","missing_time","recent","boundary","purging"] as const){
      const f=await sourceFixture();
      try{
        await db.workflowRun.update({where:{id:f.run.id},data:{status:"completed"}});
        switch(condition){
          case "missing_key":await db.project.update({where:{id:f.project.id},data:{sourceStorageKey:null}});break;
          case "not_ready":await db.project.update({where:{id:f.project.id},data:{ingestStatus:"normalizing"}});break;
          case "workflow":await db.workflowRun.update({where:{id:f.run.id},data:{status:"waiting"}});break;
          case "ingest":await db.ingestJob.create({data:{projectId:f.project.id,jobType:"link_import",payload:{},status:"queued"}});break;
          case "no_render":await db.clipRender.updateMany({where:{clipId:f.clip.id},data:{status:"pending",storageKey:null}});break;
          case "preview":await db.clip.update({where:{id:f.clip.id},data:{previewStorageKey:null}});break;
          case "missing_time":await db.project.update({where:{id:f.project.id},data:{ingestCompletedAt:null}});break;
          case "recent":await db.project.update({where:{id:f.project.id},data:{ingestCompletedAt:new Date(cutoffAt.getTime()+1)}});break;
          case "boundary":await db.project.update({where:{id:f.project.id},data:{ingestCompletedAt:cutoffAt}});break;
          case "purging":await db.project.update({where:{id:f.project.id},data:{purgeStartedAt:new Date()}});break;
        }
        const result=await db.$transaction(async tx=>retireSourceMediaPage(tx,await page()));
        expect(result.processed).toBe(0);expect(result.dispatchIds).toEqual([]);
        expect(await db.mediaCleanupObligation.count({where:{objectKey:f.videoKey}})).toBe(0);
        expect(await db.sourceAudio.findUnique({where:{id:f.audio.id}})).not.toBeNull();
      }finally{await db.workspace.delete({where:{id:f.workspace.id}});}
    }
    const f=await sourceFixture();
    try{
      await db.workflowRun.update({where:{id:f.run.id},data:{status:"completed"}});
      await db.project.update({where:{id:f.project.id},data:{ingestCompletedAt:new Date(cutoffAt.getTime()-1)}});
      expect((await db.$transaction(async tx=>retireSourceMediaPage(tx,await page()))).processed).toBe(1);
      expect(await db.project.findUniqueOrThrow({where:{id:f.project.id}})).toMatchObject({sourceStorageKey:null});
      expect(await db.mediaCleanupObligation.count({where:{objectKey:f.videoKey}})).toBe(1);
    }finally{await db.workspace.delete({where:{id:f.workspace.id}});}
  });

});
