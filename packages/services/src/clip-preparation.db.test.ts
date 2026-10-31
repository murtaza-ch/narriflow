import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { editorDocumentSchema, CLIP_AUTO_LAYOUT_ENGINE, CLIP_AUTO_LAYOUT_VERSION } from "@narriflow/validators";
import documents from "../../../apps/media/src/__fixtures__/render-golden/documents.json";
import { assertExecutionDatabaseTestTarget } from "./execution-db-test-support";
import { appendExecutionDispatch, readExecutionDispatch } from "./execution-dispatch";
import { renderGroupExportIdentity } from "./render-group-contract";
import { encodeClipEditorDocumentForStorage } from "./clip-editor-document-persistence";
import { ClipPreparationService, type ClipPreparationArtifactCommit } from "./clip-preparation";
import { decodeClipPreparationInput } from "./clip-preparation-input";
import { executionInputRetainUntil } from "./media-cleanup";
import { createExecutorControl } from "./executor-control";
import type { ExecutionCommand } from "@narriflow/validators/execution";
import type { ClipPreparationResult } from "@narriflow/validators/clip-preparation";

const url = process.env.SERVERLESS_TEST_DATABASE_URL;
const suite = process.env.ALLOW_SERVERLESS_DB_TESTS === "1" && url ? describe : describe.skip;
suite("Clip Preparation authority and publication", () => {
  let db: PrismaClient;
  beforeAll(() => {
    const schema = process.env.SERVERLESS_TEST_DATABASE_SCHEMA!;
    assertExecutionDatabaseTestTarget(url, schema);
    if (!schema.startsWith("serverless_execution_test_")) throw new Error("Disposable schema required");
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url, max: 5 }, { schema }), transactionOptions: { timeout: 30_000, maxWait: 10_000 } });
  });
  afterAll(async () => { await db?.$disconnect(); });

  async function fixture(frozenExport = false, snapshotRevision?: number) {
    const user = await db.user.create({ data: { clerkId: `clip-preparation:${crypto.randomUUID()}` } });
    const workspace = await db.workspace.create({ data: { name: "Clip preparation gate", ownerUserId: user.id } });
    const epoch = (await db.executionEpoch.findUniqueOrThrow({ where: { id: 1 } })).epoch;
    const sourceProbe = { durationSec: 20, video: null, audio: { sampleRate: 48000, channels: 2 }, facts: {
      format: { name: "matroska", startTimeSec: 0, durationSec: 20, sizeBytes: 1000, bitRate: null }, attachedPictureCount: 0, videos: [],
      audios: [{ index: 0, codec: "opus", profile: null, timeBase: null, startPts: null, startTimeSec: 0, durationTs: null, durationSec: 20, endTimeSec: 20,
        frameCount: null, bitRate: null, sampleRate: 48000, channels: 2, channelLayout: "stereo", sampleFormat: "fltp", initialPadding: null, trailingPadding: null }],
    } };
    const project = await db.project.create({ data: { workspaceId: workspace.id, title: "Sealed source", sourceMediaUrl: "r2://source", ingestStatus: "ready", sourceProbe,
      sourceSizeBytes: 1000n, sourceDurationSeconds: 20 } });
    const job = await db.ingestJob.create({ data: { projectId: project.id, jobType: "link_import", payload: {}, deploymentEpoch: epoch } });
    const sourceDispatch = await db.$transaction(tx => appendExecutionDispatch(tx, { deploymentEpoch: epoch, generation: 1, kind: "modal_execution", subject: { kind: "ingest_job", id: job.id }, inputHash: "a".repeat(64), dueAt: new Date(0) }));
    const token = crypto.randomUUID(), owner = crypto.randomUUID();
    await db.executionAttempt.create({ data: { attemptToken: token, dispatchId: sourceDispatch.reference.dispatchId, deploymentEpoch: epoch, generation: 1, inputHash: "a".repeat(64), functionName: "fetch_source",
      status: "completed", finishedAt: new Date(), operationDeadlineAt: new Date(Date.now() + 45 * 60_000) } });
    const source = await db.executionArtifact.create({ data: { attemptToken: token, owner, role: "source_video", bindingHash: "b".repeat(64), storageKey: `execution/${epoch}/${token}/${owner}/source_video`,
      contentType: "video/webm", maxBytes: 1000n, byteLength: 1000n, checksumSha256: "c".repeat(64), etag: '"source"', grantExpiresAt: new Date(Date.now() + 60_000), committedAt: new Date(),
      sourceVideoBinding: { projectId: project.id, sourceRevision: 1, mediaIdentity: { provider: "upload", mediaId: job.id }, audioTrack: null,
        probe: sourceProbe, wholeSource: true, audioStartTimeSec: 0, videoStartTimeSec: null, probeVersion: "normalized-probe-1", toolchainFingerprint: "e".repeat(64) } } });
    await db.project.update({ where: { id: project.id }, data: { sourceStorageKey: source.storageKey } });
    const workSetGeneration = crypto.randomUUID();
    const run = await db.workflowRun.create({ data: { projectId: project.id, stage: "clip_rendering", status: "waiting", idempotencyKey: crypto.randomUUID(), deploymentEpoch: epoch,
      renderWorkSetGeneration: workSetGeneration, renderWorkSetFrozenAt: new Date(), requestedCount: 2 } });
    const document = editorDocumentSchema.parse({ ...documents.cases["solo-auto-vertical"].document, clipEndSec: 10 });
    const clip = await db.clip.create({ data: { projectId: project.id, workflowRunId: run.id, index: 0, ...encodeClipEditorDocumentForStorage(document, { durationSec: 20, wholeSource: false }),
      hookText: "fixture", reasoning: "fixture", category: "hook", viralityScore: 50, hookStrengthScore: 50, emotionalIntensityScore: 50, pacingScore: 50, durationOptimalityScore: 50,
      tiktokScore: 50, youtubeScore: 50, instagramScore: 50, llmProvider: "fixture", llmModel: "fixture" } });
    const references = [];
    for (const resolution of ["720p", "1080p"]) {
      const aspectRatio = resolution === "720p" ? "ratio_9_16" as const : "ratio_16_9" as const;
      let exportId: string | null = null, exportVariantId: string | undefined;
      if (frozenExport && resolution === "720p") {
        const exported = await db.clipExport.create({ data: { projectId: project.id, clipId: clip.id, editorRevision: clip.editorRevision, fingerprint: "fixed-export", resolution, watermark: true } });
        exportId = exported.id;
        exportVariantId = (await db.clipExportVariant.create({ data: { exportId, aspectRatio, resolution, watermark: true } })).id;
      }
      const variant = await db.clipRender.create({ data: { clipId: clip.id, workflowRunId: run.id, editorRevision: clip.editorRevision, aspectRatio, resolution,
        ...(exportVariantId ? { exportVariantId, clipSnapshot: JSON.parse(JSON.stringify({ ...clip, editorRevision: snapshotRevision ?? clip.editorRevision })) } : {}) } });
      const group = await db.renderGroup.create({ data: { workflowRunId: run.id, workSetGeneration, clipId: clip.id, deploymentEpoch: epoch,
        exportIdentity: renderGroupExportIdentity({ clipId: clip.id, exportId, editorRevision: clip.editorRevision, resolution, watermark: true }), members: { create: { clipRenderId: variant.id } } } });
      references.push((await db.$transaction(tx => appendExecutionDispatch(tx, { deploymentEpoch: epoch, generation: 1, kind: "operation_driver", subject: { kind: "render_group", id: group.id }, inputHash: "d".repeat(64), dueAt: group.createdAt }))).reference);
    }
    const objects = new Map<string, Uint8Array>();
    let writes = 0;
    let afterWrite: (() => Promise<void>) | undefined;
    const confirmed: string[] = [];
    const service = new ClipPreparationService(db, { toolchainFingerprint: "e".repeat(64), engineHash: "f".repeat(64), register: async (ids: readonly string[]) => {
      expect(await db.executionDispatch.count({ where: { id: { in: [...ids] } } })).toBe(ids.length);
      confirmed.push(...ids);
    }, storage: { write: async (key: string, bytes: Uint8Array) => {
      if (!objects.has(key)) { writes++; objects.set(key, bytes.slice()); }
      else if (!Buffer.from(objects.get(key)!).equals(bytes)) throw new Error("Immutable input changed");
      await afterWrite?.();
      return { etag: '"input"', byteLength: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") };
    } } });
    return { user, workspace, project, run, clip, source, references, service, objects, confirmed, writes: () => writes, afterWrite: (action: () => Promise<void>) => { afterWrite = action; } };
  }

  async function native(f: Awaited<ReturnType<typeof fixture>>) {
    const admitted = await f.service.admitForGroup(f.references[0]!);
    const prepared = await f.service.prepareExecution((await readExecutionDispatch(db, admitted.dispatchIds[0]!))!.reference);
    if (prepared.kind !== "waiting") throw new Error("Expected prepared native job");
    const heads = new Map<string, { etag: string; contentType: string; byteLength: bigint; sha256: string }>();
    const manifests = new Map<string, ClipPreparationResult>();
    let loseAck = false;
    const wakes: string[][] = [];
    const control = createExecutorControl({ database: db, subjectKind: "clip_preparation", domain: f.service,
      deliverWakes: async ids => { wakes.push([...ids]); if (loseAck) throw new Error("Lost preparation wake"); },
      artifacts: { head: async assignment => heads.get(assignment.id) ?? null, prepare: async (_assignment, artifact): Promise<ClipPreparationArtifactCommit> => {
        if (artifact.role === "layout_evidence") return { ...artifact, role: "layout_evidence", result: manifests.get(artifact.artifactId)! };
        if (artifact.role === "clip_preview" || artifact.role === "preview_peaks") return { ...artifact, role: artifact.role };
        throw new Error("Unexpected role");
      } },
    });
    const verified = () => ({ requestHash: "a".repeat(64), metadata: { version: 1 as const, keyId: "gate-key", audience: "executor-control" as const, method: "POST" as const,
      canonicalTarget: "/api/execution/command", bodySha256: "0".repeat(64), timestamp: Math.floor(Date.now() / 1000), deliveryId: crypto.randomUUID(), signature: "0".repeat(64) } });
    const fence = { reference: prepared.deadline.reference, attemptToken: prepared.deadline.attemptToken, owner: crypto.randomUUID() };
    const send = (command: ExecutionCommand, request = verified()) => control.execute({ command, verifiedRequest: request });
    await send({ action: "acquire", ...fence, leaseSeconds: 120 });
    await send({ action: "process-start", fence });
    const previewKey = `execution/${fence.reference.deploymentEpoch}/${fence.attemptToken}/${fence.owner}/${crypto.randomUUID()}.mp4`;
    const assignments = [];
    for (const role of ["clip_preview", "preview_peaks", "layout_evidence"] as const) {
      const storageKey = role === "clip_preview" ? previewKey : role === "preview_peaks" ? previewKey.slice(0, -4) + ".peaks.json" : previewKey.slice(0, -4) + ".layout.json";
      const contentType = role === "clip_preview" ? "video/mp4" : "application/json";
      const row = await db.executionArtifact.create({ data: { attemptToken: fence.attemptToken, owner: fence.owner, role, bindingHash: admitted.bindingHash, storageKey,
        contentType, maxBytes: 10000n, grantExpiresAt: new Date(Date.now() + 60_000) } });
      heads.set(row.id, { etag: `"${role}"`, contentType, byteLength: 1000n, sha256: "b".repeat(64) });
      assignments.push(row);
    }
    const [preview, peaks, manifest] = assignments;
    const result: ClipPreparationResult = { version: 1, preparationId: admitted.preparationId, bindingHash: admitted.bindingHash,
      preview: { artifactId: preview!.id, startSec: 0, durationSec: 14 }, peaks: { state: "ready", artifactId: peaks!.id },
      layout: { automatic: { state: "failed", reason: "analysis_unavailable" }, screen: null, split: null } };
    manifests.set(manifest!.id, result);
    const commit = (row: typeof assignments[number]): ExecutionCommand => ({ action: "commit-artifact", fence, artifact: { artifactId: row.id,
      role: row.role as "clip_preview" | "preview_peaks" | "layout_evidence", bindingHash: row.bindingHash, contentType: row.contentType, byteLength: 1000, etag: heads.get(row.id)!.etag, sha256: "b".repeat(64) } });
    return { admitted, fence, control, send, verified, preview: preview!, peaks: peaks!, manifest: manifest!, result, manifests, commit, wakes, loseAck: (value: boolean) => { loseAck = value; } };
  }

  test("groups over the same source/editor binding share one sealed preparation without acquiring either parent", async () => {
    const f = await fixture();
    const [a, b] = await Promise.all(f.references.map(reference => f.service.admitForGroup(reference)));
    expect(a.kind).toBe("wait");
    expect(b.preparationId).toBe(a.preparationId);
    expect(await db.clipPreparation.count({ where: { clipId: f.clip.id } })).toBe(1);
    expect(await db.renderGroup.count({ where: { workflowRunId: f.run.id, preparationId: a.preparationId } })).toBe(2);
    expect(f.writes()).toBeGreaterThan(0);
    expect(f.writes()).toBeLessThanOrEqual(2);
    const preparation = await db.clipPreparation.findUniqueOrThrow({ where: { id: a.preparationId } });
    expect((await executionInputRetainUntil(db, preparation.inputStorageKey))!.getTime()).toBeGreaterThan(preparation.operationDeadlineAt.getTime());
    const input = await decodeClipPreparationInput(f.objects.get(preparation.inputStorageKey)!, { storageKey: preparation.inputStorageKey, etag: preparation.inputEtag,
      byteLength: Number(preparation.inputByteLength), sha256: preparation.inputChecksumSha256 });
    expect(input.source).toEqual({ storageKey: f.source.storageKey, etag: '"source"', byteLength: 1000, sha256: "c".repeat(64) });
    expect(input.document.clipEndSec).toBe(10);
    expect(await db.workflowRun.findUnique({ where: { id: f.run.id } })).toMatchObject({ attemptId: null, leaseOwner: null, attemptCount: 0 });
    expect(await db.renderGroup.count({ where: { workflowRunId: f.run.id, leaseOwner: { not: null } } })).toBe(0);
    expect(await db.executionAttempt.count({ where: { dispatch: { subjectKind: "clip_preparation", subjectId: preparation.id } } })).toBe(0);
    expect(JSON.stringify(a).length).toBeLessThan(4096);
    const writes = f.writes();
    expect(await f.service.admitForGroup(f.references[0]!)).toEqual(a);
    expect(f.writes()).toBe(writes);
  });

  test("preparation provenance cannot pair another Project with this Clip", async () => {
    const f = await fixture();
    const accepted = await f.service.admitForGroup(f.references[0]!);
    const row = await db.clipPreparation.findUniqueOrThrow({ where: { id: accepted.preparationId } });
    const other = await db.project.create({ data: { workspaceId: f.workspace.id, title: "Another Project", sourceMediaUrl: "r2://another" } });
    const { result: _result, ...data } = row;
    expect((await db.clipPreparation.create({ data: { ...data, id: crypto.randomUUID(), bindingHash: "0".repeat(64) } })).projectId).toBe(f.project.id);
    await expect(Promise.resolve(db.clipPreparation.create({ data: { ...data, id: crypto.randomUUID(), bindingHash: "1".repeat(64), projectId: other.id } }))).rejects.toMatchObject({ code: "P2003" });
  });

  test("source replacement during input I/O leaves no preparation and a durable exact-key cleanup obligation", async () => {
    const f = await fixture();
    f.afterWrite(async () => { await db.project.update({ where: { id: f.project.id }, data: { sourceRevision: 2 } }); });
    await expect(f.service.admitForGroup(f.references[0]!)).rejects.toMatchObject({ code: "clip_preparation_input_invalid" });
    expect(await db.clipPreparation.count({ where: { clipId: f.clip.id } })).toBe(0);
    const pending = await db.mediaCleanupObligation.findMany({ where: { projectId: f.project.id, origin: "clip_preparation_input" } });
    expect(pending).toHaveLength(1);
    expect(pending[0]!.objectKey).toBe([...f.objects.keys()][0]);
    expect(pending[0]!.nextAttemptAt.getTime()).toBeGreaterThan(Date.now() + 45 * 60_000);
    expect(pending[0]!.completedAt).toBeNull();
    expect(await executionInputRetainUntil(db, pending[0]!.objectKey)).toBeNull();
  });

  test("preparation registers its absolute watchdog before native admission, acquires once and charges one process start", async () => {
    const f = await fixture();
    const admitted = await f.service.admitForGroup(f.references[0]!);
    const reference = (await readExecutionDispatch(db, admitted.dispatchIds[0]!))!.reference;
    const prepared = await f.service.prepareExecution(reference);
    if (prepared.kind !== "waiting") throw new Error("Expected native preparation");
    const replay = await f.service.prepareExecution(reference);
    expect(replay).toEqual(prepared);
    const attempt = await db.executionAttempt.findUniqueOrThrow({ where: { attemptToken: prepared.deadline.attemptToken } });
    expect(attempt).toMatchObject({ functionName: "prepare_clip", owner: null, processStartedAt: null, status: "admitted" });
    expect(prepared.dispatchIds).toHaveLength(2);
    const watchdog = await readExecutionDispatch(db, prepared.deliveryId);
    expect(watchdog).toMatchObject({ deadlineKind: "operation", observedDeadlineAt: attempt.operationDeadlineAt });
    const wakes: string[] = [];
    const control = createExecutorControl({ database: db, subjectKind: "clip_preparation", domain: f.service, deliverWakes: async ids => { wakes.push(...ids); } });
    const verified = () => ({ requestHash: "a".repeat(64), metadata: { version: 1 as const, keyId: "gate-key", audience: "executor-control" as const, method: "POST" as const,
      canonicalTarget: "/api/execution/command", bodySha256: "0".repeat(64), timestamp: Math.floor(Date.now() / 1000), deliveryId: crypto.randomUUID(), signature: "0".repeat(64) } });
    const owners = [crypto.randomUUID(), crypto.randomUUID()];
    const results = await Promise.all(owners.map(owner => control.execute({ command: { action: "acquire", reference: prepared.deadline.reference, attemptToken: attempt.attemptToken, owner, leaseSeconds: 120 }, verifiedRequest: verified() })));
    expect(results.map(result => result.disposition).sort()).toEqual(["acquired", "busy"]);
    expect(wakes).toHaveLength(1);
    expect((await db.clipPreparation.findUniqueOrThrow({ where: { id: admitted.preparationId } })).chargedAttempts).toBe(0);
    const fence = { reference: prepared.deadline.reference, attemptToken: attempt.attemptToken, owner: owners[results.findIndex(result => result.disposition === "acquired")]! };
    const work = await f.service.workInput(await control.authorize(fence, false));
    expect(work.source).toEqual({ storageKey: f.source.storageKey, etag: '"source"', byteLength: 1000, sha256: "c".repeat(64) });
    expect(work.outputs.map(output => [output.role, output.bindingHash])).toEqual([["clip_preview", admitted.bindingHash], ["preview_peaks", admitted.bindingHash], ["layout_evidence", admitted.bindingHash]]);
    await control.execute({ command: { action: "process-start", fence }, verifiedRequest: verified() });
    await control.execute({ command: { action: "process-start", fence }, verifiedRequest: verified() });
    expect((await db.clipPreparation.findUniqueOrThrow({ where: { id: admitted.preparationId } })).chargedAttempts).toBe(1);
    expect(await db.workflowRun.findUnique({ where: { id: f.run.id } })).toMatchObject({ leaseOwner: null, attemptId: null, attemptCount: 0 });
  });

  test("a manifest arriving before its objects finalizes once with the Clip and both group wakes; lost ACK replays that receipt", async () => {
    const f = await fixture();
    const execution = await native(f);
    await f.service.admitForGroup(f.references[1]!);
    await execution.send(execution.commit(execution.manifest));
    await execution.send(execution.commit(execution.peaks));
    expect(await db.clipPreparation.findUnique({ where: { id: execution.admitted.preparationId } })).toMatchObject({ status: "running", chargedAttempts: 1 });
    expect((await db.clip.findUniqueOrThrow({ where: { id: f.clip.id } })).previewStorageKey).toBeNull();
    const request = execution.verified(), command = execution.commit(execution.preview);
    execution.loseAck(true);
    await expect(execution.send(command, request)).rejects.toThrow("Lost preparation wake");
    expect(await db.clipPreparation.findUnique({ where: { id: execution.admitted.preparationId } })).toMatchObject({ status: "completed", chargedAttempts: 1, executorOwner: null });
    expect(await db.clip.findUnique({ where: { id: f.clip.id } })).toMatchObject({ previewStorageKey: execution.preview.storageKey, previewStartSec: 0, previewDurationSec: 14, autoLayoutStatus: "completed" });
    execution.loseAck(false);
    expect(await execution.send(command, request)).toMatchObject({ disposition: "committed" });
    expect(execution.wakes.at(-1)).toEqual(execution.wakes.at(-2));
    expect(execution.wakes.at(-1)).toHaveLength(2);
    const ready = await f.service.readReadyForGroup(f.references[1]!);
    expect(ready).toMatchObject({ preparationId: execution.admitted.preparationId, preview: { storageKey: execution.preview.storageKey }, peaks: { storageKey: execution.peaks.storageKey }, result: execution.result });
    expect(await db.workflowRun.findUnique({ where: { id: f.run.id } })).toMatchObject({ attemptId: null, leaseOwner: null, attemptCount: 0 });
  });

  test("a frozen export finishes its preparation after a live edit without replacing the newer preview", async () => {
    const f = await fixture(true), execution = await native(f);
    await db.clip.update({ where: { id: f.clip.id }, data: { editorRevision: 1, startSec: 1, endSec: 11, previewStorageKey: "projects/newer-preview.mp4", previewStartSec: 1, previewDurationSec: 10 } });
    await execution.send(execution.commit(execution.preview));
    await execution.send(execution.commit(execution.peaks));
    await execution.send(execution.commit(execution.manifest));
    expect(await db.clipPreparation.findUnique({ where: { id: execution.admitted.preparationId } })).toMatchObject({ status: "completed", chargedAttempts: 1 });
    expect(await db.clip.findUnique({ where: { id: f.clip.id } })).toMatchObject({ editorRevision: 1, previewStorageKey: "projects/newer-preview.mp4", startSec: 1, endSec: 11 });
    expect(await f.service.readReadyForGroup(f.references[0]!)).toMatchObject({ preview: { storageKey: execution.preview.storageKey }, result: execution.result });
  });

  test("an export snapshot must carry its exact frozen revision before a capsule is written", async () => {
    const f = await fixture(true, 99);
    await expect(f.service.admitForGroup(f.references[0]!)).rejects.toMatchObject({ code: "clip_preparation_input_invalid" });
    expect(f.writes()).toBe(0);
    expect(await db.clipPreparation.count({ where: { clipId: f.clip.id } })).toBe(0);
  });

  test("an elapsed group deadline refuses preparation before storage I/O", async () => {
    const f = await fixture();
    await db.renderGroup.update({ where: { id: f.references[0]!.subject.id }, data: { operationDeadlineAt: new Date(0) } });
    await expect(f.service.admitForGroup(f.references[0]!)).rejects.toMatchObject({ code: "clip_preparation_input_invalid" });
    expect(f.writes()).toBe(0);
    expect(await db.clipPreparation.count({ where: { clipId: f.clip.id } })).toBe(0);
  });

  test("a replaced source revokes a started preparation before an old owner can publish", async () => {
    const f = await fixture(), execution = await native(f);
    await db.project.update({ where: { id: f.project.id }, data: { sourceRevision: 2 } });
    expect(await execution.send(execution.commit(execution.preview))).toMatchObject({ disposition: "superseded" });
    expect(await db.clipPreparation.findUnique({ where: { id: execution.admitted.preparationId } })).toMatchObject({ status: "superseded", chargedAttempts: 1, executorOwner: null, leaseExpiresAt: null });
    expect((await db.executionAttempt.findUniqueOrThrow({ where: { attemptToken: execution.fence.attemptToken } })).revokedAt).not.toBeNull();
    expect((await db.executionArtifact.findUniqueOrThrow({ where: { id: execution.preview.id } })).committedAt).toBeNull();
    expect((await db.clip.findUniqueOrThrow({ where: { id: f.clip.id } })).previewStorageKey).toBeNull();
    await expect(execution.control.authorize(execution.fence)).rejects.toMatchObject({ code: "authority_lost" });
  });

  test("lease expiry authorizes one fenced retry with the original deadline and preserves the charged start", async () => {
    const f = await fixture(), execution = await native(f);
    const initial = await db.clipPreparation.findUniqueOrThrow({ where: { id: execution.admitted.preparationId } });
    await db.clipPreparation.update({ where: { id: initial.id }, data: { leaseExpiresAt: new Date(0) } });
    await db.executionAttempt.update({ where: { attemptToken: execution.fence.attemptToken }, data: { leaseExpiresAt: new Date(0) } });
    const deadline = { reference: execution.fence.reference, attemptToken: execution.fence.attemptToken, kind: "lease" as const, observedDeadlineAt: new Date(0).toISOString() };
    expect((await execution.control.expireDeadline({ deadline, deliveryId: crypto.randomUUID() })).kind).toBe("expired");
    const retried = await db.clipPreparation.findUniqueOrThrow({ where: { id: initial.id } });
    expect(retried).toMatchObject({ status: "queued", generation: 2, chargedAttempts: 1, attemptToken: null, executorOwner: null, operationDeadlineAt: initial.operationDeadlineAt });
    expect((await db.executionAttempt.findUniqueOrThrow({ where: { attemptToken: execution.fence.attemptToken } })).revokedAt).not.toBeNull();
    const next = await db.executionDispatch.findFirstOrThrow({ where: { subjectKind: "clip_preparation", subjectId: initial.id, generation: 2, kind: "operation_driver", wakeKind: null, deadlineKind: null } });
    expect(await f.service.prepareExecution((await readExecutionDispatch(db, next.id))!.reference)).toMatchObject({ kind: "sleep", dueAt: retried.retryAt });
    expect(await execution.send(execution.commit(execution.preview))).toMatchObject({ disposition: "superseded" });
  });

  for (const changed of ["window", "source_identity"] as const) test(`a manifest with changed ${changed} cannot publish a preview`, async () => {
    const f = await fixture(), execution = await native(f);
    const result = structuredClone(execution.result);
    if (changed === "window") result.preview.durationSec = 15;
    else {
      const segment = { startSec: 0, endSec: 10, layout: "single" as const, cxNorm: 0.5, cyNorm: 0.5, zoom: 1, subjects: [] };
      result.layout.automatic = { version: CLIP_AUTO_LAYOUT_VERSION, engine: CLIP_AUTO_LAYOUT_ENGINE, sourceIdentity: "unrelated-source", analyzedAtISO: new Date().toISOString(),
        clipStartSec: 0, clipEndSec: 10, deletedRanges: [], editedDurationSec: 10, sourceWidth: 1, sourceHeight: 1, segments: [segment], noSplitSegments: [segment],
        shotCount: 0, soloShotCount: 0, multiShotCount: 0, twoUpSegmentCount: 0, speakerCount: 0, mappedSpeakerCount: 0 };
    }
    execution.manifests.set(execution.manifest.id, result);
    await execution.send(execution.commit(execution.preview));
    await execution.send(execution.commit(execution.peaks));
    await expect(execution.send(execution.commit(execution.manifest))).rejects.toMatchObject({ code: "clip_preparation_input_invalid" });
    expect(await db.clipPreparation.findUnique({ where: { id: execution.admitted.preparationId } })).toMatchObject({ status: "running", chargedAttempts: 1, result: null });
    expect((await db.clip.findUniqueOrThrow({ where: { id: f.clip.id } })).previewStorageKey).toBeNull();
    expect((await db.executionArtifact.findUniqueOrThrow({ where: { id: execution.manifest.id } })).committedAt).toBeNull();
  });

  test("a projection failure rolls back the manifest receipt, job completion and wakes together", async () => {
    const f = await fixture(), execution = await native(f);
    await execution.send(execution.commit(execution.preview));
    await execution.send(execution.commit(execution.peaks));
    const trigger = `fail_preparation_${crypto.randomUUID().replaceAll("-", "")}`;
    // Generated fixture identifiers only. This runs inside the guarded disposable schema.
    await db.$executeRawUnsafe(`CREATE FUNCTION "${trigger}"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id='${f.clip.id}'::uuid AND NEW."previewStorageKey" IS NOT NULL THEN RAISE EXCEPTION 'injected_preparation_projection_failure'; END IF; RETURN NEW; END $$`);
    await db.$executeRawUnsafe(`CREATE TRIGGER "${trigger}" BEFORE UPDATE ON "Clip" FOR EACH ROW EXECUTE FUNCTION "${trigger}"()`);
    const command = execution.commit(execution.manifest), request = execution.verified();
    try { await expect(execution.send(command, request)).rejects.toThrow("injected_preparation_projection_failure"); }
    finally { await db.$executeRawUnsafe(`DROP TRIGGER "${trigger}" ON "Clip"`); await db.$executeRawUnsafe(`DROP FUNCTION "${trigger}"()`); }
    expect(await db.clipPreparation.findUnique({ where: { id: execution.admitted.preparationId } })).toMatchObject({ status: "running", chargedAttempts: 1, result: null });
    expect((await db.executionArtifact.findUniqueOrThrow({ where: { id: execution.manifest.id } })).committedAt).toBeNull();
    expect(await db.executionInboxReceipt.findUnique({ where: { audience_deliveryId: { audience: "executor-control", deliveryId: request.metadata.deliveryId } } })).toBeNull();
    expect(await db.executionDispatch.count({ where: { subjectId: { in: f.references.map(reference => reference.subject.id) }, wakeKind: "preparation_outcome" } })).toBe(0);
    expect(await execution.send(command, request)).toMatchObject({ disposition: "committed" });
    expect(await db.clipPreparation.findUnique({ where: { id: execution.admitted.preparationId } })).toMatchObject({ status: "completed", chargedAttempts: 1 });
  });
});
