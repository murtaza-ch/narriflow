import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { IngestJobLifecycle } from "./ingest-job-lifecycle";
import { WorkflowRunLifecycle } from "./workflow-run-lifecycle";
import { ProcessingUsage } from "./processing-usage";
import { appendExecutionDispatch } from "./execution-dispatch";
import { withServiceEnvironment } from "./runtime-environment";
import { createSourceVideoValidator } from "./source-readiness";
import { createExecutorControl } from "./executor-control";
import type { SourceAudioBinding, SourceVideoBinding } from "@narriflow/validators/execution";

const url = process.env.SERVERLESS_TEST_DATABASE_URL;
const dbDescribe = process.env.ALLOW_SERVERLESS_DB_TESTS === "1" && url ? describe : describe.skip;

dbDescribe("Targeted Ingest execution", () => {
  let db: PrismaClient;
  const users: string[] = [], subjects: string[] = [], receipts: string[] = [];
  beforeAll(async () => {
    if (!url || new URL(url).hostname !== "ep-wispy-field-b5wyn9o3.c-7.us-east-2.aws.neon.tech") throw new Error("Only the isolated serverless gate branch is allowed");
    const schema = process.env.SERVERLESS_TEST_DATABASE_SCHEMA ?? "public";
    if (schema !== "public" && !/^serverless_execution_test_[a-z0-9]+$/.test(schema)) throw new Error("Only disposable execution schemas are allowed");
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url, max: 4 }, { schema }), transactionOptions: { timeout: 60_000, maxWait: 30_000 } });
    const [actual] = await db.$queryRaw<Array<{ schema: string }>>`SELECT current_schema() AS "schema"`;
    if (actual?.schema !== schema) throw new Error("Wrong execution schema");
  }, 60_000);
  afterAll(async () => {
    const ids = (await db.executionDispatch.findMany({ where: { subjectId: { in: subjects } }, select: { id: true } })).map((row) => row.id);
    await db.executionInboxReceipt.deleteMany({ where: { deliveryId: { in: receipts } } });
    await db.executionArtifact.deleteMany({ where: { attempt: { dispatchId: { in: ids } } } });
    await db.executionAttempt.deleteMany({ where: { dispatchId: { in: ids } } });
    await db.executionDispatch.deleteMany({ where: { id: { in: ids } } });
    await db.processingUsageReservation.deleteMany({ where: { workspace: { ownerUserId: { in: users } } } });
    await db.workspace.deleteMany({ where: { ownerUserId: { in: users } } });
    await db.user.deleteMany({ where: { id: { in: users } } });
    await db.$disconnect();
  }, 60_000);

  async function fixture() {
    const user = await db.user.create({ data: { clerkId: `targeted-ingest:${crypto.randomUUID()}` } }); users.push(user.id);
    const workspace = await db.workspace.create({ data: { name: "Targeted ingest", ownerUserId: user.id } });
    const project = await db.project.create({ data: { workspaceId: workspace.id, title: "Targeted ingest", sourceType: "youtube", sourceMediaUrl: "https://youtube.com/watch?v=dQw4w9WgXcQ", ingestStatus: "queued" } });
    const job = await db.ingestJob.create({ data: { projectId: project.id, jobType: "link_import", payload: { provider: "youtube", mediaId: "dQw4w9WgXcQ" } } }); subjects.push(job.id);
    const usage = new ProcessingUsage({ prisma: db, log: () => {} });
    await db.$transaction((tx) => usage.reserve(tx, { workspaceId: workspace.id, projectId: project.id, actorUserId: user.id, intakeKind: "link", declaredSeconds: 120 }));
    const workflow = withServiceEnvironment({}, () => new WorkflowRunLifecycle({ prisma: db }));
    const lifecycle = new IngestJobLifecycle({ prisma: db, workflow, usage, validateVideo: createSourceVideoValidator(usage), requireRetryActor: async () => { throw new Error("Retry admission is outside this fixture"); } });
    const epoch = (await db.executionEpoch.findUniqueOrThrow({ where: { id: 1 } })).epoch;
    const dispatch = await db.$transaction((tx) => appendExecutionDispatch(tx, { deploymentEpoch: epoch, kind: "modal_execution", subject: { kind: "ingest_job", id: job.id }, generation: 1, inputHash: "a".repeat(64), dueAt: new Date("2026-10-31T00:00:00.000Z") }));
    const token = crypto.randomUUID(), owner = crypto.randomUUID();
    await db.executionAttempt.create({ data: { attemptToken: token, dispatchId: dispatch.reference.dispatchId, deploymentEpoch: epoch, generation: 1, inputHash: dispatch.reference.inputHash, functionName: "fetch_source", operationDeadlineAt: new Date(Date.now() + 45 * 60_000) } });
    const control = createExecutorControl({ database: db, subjectKind: "ingest_job", domain: lifecycle, deliverWakes: async () => {},
      artifacts: { head: async (assignment) => ({ etag: '"audio-etag"', contentType: assignment.contentType, byteLength: 1024n, sha256: "c".repeat(64) }),
        prepare: async (_assignment, artifact, reported) => {
          if (reported.role === "source_audio" && reported.sourceAudio) return { ...artifact, role: "source_audio" as const, binding: reported.sourceAudio };
          if (reported.role === "source_video" && reported.sourceVideo) return { ...artifact, role: "source_video" as const, binding: reported.sourceVideo };
          throw new Error("Unexpected fixture role");
        } },
    });
    function verified() {
      const deliveryId = crypto.randomUUID(); receipts.push(deliveryId);
      return { requestHash: crypto.randomUUID().replaceAll("-", "").repeat(2), metadata: { version: 1 as const, keyId: "ingest-gate", audience: "executor-control" as const, method: "POST" as const,
        canonicalTarget: "/api/execution/command", bodySha256: "0".repeat(64), timestamp: Math.floor(Date.now() / 1000), deliveryId, signature: "0".repeat(64) } };
    }
    return { job, project, owner, token, reference: dispatch.reference, control, verified, lifecycle, epoch };
  }

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
    const f = await fixture();
    const expired = new Date(0);
    await db.executionAttempt.update({ where: { attemptToken: f.token }, data: { createdAt: new Date(-60_000), operationDeadlineAt: expired } });
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
    if (first === "source_video") {
      expect((await db.executionArtifact.findUniqueOrThrow({ where: { id: video.id } })).sourceVideoBinding).toEqual(bindings.video);
      expect(await db.sourceAudio.findUnique({ where: { id: bindings.audio.sourceAudioId } })).toBeNull();
    }
    expect((await commit(first === "source_audio" ? "source_video" : "source_audio")).disposition).toBe("committed");
    expect(await db.ingestJob.findUniqueOrThrow({ where: { id: f.job.id } })).toMatchObject({ status: "completed", claimId: null, executorOwner: null, attemptCount: 1 });
    expect(await db.project.findUniqueOrThrow({ where: { id: f.project.id } })).toMatchObject({ ingestStatus: "ready", sourceStorageKey: videoKey, sourceProbe: bindings.video.probe });
    expect(await db.executionAttempt.findUniqueOrThrow({ where: { attemptToken: f.token } })).toMatchObject({ status: "completed", owner: f.owner });
    expect(await db.executionDispatch.count({ where: { subjectId: f.job.id, kind: "import_pipeline", wakeKind: "video_ready" } })).toBe(1);
    expect(await db.processingUsageReservation.findUniqueOrThrow({ where: { projectId: f.project.id } })).toMatchObject({ state: "reserved", settledSeconds: null });
  }, 120_000);

});
