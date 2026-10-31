import { assertExecutionDatabaseTestTarget } from "./execution-db-test-support";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, type Prisma } from "@prisma/client";
import { IngestJobLifecycle } from "./ingest-job-lifecycle";
import { WorkflowRunLifecycle } from "./workflow-run-lifecycle";
import { ProcessingUsage } from "./processing-usage";
import { appendExecutionDispatch } from "./execution-dispatch";
import { withServiceEnvironment } from "./runtime-environment";
import { createSourceVideoValidator } from "./source-readiness";
import { createExecutorControl } from "./executor-control";
import type { SourceAudioBinding, SourceVideoBinding } from "@narriflow/validators/execution";
import { sourceAudioBindingHash } from "./source-audio-binding";
import { workflowRunExecutionInputHash } from "./workflow-execution-input";
import { createTranscriptionAdmission } from "./transcription-admission";
import { createTranscriptionProbe } from "./transcription-probe";
import { createIngestSourceExecution, ingestExecutionInputHash, prepareIngestSourceExecution } from "./ingest-source-execution";
import { createExecutionStorage } from "./execution-storage";

const url = process.env.SERVERLESS_TEST_DATABASE_URL;
const dbDescribe = process.env.ALLOW_SERVERLESS_DB_TESTS === "1" && url ? describe : describe.skip;

