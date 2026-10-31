import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { assertExecutionDatabaseTestTarget } from "./execution-db-test-support";
import { frozenDubbingRequestSchema } from "@narriflow/validators/dubbing-execution";
import { frozenDubbingRequestHash, dubTranslationRequestBody, dubSpeechRequestBody, dubbingArtifactBindingHash } from "./dubbing-policy";
import { reserveGenerationUsage } from "./generated-media-usage-ledger";
import { WorkflowRunLifecycle } from "./workflow-run-lifecycle";
import { withServiceEnvironment } from "./runtime-environment";
import { DubbingExecution, createDubbingExecution } from "./dubbing-execution";
import { restoreDubWithinTransaction, restoreDubbingPage, recoverDubbingWakesPage } from "./dubbing-recovery";
import { takeExecutionDispatchIds } from "./execution-dispatch-runtime";
import { createExecutionStorage } from "./execution-storage";

const url = process.env.SERVERLESS_TEST_DATABASE_URL;
const suite = process.env.ALLOW_SERVERLESS_DB_TESTS === "1" && url ? describe : describe.skip;
suite("Native Dubbing execution", () => {
  let db: PrismaClient;
  beforeAll(() => {
    const schema = process.env.SERVERLESS_TEST_DATABASE_SCHEMA!;assertExecutionDatabaseTestTarget(url, schema);
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url, max: 4 }, { schema }), transactionOptions: { timeout: 30000, maxWait: 10000 } });
  });
  afterAll(async () => { await db?.$disconnect(); });

  async function fixture(options: { acceptedAt?: Date } = {}) {
    const createdAt = options.acceptedAt ?? new Date();
    const user = await db.user.create({ data: { clerkId: `native-dub:${randomUUID()}` } });
    const workspace = await db.workspace.create({ data: { ownerUserId: user.id, name: "Native Dub", pricingTier: "business" } });
    const project = await db.project.create({ data: { workspaceId: workspace.id, title: "Native Dub", sourceMediaUrl: "r2://frozen", ingestStatus: "ready", sourceDurationSeconds: 10 } });
    const epoch = (await db.executionEpoch.findUniqueOrThrow({ where: { id: 1 } })).epoch;
    const run = await db.workflowRun.create({ data: { projectId: project.id, stage: "dubbing", status: "queued", idempotencyKey: randomUUID(), deploymentEpoch: epoch, createdAt } });
    const clip = await db.clip.create({ data: { projectId: project.id, workflowRunId: run.id, index: 0, startSec: 0, endSec: 10, hookText: "The frozen source script", reasoning: "Fixture", category: "hook", transcriptSlice: [], viralityScore: 50, hookStrengthScore: 50, emotionalIntensityScore: 50, pacingScore: 50, durationOptimalityScore: 50, tiktokScore: 50, youtubeScore: 50, instagramScore: 50, llmProvider: "fixture", llmModel: "fixture" } });
    const render = await db.clipRender.create({ data: { clipId: clip.id, aspectRatio: "ratio_9_16", status: "completed", storageKey: `projects/${project.id}/renders/${randomUUID()}.mp4`, sizeBytes: 3n, durationSec: 10 } });
    const id = randomUUID();
    const request = frozenDubbingRequestSchema.parse({ version: 1, kind: "dubbing_request", dubId: id, workflowRunId: run.id, projectId: project.id, workspaceId: workspace.id, actorUserId: user.id, clipId: clip.id,
      editorRevision: clip.editorRevision, sourceRevision: project.sourceRevision, baseRender: { id: render.id, storageKey: render.storageKey, byteLength: 3, durationSec: 10 },
      script: "The frozen source script", sourceLanguageCode: "en", targetLanguageCode: "es", voice: "marin", aspectRatio: "9:16", provider: "openai", model: "gpt-4o-mini-tts", translationModel: "test-translation" });
    const dub = await db.$transaction(async tx => {
      const row = await tx.clipDub.create({ data: { id, projectId: project.id, clipId: clip.id, workflowRunId: run.id, targetLanguageCode: "es", voice: "marin", model: request.model,
        frozenRequest: request, requestHash: await frozenDubbingRequestHash(request), createdAt, operationDeadlineAt: new Date(createdAt.getTime() + 45 * 60_000), deploymentEpoch: epoch } });
      await reserveGenerationUsage(tx, { kind: "dub", jobId: id, workspaceId: workspace.id, actorUserId: user.id, pricingTier: "business", now: createdAt, attached: true });
      return row;
    });
    const reference = (await db.$transaction(tx => new WorkflowRunLifecycle({ prisma: db }).dispatchRunWithinTransaction(tx, run.id))).reference;
    const objects = new Map<string, Uint8Array>(), registrations: string[] = [];
    const domain = new DubbingExecution(db, { toolchainFingerprint: "a".repeat(64), register: async ids => { registrations.push(...ids); },
      head: async storageKey => ({ storageKey, etag: '"base"', byteLength: 3, sha256: createHash("sha256").update("abc").digest("hex") }),
      inputStorage: { read: async object => objects.get(object.storageKey)!, write: async (storageKey, bytes) => {
        await db.$transaction(tx => tx.$queryRaw`SELECT id FROM "WorkflowRun" WHERE id=${run.id}::uuid FOR UPDATE NOWAIT`);
        expect(await db.executionDispatch.count({ where: { subjectId: run.id, deadlineKind: "operation" } })).toBeGreaterThan(0);
        objects.set(storageKey, bytes.slice());return { etag: '"capsule"', byteLength: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
      } } });
    return { user, workspace, project, run, clip, render, dub, request, reference, domain, objects, registrations };
  }
  test("quiesced Dub restore changes metadata only, preserves paid evidence and accepted budget, and dispatches only in the final phase", async () => {
    const f = await fixture(), others = [await fixture(), await fixture()], rollback = Error("rollback_dub_restore");
    try {
      await withServiceEnvironment({}, () => f.domain.prepareExecution(f.reference));
      const paidIntentId = randomUUID(), reservation = await db.generatedMediaUsageReservation.findUniqueOrThrow({ where: { jobId: f.dub.id } });
      await db.clipDub.update({ where: { id: f.dub.id }, data: { translationIntentArtifactId: paidIntentId } });
      await expect(db.$transaction(async tx => {
        const epoch = await tx.executionEpoch.findUniqueOrThrow({ where: { id: 1 } });
        const fence = await tx.executionEpoch.update({ where: { id: 1 }, data: { epoch: epoch.epoch + 1, admissionOpen: false, changedAt: new Date() } });
        const proof = { snapshotEpoch: epoch.epoch, fenceAboveEpoch: epoch.epoch, deploymentEpoch: fence.epoch, cutoff: fence.changedAt };
        await tx.workflowRun.updateMany({ where: { id: { in: [f.run.id, ...others.map(value => value.run.id)] } }, data: { deploymentEpoch: fence.epoch, generation: { increment: 1 }, status: "queued", attemptCount: 2, attemptId: null, leaseOwner: null, leaseExpiresAt: null } });
        await expect(restoreDubWithinTransaction(tx, f.dub.id, proof)).rejects.toThrow("dubbing_restore_owner_not_revoked");
        await tx.executionAttempt.updateMany({ where: { dispatch: { subjectId: f.run.id } }, data: { status: "superseded", revokedAt: fence.changedAt, finishedAt: fence.changedAt } });
        const count = await tx.executionDispatch.count({ where: { deploymentEpoch: fence.epoch } });
        expect(await restoreDubWithinTransaction(tx, f.dub.id, proof)).toEqual({ dispatchIds: [] });
        const first = await restoreDubbingPage(tx, { ...proof, after: null, limit: 1 });expect(first.processed).toBe(1);expect(first.next).not.toBeNull();expect(first.dispatchIds).toEqual([]);
        const last = await restoreDubbingPage(tx, { ...proof, after: first.next, limit: 1 });expect(last.processed).toBe(1);expect(last.next).toBeNull();expect(last.dispatchIds).toEqual([]);
        expect(await tx.executionDispatch.count({ where: { deploymentEpoch: fence.epoch } })).toBe(count);expect(takeExecutionDispatchIds(tx)).toEqual([]);
        expect(await tx.clipDub.findUniqueOrThrow({ where: { id: f.dub.id } })).toMatchObject({ status: "queued", deploymentEpoch: fence.epoch, translationIntentArtifactId: paidIntentId, translationResultArtifactId: null,
          requestHash: f.dub.requestHash, frozenRequest: f.request, inputStorageKey: null, inputBindingHash: null, operationDeadlineAt: f.dub.operationDeadlineAt });
        expect(await tx.workflowRun.findUniqueOrThrow({ where: { id: f.run.id } })).toMatchObject({ attemptCount: 2, attemptId: null, operationDeadlineAt: f.dub.operationDeadlineAt });
        expect(await tx.generatedMediaUsageReservation.findUniqueOrThrow({ where: { jobId: f.dub.id } })).toEqual(reservation);
        const final = await recoverDubbingWakesPage(tx, { deploymentEpoch: fence.epoch, cutoff: proof.cutoff, after: null, limit: 3 });expect(final.processed).toBe(3);expect(final.dispatchIds).toHaveLength(6);
        expect(await tx.executionAttempt.count({ where: { dispatch: { subjectId: f.run.id } } })).toBe(1);
        await expect(restoreDubWithinTransaction(tx, f.dub.id, { ...proof, cutoff: new Date(proof.cutoff.getTime() + 1) })).rejects.toThrow("dubbing_restore_fence_invalid");
        throw rollback;
      })).rejects.toBe(rollback);
      expect((await db.executionEpoch.findUniqueOrThrow({ where: { id: 1 } })).epoch).toBe(f.reference.deploymentEpoch);
    } finally { for (const value of [f, ...others]) { await db.executionAttempt.deleteMany({ where: { dispatch: { subjectId: value.run.id } } });await db.executionDispatch.deleteMany({ where: { subjectId: value.run.id } });await db.workspace.delete({ where: { id: value.workspace.id } });await db.user.delete({ where: { id: value.user.id } }); } }
  });
  test("one sealed request and absolute watchdog prepare one unowned native attempt without charging provider work", async () => {
    const f = await fixture();
    try {
      const [first, replay] = await withServiceEnvironment({}, () => Promise.all([f.domain.prepareExecution(f.reference), f.domain.prepareExecution(f.reference)]));
      expect(first.kind).toBe("waiting");expect(replay).toEqual(first);
      const row = await db.clipDub.findUniqueOrThrow({ where: { id: f.dub.id } });
      expect(row).toMatchObject({ status: "queued", operationDeadlineAt: f.dub.operationDeadlineAt, workflowAttemptId: null });
      expect(row.inputStorageKey).not.toBeNull();expect(f.objects.has(row.inputStorageKey!)).toBe(true);
      const attempts = await db.executionAttempt.findMany({ where: { dispatch: { subjectId: f.run.id, kind: "modal_execution" } } });
      expect(attempts).toHaveLength(1);expect(attempts[0]).toMatchObject({ functionName: "dub_mix", owner: null, status: "admitted", inputStorageKey: row.inputStorageKey, operationDeadlineAt: f.dub.operationDeadlineAt });
      expect(await db.workflowRun.findUniqueOrThrow({ where: { id: f.run.id } })).toMatchObject({ attemptCount: 0, attemptId: null, leaseOwner: null });
      expect(await db.generatedMediaUsageReservation.findUniqueOrThrow({ where: { jobId: f.dub.id } })).toMatchObject({ status: "reserved" });
    } finally {
      await db.executionAttempt.deleteMany({ where: { dispatch: { subjectId: f.run.id } } });await db.executionDispatch.deleteMany({ where: { subjectId: f.run.id } });
      await db.workspace.delete({ where: { id: f.workspace.id } });await db.user.delete({ where: { id: f.user.id } });
    }
  });
  test("an elapsed unowned accepted deadline releases only its known unused quota without inventing native history", async () => {
    const f = await fixture({ acceptedAt: new Date(Date.now() - 46 * 60_000) });
    try {
      expect(await withServiceEnvironment({}, () => f.domain.prepareExecution(f.reference))).toEqual({ kind: "terminal" });
      expect(await db.clipDub.findUniqueOrThrow({ where: { id: f.dub.id } })).toMatchObject({ status: "failed", errorCode: "operation_deadline_exceeded", workflowAttemptId: null });
      expect(await db.workflowRun.findUniqueOrThrow({ where: { id: f.run.id } })).toMatchObject({ status: "failed", attemptCount: 0, attemptId: null, leaseOwner: null, requestedCount: 1, failedCount: 1 });
      expect(await db.generatedMediaUsageReservation.findUniqueOrThrow({ where: { jobId: f.dub.id } })).toMatchObject({ status: "released", reason: "operation_deadline_exceeded" });
      expect(f.objects.size).toBe(0);expect(await db.executionAttempt.count({ where: { dispatch: { subjectId: f.run.id } } })).toBe(0);
    } finally {
      await db.executionDispatch.deleteMany({ where: { subjectId: f.run.id } });await db.workspace.delete({ where: { id: f.workspace.id } });await db.user.delete({ where: { id: f.user.id } });
    }
  });
  test("current source and actor revocation settle unused work, while an old generation cannot cancel the current request", async () => {
    for (const cause of ["source", "actor", "generation"] as const) {
      const f = await fixture();let replacement: string | undefined;
      try {
        if (cause === "source") await db.project.update({ where: { id: f.project.id }, data: { sourceRevision: { increment: 1 } } });
        else if (cause === "generation") await db.workflowRun.update({ where: { id: f.run.id }, data: { generation: { increment: 1 } } });
        else { replacement = (await db.user.create({ data: { clerkId: `dub-replacement:${randomUUID()}` } })).id;await db.workspace.update({ where: { id: f.workspace.id }, data: { ownerUserId: replacement } }); }
        expect(await withServiceEnvironment({}, () => f.domain.prepareExecution(f.reference))).toEqual({ kind: "superseded" });
        expect(await db.clipDub.findUniqueOrThrow({ where: { id: f.dub.id } })).toMatchObject({ status: cause === "generation" ? "queued" : "failed", errorCode: cause === "generation" ? null : cause === "source" ? "dubbing_source_superseded" : "dubbing_access_revoked" });
        expect(await db.generatedMediaUsageReservation.findUniqueOrThrow({ where: { jobId: f.dub.id } })).toMatchObject({ status: cause === "generation" ? "reserved" : "released" });
        expect(f.objects.size).toBe(0);expect(await db.executionAttempt.count({ where: { dispatch: { subjectId: f.run.id } } })).toBe(0);
      } finally {
        await db.executionDispatch.deleteMany({ where: { subjectId: f.run.id } });await db.workspace.delete({ where: { id: f.workspace.id } });await db.user.deleteMany({ where: { id: { in: [f.user.id, ...(replacement ? [replacement] : [])] } } });
      }
    }
  });
  test("only a charged live owner records a paid intent, and ambiguous failure keeps the count without another generation", async () => {
    for (const ending of ["failure", "lease", "release", "source", "actor"] as const) {
    const f = await fixture(), receipts: string[] = [], evidence = new Map<string, unknown>();let replacement: string | undefined;
    try {
      const prepared = await withServiceEnvironment({}, () => f.domain.prepareExecution(f.reference));if (prepared.kind !== "waiting") throw Error("Expected prepared Dub");
      const fence = { reference: prepared.deadline.reference, attemptToken: prepared.deadline.attemptToken, owner: randomUUID() };
      const execution = createDubbingExecution({ database: db, domain: f.domain, storage: createExecutionStorage({ accountId: "a".repeat(32), bucket: "dub-gate", accessKeyId: "not-a-real-key", secretAccessKey: "not-a-real-secret" }),
        deliverWakes: async () => {}, artifacts: { head: async assignment => ({ etag: '"proof"', contentType: assignment.contentType, byteLength: BigInt(JSON.stringify(evidence.get(assignment.id)).length) }), readJson: async artifact => evidence.get(artifact.artifactId) } });
      const verified = (target = "/api/execution/command") => { const deliveryId = randomUUID();receipts.push(deliveryId);return { requestHash: randomUUID().replaceAll("-", "").repeat(2), metadata: { version: 1 as const, keyId: "dub-gate", audience: "executor-control" as const, method: "POST" as const, canonicalTarget: target, bodySha256: "0".repeat(64), timestamp: Math.floor(Date.now() / 1000), deliveryId, signature: "0".repeat(64) } }; };
      const send = (command: unknown) => withServiceEnvironment({}, () => execution.control.execute({ command, verifiedRequest: verified() }));
      expect((await send({ action: "acquire", ...fence, leaseSeconds: ending === "lease" ? 3 : 120 })).disposition).toBe("acquired");
      const work = await withServiceEnvironment({}, () => execution.transfer.execute({ command: { action: "work-package", fence }, verifiedRequest: verified("/api/execution/transfer") }));
      if (work.disposition !== "work_package") throw Error("Expected Dub work package");
      const binding = await dubbingArtifactBindingHash(f.dub.requestHash!, "translation_intent");
      const output = work.outputs.find(output => output.bindingHash === binding)!;expect(output.role).toBe("probe");
      const value = { version: 1, kind: "dubbing_checkpoint", stage: "translation_intent", dubId: f.dub.id, requestHash: f.dub.requestHash,
        bodySha256: createHash("sha256").update(JSON.stringify(dubTranslationRequestBody(f.request))).digest("hex") };
      evidence.set(output.artifactId, value);const raw = JSON.stringify(value);
      const artifact = { artifactId: output.artifactId, role: "probe", bindingHash: binding, contentType: "application/json", byteLength: raw.length, etag: '"proof"', sha256: createHash("sha256").update(raw).digest("hex") };
      await expect(send({ action: "commit-artifact", fence, artifact })).rejects.toMatchObject({ code: "artifact_invalid" });
      expect((await db.clipDub.findUniqueOrThrow({ where: { id: f.dub.id } })).translationIntentArtifactId).toBeNull();
      await send({ action: "process-start", fence });
      expect(await send({ action: "commit-artifact", fence, artifact })).toEqual({ disposition: "committed", artifactId: output.artifactId });
      expect(await db.clipDub.findUniqueOrThrow({ where: { id: f.dub.id } })).toMatchObject({ status: "processing", translationIntentArtifactId: output.artifactId, workflowAttemptId: fence.attemptToken });
      if (ending === "failure") await send({ action: "fail", fence, failureCode: "native_connection_lost", retryable: true });
      else if (ending === "release") await send({ action: "release", fence, reason: "shutdown" });
      else if (ending === "source") { await db.project.update({ where: { id: f.project.id }, data: { sourceRevision: { increment: 1 } } });await send({ action: "read-disposition", fence }); }
      else if (ending === "actor") { replacement = (await db.user.create({ data: { clerkId: `dub-replacement:${randomUUID()}` } })).id;await db.workspace.update({ where: { id: f.workspace.id }, data: { ownerUserId: replacement } });await send({ action: "read-disposition", fence }); }
      else {
        const attempt = await db.executionAttempt.findUniqueOrThrow({ where: { attemptToken: fence.attemptToken } });
        await Bun.sleep(3100);const deliveryId = randomUUID();receipts.push(deliveryId);
        await withServiceEnvironment({}, () => execution.control.expireDeadline({ deadline: { reference: fence.reference, attemptToken: fence.attemptToken, kind: "lease", observedDeadlineAt: attempt.leaseExpiresAt!.toISOString() }, deliveryId }));
      }
      expect(await db.clipDub.findUniqueOrThrow({ where: { id: f.dub.id } })).toMatchObject({ status: "unknown", errorCode: "dub_provider_outcome_unknown" });
      expect(await db.workflowRun.findUniqueOrThrow({ where: { id: f.run.id } })).toMatchObject({ status: "failed", attemptCount: 1, generation: 1, requestedCount: 1, failedCount: 1 });
      expect(await db.generatedMediaUsageReservation.findUniqueOrThrow({ where: { jobId: f.dub.id } })).toMatchObject({ status: "reserved" });
      expect((await withServiceEnvironment({}, () => f.domain.prepareExecution(f.reference))).kind).toBe("superseded");
      expect(await db.executionAttempt.count({ where: { dispatch: { subjectId: f.run.id } } })).toBe(1);
    } finally {
      await db.executionInboxReceipt.deleteMany({ where: { deliveryId: { in: receipts } } });await db.executionArtifact.deleteMany({ where: { attempt: { dispatch: { subjectId: f.run.id } } } });
      await db.executionAttempt.deleteMany({ where: { dispatch: { subjectId: f.run.id } } });await db.executionDispatch.deleteMany({ where: { subjectId: f.run.id } });
      await db.workspace.delete({ where: { id: f.workspace.id } });await db.user.deleteMany({ where: { id: { in: [f.user.id, ...(replacement ? [replacement] : [])] } } });
    }
    }
  }, 10_000);
  test("a sealed translation becomes a scoped recovery input and survives a bounded retry without another paid intent", async () => {
    const f = await fixture(), receipts: string[] = [], evidence = new Map<string, unknown>();
    try {
      const prepared = await withServiceEnvironment({}, () => f.domain.prepareExecution(f.reference));if (prepared.kind !== "waiting") throw Error("Expected prepared Dub");
      const fence = { reference: prepared.deadline.reference, attemptToken: prepared.deadline.attemptToken, owner: randomUUID() };
      const execution = createDubbingExecution({ database: db, domain: f.domain, storage: createExecutionStorage({ accountId: "a".repeat(32), bucket: "dub-gate", accessKeyId: "not-a-real-key", secretAccessKey: "not-a-real-secret" }), deliverWakes: async () => {},
        artifacts: { head: async assignment => ({ etag: '"proof"', contentType: assignment.contentType, byteLength: BigInt(JSON.stringify(evidence.get(assignment.id)).length) }), readJson: async artifact => evidence.get(artifact.artifactId) } });
      const verified = (target = "/api/execution/command") => { const deliveryId = randomUUID();receipts.push(deliveryId);return { requestHash: randomUUID().replaceAll("-", "").repeat(2), metadata: { version: 1 as const, keyId: "dub-gate", audience: "executor-control" as const, method: "POST" as const, canonicalTarget: target, bodySha256: "0".repeat(64), timestamp: Math.floor(Date.now() / 1000), deliveryId, signature: "0".repeat(64) } }; };
      const send = (command: unknown) => withServiceEnvironment({}, () => execution.control.execute({ command, verifiedRequest: verified() }));
      const work = () => withServiceEnvironment({}, () => execution.transfer.execute({ command: { action: "work-package", fence }, verifiedRequest: verified("/api/execution/transfer") }));
      await send({ action: "acquire", ...fence, leaseSeconds: 120 });await send({ action: "process-start", fence });
      const packageReply = await work();if (packageReply.disposition !== "work_package") throw Error("Expected Dub package");
      const commit = async (stage: "translation_intent" | "translation_result", fields: object) => {
        const binding = await dubbingArtifactBindingHash(f.dub.requestHash!, stage), output = packageReply.outputs.find(output => output.bindingHash === binding)!;
        const value = { version: 1, kind: "dubbing_checkpoint", stage, dubId: f.dub.id, requestHash: f.dub.requestHash, ...fields };evidence.set(output.artifactId, value);const raw = JSON.stringify(value);
        await send({ action: "commit-artifact", fence, artifact: { artifactId: output.artifactId, role: "probe", bindingHash: binding, contentType: "application/json", byteLength: raw.length, etag: '"proof"', sha256: createHash("sha256").update(raw).digest("hex") } });return output.artifactId;
      };
      const intentId = await commit("translation_intent", { bodySha256: createHash("sha256").update(JSON.stringify(dubTranslationRequestBody(f.request))).digest("hex") });
      const resultId = await commit("translation_result", { text: "El guion original congelado", providerRequestId: "resp_fixture" });
      const recovered = await work();if (recovered.disposition !== "work_package") throw Error("Expected recovery package");
      const result = await db.executionArtifact.findUniqueOrThrow({ where: { id: resultId } });
      expect(recovered.sources).toContainEqual(expect.objectContaining({ name: "translation_result", storageKey: result.storageKey, etag: '"proof"', sha256: result.checksumSha256 }));
      expect(recovered.outputs.some(output => [intentId, resultId].includes(output.artifactId))).toBe(false);
      await send({ action: "fail", fence, failureCode: "native_mux_unavailable", retryable: true });
      expect(await db.clipDub.findUniqueOrThrow({ where: { id: f.dub.id } })).toMatchObject({ status: "queued", translatedText: "El guion original congelado", translationIntentArtifactId: intentId, translationResultArtifactId: resultId, operationDeadlineAt: f.dub.operationDeadlineAt });
      expect(await db.workflowRun.findUniqueOrThrow({ where: { id: f.run.id } })).toMatchObject({ status: "queued", generation: 2, attemptCount: 1 });
      expect(await db.generatedMediaUsageReservation.findUniqueOrThrow({ where: { jobId: f.dub.id } })).toMatchObject({ status: "reserved" });
    } finally {
      await db.executionInboxReceipt.deleteMany({ where: { deliveryId: { in: receipts } } });await db.executionArtifact.deleteMany({ where: { attempt: { dispatch: { subjectId: f.run.id } } } });await db.executionAttempt.deleteMany({ where: { dispatch: { subjectId: f.run.id } } });
      await db.executionDispatch.deleteMany({ where: { subjectId: f.run.id } });await db.workspace.delete({ where: { id: f.workspace.id } });await db.user.delete({ where: { id: f.user.id } });
    }
  });
  test("speech intent requires the sealed translated script and sealed audio survives retry as a scoped source", async () => {
    for (const mode of ["unknown", "reported_unknown", "rejected", "retry", "complete"] as const) {
    const f = await fixture(), receipts: string[] = [], evidence = new Map<string, unknown>();let loseWakeAck = false;
    try {
      const prepared = await withServiceEnvironment({}, () => f.domain.prepareExecution(f.reference));if (prepared.kind !== "waiting") throw Error("Expected prepared Dub");
      const fence = { reference: prepared.deadline.reference, attemptToken: prepared.deadline.attemptToken, owner: randomUUID() };
      const execution = createDubbingExecution({ database: db, domain: f.domain, storage: createExecutionStorage({ accountId: "a".repeat(32), bucket: "dub-gate", accessKeyId: "not-a-real-key", secretAccessKey: "not-a-real-secret" }), deliverWakes: async () => { if (loseWakeAck) { loseWakeAck = false;throw Error("lost_dub_wake_ack"); } },
        artifacts: { head: async assignment => assignment.role === "dub_mix" ? { etag: assignment.contentType === "video/mp4" ? '"video"' : '"audio"', contentType: assignment.contentType, byteLength: assignment.contentType === "video/mp4" ? 8192n : 4096n } : ({ etag: '"proof"', contentType: assignment.contentType, byteLength: BigInt(JSON.stringify(evidence.get(assignment.id)).length) }), readJson: async artifact => evidence.get(artifact.artifactId) } });
      const verified = (target = "/api/execution/command") => { const deliveryId = randomUUID();receipts.push(deliveryId);return { requestHash: randomUUID().replaceAll("-", "").repeat(2), metadata: { version: 1 as const, keyId: "dub-gate", audience: "executor-control" as const, method: "POST" as const, canonicalTarget: target, bodySha256: "0".repeat(64), timestamp: Math.floor(Date.now() / 1000), deliveryId, signature: "0".repeat(64) } }; };
      const send = (command: unknown, request = verified()) => withServiceEnvironment({}, () => execution.control.execute({ command, verifiedRequest: request }));
      const work = () => withServiceEnvironment({}, () => execution.transfer.execute({ command: { action: "work-package", fence }, verifiedRequest: verified("/api/execution/transfer") }));
      await send({ action: "acquire", ...fence, leaseSeconds: 120 });await send({ action: "process-start", fence });
      const reply = await work();if (reply.disposition !== "work_package") throw Error("Expected Dub package");
      const commit = async (stage: "translation_intent" | "translation_result" | "speech_intent", fields: object) => {
        const binding = await dubbingArtifactBindingHash(f.dub.requestHash!, stage), output = reply.outputs.find(output => output.bindingHash === binding)!;
        const value = { version: 1, kind: "dubbing_checkpoint", stage, dubId: f.dub.id, requestHash: f.dub.requestHash, ...fields };evidence.set(output.artifactId, value);const raw = JSON.stringify(value);
        await send({ action: "commit-artifact", fence, artifact: { artifactId: output.artifactId, role: "probe", bindingHash: binding, contentType: "application/json", byteLength: raw.length, etag: '"proof"', sha256: createHash("sha256").update(raw).digest("hex") } });return output.artifactId;
      };
      const text = "El guion original congelado";
      await expect(commit("speech_intent", { bodySha256: createHash("sha256").update(JSON.stringify(dubSpeechRequestBody(f.request, text))).digest("hex") })).rejects.toMatchObject({ code: "artifact_invalid" });
      await commit("translation_intent", { bodySha256: createHash("sha256").update(JSON.stringify(dubTranslationRequestBody(f.request))).digest("hex") });
      await commit("translation_result", { text, providerRequestId: "resp_fixture" });
      const speechId = await commit("speech_intent", { bodySha256: createHash("sha256").update(JSON.stringify(dubSpeechRequestBody(f.request, text))).digest("hex") });
      if (mode === "reported_unknown" || mode === "rejected") {
        const binding = await dubbingArtifactBindingHash(f.dub.requestHash!, "final_result"), output = reply.outputs.find(output => output.bindingHash === binding)!;
        const finish = async (fields: object) => {
          const value = { version: 1, kind: "dubbing_checkpoint", stage: "final_result", dubId: f.dub.id, requestHash: f.dub.requestHash, ...fields };
          evidence.set(output.artifactId, value);const raw = JSON.stringify(value);
          return send({ action: "commit-artifact", fence, artifact: { artifactId: output.artifactId, role: "probe", bindingHash: binding, contentType: "application/json", byteLength: raw.length, etag: '"proof"', sha256: createHash("sha256").update(raw).digest("hex") } });
        };
        await expect(finish({ outcome: "rejected", providerStage: "translation", httpStatus: 400 })).rejects.toMatchObject({ code: "artifact_invalid" });
        await expect(finish({ outcome: "rejected", providerStage: "speech", httpStatus: 500 })).rejects.toMatchObject({ code: "artifact_invalid" });
        expect(await finish(mode === "rejected" ? { outcome: "rejected", providerStage: "speech", httpStatus: 429 } : { outcome: "unknown", providerStage: "speech" })).toEqual({ disposition: "committed", artifactId: output.artifactId });
        expect(await db.clipDub.findUniqueOrThrow({ where: { id: f.dub.id } })).toMatchObject({ status: mode === "rejected" ? "failed" : "unknown", outcomeArtifactId: output.artifactId,
          errorCode: mode === "rejected" ? "dub_provider_rejected" : "dub_provider_outcome_unknown", audioArtifactId: null, renderStorageKey: null });
        expect(await db.workflowRun.findUniqueOrThrow({ where: { id: f.run.id } })).toMatchObject({ status: "failed", generation: 1, attemptCount: 1, failedCount: 1 });
        expect(await db.generatedMediaUsageReservation.findUniqueOrThrow({ where: { jobId: f.dub.id } })).toMatchObject({ status: mode === "rejected" ? "released" : "reserved" });
        continue;
      }
      if (mode === "unknown") {
        await send({ action: "fail", fence, failureCode: "native_connection_lost", retryable: true });
        expect(await db.clipDub.findUniqueOrThrow({ where: { id: f.dub.id } })).toMatchObject({ status: "unknown", errorCode: "dub_provider_outcome_unknown", speechIntentArtifactId: speechId, audioArtifactId: null });
        expect(await db.workflowRun.findUniqueOrThrow({ where: { id: f.run.id } })).toMatchObject({ status: "failed", generation: 1, attemptCount: 1 });
        expect(await db.generatedMediaUsageReservation.findUniqueOrThrow({ where: { jobId: f.dub.id } })).toMatchObject({ status: "reserved" });
        continue;
      }
      const audioBinding = await dubbingArtifactBindingHash(f.dub.requestHash!, "audio"), audio = reply.outputs.find(output => output.bindingHash === audioBinding)!;
      await send({ action: "commit-artifact", fence, artifact: { artifactId: audio.artifactId, role: "dub_mix", bindingHash: audioBinding, contentType: "audio/mpeg", byteLength: 4096, etag: '"audio"', sha256: "c".repeat(64) } });
      const recovered = await work();if (recovered.disposition !== "work_package") throw Error("Expected recovery package");
      expect(recovered.sources).toContainEqual(expect.objectContaining({ name: "dub_audio", byteLength: 4096, etag: '"audio"', sha256: "c".repeat(64) }));
      if (mode === "complete") {
        const videoBinding = await dubbingArtifactBindingHash(f.dub.requestHash!, "video"), video = reply.outputs.find(output => output.bindingHash === videoBinding)!;
        const finalBinding = await dubbingArtifactBindingHash(f.dub.requestHash!, "final_result"), final = reply.outputs.find(output => output.bindingHash === finalBinding)!;
        const value = { version: 1, kind: "dubbing_checkpoint", stage: "final_result", dubId: f.dub.id, requestHash: f.dub.requestHash, outcome: "completed",
          audio: { byteLength: 4096, sha256: "c".repeat(64) }, video: { byteLength: 8192, sha256: "d".repeat(64) }, probe: { state: "ready", durationSec: 10 } };
        evidence.set(final.artifactId, value);const raw = JSON.stringify(value);
        const command = { action: "commit-artifact", fence, artifact: { artifactId: final.artifactId, role: "probe", bindingHash: finalBinding, contentType: "application/json", byteLength: raw.length, etag: '"proof"', sha256: createHash("sha256").update(raw).digest("hex") } };
        await expect(send(command)).rejects.toMatchObject({ code: "artifact_invalid" });
        await send({ action: "commit-artifact", fence, artifact: { artifactId: video.artifactId, role: "dub_mix", bindingHash: videoBinding, contentType: "video/mp4", byteLength: 8192, etag: '"video"', sha256: "d".repeat(64) } });
        const signed = verified();loseWakeAck = true;await expect(send(command, signed)).rejects.toThrow("lost_dub_wake_ack");
        const audioRow = await db.executionArtifact.findUniqueOrThrow({ where: { id: audio.artifactId } }), videoRow = await db.executionArtifact.findUniqueOrThrow({ where: { id: video.artifactId } });
        expect(await db.clipDub.findUniqueOrThrow({ where: { id: f.dub.id } })).toMatchObject({ status: "completed", outcomeArtifactId: final.artifactId, audioArtifactId: audio.artifactId, videoArtifactId: video.artifactId,
          audioStorageKey: audioRow.storageKey, renderStorageKey: videoRow.storageKey, audioSizeBytes: 4096n, renderSizeBytes: 8192n, durationSec: 10, transcriptText: f.request.script, translatedText: text });
        expect(await db.workflowRun.findUniqueOrThrow({ where: { id: f.run.id } })).toMatchObject({ status: "completed", generation: 1, attemptCount: 1, requestedCount: 1, succeededCount: 1, failedCount: 0, leaseOwner: null });
        expect(await db.generatedMediaUsageReservation.findUniqueOrThrow({ where: { jobId: f.dub.id } })).toMatchObject({ status: "finalized", actualUnits: 1 });
        expect(await send(command, signed)).toEqual({ disposition: "committed", artifactId: final.artifactId });
        expect(await db.workflowEvent.count({ where: { workflowRunId: f.run.id, status: "completed" } })).toBe(1);
        continue;
      }
      await send({ action: "fail", fence, failureCode: "native_mux_unavailable", retryable: true });
      expect(await db.clipDub.findUniqueOrThrow({ where: { id: f.dub.id } })).toMatchObject({ status: "queued", speechIntentArtifactId: speechId, audioArtifactId: audio.artifactId, audioStorageKey: null, renderStorageKey: null });
      expect(await db.workflowRun.findUniqueOrThrow({ where: { id: f.run.id } })).toMatchObject({ status: "queued", generation: 2, attemptCount: 1 });
      expect(await db.generatedMediaUsageReservation.findUniqueOrThrow({ where: { jobId: f.dub.id } })).toMatchObject({ status: "reserved" });
    } finally {
      await db.executionInboxReceipt.deleteMany({ where: { deliveryId: { in: receipts } } });await db.executionArtifact.deleteMany({ where: { attempt: { dispatch: { subjectId: f.run.id } } } });await db.executionAttempt.deleteMany({ where: { dispatch: { subjectId: f.run.id } } });
      await db.executionDispatch.deleteMany({ where: { subjectId: f.run.id } });await db.workspace.delete({ where: { id: f.workspace.id } });await db.user.delete({ where: { id: f.user.id } });
    }
    }
  });
});
