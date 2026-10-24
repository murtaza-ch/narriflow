import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { buildCaptionedVideoContentPack, buildCaptionedVideoSettings, buildGenerationContentPack } from "@narriflow/validators";
import { createOperationStatusReader } from "./operation-status";

const url = process.env.INTEGRATION_TEST_DATABASE_URL;
const schema = process.env.INTEGRATION_TEST_DATABASE_SCHEMA;
const enabled = process.env.ALLOW_INTEGRATION_DB_TESTS === "1" && Boolean(url);
const db = enabled ? describe : describe.skip;
setDefaultTimeout(180_000);

db("Operation Status lineage", () => {
  let prisma: PrismaClient;
  let pool: Pool;
  let userId: string;
  let workspaceId: string;
  const reader = () => createOperationStatusReader(prisma);
  beforeAll(async () => {
    if (!url || !schema || !/^integration_test_[a-z0-9_]+$/.test(schema)) throw new Error("Operation Status tests require a disposable schema");
    pool = new Pool({ connectionString: url, max: 5 });
    if ((await pool.query("SELECT current_schema() AS schema")).rows[0]?.schema !== schema) throw new Error("Wrong disposable schema");
    prisma = new PrismaClient({ adapter: new PrismaPg(pool, { schema }) });
    userId = (await prisma.user.create({ data: { clerkId: `operation-status:${randomUUID()}` } })).id;
    workspaceId = (await prisma.workspace.create({ data: { name: "Operation Status", ownerUserId: userId, pricingTier: "business", members: { create: { userId, role: "owner" } } } })).id;
  });
  afterAll(async () => { await prisma?.$disconnect(); await pool?.end(); });

  async function project() {
    return prisma.project.create({ data: { workspaceId, createdByUserId: userId, title: "Lineage", sourceMediaUrl: "r2://source.mp4", ingestStatus: "ready" } });
  }
  async function sttRun(projectId: string, status: string) {
    const pack = await prisma.contentPack.create({ data: { projectId, ...buildGenerationContentPack() } });
    return prisma.workflowRun.create({ data: { projectId, contentPackId: pack.id, stage: "stt", status, idempotencyKey: randomUUID() } });
  }
  const read = (kind: "intake" | "generation" | "export", id: string) => reader().read({ workspaceId }, { kind, id });

  test("a link intake reports import, then follows only the generation run it handed off to", async () => {
    const { id: projectId } = await project();
    const job = await prisma.ingestJob.create({ data: { projectId, jobType: "link_import", payload: {}, status: "running", claimId: randomUUID(), claimExpiresAt: new Date(Date.now() + 60_000), startedAt: new Date() } });
    expect(await read("intake", job.id)).toMatchObject({ state: "working", stage: "importing", results: { projectId } });
    await prisma.ingestJob.update({ where: { id: job.id }, data: { status: "completed", completedAt: new Date(), claimId: null, claimExpiresAt: null } });
    expect(await read("intake", job.id)).toMatchObject({ state: "working", stage: "awaiting_generation" });

    const handedOff = await sttRun(projectId, "running");
    await prisma.ingestJob.update({ where: { id: job.id }, data: { generationHandoffAt: new Date(), generationRunId: handedOff.id } });
    // A later regeneration that already failed must not stand in for this intake.
    const regeneration = await sttRun(projectId, "failed");
    expect(await read("intake", job.id)).toMatchObject({ kind: "intake", id: job.id, state: "working", stage: "transcribing" });
    expect(await read("generation", regeneration.id)).toMatchObject({ state: "failed" });

    await prisma.workflowRun.update({ where: { id: handedOff.id }, data: { status: "failed", errorCode: "transcription_failed" } });
    expect(await read("intake", job.id)).toMatchObject({ state: "failed", failureCode: "transcription_failed" });
  });

  test("an upload intake reports verification and pre-handoff failure before any Project exists", async () => {
    const sessionId = randomUUID();
    const preallocatedProjectId = randomUUID();
    await prisma.uploadSession.create({ data: { id: sessionId, workspaceId, actorUserId: userId, clientIdempotencyKey: randomUUID(), immutableInputFingerprint: "fixture",
      preallocatedProjectId, title: "Upload", fileName: "upload.mp4", fileSizeBytes: BigInt(10), contentType: "video/mp4", browserFingerprint: "fixture",
      generationSettings: {}, transferKind: "single", storageKey: `uploads/${sessionId}.mp4`, status: "reconciling",
      expiresAt: new Date(Date.now() + 3_600_000), hardExpiresAt: new Date(Date.now() + 7_200_000) } });
    expect(await read("intake", sessionId)).toMatchObject({ state: "working", stage: "verifying", results: { projectId: null } });
    await prisma.uploadSession.update({ where: { id: sessionId }, data: { status: "failed", failureCode: "upload_size_mismatch" } });
    expect(await read("intake", sessionId)).toMatchObject({ state: "failed", failureCode: "upload_size_mismatch" });
    // An accepted upload whose Project (and so its Ingest Job) was deleted is unavailable, not working.
    await prisma.uploadSession.update({ where: { id: sessionId }, data: { status: "queued_for_ingest", failureCode: null } });
    await expect(read("intake", sessionId)).rejects.toMatchObject({ code: "operation_not_found" });
    expect(await reader().readTrusted({ workspaceId }, { kind: "intake", id: sessionId })).toEqual({ kind: "intake", id: sessionId, state: "unavailable" });
  });

  test("a handed-off intake whose generation run was deleted is unavailable", async () => {
    const { id: projectId } = await project();
    const run = await sttRun(projectId, "queued");
    const job = await prisma.ingestJob.create({ data: { projectId, jobType: "link_import", payload: {}, status: "completed", completedAt: new Date(), generationHandoffAt: new Date(), generationRunId: run.id } });
    expect(await read("intake", job.id)).toMatchObject({ state: "working", stage: "transcribing" });
    await prisma.workflowRun.delete({ where: { id: run.id } });
    expect(await reader().readTrusted({ workspaceId }, { kind: "intake", id: job.id })).toEqual({ kind: "intake", id: job.id, state: "unavailable" });
  });

  test("an export reports mixed variants and a missing artifact per format", async () => {
    const { id: projectId } = await project();
    const detection = await prisma.workflowRun.create({ data: { projectId, stage: "moment_detection", status: "completed", idempotencyKey: randomUUID() } });
    const clip = await prisma.clip.create({ data: { projectId, workflowRunId: detection.id, index: 0, startSec: 0, endSec: 30, hookText: "Hook", reasoning: "Test", category: "story",
      transcriptSlice: [], viralityScore: 50, hookStrengthScore: 50, emotionalIntensityScore: 50, pacingScore: 50, durationOptimalityScore: 50,
      tiktokScore: 50, youtubeScore: 50, instagramScore: 50, llmProvider: "test", llmModel: "test" } });
    const exported = await prisma.clipExport.create({ data: { projectId, workspaceId, clipId: clip.id, editorRevision: 0, fingerprint: randomUUID(), resolution: "720p", watermark: true,
      status: "partial_ready", progress: 100, variants: { create: [
        { aspectRatio: "ratio_9_16", resolution: "720p", watermark: true, status: "completed", storageKey: "projects/x/a.mp4" },
        { aspectRatio: "ratio_1_1", resolution: "720p", watermark: true, status: "failed", errorCode: "render_failed" },
        { aspectRatio: "ratio_16_9", resolution: "720p", watermark: true, status: "completed", storageKey: null },
      ] } }, include: { variants: { orderBy: { createdAt: "asc" } } } });
    const status = await read("export", exported.id);
    expect(status).toMatchObject({ state: "partial", results: { projectId, clipIds: [clip.id], exportId: exported.id } });
    expect(status.items.map((item) => [item.state, item.failureCode]).sort()).toEqual([["completed", null], ["failed", "export_file_missing"], ["failed", "render_failed"]]);
  });

  describe("a captioned video", () => {
    const probe = { durationSec: 8, video: { width: 1920, height: 1080, frameRate: { numerator: 24, denominator: 1 }, startTimecode: null }, audio: null };
    async function captioned(framing: "fit" | "center") {
      const created = await prisma.project.create({ data: { workspaceId, createdByUserId: userId, title: "Captioned", sourceMediaUrl: "r2://source.mp4", ingestStatus: "ready", sourceDurationSeconds: 8, sourceProbe: probe } });
      const settings = buildCaptionedVideoSettings({ framing, aspectRatios: ["9:16", "1:1"], captions: { source: "none" } });
      const pack = await prisma.contentPack.create({ data: { projectId: created.id, ...buildCaptionedVideoContentPack(settings) } });
      const origin = await prisma.workflowRun.create({ data: { projectId: created.id, contentPackId: pack.id, stage: "stt", status: "completed", idempotencyKey: randomUUID() } });
      const detection = await prisma.workflowRun.create({ data: { projectId: created.id, contentPackId: pack.id, stage: "moment_detection", status: "completed", idempotencyKey: `${origin.idempotencyKey}__moment_detection` } });
      const clip = await prisma.clip.create({ data: { projectId: created.id, workflowRunId: detection.id, index: 0, startSec: 0, endSec: 8, wholeSource: true, hookText: "Captioned", reasoning: "Test", category: "story",
        transcriptSlice: [], viralityScore: 1, hookStrengthScore: 1, emotionalIntensityScore: 1, pacingScore: 1, durationOptimalityScore: 1, tiktokScore: 1, youtubeScore: 1, instagramScore: 1, llmProvider: "test", llmModel: "test" } });
      return { projectId: created.id, origin, detection, clip };
    }
    /** The detection run's durable record, as the lifecycle appends it: the export frozen at
     * completion, then (once) the outcome the export first ended as. */
    let eventSeq = 0;
    const record = (projectId: string, detectionId: string, extra: Record<string, unknown>) => {
      eventSeq += 1;
      const emittedAt = new Date().toISOString();
      return prisma.workflowEvent.create({ data: { projectId, workflowRunId: detectionId, seq: eventSeq, stage: "moment_detection", status: "completed", progress: 100, emittedAt: new Date(), dedupeKey: randomUUID(),
        payload: { event: "workflow.stage.updated", projectId, workflowRunId: detectionId, seq: eventSeq, stage: "moment_detection", status: "completed", progress: 100, errorCode: null, emittedAt, ...extra } as never } });
    };
    const freeze = (projectId: string, detectionId: string, exportId: string, clipId: string) => record(projectId, detectionId, { generationExport: { exportId, clipId } });
    const exportFor = (projectId: string, clipId: string, status: string, variants: Array<{ aspectRatio: "ratio_9_16" | "ratio_1_1"; status: string; storageKey?: string | null; errorCode?: string }>) =>
      prisma.clipExport.create({ data: { projectId, workspaceId, clipId, editorRevision: 0, fingerprint: randomUUID(), resolution: "1080p", watermark: false, status: status as never, progress: status === "ready" ? 100 : 20,
        variants: { create: variants.map((variant) => ({ resolution: "1080p", watermark: false, ...variant, status: variant.status as never })) } } });

    test("is not done until its export is, and names the export", async () => {
      const { origin, detection, projectId, clip } = await captioned("fit");
      expect(await read("generation", origin.id)).toMatchObject({ state: "failed", failureCode: "export_unavailable", results: { projectId, clipIds: [clip.id], exportId: null } });
      const exported = await exportFor(projectId, clip.id, "rendering", [{ aspectRatio: "ratio_9_16", status: "completed", storageKey: "projects/x/a.mp4" }, { aspectRatio: "ratio_1_1", status: "rendering" }]);
      await freeze(projectId, detection.id, exported.id, clip.id);
      expect(await read("generation", origin.id)).toMatchObject({ state: "working", stage: "rendering", results: { projectId, clipIds: [clip.id], exportId: exported.id },
        items: [{ kind: "variant", state: "completed" }, { kind: "variant", state: "working" }] });
      await prisma.clipExport.update({ where: { id: exported.id }, data: { status: "ready", progress: 100 } });
      await prisma.clipExportVariant.updateMany({ where: { exportId: exported.id, aspectRatio: "ratio_1_1" }, data: { status: "completed", storageKey: "projects/x/b.mp4" } });
      expect(await read("generation", origin.id)).toMatchObject({ state: "completed", progress: 1, results: { exportId: exported.id }, failureCode: null });
    });

    test("an intake follows it to the export, and a failed format makes it partial", async () => {
      const { origin, detection, projectId, clip } = await captioned("fit");
      const job = await prisma.ingestJob.create({ data: { projectId, jobType: "link_import", payload: {}, status: "completed", completedAt: new Date(), generationHandoffAt: new Date(), generationRunId: origin.id } });
      const exported = await exportFor(projectId, clip.id, "partial_ready", [{ aspectRatio: "ratio_9_16", status: "completed", storageKey: "projects/x/a.mp4" }, { aspectRatio: "ratio_1_1", status: "failed", errorCode: "render_failed" }]);
      await freeze(projectId, detection.id, exported.id, clip.id);
      expect(await read("intake", job.id)).toMatchObject({ kind: "intake", state: "partial", failureCode: "render_failed", results: { exportId: exported.id } });
    });

    test("an export the person makes later never stands in for the video's own", async () => {
      const { origin, detection, projectId, clip } = await captioned("fit");
      const first = await exportFor(projectId, clip.id, "rendering", [{ aspectRatio: "ratio_9_16", status: "rendering" }]);
      await freeze(projectId, detection.id, first.id, clip.id);
      await exportFor(projectId, clip.id, "ready", [{ aspectRatio: "ratio_1_1", status: "completed", storageKey: "projects/x/later.mp4" }]);
      expect(await read("generation", origin.id)).toMatchObject({ state: "working", results: { exportId: first.id } });
    });

    test("once its export has ended, a retry or a deletion of the export leaves the generation as it reported", async () => {
      const { origin, detection, projectId, clip } = await captioned("fit");
      const exported = await exportFor(projectId, clip.id, "failed", [{ aspectRatio: "ratio_9_16", status: "failed", errorCode: "render_failed" }, { aspectRatio: "ratio_1_1", status: "failed", errorCode: "render_failed" }]);
      await freeze(projectId, detection.id, exported.id, clip.id);
      const variants = await prisma.clipExportVariant.findMany({ where: { exportId: exported.id }, orderBy: { aspectRatio: "asc" } });
      // The first final outcome is recorded on the detection run, as the lifecycle does when the export ends.
      await record(projectId, detection.id, { generationExportResult: { exportId: exported.id, state: "failed", failureCode: "render_failed",
        items: variants.map((variant) => ({ id: variant.id, state: "failed", failureCode: "render_failed" })) } });
      const reported = await read("generation", origin.id);
      expect(reported).toMatchObject({ state: "failed", failureCode: "render_failed", results: { exportId: exported.id }, items: [{ kind: "variant", state: "failed" }, { kind: "variant", state: "failed" }] });

      // A retry that succeeds updates the export, not what the generation reported.
      await prisma.clipExport.update({ where: { id: exported.id }, data: { status: "ready", progress: 100, errorCode: null } });
      await prisma.clipExportVariant.updateMany({ where: { exportId: exported.id }, data: { status: "completed", storageKey: "projects/x/retry.mp4", errorCode: null } });
      expect(await read("export", exported.id)).toMatchObject({ state: "completed" });
      expect(await read("generation", origin.id)).toEqual(reported);

      // Deleting the export (its clip, or the person) doesn't flip it either, and it still names the export.
      await prisma.clipExport.delete({ where: { id: exported.id } });
      expect(await read("generation", origin.id)).toEqual(reported);
    });

    test("an export deleted before it ended leaves the generation failed, still naming it", async () => {
      const { origin, detection, projectId, clip } = await captioned("fit");
      const exported = await exportFor(projectId, clip.id, "rendering", [{ aspectRatio: "ratio_9_16", status: "rendering" }]);
      await freeze(projectId, detection.id, exported.id, clip.id);
      await prisma.clipExport.delete({ where: { id: exported.id } });
      expect(await read("generation", origin.id)).toMatchObject({ state: "failed", failureCode: "export_unavailable", results: { exportId: exported.id } });
    });

    test("Center reports where it crops the frame, Fit reports nothing, and a clip-mode generation has no notices", async () => {
      const center = await captioned("center");
      expect(await read("generation", center.origin.id)).toMatchObject({ notices: [{ code: "framing_degraded", aspectRatio: "9:16", croppedPercent: 68 }, { code: "framing_degraded", aspectRatio: "1:1", croppedPercent: 44 }] });
      const fit = await captioned("fit");
      expect((await read("generation", fit.origin.id)).notices).toEqual([]);
      const { id: projectId } = await project();
      expect((await read("generation", (await sttRun(projectId, "running")).id)).notices).toEqual([]);
    });
  });

  test("work in another Workspace is concealed, and trusted reads report deleted lineage as unavailable", async () => {
    const { id: projectId } = await project();
    const run = await sttRun(projectId, "queued");
    await expect(reader().read({ workspaceId: randomUUID() }, { kind: "generation", id: run.id })).rejects.toMatchObject({ code: "operation_not_found" });
    await prisma.project.update({ where: { id: projectId }, data: { expiresAt: new Date(Date.now() - 1_000) } });
    await expect(read("generation", run.id)).rejects.toMatchObject({ code: "operation_not_found" });
    expect(await reader().readTrusted({ workspaceId }, { kind: "generation", id: run.id })).toEqual({ kind: "generation", id: run.id, state: "unavailable" });
  });
});