dbDescribe("Targeted Ingest execution", () => {
  let db: PrismaClient;
  const users: string[] = [], subjects: string[] = [], receipts: string[] = [];
  beforeAll(async () => {
    assertExecutionDatabaseTestTarget(url, process.env.SERVERLESS_TEST_DATABASE_SCHEMA ?? "public");
    const schema = process.env.SERVERLESS_TEST_DATABASE_SCHEMA ?? "public";
    if (schema !== "public" && !/^serverless_execution_test_[a-z0-9]+$/.test(schema)) throw new Error("Only disposable execution schemas are allowed");
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url, max: 4 }, { schema }), transactionOptions: { timeout: 60_000, maxWait: 30_000 } });
    const [actual] = await db.$queryRaw<Array<{ schema: string }>>`SELECT current_schema() AS "schema"`;
    if (actual?.schema !== schema) throw new Error("Wrong execution schema");
  }, 60_000);
  afterAll(async () => {
    subjects.push(...(await db.workflowEvent.findMany({ where: { project: { workspace: { ownerUserId: { in: users } } } }, select: { id: true } })).map(row => row.id));
    subjects.push(...(await db.workspaceEvent.findMany({ where: { workspace: { ownerUserId: { in: users } } }, select: { id: true } })).map(row => row.id));
    const workflows = await db.workflowRun.findMany({ where: { project: { workspace: { ownerUserId: { in: users } } } }, select: { id: true } });
    subjects.push(...workflows.map((run) => run.id));
    const ids = (await db.executionDispatch.findMany({ where: { subjectId: { in: subjects } }, select: { id: true } })).map((row) => row.id);
    await db.executionInboxReceipt.deleteMany({ where: { deliveryId: { in: receipts } } });
    await db.executionArtifact.deleteMany({ where: { attempt: { dispatchId: { in: ids } } } });
    await db.executionAttempt.deleteMany({ where: { dispatchId: { in: ids } } });
    await db.executionDispatch.deleteMany({ where: { id: { in: ids } } });
    await db.sourceRefundNeed.deleteMany({ where: { projectId: { in: (await db.project.findMany({ where: { workspace: { ownerUserId: { in: users } } }, select: { id: true } })).map(project => project.id) } } });
    await db.processingUsageReservation.deleteMany({ where: { workspace: { ownerUserId: { in: users } } } });
    await db.workspace.deleteMany({ where: { ownerUserId: { in: users } } });
    await db.user.deleteMany({ where: { id: { in: users } } });
    await db.$disconnect();
  }, 60_000);

  async function fixture(executionDeadline?: Date,audioPolicy:"none"|"pending_pack"="pending_pack",source?:{jobType:"upload_finalize";payload:Prisma.InputJsonObject}) {
    const user = await db.user.create({ data: { clerkId: `targeted-ingest:${crypto.randomUUID()}` } }); users.push(user.id);
    const workspace = await db.workspace.create({ data: { name: "Targeted ingest", ownerUserId: user.id } });
    const project = await db.project.create({ data: { workspaceId: workspace.id, title: "Targeted ingest", sourceType: "youtube", sourceMediaUrl: "https://youtube.com/watch?v=dQw4w9WgXcQ", ingestStatus: "queued" } });
    const job = await db.ingestJob.create({ data: { projectId: project.id, jobType: source?.jobType??"link_import", payload: source?{...source.payload,acquisition:{audioPolicy}}:{ acquisition:{audioPolicy}, provider: "youtube", mediaId: "dQw4w9WgXcQ", url: project.sourceMediaUrl } } }); subjects.push(job.id);
    const usage = new ProcessingUsage({ prisma: db, log: () => {} });
    await db.$transaction((tx) => usage.reserve(tx, { workspaceId: workspace.id, projectId: project.id, actorUserId: user.id, intakeKind: "link", declaredSeconds: 120 }));
    const workflow = withServiceEnvironment({}, () => new WorkflowRunLifecycle({ prisma: db }));
    const lifecycle = new IngestJobLifecycle({ prisma: db, workflow, usage, validateVideo: createSourceVideoValidator(usage), executionInputHash: job => ingestExecutionInputHash(job, "d".repeat(64)), requireRetryActor: async () => { throw new Error("Retry admission is outside this fixture"); } });
    const epoch = (await db.executionEpoch.findUniqueOrThrow({ where: { id: 1 } })).epoch;
    const inputHash = await ingestExecutionInputHash(job, "d".repeat(64));
    const dispatch = await db.$transaction((tx) => appendExecutionDispatch(tx, { deploymentEpoch: epoch, kind: "modal_execution", subject: { kind: "ingest_job", id: job.id }, generation: 1, inputHash, dueAt: new Date("2026-10-31T00:00:00.000Z") }));
    const token = crypto.randomUUID(), owner = crypto.randomUUID();
    await db.executionAttempt.create({ data: { attemptToken: token, dispatchId: dispatch.reference.dispatchId, deploymentEpoch: epoch, generation: 1, inputHash: dispatch.reference.inputHash, functionName:job.jobType==="upload_finalize"?"pin_source":"fetch_source", operationDeadlineAt: executionDeadline ?? new Date(Date.now() + 45 * 60_000),
      createdAt: executionDeadline ? new Date(executionDeadline.getTime() - 60_000) : undefined } });
    const control = createExecutorControl({ database: db, subjectKind: "ingest_job", domain: lifecycle, deliverWakes: async () => {},
      artifacts: { head: async (assignment) => ({ etag: '"audio-etag"', contentType: assignment.contentType, byteLength: 1024n, sha256: "c".repeat(64) }),
        prepare: async (_assignment, artifact, reported) => {
          if (reported.role === "source_audio" && reported.sourceAudio) return { ...artifact, role: "source_audio" as const, binding: reported.sourceAudio };
          if (reported.role === "source_video" && reported.sourceVideo) return { ...artifact, role: "source_video" as const, binding: reported.sourceVideo };
          if (reported.role === "probe") return { ...artifact, role: "probe" as const };
          throw new Error("Unexpected fixture role");
        } },
    });
    function verified() {
      const deliveryId = crypto.randomUUID(); receipts.push(deliveryId);
      return { requestHash: crypto.randomUUID().replaceAll("-", "").repeat(2), metadata: { version: 1 as const, keyId: "ingest-gate", audience: "executor-control" as const, method: "POST" as const,
        canonicalTarget: "/api/execution/command", bodySha256: "0".repeat(64), timestamp: Math.floor(Date.now() / 1000), deliveryId, signature: "0".repeat(64) } };
    }
    return { job, project, owner, token, reference: dispatch.reference, control, verified, lifecycle, epoch, workflow, usage };
  }

  test("source preparation admits one unowned generic attempt and retains one absolute deadline on replay", async () => {
    const f = await fixture();
    await db.executionAttempt.delete({ where: { attemptToken: f.token } });
    await db.executionDispatch.delete({ where: { id: f.reference.dispatchId } });
    const driver = await db.$transaction(tx => appendExecutionDispatch(tx, { deploymentEpoch: f.epoch, generation: 1,
      kind: "operation_driver", subject: { kind: "ingest_job", id: f.job.id }, inputHash: f.reference.inputHash, dueAt: f.job.createdAt }));
    const prepare = () => prepareIngestSourceExecution({ database: db, domain: f.lifecycle, reference: driver.reference,
      toolchainFingerprint: "d".repeat(64), executionKind: "modal_execution" });
    const [first, replay] = await Promise.all([prepare(), prepare()]);
    expect(first.kind).toBe("waiting"); expect(replay.kind).toBe("waiting");
    if (first.kind !== "waiting" || replay.kind !== "waiting") throw new Error("Preparation missing");
    expect(first.deadline).toEqual(replay.deadline);
    const attempts = await db.executionAttempt.findMany({ where: { dispatch: { subjectId: f.job.id, kind: "modal_execution" } } });
    expect(attempts).toHaveLength(1);expect(attempts[0]!.owner).toBeNull();expect(attempts[0]!.status).toBe("admitted");
    const job=await db.ingestJob.findUniqueOrThrow({where:{id:f.job.id}});
    expect(job).toMatchObject({status:"queued",claimId:null,executorOwner:null,attemptCount:0,operationDeadlineAt:attempts[0]!.operationDeadlineAt});
    expect(attempts[0]!.operationDeadlineAt.getTime()-attempts[0]!.createdAt.getTime()).toBeGreaterThan(44*60_000);
    expect(attempts[0]!.operationDeadlineAt.getTime()-attempts[0]!.createdAt.getTime()).toBeLessThanOrEqual(45*60_000);
    expect(await prepareIngestSourceExecution({database:db,domain:f.lifecycle,reference:{...driver.reference,inputHash:"f".repeat(64)},toolchainFingerprint:"d".repeat(64),executionKind:"modal_execution"})).toEqual({kind:"superseded"});
  });

  test("a charged transient retry wakes the next exact source generation without extending its deadline",async()=>{
    const f=await fixture();const fence={reference:f.reference,attemptToken:f.token,owner:f.owner};
    await f.control.execute({command:{action:"acquire",...fence,leaseSeconds:120},verifiedRequest:f.verified()});
    await f.control.execute({command:{action:"process-start",fence},verifiedRequest:f.verified()});
    const before=await db.ingestJob.findUniqueOrThrow({where:{id:f.job.id}});
    expect((await f.control.execute({command:{action:"fail",fence,failureCode:"remote_download_failed",retryable:true},verifiedRequest:f.verified()})).disposition).toBe("failed");
    const job=await db.ingestJob.findUniqueOrThrow({where:{id:f.job.id}});
    expect(job).toMatchObject({status:"queued",generation:2,attemptCount:1,claimId:null,executorOwner:null,operationDeadlineAt:before.operationDeadlineAt});
    const retry=await db.executionDispatch.findFirstOrThrow({where:{subjectId:job.id,kind:"operation_driver",generation:2}});
    expect(retry.inputHash).toBe(await ingestExecutionInputHash(job,"d".repeat(64)));
    expect(retry.inputHash).not.toBe(f.reference.inputHash);
    expect(await db.executionAttempt.count({where:{dispatch:{subjectId:job.id,generation:2}}})).toBe(0);
  });

  test("enqueue seals the producer's acquisition policy into the source payload",async()=>{
    const f=await fixture();
    const project=await db.project.create({data:{workspaceId:f.project.workspaceId,title:"Supplied source",sourceType:"upload",sourceMediaUrl:"r2://verified/source.mp4",ingestStatus:"queued"}});
    const admitted=await db.$transaction(tx=>f.lifecycle.enqueue(tx,{projectId:project.id,jobType:"upload_finalize",payload:{storageKey:"verified/source.mp4"},acquisition:{audioPolicy:"none"}}));subjects.push(admitted.id);
    const job=await db.ingestJob.findUniqueOrThrow({where:{id:admitted.id}});
    expect(job.payload).toEqual({storageKey:"verified/source.mp4",acquisition:{audioPolicy:"none"}});
    expect(job).toMatchObject({status:"queued",attemptCount:0,claimId:null});
  });

  function measuredBindings(f: Awaited<ReturnType<typeof fixture>>, audioKey: string): { audio: SourceAudioBinding; video: SourceVideoBinding } {
    const audio: SourceAudioBinding = { sourceAudioId: crypto.randomUUID(), projectId: f.project.id, sourceRevision: 1,
      mediaIdentity: { provider: "youtube", mediaId: "dQw4w9WgXcQ" }, audioTrack: { id: "140", language: "en", codec: "aac", sampleRate: 48000, channels: 2 },
      object: { key: audioKey, etag: '"audio-etag"', byteLength: 1024, sha256: "c".repeat(64) }, durationSeconds: 120.25,
      wholeSource: true, audioStartTimeSec: 0, probeVersion: "normalized-probe-1", toolchainFingerprint: "d".repeat(64) };
    const stream = { codec: "aac", profile: null, timeBase: null, startPts: null, startTimeSec: 0, durationTs: null,
      durationSec: 120.25, endTimeSec: 120.25, frameCount: null, bitRate: null };
    const video: SourceVideoBinding = { projectId: f.project.id, sourceRevision: 1, mediaIdentity: audio.mediaIdentity, audioTrack: audio.audioTrack,
      wholeSource: true, audioStartTimeSec: 0, videoStartTimeSec: 0, probeVersion: audio.probeVersion, toolchainFingerprint: audio.toolchainFingerprint,
      probe: { durationSec: 120.25, audio: { sampleRate: 48000, channels: 2 },
        video: { width: 1920, height: 1080, frameRate: { numerator: 30, denominator: 1 }, startTimecode: null },
        facts: { format: { name: "mov,mp4,m4a,3gp,3g2,mj2", startTimeSec: 0, durationSec: 120.25, sizeBytes: 1024, bitRate: null }, attachedPictureCount: 0,
          videos: [{ ...stream, index: 0, codec: "h264", width: 1920, height: 1080, codedWidth: 1920, codedHeight: 1080, displayWidth: 1920, displayHeight: 1080,
            sampleAspectRatio: { numerator: 1, denominator: 1 }, displayMatrix: null, rotationDeg: 0, reflected: false,
            avgFrameRate: { numerator: 30, denominator: 1 }, rFrameRate: { numerator: 30, denominator: 1 }, pixelFormat: "yuv420p",
            colorRange: null, colorSpace: null, colorTransfer: null, colorPrimaries: null, chromaLocation: null, fieldOrder: null,
            masteringDisplay: null, contentLight: null, dolbyVision: null }],
          audios: [{ ...stream, index: 1, sampleRate: 48000, channels: 2, channelLayout: "stereo", sampleFormat: "fltp", initialPadding: 0, trailingPadding: 0 }] },
      } };
    return { audio, video };
  }

  test("the production source package assigns stable outputs and rejects rewritten source evidence", async () => {
    const f = await fixture();
    const factory = createIngestSourceExecution({ database: db, domain: f.lifecycle, workflow: f.workflow, toolchainFingerprint: "d".repeat(64),
      storage: createExecutionStorage({ accountId: "a".repeat(32), bucket: "test", accessKeyId: "fixture-key", secretAccessKey: "fixture-secret" }),
      artifacts: { head: async assignment => ({ etag: '"audio-etag"', contentType: assignment.contentType, byteLength: 1024n, sha256: "c".repeat(64) }) }, deliverWakes: async () => {} });
    const fence = { reference: f.reference, attemptToken: f.token, owner: f.owner };
    await factory.control.execute({ command: { action: "acquire", ...fence, leaseSeconds: 120 }, verifiedRequest: f.verified() });
    const first = await factory.transfer.execute({ command: { action: "work-package", fence }, verifiedRequest: f.verified() });
    const replay = await factory.transfer.execute({ command: { action: "work-package", fence }, verifiedRequest: f.verified() });
    expect(first).toEqual(replay);
    if (first.disposition !== "work_package" || first.input.kind !== "inline") throw new Error("Expected inline source package");
    expect(first.input.command).toMatchObject({ kind: "youtube_source", projectId: f.project.id, sourceAudioId: f.token, mediaId: "dQw4w9WgXcQ", existingSourceAudio: null });
    expect(first.outputs.map(value => value.role).sort()).toEqual(["source_audio", "source_video"]);
    expect(await db.ingestJob.findUniqueOrThrow({ where: { id: f.job.id } })).toMatchObject({ attemptCount: 0, startedAt: null });
    await factory.control.execute({ command: { action: "process-start", fence }, verifiedRequest: f.verified() });
    const output = first.outputs.find(value => value.role === "source_audio")!;
    const assigned = await db.executionArtifact.findUniqueOrThrow({ where: { id: output.artifactId } });
    const binding = { ...measuredBindings(f, assigned.storageKey).audio, sourceAudioId: f.token, probeVersion: "normalized-probe-v1" };
    const artifact = { artifactId: assigned.id, role: "source_audio", bindingHash: assigned.bindingHash, contentType: assigned.contentType,
      byteLength: 1024, etag: '"audio-etag"', sha256: "c".repeat(64), sourceAudio: binding };
    await expect(factory.control.execute({ command: { action: "commit-artifact", fence, artifact: { ...artifact, sourceAudio: { ...binding, mediaIdentity: { provider: "youtube", mediaId: "abcdefghijk" } } } }, verifiedRequest: f.verified() })).rejects.toThrow("artifact_invalid");
    expect(await db.sourceAudio.count({ where: { projectId: f.project.id } })).toBe(0);
    expect((await factory.control.execute({ command: { action: "commit-artifact", fence, artifact }, verifiedRequest: f.verified() })).disposition).toBe("committed");
    expect(await db.sourceAudio.findUniqueOrThrow({ where: { id: f.token } })).toMatchObject({ mediaId: "dQw4w9WgXcQ", storageKey: assigned.storageKey, durationSeconds: 120.25 });
    await expect(Promise.resolve(db.ingestJob.update({ where: { id: f.job.id }, data: { payload: { provider: "youtube", url: "https://youtu.be/abcdefghijk" } } }))).rejects.toThrow();
  }, 60_000);

  test("known supplied or declined captions never receive a fresh SourceAudio destination",async()=>{
    const f=await fixture(undefined,"none");
    const factory=createIngestSourceExecution({database:db,domain:f.lifecycle,workflow:f.workflow,toolchainFingerprint:"d".repeat(64),
      storage:createExecutionStorage({accountId:"a".repeat(32),bucket:"test",accessKeyId:"fixture",secretAccessKey:"fixture"}),
      artifacts:{head:async assignment=>({etag:'"audio-etag"',contentType:assignment.contentType,byteLength:1024n,sha256:"c".repeat(64)})},deliverWakes:async()=>{}});
    const fence={reference:f.reference,attemptToken:f.token,owner:f.owner};
    await factory.control.execute({command:{action:"acquire",...fence,leaseSeconds:120},verifiedRequest:f.verified()});
    const result=await factory.transfer.execute({command:{action:"work-package",fence},verifiedRequest:f.verified()});
    if(result.disposition!=="work_package" || result.input.kind!=="inline")throw new Error("No source package");
    expect(result.outputs.map(value=>value.role)).toEqual(["source_video"]);
    expect(result.input.command).toMatchObject({audioPolicy:"none"});
  });

  test("upload source preparation binds conditional pin outputs to the verified object tuple",async()=>{
    const source={uploadSessionId:crypto.randomUUID(),storageKey:"uploads/verified/source.mp4",verifiedEtag:'"frozen"',verifiedSizeBytes:6*1024**3,verifiedContentType:"video/mp4"};
    const f=await fixture(undefined,"pending_pack",{jobType:"upload_finalize",payload:source});
    const factory=createIngestSourceExecution({database:db,domain:f.lifecycle,workflow:f.workflow,toolchainFingerprint:"d".repeat(64),
      storage:createExecutionStorage({accountId:"a".repeat(32),bucket:"test",accessKeyId:"fixture",secretAccessKey:"fixture"}),
      artifacts:{head:async assignment=>({etag:'"audio-etag"',contentType:assignment.contentType,byteLength:1024n,sha256:"c".repeat(64)})},deliverWakes:async()=>{}});
    const fence={reference:f.reference,attemptToken:f.token,owner:f.owner};
    await factory.control.execute({command:{action:"acquire",...fence,leaseSeconds:120},verifiedRequest:f.verified()});
    const result=await factory.transfer.execute({command:{action:"work-package",fence},verifiedRequest:f.verified()});
    if(result.disposition!=="work_package"||result.input.kind!=="inline")throw new Error("No source package");
    expect(result.functionName).toBe("pin_source");expect(result.input.command).toMatchObject({kind:"upload_source",mediaIdentity:{provider:"upload",mediaId:source.uploadSessionId}});
    expect(result.outputs.find(value=>value.role==="source_video")).toMatchObject({sourceEtag:'"frozen"',sourceByteLength:6*1024**3,maxBytes:6*1024**3});
    expect(result.sources.map(value=>({name:value.name,storageKey:value.storageKey,etag:value.etag,byteLength:value.byteLength}))).toEqual([{name:"upload_source",storageKey:source.storageKey,etag:'"frozen"',byteLength:6*1024**3}]);
    await factory.control.execute({command:{action:"process-start",fence},verifiedRequest:f.verified()});
    const output=result.outputs.find(value=>value.role==="source_video")!;
    const binding=measuredBindings(f,"execution/unused").video;
    binding.mediaIdentity={provider:"upload",mediaId:source.uploadSessionId};binding.probeVersion="normalized-probe-v1";
    binding.audioTrack=null;binding.audioStartTimeSec=null;binding.probe.audio=null;binding.probe.facts.audios=[];
    await expect(factory.control.execute({command:{action:"commit-artifact",fence,artifact:{artifactId:output.artifactId,role:"source_video",bindingHash:output.bindingHash,
      contentType:"video/mp4",byteLength:1024,sha256:"c".repeat(64),etag:'"audio-etag"',sourceVideo:binding}},verifiedRequest:f.verified()})).rejects.toThrow("artifact_invalid");
  });

  async function earlyAudio(f: Awaited<ReturnType<typeof fixture>>, draft = false) {
    await db.project.update({ where: { id: f.project.id }, data: { ingestStatus: "downloading", sourceDurationSeconds: null } });
    await db.ingestJob.update({ where: { id: f.job.id }, data: { status: "running", claimId: f.token, executorOwner: f.owner, claimExpiresAt: new Date(Date.now() + 120_000) } });
    const binding = { ...measuredBindings(f, `execution/${f.token}/source.m4a`).audio, durationSeconds: 60.01 };
    const sourceAudio = await db.sourceAudio.create({ data: { id: binding.sourceAudioId, projectId: f.project.id, sourceRevision: 1,
      mediaProvider: binding.mediaIdentity.provider, mediaId: binding.mediaIdentity.mediaId, audioTrack: binding.audioTrack,
      bindingHash: await sourceAudioBindingHash(binding), storageKey: binding.object.key, etag: binding.object.etag, byteLength: BigInt(binding.object.byteLength),
      checksumSha256: binding.object.sha256, durationSeconds: binding.durationSeconds, audioStartTimeSec: binding.audioStartTimeSec,
      probeVersion: binding.probeVersion, toolchainFingerprint: binding.toolchainFingerprint } });
    const pack = await db.contentPack.create({ data: { projectId: f.project.id, draft, outputTypes: ["short_clip"], clipGenerationMode: "best", clipCountTarget: 10,
      clipDurationSecTarget: 45, platformTargets: ["tiktok"], toneConstraints: [], captionPreset: "brand_default", platformPlaybookVersion: "2026-07-01" } });
    const record = await db.$transaction(tx => appendExecutionDispatch(tx, { deploymentEpoch: f.epoch, kind: "import_pipeline", subject: { kind: "ingest_job", id: f.job.id },
      generation: 1, inputHash: f.reference.inputHash, dueAt: f.job.createdAt, wakeKind: "audio_ready" }));
    return { sourceAudio, pack, reference: record.reference };
  }

  test("exact audio handoff admits STT once while native video stays owned and downloading", async () => {
    const f = await fixture();
    const audio = await earlyAudio(f);
    const results = await Promise.all([1, 2].map(() => withServiceEnvironment({}, () => f.lifecycle.handoffGeneration(audio.reference))));
    expect(results.map(result => result.kind).sort()).toEqual(["acknowledged", "admitted"]);
    const run = await db.workflowRun.findFirstOrThrow({ where: { projectId: f.project.id, stage: "stt" } });
    expect(await db.workflowRun.count({ where: { projectId: f.project.id, stage: "stt" } })).toBe(1);
    expect(await db.transcript.findUniqueOrThrow({ where: { projectId: f.project.id } })).toMatchObject({ status: "queued", sourceAudioId: audio.sourceAudio.id, sourceRevision: 1 });
    expect(await db.processingUsageReservation.findUniqueOrThrow({ where: { projectId: f.project.id } })).toMatchObject({ state: "settled", settledSeconds: 120 });
    expect(await db.ingestJob.findUniqueOrThrow({ where: { id: f.job.id } })).toMatchObject({ status: "running", claimId: f.token, executorOwner: f.owner, generationRunId: run.id });
    expect(await db.project.findUniqueOrThrow({ where: { id: f.project.id } })).toMatchObject({ ingestStatus: "downloading", sourceStorageKey: null });
    const dispatches = await db.executionDispatch.findMany({ where: { subjectKind: "workflow_run", subjectId: run.id, kind: "operation_driver" } });
    expect(dispatches).toHaveLength(1);
    expect(dispatches[0]!.inputHash).toBe(await workflowRunExecutionInputHash({ id: run.id, projectId: f.project.id, stage: "stt", contentPackId: audio.pack.id,
      generation: run.generation, deploymentEpoch: run.deploymentEpoch, sourceAudioId: audio.sourceAudio.id, sourceRevision: 1 }));
    expect(results[0]!.dispatchIds).toEqual(results[1]!.dispatchIds);
    expect(results[0]!.dispatchIds).toContain(dispatches[0]!.id);
    expect(results[0]!.dispatchIds).toHaveLength(2);
    const progress = await db.executionDispatch.findUniqueOrThrow({ where: { id: results[0]!.dispatchIds.find(id => id !== dispatches[0]!.id)! } });
    expect(progress).toMatchObject({ kind: "project_progress", subjectKind: "maintenance" });
  }, 120_000);

  test("audio handoff validates the ledger tuple and waits for a committed pack before charging", async () => {
    const f = await fixture();
    const audio = await earlyAudio(f, true);
    expect((await withServiceEnvironment({}, () => f.lifecycle.handoffGeneration({ ...audio.reference, inputHash: "f".repeat(64) }))).kind).toBe("superseded");
    expect((await withServiceEnvironment({}, () => f.lifecycle.handoffGeneration(audio.reference))).kind).toBe("waiting_for_pack");
    expect(await db.workflowRun.count({ where: { projectId: f.project.id } })).toBe(0);
    expect(await db.processingUsageReservation.findUniqueOrThrow({ where: { projectId: f.project.id } })).toMatchObject({ state: "reserved", settledSeconds: null });
  }, 90_000);

  test("audio handoff refusal releases usage and revokes native ownership in the same commit", async () => {
    const f = await fixture();
    const audio = await earlyAudio(f);
    await db.workspace.update({ where: { id: f.project.workspaceId }, data: { status: "restricted" } });
    expect((await withServiceEnvironment({}, () => f.lifecycle.handoffGeneration(audio.reference))).kind).toBe("refused");
    expect(await db.ingestJob.findUniqueOrThrow({ where: { id: f.job.id } })).toMatchObject({ status: "failed", claimId: null, executorOwner: null, claimExpiresAt: null, attemptCount: 0 });
    const attempt = await db.executionAttempt.findUniqueOrThrow({ where: { attemptToken: f.token } });
    expect(attempt).toMatchObject({ status: "failed", failureCode: "project_access_denied" });
    expect(attempt.revokedAt).not.toBeNull();
    expect(attempt.finishedAt).not.toBeNull();
    expect(await db.processingUsageReservation.findUniqueOrThrow({ where: { projectId: f.project.id } })).toMatchObject({ state: "released", settledSeconds: null });
    expect(await db.workflowRun.count({ where: { projectId: f.project.id } })).toBe(0);
  }, 90_000);

  test("scheduling failure rolls back audio debit, transcript and STT admission before a durable retry", async () => {
    const f = await fixture();
    const audio = await earlyAudio(f);
    const failingDatabase = new Proxy(db, { get(target, field) {
      if (field !== "$transaction") return Reflect.get(target, field);
      return (work: (tx: Prisma.TransactionClient) => Promise<unknown>, options: object) => target.$transaction(tx => work(new Proxy(tx, { get(inner, method) {
        if (method !== "$queryRaw") return Reflect.get(inner, method);
        return (...args: unknown[]) => {
          const query = args[0] as { strings?: readonly string[] };
          const strings = Array.isArray(query) ? query : query.strings;
          if (strings?.join("").includes('INSERT INTO "ExecutionDispatch"')) throw new Error("injected scheduling outage");
          return Reflect.apply(inner.$queryRaw, inner, args);
        };
      } })), options);
    } });
    const failing = new IngestJobLifecycle({ prisma: failingDatabase, workflow: f.workflow, usage: f.usage,
      requireRetryActor: async () => { throw new Error("Retry admission is outside this fixture"); } });
    expect((await withServiceEnvironment({}, () => failing.handoffGeneration(audio.reference))).kind).toBe("deferred");
    expect(await db.processingUsageReservation.findUniqueOrThrow({ where: { projectId: f.project.id } })).toMatchObject({ state: "reserved", settledSeconds: null });
    expect(await db.transcript.findUnique({ where: { projectId: f.project.id } })).toBeNull();
    expect(await db.workflowRun.count({ where: { projectId: f.project.id } })).toBe(0);
    const job = await db.ingestJob.findUniqueOrThrow({ where: { id: f.job.id } });
    expect(job).toMatchObject({ status: "running", generationHandoffAt: null, generationRunId: null, claimId: f.token });
    expect(job.generationHandoffRetryAt).not.toBeNull();
  }, 120_000);

  test("a pre-start rejection is uncharged, revokes the old generation and keeps reserved usage", async () => {
    const f = await fixture();
    const acquired = await withServiceEnvironment({}, () => f.control.execute({ command: { action: "acquire", reference: f.reference, attemptToken: f.token, owner: f.owner, leaseSeconds: 120 }, verifiedRequest: f.verified() }));
    expect(acquired.disposition).toBe("acquired");
    expect(await db.ingestJob.findUniqueOrThrow({ where: { id: f.job.id } })).toMatchObject({ status: "running", attemptCount: 0, startedAt: null });
    await withServiceEnvironment({}, () => f.control.execute({ command: { action: "release", fence: { reference: f.reference, attemptToken: f.token, owner: f.owner }, reason: "startup_rejected" }, verifiedRequest: f.verified() }));
    expect(await db.ingestJob.findUniqueOrThrow({ where: { id: f.job.id } })).toMatchObject({ status: "queued", attemptCount: 0, generation: 2, claimId: null, executorOwner: null });
    expect(await db.processingUsageReservation.findUniqueOrThrow({ where: { projectId: f.project.id } })).toMatchObject({ state: "reserved" });
  }, 90_000);

  test("process-start charges once while progress preserves the exact native lease", async () => {
    const f = await fixture();
    const fence = { reference: f.reference, attemptToken: f.token, owner: f.owner };
    await withServiceEnvironment({}, () => f.control.execute({ command: { action: "acquire", reference: f.reference, attemptToken: f.token, owner: f.owner, leaseSeconds: 120 }, verifiedRequest: f.verified() }));
    const start = { command: { action: "process-start", fence }, verifiedRequest: f.verified() };
    await withServiceEnvironment({}, () => f.control.execute(start));
    await withServiceEnvironment({}, () => f.control.execute(start));
    const before = await db.ingestJob.findUniqueOrThrow({ where: { id: f.job.id } });
    expect(before.attemptCount).toBe(1);
    await withServiceEnvironment({}, () => f.control.execute({ command: { action: "progress", fence, phase: "downloading", progress: 20 }, verifiedRequest: f.verified() }));
    const after = await db.ingestJob.findUniqueOrThrow({ where: { id: f.job.id } });
    expect(after.claimExpiresAt).toEqual(before.claimExpiresAt);
    expect(await db.project.findUniqueOrThrow({ where: { id: f.project.id } })).toMatchObject({ ingestStatus: "downloading" });
  }, 90_000);

  test("verified whole-source audio commits evidence and wake without marking video ready or spending usage", async () => {
    const f = await fixture();
    const fence = { reference: f.reference, attemptToken: f.token, owner: f.owner };
    await withServiceEnvironment({}, () => f.control.execute({ command: { action: "acquire", reference: f.reference, attemptToken: f.token, owner: f.owner, leaseSeconds: 120 }, verifiedRequest: f.verified() }));
    await withServiceEnvironment({}, () => f.control.execute({ command: { action: "process-start", fence }, verifiedRequest: f.verified() }));
    const key = `execution/${f.epoch}/${f.token}/${f.owner}/audio.m4a`;
    const assignment = await db.executionArtifact.create({ data: { attemptToken: f.token, owner: f.owner, role: "source_audio", bindingHash: "b".repeat(64), storageKey: key,
      contentType: "audio/mp4", maxBytes: 4096n, grantExpiresAt: new Date(Date.now() + 60_000) } });
    const binding = { sourceAudioId: crypto.randomUUID(), projectId: f.project.id, sourceRevision: 1, mediaIdentity: { provider: "youtube", mediaId: "dQw4w9WgXcQ" },
      audioTrack: { id: "140", language: "en", codec: "aac", sampleRate: 48000, channels: 2 }, object: { key, etag: '"audio-etag"', byteLength: 1024, sha256: "c".repeat(64) },
      durationSeconds: 120.25, wholeSource: true, audioStartTimeSec: 0, probeVersion: "normalized-probe-1", toolchainFingerprint: "d".repeat(64) };
    expect(await withServiceEnvironment({}, () => f.control.execute({ command: { action: "commit-artifact", fence, artifact: { artifactId: assignment.id, role: "source_audio", contentType: "audio/mp4",
      byteLength: 1024, etag: '"audio-etag"', sha256: "c".repeat(64), bindingHash: assignment.bindingHash, sourceAudio: binding } }, verifiedRequest: f.verified() }))).toEqual({ disposition: "committed", artifactId: assignment.id });
    const audio = await db.sourceAudio.findUniqueOrThrow({ where: { id: binding.sourceAudioId } });
    expect(audio).toMatchObject({ durationSeconds: 120.25, storageKey: key, checksumSha256: "c".repeat(64) });
    expect(audio.bindingHash).not.toBe(assignment.bindingHash);
    expect((await db.project.findUniqueOrThrow({ where: { id: f.project.id } })).ingestStatus).not.toBe("ready");
    expect(await db.ingestJob.findUniqueOrThrow({ where: { id: f.job.id } })).toMatchObject({ status: "running", generation: 1 });
    expect(await db.processingUsageReservation.findUniqueOrThrow({ where: { projectId: f.project.id } })).toMatchObject({ state: "reserved", settledSeconds: null });
    expect(await db.executionDispatch.findFirst({ where: { subjectId: f.job.id, kind: "import_pipeline", wakeKind: "audio_ready" } })).not.toBeNull();
  }, 90_000);

  test("unacquired absolute expiry releases reserved usage and completes the intake once", async () => {
    const expired = new Date(0);
    const f = await fixture(expired);
    const run = () => withServiceEnvironment({}, () => db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "epoch" FROM "ExecutionEpoch" WHERE "id" = 1 FOR SHARE`;
      await f.lifecycle.lockExecution(tx, f.reference, f.token);
      await tx.$queryRaw`SELECT "attemptToken" FROM "ExecutionAttempt" WHERE "attemptToken" = ${f.token}::uuid FOR UPDATE`;
      return f.lifecycle.expireExecution(tx, f.reference, f.token, { kind: "operation", observedDeadlineAt: expired });
    }));
    expect((await run()).kind).toBe("expired");
    expect((await run()).kind).toBe("terminal");
    expect(await db.ingestJob.findUniqueOrThrow({ where: { id: f.job.id } })).toMatchObject({ status: "failed", attemptCount: 0 });
    expect(await db.processingUsageReservation.findUniqueOrThrow({ where: { projectId: f.project.id } })).toMatchObject({ state: "released", settledSeconds: null });
    expect(await db.workspaceEvent.count({ where: { subject: { path: ["projectId"], equals: f.project.id }, type: "operation.finished" } })).toBe(1);
  }, 90_000);

  test("audio publication atomically admits an already committed pack without another pipeline read", async () => {
    const f = await fixture();
    await db.contentPack.create({ data: { projectId: f.project.id, outputTypes: ["short_clip"], clipGenerationMode: "best", clipCountTarget: 10,
      clipDurationSecTarget: 45, platformTargets: ["tiktok"], toneConstraints: [], captionPreset: "brand_default", platformPlaybookVersion: "2026-07-01" } });
    const fence = { reference: f.reference, attemptToken: f.token, owner: f.owner };
    await withServiceEnvironment({}, () => f.control.execute({ command: { action: "acquire", reference: f.reference, attemptToken: f.token, owner: f.owner, leaseSeconds: 120 }, verifiedRequest: f.verified() }));
    await withServiceEnvironment({}, () => f.control.execute({ command: { action: "process-start", fence }, verifiedRequest: f.verified() }));
    const key = `execution/${f.epoch}/${f.token}/${f.owner}/source.m4a`;
    const binding = measuredBindings(f, key).audio;
    const artifact = await db.executionArtifact.create({ data: { attemptToken: f.token, owner: f.owner, role: "source_audio", bindingHash: "b".repeat(64), storageKey: key,
      contentType: "audio/mp4", maxBytes: 4096n, grantExpiresAt: new Date(Date.now() + 60_000) } });
    await withServiceEnvironment({}, () => f.control.execute({ command: { action: "commit-artifact", fence, artifact: { artifactId: artifact.id, role: "source_audio", contentType: "audio/mp4",
      byteLength: 1024, etag: '"audio-etag"', sha256: "c".repeat(64), bindingHash: artifact.bindingHash, sourceAudio: binding } }, verifiedRequest: f.verified() }));
    const run = await db.workflowRun.findFirstOrThrow({ where: { projectId: f.project.id, stage: "stt" } });
    expect(await db.ingestJob.findUniqueOrThrow({ where: { id: f.job.id } })).toMatchObject({ status: "running", generationRunId: run.id, executorOwner: f.owner });
    expect(await db.transcript.findUniqueOrThrow({ where: { projectId: f.project.id } })).toMatchObject({ sourceAudioId: binding.sourceAudioId, sourceRevision: 1, status: "queued" });
    expect(await db.processingUsageReservation.findUniqueOrThrow({ where: { projectId: f.project.id } })).toMatchObject({ state: "settled", settledSeconds: 180 });
    expect(await db.executionDispatch.count({ where: { subjectId: run.id, kind: "operation_driver", wakeKind: null, deadlineKind: null } })).toBe(1);
    expect((await db.project.findUniqueOrThrow({ where: { id: f.project.id } })).ingestStatus).not.toBe("ready");
  }, 120_000);

  test("optional native probe waits unowned before provider intent and its same-owner commit wakes the exact STT run", async () => {
    const f = await fixture();
    await db.contentPack.create({ data: { projectId: f.project.id, outputTypes: ["short_clip"], clipGenerationMode: "best", clipCountTarget: 10,
      clipDurationSecTarget: 45, platformTargets: ["tiktok"], toneConstraints: [], captionPreset: "brand_default", platformPlaybookVersion: "2026-07-01" } });
    const fence = { reference: f.reference, attemptToken: f.token, owner: f.owner };
    const probe = createTranscriptionProbe({ database: db, workflow: f.workflow });
    expect(await probe.descriptorForIngest(fence)).toBeNull();
    await withServiceEnvironment({}, () => f.control.execute({ command: { action: "acquire", reference: f.reference, attemptToken: f.token, owner: f.owner, leaseSeconds: 120 }, verifiedRequest: f.verified() }));
    await withServiceEnvironment({}, () => f.control.execute({ command: { action: "process-start", fence }, verifiedRequest: f.verified() }));
    const key = `execution/${f.epoch}/${f.token}/${f.owner}/source.m4a`, binding = measuredBindings(f, key).audio;
    const artifact = await db.executionArtifact.create({ data: { attemptToken: f.token, owner: f.owner, role: "source_audio", bindingHash: "b".repeat(64), storageKey: key,
      contentType: "audio/mp4", maxBytes: 4096n, grantExpiresAt: new Date(Date.now() + 60_000) } });
    await withServiceEnvironment({}, () => f.control.execute({ command: { action: "commit-artifact", fence, artifact: { artifactId: artifact.id, role: "source_audio", contentType: "audio/mp4",
      byteLength: 1024, etag: '"audio-etag"', sha256: "c".repeat(64), bindingHash: artifact.bindingHash, sourceAudio: binding } }, verifiedRequest: f.verified() }));
    const run = await db.workflowRun.findFirstOrThrow({ where: { projectId: f.project.id, stage: "stt" } });
    const registration = await db.$transaction(tx => f.workflow.dispatchRunWithinTransaction(tx, run.id));
    expect(await probe.prepare({ ...registration.reference, inputHash: "f".repeat(64) })).toMatchObject({ kind: "unavailable", reason: "superseded" });
    await db.project.update({ where: { id: f.project.id }, data: { languageCode: "en" } });
    expect(await probe.prepare(registration.reference)).toMatchObject({ kind: "skip", reason: "explicit_language" });
    expect(await probe.descriptorForIngest(fence)).toBeNull();
    await db.project.update({ where: { id: f.project.id }, data: { languageCode: null } });
    const waiting = await withServiceEnvironment({}, () => probe.prepare(registration.reference));
    expect(waiting.kind).toBe("wait");
    if (waiting.kind === "wait") expect(waiting.dueAt).toEqual(new Date((await db.sourceAudio.findUniqueOrThrow({ where: { id: binding.sourceAudioId } })).createdAt.getTime() + 90_000));
    expect((await db.workflowRun.findUniqueOrThrow({ where: { id: run.id } }))).toMatchObject({ status: "queued", attemptId: null, attemptCount: 0 });
    expect(await db.executionAttempt.count({ where: { dispatch: { subjectId: run.id } } })).toBe(0);
    const descriptor = await probe.descriptorForIngest(fence);
    if (!descriptor) throw new Error("Expected admitted same-owner probe");
    expect(await probe.descriptorForIngest({ ...fence, owner: crypto.randomUUID() })).toBeNull();
    expect(descriptor.input).toMatchObject({ sourceAudioId: binding.sourceAudioId, workflowRunId: run.id, generation: 1,
      windows: [{ startSec: 14.05, durationSec: 20 }, { startSec: 50.125, durationSec: 20 }, { startSec: 86.2, durationSec: 20 }], toolchainFingerprint: binding.toolchainFingerprint });
    const output = await db.executionArtifact.create({ data: { attemptToken: f.token, owner: f.owner, role: "probe", bindingHash: descriptor.output.bindingHash,
      storageKey: `execution/${f.epoch}/${f.token}/${f.owner}/probe.wav`, contentType: "audio/wav", maxBytes: 2_000_000n, grantExpiresAt: new Date(Date.now() + 60_000) } });
    const committed = await withServiceEnvironment({}, () => f.control.execute({ command: { action: "commit-artifact", fence, artifact: { artifactId: output.id, role: "probe",
      contentType: "audio/wav", byteLength: 1024, etag: '"audio-etag"', sha256: "c".repeat(64), bindingHash: output.bindingHash } }, verifiedRequest: f.verified() }));
    expect(committed.disposition).toBe("committed");
    expect(await db.executionDispatch.count({ where: { subjectId: run.id, wakeKind: "probe_ready", generation: 1 } })).toBe(1);
    expect(await probe.prepare(registration.reference)).toMatchObject({ kind: "ready", artifactId: output.id });
    expect((await db.ingestJob.findUniqueOrThrow({ where: { id: f.job.id } }))).toMatchObject({ status: "running", executorOwner: f.owner });
    const admitted = await withServiceEnvironment({}, () => createTranscriptionAdmission({ database: db, workflow: f.workflow, maxUnits: 12 }).admit(registration.reference, { owner: crypto.randomUUID() }));
    if (admitted.kind !== "begun") throw new Error("Expected provider intent after ready probe");
    expect((await probe.readForProvider(admitted.intent.reference))?.artifact.id).toBe(output.id);
    const videoBinding = measuredBindings(f, key).video;
    const video = await db.executionArtifact.create({ data: { attemptToken: f.token, owner: f.owner, role: "source_video", bindingHash: "e".repeat(64), storageKey: `${key}.mp4`,
      contentType: "video/mp4", maxBytes: 4096n, grantExpiresAt: new Date(Date.now() + 60_000) } });
    await withServiceEnvironment({}, () => f.control.execute({ command: { action: "commit-artifact", fence, artifact: { artifactId: video.id, role: "source_video", contentType: "video/mp4",
      byteLength: 1024, etag: '"audio-etag"', sha256: "c".repeat(64), bindingHash: video.bindingHash, sourceVideo: videoBinding } }, verifiedRequest: f.verified() }));
    expect((await db.ingestJob.findUniqueOrThrow({ where: { id: f.job.id } })).status).toBe("completed");
    expect((await probe.readForProvider(admitted.intent.reference))?.artifact.id).toBe(output.id);
    expect(await probe.descriptorForIngest(fence)).toBeNull();
  }, 60_000);

  test("already sealed mismatching video refuses audio admission before a debit or STT run exists", async () => {
    const f = await fixture();
    await db.contentPack.create({ data: { projectId: f.project.id, outputTypes: ["short_clip"], clipGenerationMode: "best", clipCountTarget: 10,
      clipDurationSecTarget: 45, platformTargets: ["tiktok"], toneConstraints: [], captionPreset: "brand_default", platformPlaybookVersion: "2026-07-01" } });
    const fence = { reference: f.reference, attemptToken: f.token, owner: f.owner };
    await withServiceEnvironment({}, () => f.control.execute({ command: { action: "acquire", reference: f.reference, attemptToken: f.token, owner: f.owner, leaseSeconds: 120 }, verifiedRequest: f.verified() }));
    await withServiceEnvironment({}, () => f.control.execute({ command: { action: "process-start", fence }, verifiedRequest: f.verified() }));
    const key = `execution/${f.epoch}/${f.token}/${f.owner}/source.m4a`;
    const binding = measuredBindings(f, key);
    binding.audio.durationSeconds = 60.01;
    binding.video.probe.durationSec = 60;
    binding.video.probe.facts.format.durationSec = 60;
    for (const stream of [...binding.video.probe.facts.videos, ...binding.video.probe.facts.audios]) { stream.durationSec = 60; stream.endTimeSec = 60; }
    const assigned = [];
    for (const role of ["source_video", "source_audio"] as const) {
      const contentType = role === "source_audio" ? "audio/mp4" : "video/mp4";
      const artifact = await db.executionArtifact.create({ data: { attemptToken: f.token, owner: f.owner, role, bindingHash: "b".repeat(64), storageKey: role === "source_audio" ? key : `${key}.mp4`,
        contentType, maxBytes: 4096n, grantExpiresAt: new Date(Date.now() + 60_000) } });
      assigned.push({ role, contentType, artifact });
    }
    for (const { role, contentType, artifact } of assigned) {
      await withServiceEnvironment({}, () => f.control.execute({ command: { action: "commit-artifact", fence, artifact: { artifactId: artifact.id, role, contentType,
        byteLength: 1024, etag: '"audio-etag"', sha256: "c".repeat(64), bindingHash: artifact.bindingHash,
        ...(role === "source_audio" ? { sourceAudio: binding.audio } : { sourceVideo: binding.video }) } }, verifiedRequest: f.verified() }));
    }
    expect(await db.ingestJob.findUniqueOrThrow({ where: { id: f.job.id } })).toMatchObject({ status: "failed", generationRunId: null });
    expect(await db.processingUsageReservation.findUniqueOrThrow({ where: { projectId: f.project.id } })).toMatchObject({ state: "released", settledSeconds: null });
    expect(await db.workflowRun.count({ where: { projectId: f.project.id, stage: "stt" } })).toBe(0);
    expect(await db.sourceRefundNeed.count({ where: { projectId: f.project.id } })).toBe(0);
  }, 120_000);

  test.each(["sealed_video", "source_audio_video_mismatch", "source_identity_mismatch"])("late mismatch %s cancels admitted provider work without erasing charged usage", async mode => {
    const f = await fixture();
    await db.contentPack.create({ data: { projectId: f.project.id, outputTypes: ["short_clip"], clipGenerationMode: "best", clipCountTarget: 10,
      clipDurationSecTarget: 45, platformTargets: ["tiktok"], toneConstraints: [], captionPreset: "brand_default", platformPlaybookVersion: "2026-07-01" } });
    const fence = { reference: f.reference, attemptToken: f.token, owner: f.owner };
    await withServiceEnvironment({}, () => f.control.execute({ command: { action: "acquire", reference: f.reference, attemptToken: f.token, owner: f.owner, leaseSeconds: 120 }, verifiedRequest: f.verified() }));
    await withServiceEnvironment({}, () => f.control.execute({ command: { action: "process-start", fence }, verifiedRequest: f.verified() }));
    const audioKey = `execution/${f.epoch}/${f.token}/${f.owner}/source.m4a`;
    const bindings = measuredBindings(f, audioKey);
    bindings.audio.durationSeconds = 60.01;
    bindings.video.probe.durationSec = bindings.video.probe.facts.format.durationSec = 60;
    for (const stream of [...bindings.video.probe.facts.videos, ...bindings.video.probe.facts.audios]) stream.durationSec = stream.endTimeSec = 60;
    const audio = await db.executionArtifact.create({ data: { attemptToken: f.token, owner: f.owner, role: "source_audio", bindingHash: "b".repeat(64), storageKey: audioKey,
      contentType: "audio/mp4", maxBytes: 4096n, grantExpiresAt: new Date(Date.now() + 60_000) } });
    const video = await db.executionArtifact.create({ data: { attemptToken: f.token, owner: f.owner, role: "source_video", bindingHash: "e".repeat(64), storageKey: `${audioKey}.mp4`,
      contentType: "video/mp4", maxBytes: 4096n, grantExpiresAt: new Date(Date.now() + 60_000) } });
    await withServiceEnvironment({}, () => f.control.execute({ command: { action: "commit-artifact", fence, artifact: { artifactId: audio.id, role: "source_audio",
      contentType: audio.contentType, byteLength: 1024, etag: '"audio-etag"', sha256: "c".repeat(64), bindingHash: audio.bindingHash, sourceAudio: bindings.audio } }, verifiedRequest: f.verified() }));
    const run = await db.workflowRun.findFirstOrThrow({ where: { projectId: f.project.id, stage: "stt" } });
    const reference = (await db.$transaction(tx => f.workflow.dispatchRunWithinTransaction(tx, run.id))).reference;
    const begun = await withServiceEnvironment({}, () => createTranscriptionAdmission({ database: db, workflow: f.workflow, maxUnits: 12 }).admit(reference, { owner: crypto.randomUUID() }));
    if (begun.kind !== "begun") throw new Error("Provider work must be admitted before the late mismatch");
    const command = mode === "sealed_video" ? { action: "commit-artifact" as const, fence, artifact: { artifactId: video.id, role: "source_video" as const, contentType: video.contentType,
      byteLength: 1024, etag: '"audio-etag"', sha256: "c".repeat(64), bindingHash: video.bindingHash, sourceVideo: bindings.video } }
      : { action: "fail" as const, fence, failureCode: mode, retryable: false };
    const receipt = f.verified();
    expect((await withServiceEnvironment({}, () => f.control.execute({ command, verifiedRequest: receipt }))).disposition).toBe(mode === "sealed_video" ? "committed" : "failed");
    expect(await db.workflowRun.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({ status: "cancelled", attemptCount: 1, leaseOwner: null, nextPollAt: null });
    expect(await db.project.findUniqueOrThrow({ where: { id: f.project.id } })).toMatchObject({ ingestStatus: "failed", ingestErrorCode: "source_audio_video_mismatch" });
    expect(await db.processingUsageReservation.findUniqueOrThrow({ where: { projectId: f.project.id } })).toMatchObject({ state: "settled", settledSeconds: 120 });
    expect(await db.sourceRefundNeed.count({ where: { projectId: f.project.id } })).toBe(1);
    const refund = await db.sourceRefundNeed.findUniqueOrThrow({ where: { projectId_sourceRevision: { projectId: f.project.id, sourceRevision: 1 } } });
    expect(refund.videoBindingHash === null).toBe(mode !== "sealed_video");
    expect(await db.executionDispatch.count({ where: { subjectId: run.id, wakeKind: "source_cancelled" } })).toBe(1);
    expect((await withServiceEnvironment({}, () => f.control.execute({ command, verifiedRequest: receipt }))).disposition).toBe(mode === "sealed_video" ? "committed" : "failed");
    expect(await db.sourceRefundNeed.count({ where: { projectId: f.project.id } })).toBe(1);
    expect(await f.workflow.recordProviderAcceptance(begun.intent.reference, { requestId: "late-mismatch", transcriptionId: "late-mismatch", nextPollAt: new Date() })).toMatchObject({ kind: "stale", reason: "source_superseded" });
    expect(await db.transcript.findUniqueOrThrow({ where: { projectId: f.project.id } })).toMatchObject({ status: "failed", errorCode: "source_audio_video_mismatch", providerResultDeadlineAt: null });
  }, 120_000);

  for (const first of ["source_audio", "source_video"] as const) test(`${first} can commit first and the second callback atomically publishes verified video`, async () => {
    const f = await fixture();
    const fence = { reference: f.reference, attemptToken: f.token, owner: f.owner };
    await withServiceEnvironment({}, () => f.control.execute({ command: { action: "acquire", reference: f.reference, attemptToken: f.token, owner: f.owner, leaseSeconds: 120 }, verifiedRequest: f.verified() }));
    await withServiceEnvironment({}, () => f.control.execute({ command: { action: "process-start", fence }, verifiedRequest: f.verified() }));
    const audioKey = `execution/${f.epoch}/${f.token}/${f.owner}/source.m4a`, videoKey = `execution/${f.epoch}/${f.token}/${f.owner}/source.mp4`;
    const bindings = measuredBindings(f, audioKey);
    const audio = await db.executionArtifact.create({ data: { attemptToken: f.token, owner: f.owner, role: "source_audio", bindingHash: "b".repeat(64), storageKey: audioKey,
      contentType: "audio/mp4", maxBytes: 4096n, grantExpiresAt: new Date(Date.now() + 60_000) } });
    const video = await db.executionArtifact.create({ data: { attemptToken: f.token, owner: f.owner, role: "source_video", bindingHash: "e".repeat(64), storageKey: videoKey,
      contentType: "video/mp4", maxBytes: 4096n, grantExpiresAt: new Date(Date.now() + 60_000) } });
    const commit = (role: "source_audio" | "source_video") => {
      const assignment = role === "source_audio" ? audio : video;
      return withServiceEnvironment({}, () => f.control.execute({ command: { action: "commit-artifact", fence,
        artifact: { artifactId: assignment.id, role, contentType: assignment.contentType, byteLength: 1024, etag: '"audio-etag"', sha256: "c".repeat(64), bindingHash: assignment.bindingHash,
          ...(role === "source_audio" ? { sourceAudio: bindings.audio } : { sourceVideo: bindings.video }) } }, verifiedRequest: f.verified() }));
    };
    expect((await commit(first)).disposition).toBe("committed");
    expect(await db.ingestJob.findUniqueOrThrow({ where: { id: f.job.id } })).toMatchObject({ status: "running" });
    expect((await db.project.findUniqueOrThrow({ where: { id: f.project.id } })).ingestStatus).not.toBe("ready");
    let waitingRenderRunId: string | null = null;
    if (first === "source_audio") {
      const run = await withServiceEnvironment({}, () => f.workflow.admit({ projectId: f.project.id, stage: "clip_rendering", idempotencyKey: crypto.randomUUID() }));
      waitingRenderRunId = run.id;
      subjects.push(run.id);
      const registered = await db.$transaction(tx => f.workflow.dispatchRunWithinTransaction(tx, run.id));
      expect((await withServiceEnvironment({}, () => f.workflow.prepareRenderRun(registered.reference))).kind).toBe("waiting_for_video");
    }
    if (first === "source_video") {
      expect((await db.executionArtifact.findUniqueOrThrow({ where: { id: video.id } })).sourceVideoBinding).toEqual(bindings.video);
      expect(await db.sourceAudio.findUnique({ where: { id: bindings.audio.sourceAudioId } })).toBeNull();
    }
    expect((await commit(first === "source_audio" ? "source_video" : "source_audio")).disposition).toBe("committed");
    expect(await db.ingestJob.findUniqueOrThrow({ where: { id: f.job.id } })).toMatchObject({ status: "completed", claimId: null, executorOwner: null, attemptCount: 1 });
    expect(await db.project.findUniqueOrThrow({ where: { id: f.project.id } })).toMatchObject({ ingestStatus: "ready", sourceStorageKey: videoKey, sourceProbe: bindings.video.probe });
    expect(await db.executionAttempt.findUniqueOrThrow({ where: { attemptToken: f.token } })).toMatchObject({ status: "completed", owner: f.owner });
    expect(await db.executionDispatch.count({ where: { subjectId: f.job.id, kind: "import_pipeline", wakeKind: "video_ready" } })).toBe(1);
    if (waitingRenderRunId) expect(await db.executionDispatch.count({ where: { subjectId: waitingRenderRunId, kind: "render_run", wakeKind: "video_ready" } })).toBe(1);
    expect(await db.processingUsageReservation.findUniqueOrThrow({ where: { projectId: f.project.id } })).toMatchObject({ state: "reserved", settledSeconds: null });
  }, 120_000);

  test("accepted source admission freezes one replayable import-pipeline obligation from the canonical job input", async () => {
    const f = await fixture();
    const first = await db.$transaction(tx => f.lifecycle.queueExecutionWithinTransaction(tx,f.job.id));
    expect(first?.subject).toEqual({ kind: "ingest_job", id: f.job.id });
    expect(first?.inputHash).toBe(await ingestExecutionInputHash(f.job,"d".repeat(64)));
    expect(first?.kind).toBe("import_pipeline");
    expect(await db.$transaction(tx => f.lifecycle.queueExecutionWithinTransaction(tx,f.job.id))).toEqual(first);
    expect(await db.executionDispatch.count({ where: { subjectKind: "ingest_job", subjectId: f.job.id, kind: "import_pipeline", wakeKind: null } })).toBe(1);
  });

});
