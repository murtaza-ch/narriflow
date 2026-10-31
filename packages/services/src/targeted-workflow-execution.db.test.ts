import { assertExecutionDatabaseTestTarget } from "./execution-db-test-support";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { WorkflowRunLifecycle, WorkflowFailure } from "./workflow-run-lifecycle";
import { createExecutorControl } from "./executor-control";
import { appendExecutionDispatch } from "./execution-dispatch";
import { withServiceEnvironment } from "./runtime-environment";
import type { ExecutorMutationContext } from "./executor-domain-control";
import { createTranscriptionAdmission } from "./transcription-admission";

const url = process.env.SERVERLESS_TEST_DATABASE_URL;
const dbDescribe = process.env.ALLOW_SERVERLESS_DB_TESTS === "1" && url ? describe : describe.skip;

dbDescribe("Exact Workflow execution commands", () => {
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
    const ids = (await db.executionDispatch.findMany({ where: { subjectId: { in: subjects } }, select: { id: true } })).map(row => row.id);
    await db.executionInboxReceipt.deleteMany({ where: { deliveryId: { in: receipts } } });
    await db.executionArtifact.deleteMany({ where: { attempt: { dispatchId: { in: ids } } } });
    await db.executionAttempt.deleteMany({ where: { dispatchId: { in: ids } } });
    await db.executionDispatch.deleteMany({ where: { id: { in: ids } } });
    await db.processingUsageReservation.deleteMany({ where: { workspace: { ownerUserId: { in: users } } } });
    await db.workspace.deleteMany({ where: { ownerUserId: { in: users } } });
    await db.user.deleteMany({ where: { id: { in: users } } });
    await db.$disconnect();
  }, 60_000);

  async function fixture(stage = "moment_detection", admitted = true, executionDeadline?: Date) {
    const user = await db.user.create({ data: { clerkId: `exact-workflow-gate:${crypto.randomUUID()}` } }); users.push(user.id);
    const workspace = await db.workspace.create({ data: { ownerUserId: user.id, name: "Exact workflow gate" } });
    const project = await db.project.create({ data: { workspaceId: workspace.id, title: "Exact workflow gate", sourceMediaUrl: "r2://gate/video.mp4", sourceStorageKey: "gate/video.mp4", ingestStatus: "ready" } });
    const epoch = (await db.executionEpoch.findUniqueOrThrow({ where: { id: 1 } })).epoch;
    const run = await db.workflowRun.create({ data: { projectId: project.id, deploymentEpoch: epoch, stage, status: "queued", idempotencyKey: crypto.randomUUID() } }); subjects.push(run.id);
    if (stage === "stt") {
      const ingest = await db.ingestJob.create({ data: { projectId: project.id, jobType: "upload_finalize", payload: {}, status: "completed" } }); subjects.push(ingest.id);
      const audioToken = crypto.randomUUID(), audioOwner = crypto.randomUUID(), audioKey = `execution/${epoch}/${audioToken}/${audioOwner}/audio.m4a`;
      const sourceDispatch = await db.$transaction(tx => appendExecutionDispatch(tx, { deploymentEpoch: epoch, kind: "modal_execution", subject: { kind: "ingest_job", id: ingest.id }, generation: 1,
        inputHash: "a".repeat(64), dueAt: ingest.createdAt }));
      await db.executionAttempt.create({ data: { attemptToken: audioToken, dispatchId: sourceDispatch.reference.dispatchId, deploymentEpoch: epoch, generation: 1,
        inputHash: sourceDispatch.reference.inputHash, functionName: "fetch_source", operationDeadlineAt: new Date(Date.now() + 45 * 60_000), owner: audioOwner,
        leaseExpiresAt: new Date(Date.now() + 120_000), processStartedAt: new Date(), finishedAt: new Date(), status: "completed" } });
      await db.executionArtifact.create({ data: { attemptToken: audioToken, owner: audioOwner, role: "source_audio", storageKey: audioKey, bindingHash: "b".repeat(64), contentType: "audio/mp4", maxBytes: 4096n,
        byteLength: 1000n, etag: '"audio"', checksumSha256: "e".repeat(64), grantExpiresAt: new Date(Date.now() + 60_000), committedAt: new Date() } });
      const audio = await db.sourceAudio.create({ data: { projectId: project.id, sourceRevision: 1, mediaProvider: "upload", mediaId: project.id,
        audioTrack: { id: "0", language: "en", codec: "aac", sampleRate: 48000, channels: 2 }, bindingHash: "d".repeat(64), storageKey: audioKey,
        etag: '"audio"', byteLength: 1000n, checksumSha256: "e".repeat(64), durationSeconds: 60.01, audioStartTimeSec: 0, probeVersion: "normalized-probe-1", toolchainFingerprint: "f".repeat(64) } });
      await db.transcript.create({ data: { projectId: project.id, sourceRevision: 1, sourceAudioId: audio.id } });
      await db.processingUsageReservation.create({ data: { projectId: project.id, workspaceId: workspace.id, intakeKind: "upload", periodStart: new Date("2026-10-01T00:00:00Z"),
        reservedSeconds: 120, settledSeconds: 120, state: "settled" } });
    }
    const lifecycle = withServiceEnvironment({}, () => new WorkflowRunLifecycle({ prisma: db }));
    const reference = (await db.$transaction(tx => lifecycle.dispatchRunWithinTransaction(tx, run.id))).reference;
    const token = crypto.randomUUID(), owner = crypto.randomUUID();
    if (admitted) await db.executionAttempt.create({ data: { attemptToken: token, dispatchId: reference.dispatchId, deploymentEpoch: epoch, generation: run.generation,
      inputHash: reference.inputHash, functionName: stage, operationDeadlineAt: executionDeadline ?? new Date(Date.now() + 10 * 60_000),
      createdAt: executionDeadline ? new Date(executionDeadline.getTime() - 60_000) : undefined } });
    const control = createExecutorControl({ database: db, subjectKind: "workflow_run", domain: lifecycle, deliverWakes: async () => {} });
    function verified() {
      const deliveryId = crypto.randomUUID(); receipts.push(deliveryId);
      return { requestHash: crypto.randomUUID().replaceAll("-", "").repeat(2), metadata: { version: 1 as const, keyId: "workflow-gate", audience: "executor-control" as const,
        method: "POST" as const, canonicalTarget: "/api/execution/command", bodySha256: "0".repeat(64), timestamp: Math.floor(Date.now() / 1000), deliveryId, signature: "0".repeat(64) } };
    }
    const fence = { reference, attemptToken: token, owner };
    const acquire = () => withServiceEnvironment({}, () => control.execute({ command: { action: "acquire", reference, attemptToken: token, owner, leaseSeconds: 120 }, verifiedRequest: verified() }));
    return { run, reference, token, owner, fence, control, verified, acquire, lifecycle };
  }

  test("concurrent weighted admission admits one provider and parks an uncharged waiter without a generic attempt", async () => {
    const fixtures = await Promise.all([fixture("stt", false), fixture("stt", false)]);
    const admission = createTranscriptionAdmission({ database: db, workflow: fixtures[0]!.lifecycle, maxUnits: 1 });
    const results = await Promise.all(fixtures.map(f => withServiceEnvironment({}, () => admission.admit(f.reference, { owner: f.owner }))));
    expect(results.map(result => result.kind).sort()).toEqual(["begun", "capacity_wait"]);
    const winner = results.findIndex(result => result.kind === "begun"), loser = winner === 0 ? 1 : 0;
    const granted = results[winner]!, denied = results[loser]!;
    if (granted.kind !== "begun" || denied.kind !== "capacity_wait") throw new Error("Expected one admission and one durable capacity wait");
    expect(await db.workflowRun.findUniqueOrThrow({ where: { id: fixtures[winner]!.run.id } })).toMatchObject({ status: "waiting", attemptCount: 1, leaseOwner: null });
    expect(await db.workflowRun.findUniqueOrThrow({ where: { id: fixtures[loser]!.run.id } })).toMatchObject({ status: "queued", attemptCount: 0, attemptId: null,
      operationDeadlineAt: null, errorCode: "provider_capacity_wait", nextAttemptAt: denied.dueAt });
    expect(await db.executionAttempt.count({ where: { dispatch: { subjectKind: "workflow_run", subjectId: fixtures[loser]!.run.id } } })).toBe(0);
    expect(denied.dueAt).toEqual(granted.intent.submissionDeadlineAt!);
    const replay = await withServiceEnvironment({}, () => admission.admit(fixtures[winner]!.reference, { owner: crypto.randomUUID() }));
    expect(replay.kind).toBe("already_waiting");
    expect(await db.executionAttempt.count({ where: { dispatch: { subjectKind: "workflow_run", subjectId: fixtures[winner]!.run.id } } })).toBe(1);
  }, 180_000);

  test("provider intent closes generic ownership and retries read the same intent without permission to POST again", async () => {
    const f = await fixture("stt");
    await f.acquire();
    await withServiceEnvironment({}, () => f.control.execute({ command: { action: "process-start", fence: f.fence }, verifiedRequest: f.verified() }));
    const begin = () => withServiceEnvironment({}, () => db.$transaction(async tx => {
      await tx.$queryRaw`SELECT "epoch" FROM "ExecutionEpoch" WHERE "id" = 1 FOR SHARE`;
      const locked = await f.lifecycle.lockExecution(tx, f.reference, f.token);
      if (locked.kind !== "current") throw new Error("Expected current STT lineage");
      await tx.$queryRaw`SELECT "attemptToken" FROM "ExecutionAttempt" WHERE "attemptToken" = ${f.token}::uuid FOR UPDATE`;
      const attempt = await tx.executionAttempt.findUniqueOrThrow({ where: { attemptToken: f.token } });
      const context: ExecutorMutationContext = { reference: f.reference, attemptToken: f.token, owner: f.owner, now: new Date(),
        leaseExpiresAt: attempt.leaseExpiresAt!, operationDeadlineAt: attempt.operationDeadlineAt, functionName: "stt" };
      return f.lifecycle.beginProviderSubmissionExecution(tx, locked.ref, context);
    }));
    const first = await begin();
    expect(first.kind).toBe("begun");
    const replay = await begin();
    expect(replay).toMatchObject({ kind: "already_waiting", reference: first.reference, submissionDeadlineAt: first.submissionDeadlineAt, dispatchIds: first.dispatchIds });
    expect(await db.workflowRun.findUniqueOrThrow({ where: { id: f.run.id } })).toMatchObject({ status: "waiting", attemptId: f.token, leaseOwner: null, leaseExpiresAt: null, attemptCount: 1 });
    const execution = await db.executionAttempt.findUniqueOrThrow({ where: { attemptToken: f.token } });
    expect(execution).toMatchObject({ status: "completed" });
    expect(execution.revokedAt).not.toBeNull();
    const audio = await db.sourceAudio.findUniqueOrThrow({ where: { id: first.reference.sourceAudioId! } });
    expect((await db.executionArtifact.findUniqueOrThrow({ where: { storageKey: audio.storageKey } })).grantExpiresAt).toEqual(first.providerAudioGrantExpiresAt);
    expect(first.providerAudioGrantExpiresAt.getTime() - first.serverTime.getTime()).toBe(4 * 60 * 60_000);
    const deliveryId = crypto.randomUUID(); receipts.push(deliveryId);
    expect(await withServiceEnvironment({}, () => f.control.expireDeadline({ deadline: { reference: f.reference, attemptToken: f.token, kind: "lease", observedDeadlineAt: execution.leaseExpiresAt!.toISOString() }, deliveryId }))).toEqual({ kind: "terminal" });
    expect(await f.lifecycle.lookupProviderAttempt({ ...first.reference, deploymentEpoch: first.reference.deploymentEpoch + 1 })).toEqual({ kind: "stale", reason: "epoch_superseded" });
    expect(await f.lifecycle.lookupProviderAttempt({ ...first.reference, sourceRevision: first.reference.sourceRevision + 1 })).toEqual({ kind: "stale", reason: "source_superseded" });
    expect(await f.lifecycle.lookupProviderAttempt({ ...first.reference, sourceAudioId: crypto.randomUUID() })).toEqual({ kind: "stale", reason: "source_superseded" });
  }, 180_000);

  test("accepted provider deadline is fixed to the intent and provider failure atomically registers the next fenced generation", async () => {
    const f = await fixture("stt", false);
    const admission = createTranscriptionAdmission({ database: db, workflow: f.lifecycle, maxUnits: 4 });
    const begun = await withServiceEnvironment({}, () => admission.admit(f.reference, { owner: f.owner }));
    if (begun.kind !== "begun") throw new Error("Expected fresh provider intent");
    const accepted = await withServiceEnvironment({}, () => f.lifecycle.recordProviderAcceptance(begun.intent.reference,
      { requestId: "request-gate", transcriptionId: "transcription-gate", nextPollAt: new Date(begun.intent.serverTime.getTime() + 60_000) }));
    expect(accepted.kind).toBe("applied");
    const transcript = await db.transcript.findUniqueOrThrow({ where: { projectId: f.run.projectId } });
    expect(transcript.providerResultDeadlineAt).toEqual(new Date(begun.intent.serverTime.getTime() + 2 * 60 * 60_000));
    expect(transcript.providerSubmissionDeadlineAt).toBeNull();
    const duplicate = await withServiceEnvironment({}, () => f.lifecycle.recordProviderAcceptance(begun.intent.reference,
      { requestId: "request-gate", transcriptionId: "transcription-gate", nextPollAt: new Date(begun.intent.serverTime.getTime() + 120_000) }));
    expect(duplicate.kind).toBe("duplicate");
    expect((await db.transcript.findUniqueOrThrow({ where: { projectId: f.run.projectId } })).providerResultDeadlineAt).toEqual(transcript.providerResultDeadlineAt);
    const result = await withServiceEnvironment({}, () => f.lifecycle.failProviderAttempt(begun.intent.reference,
      new WorkflowFailure("elevenlabs_result_timeout", "retryable", "Test timeout"), { requestId: "request-gate", transcriptionId: "transcription-gate" }));
    expect(result.kind).toBe("applied");
    expect(await db.workflowRun.findUniqueOrThrow({ where: { id: f.run.id } })).toMatchObject({ status: "queued", generation: 2, operationDeadlineAt: null, attemptCount: 1, attemptId: null });
    expect(await db.executionDispatch.count({ where: { subjectId: f.run.id, generation: 2, kind: "operation_driver", wakeKind: null } })).toBe(1);
  }, 180_000);

  test("source cancellation revokes running TS ownership and provider lineage atomically without changing historical charges", async () => {
    const f = await fixture("stt", false);
    const admission = createTranscriptionAdmission({ database: db, workflow: f.lifecycle, maxUnits: 4 });
    const begun = await withServiceEnvironment({}, () => admission.admit(f.reference, { owner: f.owner }));
    if (begun.kind !== "begun") throw new Error("Expected provider lineage");
    const sibling = await db.workflowRun.create({ data: { projectId: f.run.projectId, deploymentEpoch: f.reference.deploymentEpoch,
      stage: "moment_detection", status: "running", idempotencyKey: crypto.randomUUID(), attemptId: crypto.randomUUID(), attemptCount: 1,
      leaseOwner: crypto.randomUUID(), leaseExpiresAt: new Date(Date.now() + 120_000) } }); subjects.push(sibling.id);
    const siblingDispatch = await db.$transaction(tx => f.lifecycle.dispatchRunWithinTransaction(tx, sibling.id));
    await db.executionAttempt.create({ data: { attemptToken: sibling.attemptId!, dispatchId: siblingDispatch.reference.dispatchId,
      deploymentEpoch: sibling.deploymentEpoch, generation: sibling.generation, inputHash: siblingDispatch.reference.inputHash,
      functionName: "moment_detection", status: "running", owner: sibling.leaseOwner, leaseExpiresAt: sibling.leaseExpiresAt,
      operationDeadlineAt: new Date(Date.now() + 600_000), processStartedAt: new Date() } });
    const result = await withServiceEnvironment({}, () => db.$transaction(async tx => {
      await tx.$queryRaw`SELECT "epoch" FROM "ExecutionEpoch" WHERE "id" = 1 FOR SHARE`;
      await tx.$queryRaw`SELECT "id" FROM "Project" WHERE "id" = ${f.run.projectId}::uuid FOR UPDATE`;
      return f.lifecycle.cancelSourceExecutionsWithinTransaction(tx, { projectId: f.run.projectId, deploymentEpoch: f.reference.deploymentEpoch,
        errorCode: "source_audio_video_mismatch", now: new Date() });
    }));
    expect(result.dispatchIds.length).toBeGreaterThanOrEqual(2);
    expect(await db.workflowRun.findMany({ where: { id: { in: [f.run.id, sibling.id] } } })).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: f.run.id, status: "cancelled", attemptCount: 1, leaseOwner: null, nextPollAt: null }),
      expect.objectContaining({ id: sibling.id, status: "cancelled", attemptCount: 1, leaseOwner: null }),
    ]));
    expect(await db.executionAttempt.findUniqueOrThrow({ where: { attemptToken: sibling.attemptId! } })).toMatchObject({ status: "failed", failureCode: "source_audio_video_mismatch" });
    expect((await db.executionAttempt.findUniqueOrThrow({ where: { attemptToken: sibling.attemptId! } })).revokedAt).not.toBeNull();
    expect(await db.transcript.findUniqueOrThrow({ where: { projectId: f.run.projectId } })).toMatchObject({ status: "failed", errorCode: "source_audio_video_mismatch", providerSubmissionDeadlineAt: null, providerResultDeadlineAt: null });
    expect(await f.lifecycle.recordProviderAcceptance(begun.intent.reference, { requestId: "cancelled-request", transcriptionId: "cancelled-provider", nextPollAt: new Date() })).toMatchObject({ kind: "terminal", status: "cancelled" });
  }, 180_000);

  test("startup rejection is uncharged and revokes the exact Workflow generation", async () => {
    const f = await fixture();
    expect((await f.acquire()).disposition).toBe("acquired");
    expect(await db.workflowRun.findUniqueOrThrow({ where: { id: f.run.id } })).toMatchObject({ status: "running", attemptCount: 0, attemptId: f.token, leaseOwner: f.owner });
    await withServiceEnvironment({}, () => f.control.execute({ command: { action: "release", fence: f.fence, reason: "startup_rejected" }, verifiedRequest: f.verified() }));
    expect(await db.workflowRun.findUniqueOrThrow({ where: { id: f.run.id } })).toMatchObject({ status: "queued", generation: 2, attemptCount: 0, attemptId: null, leaseOwner: null });
    const retry = await db.executionDispatch.findFirstOrThrow({ where: { subjectId: f.run.id, kind: "operation_driver", generation: 2, wakeKind: null } });
    expect(retry.inputHash).not.toBe(f.reference.inputHash);
    expect(await db.executionAttempt.findUniqueOrThrow({ where: { attemptToken: f.token } })).toMatchObject({ status: "released" });
  }, 90_000);

  test("start replay charges once and progress never extends the TS execution lease", async () => {
    const f = await fixture();
    await f.acquire();
    const command = { action: "process-start" as const, fence: f.fence }, verifiedRequest = f.verified();
    await withServiceEnvironment({}, () => f.control.execute({ command, verifiedRequest }));
    await withServiceEnvironment({}, () => f.control.execute({ command, verifiedRequest }));
    const before = await db.workflowRun.findUniqueOrThrow({ where: { id: f.run.id } });
    expect(before.attemptCount).toBe(1);
    await withServiceEnvironment({}, () => f.control.execute({ command: { action: "progress", fence: f.fence, phase: "preparing", progress: 30 }, verifiedRequest: f.verified() }));
    expect(await db.workflowRun.findUniqueOrThrow({ where: { id: f.run.id } })).toMatchObject({ progress: 30, leaseExpiresAt: before.leaseExpiresAt });
    await withServiceEnvironment({}, () => f.control.execute({ command: { action: "fail", fence: f.fence, failureCode: "llm_rate_limited", retryable: true }, verifiedRequest: f.verified() }));
    expect(await db.workflowRun.findUniqueOrThrow({ where: { id: f.run.id } })).toMatchObject({ status: "queued", generation: 2, attemptCount: 1, attemptId: null });
  }, 120_000);

  test("expired lease cannot renew and the exact deadline commits one retry transition", async () => {
    const f = await fixture();
    await f.acquire();
    await withServiceEnvironment({}, () => f.control.execute({ command: { action: "process-start", fence: f.fence }, verifiedRequest: f.verified() }));
    const expired = new Date(0);
    await db.workflowRun.update({ where: { id: f.run.id }, data: { leaseExpiresAt: expired } });
    await db.executionAttempt.update({ where: { attemptToken: f.token }, data: { leaseExpiresAt: expired } });
    expect((await withServiceEnvironment({}, () => f.control.execute({ command: { action: "renew", fence: f.fence, leaseSeconds: 120 }, verifiedRequest: f.verified() }))).disposition).toBe("expired");
    const deliveryId = crypto.randomUUID(); receipts.push(deliveryId);
    const deadline = { reference: f.reference, attemptToken: f.token, kind: "lease", observedDeadlineAt: expired.toISOString() };
    const first = await withServiceEnvironment({}, () => f.control.expireDeadline({ deadline, deliveryId }));
    expect(first.kind).toBe("expired");
    expect(await withServiceEnvironment({}, () => f.control.expireDeadline({ deadline, deliveryId }))).toEqual(first);
    expect(await db.workflowRun.findUniqueOrThrow({ where: { id: f.run.id } })).toMatchObject({ status: "queued", generation: 2, attemptCount: 1, attemptId: null, leaseOwner: null });
    expect(await db.executionAttempt.findUniqueOrThrow({ where: { attemptToken: f.token } })).toMatchObject({ status: "expired" });
  }, 120_000);

  test("unacquired operation deadline fails without inventing a charged Workflow attempt", async () => {
    const expired = new Date(0);
    const f = await fixture("moment_detection", true, expired);
    const deliveryId = crypto.randomUUID(); receipts.push(deliveryId);
    expect((await withServiceEnvironment({}, () => f.control.expireDeadline({ deadline: { reference: f.reference, attemptToken: f.token, kind: "operation", observedDeadlineAt: expired.toISOString() }, deliveryId }))).kind).toBe("expired");
    expect(await db.workflowRun.findUniqueOrThrow({ where: { id: f.run.id } })).toMatchObject({ status: "failed", attemptCount: 0, attemptId: null, leaseOwner: null });
  }, 90_000);
});
