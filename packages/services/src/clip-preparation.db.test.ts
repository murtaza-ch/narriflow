import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { editorDocumentSchema } from "@narriflow/validators";
import documents from "../../../apps/media/src/__fixtures__/render-golden/documents.json";
import { assertExecutionDatabaseTestTarget } from "./execution-db-test-support";
import { appendExecutionDispatch } from "./execution-dispatch";
import { renderGroupExportIdentity } from "./render-group-contract";
import { encodeClipEditorDocumentForStorage } from "./clip-editor-document-persistence";
import { ClipPreparationService } from "./clip-preparation";
import { decodeClipPreparationInput } from "./clip-preparation-input";
import { executionInputRetainUntil } from "./media-cleanup";

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

  async function fixture() {
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
      const variant = await db.clipRender.create({ data: { clipId: clip.id, workflowRunId: run.id, editorRevision: clip.editorRevision, aspectRatio: resolution === "720p" ? "ratio_9_16" : "ratio_16_9", resolution } });
      const group = await db.renderGroup.create({ data: { workflowRunId: run.id, workSetGeneration, clipId: clip.id, deploymentEpoch: epoch,
        exportIdentity: renderGroupExportIdentity({ clipId: clip.id, exportId: null, editorRevision: clip.editorRevision, resolution, watermark: true }), members: { create: { clipRenderId: variant.id } } } });
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
});
