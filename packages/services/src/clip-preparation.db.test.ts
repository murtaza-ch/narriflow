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
import { clipPreparationEngineHash } from "./clip-preparation-policy";
import { RenderGroupExecutionService, createRenderGroupExecution } from "./render-group-execution";
import { createRenderInputSnapshot } from "./render-input-snapshot";
import { renderArtifactBindingHash } from "./render-artifact";
import { createExecutionStorage } from "./execution-storage";
import { createClipPreparationExecution } from "./clip-preparation-execution";

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

  async function fixture(frozenExport = false, snapshotRevision?: number, siblingGroup = false) {
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
    if (siblingGroup) {
      const members = [];
      for (const aspectRatio of ["ratio_9_16", "ratio_16_9"] as const) members.push(await db.clipRender.create({ data: { clipId: clip.id, workflowRunId: run.id, editorRevision: clip.editorRevision, aspectRatio, resolution: "720p" } }));
      const group = await db.renderGroup.create({ data: { workflowRunId: run.id, workSetGeneration, clipId: clip.id, deploymentEpoch: epoch,
        exportIdentity: renderGroupExportIdentity({ clipId: clip.id, exportId: null, editorRevision: clip.editorRevision, resolution: "720p", watermark: true }), members: { create: members.map(member => ({ clipRenderId: member.id })) } } });
      references.push((await db.$transaction(tx => appendExecutionDispatch(tx, { deploymentEpoch: epoch, generation: 1, kind: "operation_driver", subject: { kind: "render_group", id: group.id }, inputHash: "d".repeat(64), dueAt: group.createdAt }))).reference);
    } else for (const resolution of ["720p", "1080p"]) {
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
    const service = new ClipPreparationService(db, { toolchainFingerprint: "e".repeat(64), engineHash: await clipPreparationEngineHash("e".repeat(64)), register: async (ids: readonly string[]) => {
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

  test("production work-package replay uses one connection before start and revalidates an edited Clip", async () => {
    const f = await fixture();
    const admitted = await f.service.admitForGroup(f.references[0]!);
    const prepared = await f.service.prepareExecution((await readExecutionDispatch(db, admitted.dispatchIds[0]!))!.reference);
    if (prepared.kind !== "waiting") throw Error("Missing preparation");
    const queries: string[] = [];
    const single = new PrismaClient({ adapter: new PrismaPg({ connectionString: url, max: 1 }, { schema: process.env.SERVERLESS_TEST_DATABASE_SCHEMA! }), transactionOptions: { timeout: 3000, maxWait: 1000 }, log: [{ emit: "event", level: "query" }] });
    single.$on("query", event => queries.push(event.query));
    const storage = createExecutionStorage({ accountId: "a".repeat(32), bucket: "test", accessKeyId: "fixture", secretAccessKey: "fixture" });
    try {
      const service = new ClipPreparationService(single, { toolchainFingerprint: "e".repeat(64), engineHash: await clipPreparationEngineHash("e".repeat(64)),
        storage: { write: async () => { throw Error("Package grants cannot write capsules"); } }, register: async () => { throw Error("Package grants cannot register scheduling"); } });
      const factory = createClipPreparationExecution({ database: single, domain: service, storage,
        artifacts: { head: async () => { throw Error("Package grants cannot HEAD storage"); }, readJson: async () => { throw Error("Package grants cannot read storage"); } }, deliverWakes: async () => {} });
      const verified = () => ({ requestHash: "a".repeat(64), metadata: { version: 1 as const, keyId: "gate-key", audience: "executor-control" as const, method: "POST" as const,
        canonicalTarget: "/api/execution/transfer", bodySha256: "0".repeat(64), timestamp: Math.floor(Date.now() / 1000), deliveryId: crypto.randomUUID(), signature: "0".repeat(64) } });
      const fence = { reference: prepared.deadline.reference, attemptToken: prepared.deadline.attemptToken, owner: crypto.randomUUID() };
      queries.length = 0;
      await factory.control.execute({ command: { action: "acquire", ...fence, leaseSeconds: 120 }, verifiedRequest: verified() });
      const acquireQueries = queries.length;
      const before = await db.clipPreparation.findUniqueOrThrow({ where: { id: admitted.preparationId } });
      const attempt = await db.executionAttempt.findUniqueOrThrow({ where: { attemptToken: fence.attemptToken } });
      const authority = await factory.control.authorize(fence, false);
      expect(typeof authority.input?.byteLength).toBe("bigint");
      expect(authority.input?.byteLength).toBe(before.inputByteLength);
      expect(authority.leaseExpiresAt).toEqual(attempt.leaseExpiresAt);
      expect(authority.operationDeadlineAt).toEqual(attempt.operationDeadlineAt);
      const requests = Array.from({ length: 6 }, verified), request = requests[0]!, command = { action: "work-package", fence };
      queries.length = 0;
      await factory.transfer.execute({ command, verifiedRequest: request });
      const startupQueries = queries.length;
      console.warn(JSON.stringify({ level: "info", message: "preparation_work_package_queries", count: startupQueries,
        dispatchReads: queries.filter(query => query.startsWith("SELECT") && query.includes('"ExecutionDispatch"')).length,
        epochReads: queries.filter(query => query.startsWith("SELECT") && query.includes('"ExecutionEpoch"')).length }));
      // This startup path previously issued 64 statements. Keep its serial
      // database work bounded without relaxing any authority or expiry check.
      expect(startupQueries).toBeLessThanOrEqual(46);
      queries.length = 0;
      await factory.transfer.execute({ command, verifiedRequest: request });
      const replayQueries = queries.length;
      const results = await Promise.all(requests.map(verifiedRequest => factory.transfer.execute({ command, verifiedRequest })));
      const first = results[0];
      if (first?.disposition !== "work_package" || first.input.kind !== "object") throw Error("Missing sealed package grant");
      expect(first.input).toMatchObject({ storageKey: before.inputStorageKey, etag: before.inputEtag, sha256: before.inputChecksumSha256 });
      expect(results.every(value => value.disposition === "work_package" && JSON.stringify(value.outputs) === JSON.stringify(first.outputs))).toBe(true);
      expect(first.outputs.map(value => [value.role, value.bindingHash])).toEqual([["clip_preview", admitted.bindingHash], ["preview_peaks", admitted.bindingHash], ["layout_evidence", admitted.bindingHash]]);
      expect(first.sources[0]).toMatchObject({ name: "original", storageKey: f.source.storageKey, headers: { "If-Match": '"source"' } });
      expect(Date.parse(first.input.expiresAt)).toBeLessThanOrEqual(attempt.leaseExpiresAt!.getTime());
      expect(await db.clipPreparation.findUniqueOrThrow({ where: { id: admitted.preparationId } })).toEqual(before);
      expect(await db.executionAttempt.findUniqueOrThrow({ where: { attemptToken: fence.attemptToken } })).toEqual(attempt);
      expect(await db.executionArtifact.count({ where: { attemptToken: fence.attemptToken } })).toBe(3);
      const sourceRead = { action: "source-read", fence, sourceId: "original" };
      await expect(factory.transfer.execute({ command: sourceRead, verifiedRequest: verified() })).rejects.toMatchObject({ code: "authority_lost" });
      queries.length = 0;
      await factory.control.execute({ command: { action: "process-start", fence }, verifiedRequest: verified() });
      const processStartQueries = queries.length;
      queries.length = 0;
      expect((await factory.transfer.execute({ command: sourceRead, verifiedRequest: verified() })).disposition).toBe("source_read");
      const sourceReadQueries = queries.length;
      console.warn(JSON.stringify({ level: "info", message: "preparation_source_read_statement_trace", count: sourceReadQueries,
        statements: queries.map(query => ({ operation: /^[A-Z]+/.exec(query.trim())?.[0],
          tables: ["ExecutionEpoch", "ExecutionInboxReceipt", "ExecutionDispatch", "ClipPreparation", "Project", "WorkflowRun", "RenderGroup", "RenderGroupMember", "Clip", "ExecutionArtifact", "ClipRender", "ClipExportVariant", "ExecutionAttempt"].filter(table => query.includes('"'+table+'"')),
          rowLock: query.includes("FOR UPDATE"), advisoryLock: query.includes("pg_advisory_xact_lock") })) }));
      expect(sourceReadQueries).toBeLessThanOrEqual(17);
      queries.length = 0;
      await factory.control.execute({ command: { action: "renew", fence, leaseSeconds: 120 }, verifiedRequest: verified() });
      console.warn(JSON.stringify({ level: "info", message: "preparation_control_query_counts", acquire: acquireQueries,
        firstWorkPackage: startupQueries, replayWorkPackage: replayQueries, processStart: processStartQueries, sourceRead: sourceReadQueries, renew: queries.length }));
      await db.clip.update({ where: { id: f.clip.id }, data: { editorRevision: { increment: 1 } } });
      await expect(factory.transfer.execute({ command, verifiedRequest: request })).rejects.toMatchObject({ code: "authority_lost" });
      expect((await db.clipPreparation.findUniqueOrThrow({ where: { id: admitted.preparationId } })).operationDeadlineAt).toEqual(before.operationDeadlineAt);
      expect((await db.clipPreparation.findUniqueOrThrow({ where: { id: admitted.preparationId } })).chargedAttempts).toBe(1);
    } finally { storage.close(); await single.$disconnect(); }
  }, 30_000);

  test("mismatched preparation references are refused before interpreting their subject as a UUID", async () => {
    const f = await fixture(), admitted = await f.service.admitForGroup(f.references[0]!);
    const preparationReference = (await readExecutionDispatch(db, admitted.dispatchIds[0]!))!.reference;
    const prepared = await f.service.prepareExecution(preparationReference);
    if (prepared.kind !== "waiting") throw Error("Missing preparation");
    const storage = createExecutionStorage({ accountId: "a".repeat(32), bucket: "test", accessKeyId: "fixture", secretAccessKey: "fixture" });
    try {
      const factory = createClipPreparationExecution({ database: db, domain: f.service, storage,
        artifacts: { head: async () => { throw Error("Refused references cannot HEAD storage"); }, readJson: async () => { throw Error("Refused references cannot read storage"); } }, deliverWakes: async () => {} });
      const verified = () => ({ requestHash: "a".repeat(64), metadata: { version: 1 as const, keyId: "gate-key", audience: "executor-control" as const, method: "POST" as const,
        canonicalTarget: "/api/execution/transfer", bodySha256: "0".repeat(64), timestamp: Math.floor(Date.now() / 1000), deliveryId: crypto.randomUUID(), signature: "0".repeat(64) } });
      const outcomes: unknown[] = [];
      for (const subjectKind of ["clip_preparation", "ingest_job"] as const) {
        const reference = { ...prepared.deadline.reference, subject: { kind: subjectKind, id: "not-a-uuid" } };
        for (const action of ["work-package", "source-read"] as const) {
          try {
            await factory.transfer.execute({ command: { action, fence: { reference, attemptToken: prepared.deadline.attemptToken, owner: crypto.randomUUID() }, ...(action === "source-read" ? { sourceId: "original" } : {}) }, verifiedRequest: verified() });
            outcomes.push({ subjectKind, action, code: "unexpected_success" });
          } catch (error) { outcomes.push({ subjectKind, action, code: error && typeof error === "object" && "code" in error ? error.code : "unclassified" }); }
        }
      }
      const domainOutcomes: unknown[] = [];
      for (const [kind, subjectKind] of [["operation_driver", "clip_preparation"], ["operation_driver", "ingest_job"], ["modal_execution", "clip_preparation"]] as const) {
        try {
          domainOutcomes.push({ kind, subjectKind, result: await f.service.prepareExecution({ ...preparationReference, kind, subject: { kind: subjectKind, id: "not-a-uuid" } }) });
        } catch (error) { domainOutcomes.push({ kind, subjectKind, code: error && typeof error === "object" && "code" in error ? error.code : "unclassified" }); }
      }
      console.warn(JSON.stringify({ level: "info", message: "malformed_preparation_reference_outcomes", outcomes, domainOutcomes }));
      expect(outcomes).toEqual(["clip_preparation", "ingest_job"].flatMap(subjectKind => ["work-package", "source-read"].map(action => ({ subjectKind, action, code: "invalid_reference" }))));
      expect(domainOutcomes).toEqual([["operation_driver", "clip_preparation"], ["operation_driver", "ingest_job"], ["modal_execution", "clip_preparation"]].map(([kind, subjectKind]) => ({ kind, subjectKind, result: { kind: "superseded", dispatchIds: [] } })));
    } finally { storage.close(); }
  });

  test("preparation Project expiry during local presigning rolls back the grant while its lease remains live", async () => {
    const f = await fixture(), admitted = await f.service.admitForGroup(f.references[0]!);
    const prepared = await f.service.prepareExecution((await readExecutionDispatch(db, admitted.dispatchIds[0]!))!.reference);
    if (prepared.kind !== "waiting") throw Error("Missing preparation");
    const storage = createExecutionStorage({ accountId: "a".repeat(32), bucket: "test", accessKeyId: "fixture", secretAccessKey: "fixture" });
    let signed = 0;
    const factory = createClipPreparationExecution({ database: db, domain: f.service,
      storage: { ...storage, signSource: async (...args) => {
        signed++;
        await Bun.sleep(Math.max(0, expiresAt.getTime() - Date.now()) + 30);
        return storage.signSource(...args);
      } },
      artifacts: { head: async () => { throw Error("No HEAD under package locks"); }, readJson: async () => { throw Error("No input I/O under package locks"); } }, deliverWakes: async () => {} });
    const verified = () => ({ requestHash: "a".repeat(64), metadata: { version: 1 as const, keyId: "gate-key", audience: "executor-control" as const,
      method: "POST" as const, canonicalTarget: "/api/execution/transfer", bodySha256: "0".repeat(64), timestamp: Math.floor(Date.now() / 1000), deliveryId: crypto.randomUUID(), signature: "0".repeat(64) } });
    const fence = { reference: prepared.deadline.reference, attemptToken: prepared.deadline.attemptToken, owner: crypto.randomUUID() };
    await factory.control.execute({ command: { action: "acquire", ...fence, leaseSeconds: 120 }, verifiedRequest: verified() });
    const before = await db.clipPreparation.findUniqueOrThrow({ where: { id: admitted.preparationId } });
    const expiresAt = new Date(Date.now() + 1000);
    await db.project.update({ where: { id: f.project.id }, data: { expiresAt } });
    const request = verified();
    try {
      await expect(factory.transfer.execute({ command: { action: "work-package", fence }, verifiedRequest: request })).rejects.toMatchObject({ code: "authority_lost" });
      expect(signed).toBe(1);
      expect(await db.executionArtifact.count({ where: { attemptToken: fence.attemptToken } })).toBe(0);
      expect(await db.mediaCleanupObligation.count({ where: { origin: "assigned_execution_artifact", objectKey: { startsWith: `execution/${fence.reference.deploymentEpoch}/${fence.attemptToken}/${fence.owner}/` } } })).toBe(0);
      expect(await db.executionInboxReceipt.count({ where: { audience: "executor-control", deliveryId: request.metadata.deliveryId } })).toBe(0);
      const after = await db.clipPreparation.findUniqueOrThrow({ where: { id: admitted.preparationId } });
      expect(after).toEqual(before);
      expect(after.leaseExpiresAt!.getTime()).toBeGreaterThan(Date.now() + 60_000);
    } finally { storage.close(); }
  });

  for (const changed of ["source_revision", "editor", "member", "cancelled", "workspace"] as const)
    test(`preparation rechecks ${changed} after a queued row-lock wait`, async () => {
      const f = await fixture(), n = await native(f);
      const single = new PrismaClient({ adapter: new PrismaPg({ connectionString: url, max: 1 }, { schema: process.env.SERVERLESS_TEST_DATABASE_SCHEMA! }), transactionOptions: { timeout: 5000, maxWait: 1000 } });
      const storage = createExecutionStorage({ accountId: "a".repeat(32), bucket: "test", accessKeyId: "fixture", secretAccessKey: "fixture" });
      const factory = createClipPreparationExecution({ database: single, domain: f.service, storage,
        artifacts: { head: async () => { throw Error("No HEAD under grant locks"); }, readJson: async () => { throw Error("No input I/O under grant locks"); } }, deliverWakes: async () => {} });
      const [backend] = await single.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
      const before = await db.clipPreparation.findUniqueOrThrow({ where: { id: n.admitted.preparationId } });
      const artifactCount = await db.executionArtifact.count({ where: { attemptToken: n.fence.attemptToken } });
      let entered!: () => void, release!: () => void;
      const locked = new Promise<void>(resolve => { entered = resolve; }), unlock = new Promise<void>(resolve => { release = resolve; });
      // The blocker deliberately edits while the grant statement is queued.
      // Its transaction bypasses domain locks only to exercise READ COMMITTED
      // snapshot freshness; it never runs outside this disposable schema.
      const blocker = db.$transaction(async tx => {
        if (changed === "source_revision") await tx.$queryRaw`SELECT id FROM "Project" WHERE id = ${f.project.id}::uuid FOR UPDATE`;
        else await tx.$queryRaw`SELECT id FROM "WorkflowRun" WHERE id = ${f.run.id}::uuid FOR UPDATE`;
        entered(); await unlock;
        if (changed === "source_revision") await tx.project.update({ where: { id: f.project.id }, data: { sourceRevision: { increment: 1 } } });
        if (changed === "editor") await tx.clip.update({ where: { id: f.clip.id }, data: { editorRevision: { increment: 1 } } });
        if (changed === "member") await tx.renderGroupMember.updateMany({ where: { groupId: f.references[0]!.subject.id }, data: { invalidatedAt: new Date() } });
        if (changed === "cancelled") await tx.executionAttempt.update({ where: { attemptToken: n.fence.attemptToken }, data: { revokedAt: new Date() } });
        if (changed === "workspace") await tx.workspace.update({ where: { id: f.workspace.id }, data: { status: "restricted" } });
      });
      await locked;
      const request = n.verified();
      const pending = factory.transfer.execute({ command: { action: "source-read", fence: n.fence, sourceId: "original" }, verifiedRequest: request })
        .then(value => ({ value }), error => ({ error }));
      try {
        let waiting = false;
        for (let tries = 0; tries < 100; tries++) {
          const [state] = await db.$queryRaw<Array<{ waiting: boolean }>>`SELECT wait_event_type = 'Lock' AS waiting FROM pg_stat_activity WHERE pid = ${backend!.pid}`;
          if (state?.waiting) { waiting = true; break; }
          await Bun.sleep(10);
        }
        expect(waiting).toBe(true);
        release(); await blocker;
        const result = await pending;
        expect(result).toHaveProperty("error.code", "authority_lost");
        expect(await db.executionInboxReceipt.count({ where: { audience: "executor-control", deliveryId: request.metadata.deliveryId } })).toBe(0);
        expect(await db.executionArtifact.count({ where: { attemptToken: n.fence.attemptToken } })).toBe(artifactCount);
        const after = await db.clipPreparation.findUniqueOrThrow({ where: { id: n.admitted.preparationId } });
        expect(after.operationDeadlineAt).toEqual(before.operationDeadlineAt);
        expect(after.chargedAttempts).toBe(before.chargedAttempts);
      } finally {
        release(); await blocker.catch(() => {}); await pending;
        storage.close(); await single.$disconnect();
      }
    });

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
  test("a preparation capsule already claimed for deletion cannot be adopted and a retry uses a new key", async () => {
    const f = await fixture();
    f.afterWrite(async () => { await db.mediaCleanupObligation.updateMany({ where: { projectId: f.project.id, origin: "clip_preparation_input" }, data: { claimId: crypto.randomUUID(), claimExpiresAt: new Date(Date.now() + 60000) } }); });
    await expect(f.service.admitForGroup(f.references[0]!)).rejects.toMatchObject({ code: "execution_object_deletion_admitted" });
    expect(await db.clipPreparation.count({ where: { clipId: f.clip.id } })).toBe(0);
    f.afterWrite(async () => {});
    const admitted = await f.service.admitForGroup(f.references[0]!);
    expect(f.objects.size).toBe(2);
    const row = await db.clipPreparation.findUniqueOrThrow({ where: { id: admitted.preparationId } });
    expect(row.inputStorageKey).not.toBe([...f.objects.keys()][0]);
  });

  test("preparation provenance cannot pair another Project with this Clip", async () => {
    const f = await fixture();
    const accepted = await f.service.admitForGroup(f.references[0]!);
    const row = await db.clipPreparation.findUniqueOrThrow({ where: { id: accepted.preparationId } });
    const other = await db.project.create({ data: { workspaceId: f.workspace.id, title: "Another Project", sourceMediaUrl: "r2://another" } });
    const { result: _result, readyObjects: _readyObjects, ...data } = row;
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
    const work = await control.withAuthority(fence, false, (tx, authority, ref) => f.service.workInputWithinAuthority(tx, authority, ref));
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
    expect((await db.clipPreparation.findUniqueOrThrow({ where: { id: execution.admitted.preparationId } })).readyObjects).toMatchObject({
      preview: { storageKey: execution.preview.storageKey }, peaks: { storageKey: execution.peaks.storageKey }, manifest: { storageKey: execution.manifest.storageKey },
    });
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

  function renderService(f: Awaited<ReturnType<typeof fixture>>, database = db, beforeRead?: () => Promise<void>) {
    const storage = { read: async (reference: { storageKey: string }) => {
      await beforeRead?.();
      const bytes = f.objects.get(reference.storageKey); if (!bytes) throw new Error("Missing immutable fixture input"); return bytes.slice();
    }, write: async (key: string, bytes: Uint8Array) => {
      f.objects.set(key, bytes.slice()); return { etag: '"render-input"', byteLength: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") };
    } };
    return new RenderGroupExecutionService(database, { toolchainFingerprint: "e".repeat(64), preparation: f.service, inputStorage: storage,
      snapshot: createRenderInputSnapshot(database, { object: async () => { throw new Error("No media assets requested"); }, pexelsConfigured: false, searchStock: async () => { throw new Error("Stock search disabled"); } }),
      register: async ids => { expect(await db.executionDispatch.count({ where: { id: { in: [...ids] } } })).toBe(ids.length); } });
  }

  test("a failed preparation input PUT leaves the group watchdog durable and expires without a generic render or charge", async () => {
    const f = await fixture(), reference = f.references[0]!, service = renderService(f);
    const absolute = new Date(Date.now()+500);
    await db.renderGroup.update({ where: { id: reference.subject.id }, data: { operationDeadlineAt: absolute } });
    f.afterWrite(async () => { throw new Error("injected_preparation_put_failure"); });
    await expect(service.prepareExecution(reference)).rejects.toThrow("injected_preparation_put_failure");
    const watchdog = await db.executionDispatch.findFirstOrThrow({ where: { subjectId: reference.subject.id, kind: "operation_driver", deadlineKind: "operation" } });
    expect(watchdog.observedDeadlineAt).toEqual(absolute);
    expect(await db.clipPreparation.count({ where: { clipId: f.clip.id } })).toBe(0);
    expect(await db.executionAttempt.count({ where: { dispatch: { subjectId: reference.subject.id } } })).toBe(0);
    expect(await db.executionDispatch.count({ where: { subjectId: reference.subject.id, kind: "modal_execution" } })).toBe(0);
    const deadlineRef = (await readExecutionDispatch(db, watchdog.id))!.reference;
    expect((await service.domain.expirePreparationDeadline(deadlineRef, { kind: "operation", observedDeadlineAt: absolute })).kind).toBe("sleep");
    await Bun.sleep(Math.max(0,absolute.getTime()-Date.now()+25));
    expect((await service.domain.expirePreparationDeadline(deadlineRef, { kind: "operation", observedDeadlineAt: absolute })).kind).toBe("expired");
    expect(await db.renderGroup.findUniqueOrThrow({ where: { id: reference.subject.id } })).toMatchObject({ status: "failed", chargedAttemptCount: 0, attemptToken: null, preparationId: null, inputStorageKey: null });
    expect(await db.renderGroupExecution.count({ where: { groupId: reference.subject.id } })).toBe(0);
    expect(await db.workflowRun.findUniqueOrThrow({ where: { id: f.run.id } })).toMatchObject({ status: "waiting", attemptId: null, leaseOwner: null, attemptCount: 0 });
  });

  test("an unfinished preparation returns an event dependency with its registered absolute deadline and no native token", async () => {
    const f = await fixture(), reference = f.references[0]!;
    const waiting = await renderService(f).prepareExecution(reference);
    if (waiting.kind !== "dependency_wait") throw new Error("Expected preparation dependency");
    const deadline = await db.executionDispatch.findUniqueOrThrow({ where: { id: waiting.deadlineDispatchId } });
    expect(deadline).toMatchObject({ subjectId: reference.subject.id, kind: "operation_driver", deadlineKind: "operation", dueAt: waiting.dueAt, observedDeadlineAt: waiting.dueAt });
    expect(waiting.dispatchIds).toContain(deadline.id);
    expect(waiting).not.toHaveProperty("attemptToken");
    expect(await db.executionAttempt.count({ where: { dispatch: { subjectId: reference.subject.id } } })).toBe(0);
    expect(await db.executionDispatch.count({ where: { subjectId: reference.subject.id, kind: "modal_execution" } })).toBe(0);
    expect(await db.renderGroupExecution.count({ where: { groupId: reference.subject.id } })).toBe(0);
  });

  test("concurrent ready group commands adopt one capsule and admit one native generation without a coordinator lease", async () => {
    const f = await fixture(), execution = await native(f);
    await execution.send(execution.commit(execution.preview)); await execution.send(execution.commit(execution.peaks)); await execution.send(execution.commit(execution.manifest));
    await db.workspace.update({ where: { id: f.workspace.id }, data: { pricingTier: "business" } });
    const reference = f.references[0]!, service = renderService(f);
    const results = await Promise.all([service.prepareExecution(reference),service.prepareExecution(reference),service.prepareExecution(reference)]);
    expect(results.every(result => result.kind === "waiting")).toBe(true);
    const waiting = results[0]; if (waiting?.kind !== "waiting") throw new Error("Expected native admission");
    expect(new Set(results.map(result => result.kind === "waiting" ? result.deadline.attemptToken : null)).size).toBe(1);
    const group = await db.renderGroup.findUniqueOrThrow({ where: { id: reference.subject.id } });
    expect(group).toMatchObject({ status: "queued", attemptToken: null, leaseOwner: null, chargedAttemptCount: 0, preparationId: execution.admitted.preparationId });
    const attempts = await db.executionAttempt.findMany({ where: { dispatch: { subjectId: group.id, kind: "modal_execution" } } });
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ owner: null, status: "admitted", inputStorageKey: group.inputStorageKey, inputEtag: group.inputEtag, operationDeadlineAt: group.operationDeadlineAt });
    const frozen = await service.loadInput(attempts[0]!);
    expect(frozen.prepared.result).toEqual(execution.result);
    expect(frozen.workspace.pricingTier).toBe("business");
    expect(frozen.watermark).toBe(true);
    expect(frozen.variants).toHaveLength(1);
    expect(frozen.preparation.document).toEqual((await decodeClipPreparationInput(f.objects.get((await db.clipPreparation.findUniqueOrThrow({ where: { id: group.preparationId! } })).inputStorageKey)!,
      await f.service.readReadyForGroup(reference).then(ready => ready!.input))).document);
    expect((await executionInputRetainUntil(db, group.inputStorageKey!))!.getTime()).toBeGreaterThan(group.operationDeadlineAt!.getTime());
    const writes = f.objects.size;
    expect(await service.prepareExecution(reference)).toEqual(results[0]);
    expect(f.objects.size).toBe(writes);
    expect(await db.workflowRun.findUniqueOrThrow({ where: { id: f.run.id } })).toMatchObject({ status: "waiting", attemptId: null, leaseOwner: null, attemptCount: 0 });
  });
  test("render input adoption rejects another group's key and a key granted to cleanup", async () => {
    const f = await fixture(), execution = await native(f);
    await execution.send(execution.commit(execution.preview)); await execution.send(execution.commit(execution.peaks)); await execution.send(execution.commit(execution.manifest));
    const reference = f.references[0]!, domain = renderService(f).domain;
    const tuple = { storageKey: `projects/${f.project.id}/render-groups/${f.references[1]!.subject.id}/${crypto.randomUUID()}.json`, etag: '"input"', byteLength: 2,
      sha256: "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a" };
    await expect(domain.adoptInput(reference, execution.admitted.preparationId, tuple)).rejects.toThrow("render_input_invalid");
    const storageKey = await domain.planInputWrite(reference, execution.admitted.preparationId);
    await db.mediaCleanupObligation.updateMany({ where: { objectKey: storageKey }, data: { claimId: crypto.randomUUID(), claimExpiresAt: new Date(Date.now() + 60000) } });
    await expect(domain.adoptInput(reference, execution.admitted.preparationId, { ...tuple, storageKey })).rejects.toMatchObject({ code: "execution_object_deletion_admitted" });
    expect((await db.renderGroup.findUniqueOrThrow({ where: { id: reference.subject.id } })).inputStorageKey).toBeNull();
    const next = await domain.planInputWrite(reference, execution.admitted.preparationId);
    expect(next).not.toBe(storageKey);
    expect(await domain.adoptInput(reference, execution.admitted.preparationId, { ...tuple, storageKey: next })).toEqual({ ...tuple, storageKey: next });
  });

  test("a failed preparation settles linked unstarted render members immediately without creating native history", async () => {
    const f = await fixture(), execution = await native(f);
    await execution.send({ action: "fail", fence: execution.fence, failureCode: "clip_preparation_failed", retryable: false });
    expect(await renderService(f).prepareExecution(f.references[0]!)).toEqual({ kind: "terminal" });
    expect(await db.renderGroup.findUniqueOrThrow({ where: { id: f.references[0]!.subject.id } })).toMatchObject({ status: "failed", chargedAttemptCount: 0, attemptToken: null });
    expect(await db.renderGroupExecution.count({ where: { groupId: f.references[0]!.subject.id } })).toBe(0);
    expect(await db.executionAttempt.count({ where: { dispatch: { subjectId: f.references[0]!.subject.id } } })).toBe(0);
  });

  test("render metadata grants include curated and current-workspace audio while refusing a foreign workspace reference", async () => {
    const f = await fixture(), foreign = await db.workspace.create({ data: { name: "Foreign audio owner", ownerUserId: f.user.id } });
    const curated = await db.audioAsset.create({ data: { kind: "sfx", title: "Curated", storageKey: `audio/${crypto.randomUUID()}`, durationSec: 1 } });
    const own = await db.audioAsset.create({ data: { kind: "sfx", title: "Current", storageKey: `audio/${crypto.randomUUID()}`, durationSec: 1, workspaceId: f.workspace.id } });
    const denied = await db.audioAsset.create({ data: { kind: "music", title: "Foreign", storageKey: `audio/${crypto.randomUUID()}`, durationSec: 1, workspaceId: foreign.id } });
    const document = editorDocumentSchema.parse({ ...documents.cases["solo-auto-vertical"].document, clipEndSec: 10,
      studioEdits: { ...documents.cases["solo-auto-vertical"].document.studioEdits, music: { assetId: denied.id }, sfx: [{ id: "curated", assetId: curated.id, startSec: 0 }, { id: "own", assetId: own.id, startSec: 1 }] } });
    await db.clip.update({ where: { id: f.clip.id }, data: encodeClipEditorDocumentForStorage(document, { durationSec: 20, wholeSource: false }) });
    const execution = await native(f);
    await execution.send(execution.commit(execution.preview)); await execution.send(execution.commit(execution.peaks)); await execution.send(execution.commit(execution.manifest));
    const ready = (await f.service.readReadyForGroup(f.references[0]!))!;
    const preparation = await decodeClipPreparationInput(f.objects.get(ready.input.storageKey)!, ready.input);
    const keys: string[] = [];
    const snapshot = await createRenderInputSnapshot(db, { pexelsConfigured: false, searchStock: async () => { throw new Error("No stock media"); },
      object: async key => { keys.push(key); return { storageKey: key, etag: '"audio"', byteLength: 1000 }; } })(f.references[0]!, preparation, ready);
    expect(snapshot.assets.audio.map(asset => asset.id).sort()).toEqual([own.id,curated.id].sort());
    expect(keys.sort()).toEqual([own.storageKey,curated.storageKey].sort());
    expect(JSON.stringify(snapshot.assets)).not.toContain(denied.storageKey);
    expect(snapshot.assets.audio.every(asset => asset.object.sha256 === undefined)).toBe(true);
  });

  test("SIGKILL after a current control commit preserves the sibling object and charged start, and a successor receives only the unsettled member", async () => {
    const f = await fixture(false, undefined, true), preparation = await native(f);
    await preparation.send(preparation.commit(preparation.preview));await preparation.send(preparation.commit(preparation.peaks));await preparation.send(preparation.commit(preparation.manifest));
    const service = renderService(f), admitted = await service.prepareExecution(f.references[0]!);
    if (admitted.kind !== "waiting") throw Error("Expected render admission");
    const execution = createRenderGroupExecution({ database: db, service, storage: createExecutionStorage({ accountId: "a".repeat(32), bucket: "fixture-render", accessKeyId: "fixture", secretAccessKey: "fixture" }),
      artifacts: { head: async () => ({ etag: '"render"', contentType: "video/mp4", byteLength: 1024n, sha256: "b".repeat(64) }), readJson: async () => { throw Error("Unexpected JSON"); } }, deliverWakes: async () => {} });
    const firstFence = { reference: admitted.deadline.reference, attemptToken: admitted.deadline.attemptToken, owner: crypto.randomUUID() };
    const send = (command: unknown) => execution.control.execute({ command, verifiedRequest: preparation.verified() });
    const packageFor = (fence: typeof firstFence) => execution.transfer.execute({ command: { action: "work-package", fence }, verifiedRequest: preparation.verified() });
    const program = `let stage='credential_guard',status=null;
try{if(process.env.DATABASE_URL||process.env.DIRECT_URL||process.env.PGPASSWORD||process.env.SERVERLESS_TEST_DATABASE_URL)throw Error();
stage='command_input';let raw='';for await(const chunk of process.stdin){raw+=chunk;if(raw.length>65536)throw Error();}
const input=JSON.parse(raw);stage='commit_request';const response=await fetch(input.url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input.command)});
status=response.status;stage='commit_ack';const result=await response.json();if(response.status!==200||result.disposition!=='committed')throw Error();
console.log(JSON.stringify(result));if(!input.exitAfterCommit)setInterval(()=>{},1000);
}catch{console.error(JSON.stringify({errorCode:'native_sibling_'+stage,status}));process.exitCode=1;}`;
    let endpointFence = firstFence, serverError: unknown;
    const secret = crypto.randomUUID();
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async request => {
      if (new URL(request.url).pathname !== `/${secret}`) return new Response(null, { status: 404 });
      try { const command = await request.json();if (JSON.stringify(command.fence) !== JSON.stringify(endpointFence) || command.action !== "commit-artifact") throw Error("Unexpected native command");return Response.json(await send(command)); }
      catch (error) { serverError = error;return Response.json({ disposition: "failed" }, { status: 500 }); }
    } });
    const children: ReturnType<typeof Bun.spawn>[] = [];
    const childFailure = async (child: ReturnType<typeof Bun.spawn>) => {
      const reader = (child.stderr as ReadableStream<Uint8Array>).getReader();let bytes = 0, stderr = "";
      try { while (true) { const item = await reader.read();if (item.done) break;bytes += item.value.byteLength;
        if (bytes > 8192) { child.kill("SIGKILL");break; } stderr += new TextDecoder().decode(item.value); } }
      finally { await reader.cancel().catch(() => {}); }
      let detail: Record<string, unknown> = { stderrBytes: bytes };
      try { const parsed = JSON.parse(stderr);if (/^native_sibling_[a-z_]{1,40}$/.test(parsed.errorCode) && (parsed.status === null || Number.isInteger(parsed.status) && parsed.status >= 100 && parsed.status <= 599)) detail = { ...detail, errorCode: parsed.errorCode, status: parsed.status }; } catch {}
      const code = serverError && typeof serverError === "object" && "code" in serverError ? serverError.code : null;
      if (typeof code === "string" && /^[a-z][a-z0-9_]{0,99}$/.test(code)) detail.controlErrorCode = code;
      return new Error(`Native sibling child failed: ${JSON.stringify({ ...detail, exitCode: await child.exited })}`);
    };
    try {
      await send({ action: "acquire", ...firstFence, leaseSeconds: 2 });
      const firstPackage = await packageFor(firstFence);if (firstPackage.disposition !== "work_package") throw Error("Expected package");
      const frozen = await service.loadInput(await db.executionAttempt.findUniqueOrThrow({ where: { attemptToken: firstFence.attemptToken } }));
      const outputs = firstPackage.outputs.filter(output => output.role === "render_variant");expect(outputs).toHaveLength(2);
      const commit = (fence: typeof firstFence, output: typeof outputs[number]) => {
        return { action: "commit-artifact", fence, artifact: { artifactId: output.artifactId, role: "render_variant", bindingHash: output.bindingHash,
          contentType: "video/mp4", byteLength: 1024, etag: '"render"', sha256: "b".repeat(64), renderVariant: { renderId: "", durationSec: 10, usedStockIds: [] } } };
      };
      const bindingOf = (renderId: string) => renderArtifactBindingHash({ inputHash: firstFence.reference.inputHash, renderId, role: "render_variant" });
      const ids = await Promise.all(frozen.variants.map(async variant => ({ id: variant.renderId, binding: await bindingOf(variant.renderId) })));
      const commandFor = (fence: typeof firstFence, output: typeof outputs[number]) => {
        const command = commit(fence, output);command.artifact.renderVariant.renderId = ids.find(row => row.binding === output.bindingHash)!.id;return command;
      };
      const child = Bun.spawn([process.execPath, "--no-env-file", "-e", program], { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { PATH: process.env.PATH! } });children.push(child);
      process.kill(child.pid!, 0);await send({ action: "process-start", fence: firstFence });
      child.stdin.write(JSON.stringify({ url: new URL(`/${secret}`, server.url).href, command: commandFor(firstFence, outputs[0]!), exitAfterCommit: false }));child.stdin.end();
      const reader = child.stdout.getReader();
      const first = await Promise.race([reader.read(), Bun.sleep(5000).then(() => { throw Error("Native sibling commit timed out"); })]);
      if (first.done) throw await childFailure(child);
      expect(JSON.parse(new TextDecoder().decode(first.value))).toMatchObject({ disposition: "committed", artifactId: outputs[0]!.artifactId });
      if (serverError) throw serverError;
      const keptId = ids.find(row => row.binding === outputs[0]!.bindingHash)!.id;
      const kept = await db.clipRender.findUniqueOrThrow({ where: { id: keptId } });expect(kept.status).toBe("completed");
      const old = await db.executionAttempt.findUniqueOrThrow({ where: { attemptToken: firstFence.attemptToken } });
      child.kill("SIGKILL");await child.exited;await reader.cancel().catch(() => {});
      await Bun.sleep(Math.max(0, old.leaseExpiresAt!.getTime() - Date.now()) + 50);
      await execution.control.expireDeadline({ deadline: { reference: firstFence.reference, attemptToken: firstFence.attemptToken, kind: "lease", observedDeadlineAt: old.leaseExpiresAt!.toISOString() }, deliveryId: crypto.randomUUID() });
      expect(await db.renderGroup.findUniqueOrThrow({ where: { id: frozen.groupId } })).toMatchObject({ status: "queued", chargedAttemptCount: 1, generation: 2 });
      expect(await db.clipRender.findUniqueOrThrow({ where: { id: keptId } })).toMatchObject({ status: "completed", storageKey: kept.storageKey, completedAt: kept.completedAt });
      const driver = await db.executionDispatch.findFirstOrThrow({ where: { subjectKind: "render_group", subjectId: frozen.groupId, generation: 2, kind: "operation_driver", wakeKind: null, deadlineKind: null } });
      const reference = (await readExecutionDispatch(db, driver.id))!.reference;
      let next = await service.prepareExecution(reference);
      if (next.kind === "sleep") { await Bun.sleep(Math.max(0, next.dueAt.getTime() - Date.now()) + 20);next = await service.prepareExecution(reference); }
      if (next.kind !== "waiting") throw Error("Expected successor");
      const nextFence = { reference: next.deadline.reference, attemptToken: next.deadline.attemptToken, owner: crypto.randomUUID() };endpointFence = nextFence;
      await send({ action: "acquire", ...nextFence, leaseSeconds: 120 });
      const successor = await packageFor(nextFence);if (successor.disposition !== "work_package") throw Error("Expected successor package");
      const remaining = successor.outputs.filter(output => output.role === "render_variant");expect(remaining).toHaveLength(1);expect(remaining[0]!.bindingHash).not.toBe(outputs[0]!.bindingHash);
      const replacement = Bun.spawn([process.execPath, "--no-env-file", "-e", program], { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { PATH: process.env.PATH! } });children.push(replacement);
      process.kill(replacement.pid!, 0);await send({ action: "process-start", fence: nextFence });
      replacement.stdin.write(JSON.stringify({ url: new URL(`/${secret}`, server.url).href, command: commandFor(nextFence, remaining[0]!), exitAfterCommit: true }));replacement.stdin.end();
      const reply = await new Response(replacement.stdout).text();if (!reply || await replacement.exited !== 0) throw await childFailure(replacement);
      const acknowledgement = JSON.parse(reply);if (serverError) throw serverError;
      expect(acknowledgement.renderGroup).toEqual({ status: "completed", requested: 2, succeeded: 2, failed: 0, superseded: 0 });
      expect(await db.renderGroup.findUniqueOrThrow({ where: { id: frozen.groupId } })).toMatchObject({ status: "completed", chargedAttemptCount: 2 });
      expect(await db.clipRender.findUniqueOrThrow({ where: { id: keptId } })).toMatchObject({ storageKey: kept.storageKey, completedAt: kept.completedAt });
      expect(await db.workflowRun.findUniqueOrThrow({ where: { id: f.run.id } })).toMatchObject({ attemptCount: 0, attemptId: null, leaseOwner: null });
    } finally { server.stop(true);for (const child of children) { if (child.exitCode === null) child.kill("SIGKILL");await child.exited; } }
  }, 60_000);

  async function renderPackageFixture(frozenExport = false, siblings = false, shortDeadline = false) {
    const f = await fixture(frozenExport, undefined, siblings);
    if (shortDeadline) await db.renderGroup.update({ where: { id: f.references[0]!.subject.id }, data: { operationDeadlineAt: new Date(Date.now() + 4000) } });
    const preparation = await native(f);
    await preparation.send(preparation.commit(preparation.preview)); await preparation.send(preparation.commit(preparation.peaks)); await preparation.send(preparation.commit(preparation.manifest));
    let duringRead: (() => Promise<void>) | undefined, reads = 0;
    const service = renderService(f, db, async () => { reads++; const action = duringRead; duringRead = undefined; await action?.(); });
    const admitted = await service.prepareExecution(f.references[0]!); if (admitted.kind !== "waiting") throw Error("Missing render admission");
    const storage = createExecutionStorage({ accountId: "a".repeat(32), bucket: "fixture-render", accessKeyId: "fixture", secretAccessKey: "fixture" });
    const execution = createRenderGroupExecution({ database: db, service, storage, artifacts: { head: async () => ({ etag: '"render"', contentType: "video/mp4", byteLength: 1024n, sha256: "b".repeat(64) }), readJson: async () => { throw Error("No result JSON requested"); } }, deliverWakes: async () => {} });
    const fence = { reference: admitted.deadline.reference, attemptToken: admitted.deadline.attemptToken, owner: crypto.randomUUID() };
    const send = (command: unknown) => execution.control.execute({ command, verifiedRequest: preparation.verified() });
    await send({ action: "acquire", ...fence, leaseSeconds: 120 }); reads = 0;
    return { f, preparation, service, execution, storage, fence, send, reads: () => reads,
      duringRead: (action: () => Promise<void>) => { duringRead = action; },
      package: (request = preparation.verified()) => execution.transfer.execute({ command: { action: "work-package", fence }, verifiedRequest: request }) };
  }

  for (const changed of ["cancelled", "lease", "deadline", "source", "source_key", "editor", "retention", "workspace", "attempt_sha", "group_sha", "group_etag", "group_size", "group_key", "epoch"] as const)
    test(`RenderGroup fences refuse ${changed} during capsule I/O without assigning outputs or extending history`, async () => {
      const r = await renderPackageFixture(), token = r.fence.attemptToken, groupId = r.fence.reference.subject.id;
      try {
        const original = await db.executionAttempt.findUniqueOrThrow({ where: { attemptToken: token } });
        const cleanupBefore = await db.mediaCleanupObligation.count(), request = r.preparation.verified();
        r.duringRead(async () => {
          if (changed === "cancelled") await db.executionAttempt.update({ where: { attemptToken: token }, data: { revokedAt: new Date() } });
          if (changed === "lease") await db.executionAttempt.update({ where: { attemptToken: token }, data: { leaseExpiresAt: new Date(0) } });
          if (changed === "deadline") await db.executionAttempt.update({ where: { attemptToken: token }, data: { operationDeadlineAt: new Date(0) } });
          if (changed === "source") await db.project.update({ where: { id: r.f.project.id }, data: { sourceRevision: { increment: 1 } } });
          if (changed === "source_key") await db.project.update({ where: { id: r.f.project.id }, data: { sourceStorageKey: "execution/replaced-source" } });
          if (changed === "editor") await db.clip.update({ where: { id: r.f.clip.id }, data: { editorRevision: { increment: 1 } } });
          if (changed === "retention") await db.project.update({ where: { id: r.f.project.id }, data: { expiresAt: new Date(0) } });
          if (changed === "workspace") await db.workspace.update({ where: { id: r.f.workspace.id }, data: { status: "restricted" } });
          if (changed === "attempt_sha") await db.executionAttempt.update({ where: { attemptToken: token }, data: { inputChecksumSha256: "b".repeat(64) } });
          if (changed.startsWith("group_")) await db.renderGroup.update({ where: { id: groupId }, data: changed === "group_sha" ? { inputChecksumSha256: "b".repeat(64) } : changed === "group_etag" ? { inputEtag: '"changed"' } : changed === "group_size" ? { inputByteLength: 1n } : { inputStorageKey: "projects/replaced.json" } });
          if (changed === "epoch") await db.executionEpoch.update({ where: { id: 1 }, data: { epoch: { increment: 1 } } });
        });
        if (changed === "deadline" || changed === "attempt_sha" || changed.startsWith("group_"))
          await expect(r.package(request)).rejects.toThrow(/immutable/);
        else await expect(r.package(request)).rejects.toMatchObject({ code: "authority_lost" });
        expect(await db.executionArtifact.count({ where: { attemptToken: token } })).toBe(0);
        expect(await db.mediaCleanupObligation.count()).toBe(cleanupBefore);
        expect(await db.executionInboxReceipt.findUnique({ where: { audience_deliveryId: { audience: "executor-control", deliveryId: request.metadata.deliveryId } } })).toBeNull();
        const after = await db.executionAttempt.findUniqueOrThrow({ where: { attemptToken: token } });
        expect(after.processStartedAt).toBeNull(); expect(after.owner).toBe(original.owner);
        expect(after.operationDeadlineAt).toEqual(original.operationDeadlineAt);
        expect((await db.renderGroup.findUniqueOrThrow({ where: { id: groupId } })).chargedAttemptCount).toBe(0);
      } finally { r.storage.close(); }
    });

  test("RenderGroup preload rejects wrong fences before I/O and the database refuses rewriting sealed tuples", async () => {
    const r = await renderPackageFixture();
    try {
      for (const [fence, code] of [[{ ...r.fence, owner: crypto.randomUUID() }, "authority_lost"], [{ ...r.fence, attemptToken: crypto.randomUUID() }, "invalid_reference"],
        [{ ...r.fence, reference: { ...r.fence.reference, subject: { kind: "render_group", id: "not-a-uuid" } } }, "invalid_reference"],
        [{ ...r.fence, reference: { ...r.fence.reference, kind: "operation_driver" } }, "invalid_reference"]] as const)
        await expect(r.execution.transfer.execute({ command: { action: "work-package", fence }, verifiedRequest: r.preparation.verified() })).rejects.toMatchObject({ code });
      await expect(r.execution.transfer.execute({ command: { action: "source-read", fence: r.fence, sourceId: "original" }, verifiedRequest: r.preparation.verified() })).rejects.toMatchObject({ code: "authority_lost" });
      await expect(Promise.resolve(db.executionAttempt.update({ where: { attemptToken: r.fence.attemptToken }, data: { inputByteLength: 16_777_217n } }))).rejects.toThrow(/immutable/);
      expect(r.reads()).toBe(0);
    } finally { r.storage.close(); }
  });

  test("RenderGroup refuses corrupt capsule bytes before a grant or assignment", async () => {
    const r = await renderPackageFixture();
    try {
      const attempt = await db.executionAttempt.findUniqueOrThrow({ where: { attemptToken: r.fence.attemptToken } });
      r.f.objects.set(attempt.inputStorageKey!, new Uint8Array([1, 2, 3]));
      await expect(r.package()).rejects.toThrow("render_input_invalid");
      expect(await db.executionArtifact.count({ where: { attemptToken: r.fence.attemptToken } })).toBe(0);
    } finally { r.storage.close(); }
  });

  test("a frozen RenderGroup export remains valid after a live edit during capsule I/O", async () => {
    const r = await renderPackageFixture(true);
    try {
      r.duringRead(async () => { await db.clip.update({ where: { id: r.f.clip.id }, data: { editorRevision: { increment: 1 } } }); });
      expect((await r.package()).disposition).toBe("work_package");
      expect((await db.renderGroup.findUniqueOrThrow({ where: { id: r.fence.reference.subject.id } })).chargedAttemptCount).toBe(0);
    } finally { r.storage.close(); }
  });

  test("RenderGroup rebinds the pending member set after a sibling commits during capsule I/O", async () => {
    const r = await renderPackageFixture(false, true);
    try {
      const first = await r.package(); if (first.disposition !== "work_package") throw Error("Missing package");
      const output = first.outputs.find(value => value.role === "render_variant")!;
      const input = await r.service.loadInput(await db.executionAttempt.findUniqueOrThrow({ where: { attemptToken: r.fence.attemptToken } }));
      let renderId = "";
      for (const variant of input.variants) if (await renderArtifactBindingHash({ inputHash: r.fence.reference.inputHash, renderId: variant.renderId, role: "render_variant" }) === output.bindingHash) renderId = variant.renderId;
      await r.send({ action: "process-start", fence: r.fence });
      r.duringRead(async () => { await r.send({ action: "commit-artifact", fence: r.fence, artifact: { artifactId: output.artifactId, role: output.role, bindingHash: output.bindingHash, contentType: "video/mp4", byteLength: 1024, etag: '"render"', sha256: "b".repeat(64), renderVariant: { renderId, durationSec: 10, usedStockIds: [] } } }); });
      const remaining = await r.package(); if (remaining.disposition !== "work_package") throw Error("Missing remaining package");
      expect(remaining.outputs.filter(value => value.role === "render_variant")).toHaveLength(1);
      expect(remaining.outputs.some(value => value.artifactId === output.artifactId)).toBe(false);
      expect((await db.clipRender.findUniqueOrThrow({ where: { id: renderId } })).status).toBe("completed");
      expect((await db.renderGroup.findUniqueOrThrow({ where: { id: r.fence.reference.subject.id } })).chargedAttemptCount).toBe(1);
    } finally { r.storage.close(); }
  });

  test("RenderGroup absolute deadline can expire during capsule I/O without being extended", async () => {
    const r = await renderPackageFixture(false, false, true);
    try {
      const before = await db.executionAttempt.findUniqueOrThrow({ where: { attemptToken: r.fence.attemptToken } });
      r.duringRead(async () => { await Bun.sleep(Math.max(0, before.operationDeadlineAt.getTime() - Date.now()) + 25); });
      await expect(r.package()).rejects.toMatchObject({ code: "authority_lost" });
      expect(await db.executionAttempt.findUniqueOrThrow({ where: { attemptToken: r.fence.attemptToken } })).toEqual(before);
      expect(await db.executionArtifact.count({ where: { attemptToken: r.fence.attemptToken } })).toBe(0);
    } finally { r.storage.close(); }
  });

  test("RenderGroup retention expiry during signing refuses the grant without another authority pass", async () => {
    const r = await renderPackageFixture();
    try {
      const expires = new Date(Date.now() + 2000);
      r.duringRead(async () => { await db.project.update({ where: { id: r.f.project.id }, data: { expiresAt: expires } }); });
      const before = await db.executionAttempt.findUniqueOrThrow({ where: { attemptToken: r.fence.attemptToken } });
      const cleanupBefore = await db.mediaCleanupObligation.count(), request = r.preparation.verified();
      const signSource = r.storage.signSource;
      r.storage.signSource = async (...args) => { const grant = await signSource(...args); await Bun.sleep(Math.max(0, expires.getTime() - Date.now()) + 25); return grant; };
      await expect(r.package(request)).rejects.toMatchObject({ code: "authority_lost" });
      expect(await db.executionArtifact.count({ where: { attemptToken: r.fence.attemptToken } })).toBe(0);
      expect(await db.mediaCleanupObligation.count()).toBe(cleanupBefore);
      expect(await db.executionInboxReceipt.findUnique({ where: { audience_deliveryId: { audience: "executor-control", deliveryId: request.metadata.deliveryId } } })).toBeNull();
      expect(await db.executionAttempt.findUniqueOrThrow({ where: { attemptToken: r.fence.attemptToken } })).toEqual(before);
    } finally { r.storage.close(); }
  });

  test("RenderGroup expiry during local signing rolls back assignments, cleanup and grant receipt", async () => {
    const r = await renderPackageFixture();
    try {
      const expires = new Date(Date.now() + 2000);
      await db.executionAttempt.update({ where: { attemptToken: r.fence.attemptToken }, data: { leaseExpiresAt: expires } });
      const before = await db.executionAttempt.findUniqueOrThrow({ where: { attemptToken: r.fence.attemptToken } });
      const cleanupBefore = await db.mediaCleanupObligation.count(), request = r.preparation.verified();
      const signSource = r.storage.signSource;
      r.storage.signSource = async (...args) => { const grant = await signSource(...args); await Bun.sleep(Math.max(0, expires.getTime() - Date.now()) + 25); return grant; };
      await expect(r.package(request)).rejects.toMatchObject({ code: "authority_lost" });
      expect(await db.executionArtifact.count({ where: { attemptToken: r.fence.attemptToken } })).toBe(0);
      expect(await db.mediaCleanupObligation.count()).toBe(cleanupBefore);
      expect(await db.executionInboxReceipt.findUnique({ where: { audience_deliveryId: { audience: "executor-control", deliveryId: request.metadata.deliveryId } } })).toBeNull();
      expect(await db.executionAttempt.findUniqueOrThrow({ where: { attemptToken: r.fence.attemptToken } })).toEqual(before);
    } finally { r.storage.close(); }
  });

  test("RenderGroup package grants use one final authority on one connection without holding locks across capsule reads", async () => {
    const f = await fixture(), preparation = await native(f);
    await preparation.send(preparation.commit(preparation.preview)); await preparation.send(preparation.commit(preparation.peaks)); await preparation.send(preparation.commit(preparation.manifest));
    const queries: string[] = [];
    const single = new PrismaClient({ adapter: new PrismaPg({ connectionString: url, max: 1 }, { schema: process.env.SERVERLESS_TEST_DATABASE_SCHEMA! }), transactionOptions: { maxWait: 1000, timeout: 3000 }, log: [{ emit: "event", level: "query" }] });
    single.$on("query", event => queries.push(event.query));
    const storage = createExecutionStorage({ accountId: "a".repeat(32), bucket: "fixture-render", accessKeyId: "fixture", secretAccessKey: "fixture" });
    let inspectRead = false, readCount = 0;
    const service = renderService(f, single, async () => {
      if (inspectRead) { readCount++; await single.$queryRaw`SELECT 1 AS outside_transaction`; }
    });
    try {
      const admitted = await service.prepareExecution(f.references[0]!); if (admitted.kind !== "waiting") throw Error("Missing render admission");
      const execution = createRenderGroupExecution({ database: single, service, storage, artifacts: { head: async () => { throw Error("Package grants cannot HEAD outputs"); }, readJson: async () => { throw Error("Package grants cannot read results"); } }, deliverWakes: async () => {} });
      const fence = { reference: admitted.deadline.reference, attemptToken: admitted.deadline.attemptToken, owner: crypto.randomUUID() };
      await execution.control.execute({ command: { action: "acquire", ...fence, leaseSeconds: 120 }, verifiedRequest: preparation.verified() });
      const before = await db.executionAttempt.findUniqueOrThrow({ where: { attemptToken: fence.attemptToken } });
      inspectRead = true; queries.length = 0;
      const command = { action: "work-package", fence };
      const request = preparation.verified();
      const first = await execution.transfer.execute({ command, verifiedRequest: request });
      const firstQueries = queries.length;
      // Count statements only: one inbox and two domain advisory locks.
      // Private query parameters never enter this observation.
      const advisoryLocks = queries.filter(query => query.includes("pg_advisory_xact_lock")).length;
      console.warn(JSON.stringify({ level: "info", message: "render_package_query_counts", total: firstQueries, advisoryLocks }));
      expect(firstQueries).toBeLessThanOrEqual(50);
      expect(queries.filter(query => query.includes('FROM "ExecutionEpoch"') && query.includes("FOR SHARE"))).toHaveLength(1);
      await expect(execution.transfer.execute({ command, verifiedRequest: { ...request, requestHash: "f".repeat(64) } })).rejects.toMatchObject({ code: "replay_conflict" });
      expect(readCount).toBe(1);
      queries.length = 0;
      const replay = await execution.transfer.execute({ command, verifiedRequest: request });
      const replayQueries = queries.length;
      expect(replay.disposition).toBe("work_package");
      if (first.disposition !== "work_package" || replay.disposition !== "work_package") throw Error("Missing replayed package");
      expect(replay.outputs).toEqual(first.outputs);
      const results = await Promise.all(Array.from({ length: 6 }, () => execution.transfer.execute({ command, verifiedRequest: preparation.verified() })));
      if (first.disposition !== "work_package") throw Error("Missing package");
      expect(results.every(result => result.disposition === "work_package" && JSON.stringify(result.outputs) === JSON.stringify(first.outputs))).toBe(true);
      expect(readCount).toBe(8);
      expect(await db.executionAttempt.findUniqueOrThrow({ where: { attemptToken: fence.attemptToken } })).toEqual(before);
      expect((await db.renderGroup.findUniqueOrThrow({ where: { id: fence.reference.subject.id } })).chargedAttemptCount).toBe(0);
      const sourceRead = { action: "source-read", fence, sourceId: "original" };
      await expect(execution.transfer.execute({ command: sourceRead, verifiedRequest: preparation.verified() })).rejects.toMatchObject({ code: "authority_lost" });
      expect(readCount).toBe(8);
      await execution.control.execute({ command: { action: "process-start", fence }, verifiedRequest: preparation.verified() });
      queries.length = 0;
      expect((await execution.transfer.execute({ command: sourceRead, verifiedRequest: preparation.verified() })).disposition).toBe("source_read");
      console.warn(JSON.stringify({ level: "info", message: "render_package_query_counts", firstWorkPackage: firstQueries, exactReplay: replayQueries, sourceRead: queries.length }));
      expect(queries.length).toBeLessThanOrEqual(36);
      expect(queries.filter(query => query.includes('FROM "ExecutionEpoch"') && query.includes("FOR SHARE"))).toHaveLength(1);
      expect((await db.renderGroup.findUniqueOrThrow({ where: { id: fence.reference.subject.id } })).chargedAttemptCount).toBe(1);
      expect((await db.executionAttempt.findUniqueOrThrow({ where: { attemptToken: fence.attemptToken } })).operationDeadlineAt).toEqual(before.operationDeadlineAt);
    } finally { storage.close(); await single.$disconnect(); }
  }, 30_000);

  test("the RenderGroup factory serves its frozen input and role-bound grants then commits the actual final group acknowledgement", async () => {
    const f = await fixture(), preparation = await native(f);
    await preparation.send(preparation.commit(preparation.preview)); await preparation.send(preparation.commit(preparation.peaks)); await preparation.send(preparation.commit(preparation.manifest));
    const service = renderService(f), admitted = await service.prepareExecution(f.references[0]!);
    if (admitted.kind !== "waiting") throw new Error("Expected render admission");
    const execution = createRenderGroupExecution({ database: db, service, storage: createExecutionStorage({ accountId: "a".repeat(32), bucket: "fixture-render", accessKeyId: "fixture", secretAccessKey: "fixture" }),
      artifacts: { head: async () => ({ etag: '"render"', contentType: "video/mp4", byteLength: 1024n, sha256: "b".repeat(64) }), readJson: async () => { throw new Error("No JSON artifact committed"); } },
      deliverWakes: async ids => { expect(await db.executionDispatch.count({ where: { id: { in: [...ids] } } })).toBe(ids.length); } });
    const fence = { reference: admitted.deadline.reference, attemptToken: admitted.deadline.attemptToken, owner: crypto.randomUUID() };
    expect(await execution.control.execute({ command: { action: "acquire", ...fence, leaseSeconds: 120 }, verifiedRequest: preparation.verified() })).toMatchObject({ disposition: "acquired" });
    const packageResult = await execution.transfer.execute({ command: { action: "work-package", fence }, verifiedRequest: preparation.verified() });
    if (packageResult.disposition !== "work_package") throw new Error("Expected a work package");
    expect(packageResult.functionName).toBe("render_group");
    expect(packageResult.input.kind).toBe("object");
    expect(packageResult.outputs.map(output => output.role).sort()).toEqual(["render_outcome","render_variant"]);
    expect(packageResult.sources.map(source => source.name)).toEqual(["original"]);
    const started = await execution.control.execute({ command: { action: "process-start", fence }, verifiedRequest: preparation.verified() });
    expect(started.disposition).toBe("started");
    const output = packageResult.outputs.find(output => output.role === "render_variant")!;
    const frozen = await service.loadInput(await db.executionAttempt.findUniqueOrThrow({ where: { attemptToken: fence.attemptToken } }));
    const committed = await execution.control.execute({ command: { action: "commit-artifact", fence, artifact: { artifactId: output.artifactId, role: output.role, contentType: "video/mp4", byteLength: 1024,
      bindingHash: output.bindingHash, etag: '"render"', sha256: "b".repeat(64), renderVariant: { renderId: frozen.variants[0]!.renderId, durationSec: 10, usedStockIds: [] } } }, verifiedRequest: preparation.verified() });
    expect(committed).toEqual({ disposition: "committed", artifactId: output.artifactId, renderGroup: { status: "completed", requested: 1, succeeded: 1, failed: 0, superseded: 0 } });
    expect(await db.renderGroup.findUniqueOrThrow({ where: { id: frozen.groupId } })).toMatchObject({ status: "completed", chargedAttemptCount: 1, attemptToken: null });
    expect(await db.workflowRun.findUniqueOrThrow({ where: { id: f.run.id } })).toMatchObject({ status: "waiting", attemptId: null, leaseOwner: null, attemptCount: 0 });
    expect(await db.renderGroupExecution.findUniqueOrThrow({ where: { token: fence.attemptToken } })).toMatchObject({ charged: true, analysisFingerprint: frozen.preparation.bindingHash, toolchainFingerprint: "e".repeat(64), result: "completed" });
  });
});
