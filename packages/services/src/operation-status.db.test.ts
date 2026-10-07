import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { buildMcpContentPack } from "@narriflow/validators";
import { createOperationStatusReader } from "./operation-status";

const url = process.env.MCP_TEST_DATABASE_URL;
const schema = process.env.MCP_TEST_DATABASE_SCHEMA;
const enabled = process.env.ALLOW_MCP_DB_TESTS === "1" && Boolean(url);
const db = enabled ? describe : describe.skip;
setDefaultTimeout(180_000);

db("Operation Status lineage", () => {
  let prisma: PrismaClient;
  let pool: Pool;
  let userId: string;
  let workspaceId: string;
  const reader = () => createOperationStatusReader(prisma);
  beforeAll(async () => {
    if (!url || !schema || !/^mcp_test_[a-z0-9_]+$/.test(schema)) throw new Error("Operation Status tests require a disposable schema");
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
    const pack = await prisma.contentPack.create({ data: { projectId, ...buildMcpContentPack() } });
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

  test("work in another Workspace is concealed, and trusted reads report deleted lineage as unavailable", async () => {
    const { id: projectId } = await project();
    const run = await sttRun(projectId, "queued");
    await expect(reader().read({ workspaceId: randomUUID() }, { kind: "generation", id: run.id })).rejects.toMatchObject({ code: "operation_not_found" });
    await prisma.project.update({ where: { id: projectId }, data: { expiresAt: new Date(Date.now() - 1_000) } });
    await expect(read("generation", run.id)).rejects.toMatchObject({ code: "operation_not_found" });
    expect(await reader().readTrusted({ workspaceId }, { kind: "generation", id: run.id })).toEqual({ kind: "generation", id: run.id, state: "unavailable" });
  });
});
