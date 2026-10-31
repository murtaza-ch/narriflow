import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { appendExecutionDispatch, readExecutionDispatch } from "./execution-dispatch";
import { ThumbnailFrameExecution } from "./thumbnail-frame-execution";
import { createExecutorControl } from "./executor-control";

const url = process.env.SERVERLESS_TEST_DATABASE_URL;
const dbDescribe = process.env.ALLOW_SERVERLESS_DB_TESTS === "1" && url ? describe : describe.skip;
dbDescribe("Targeted thumbnail validation", () => {
  let db: PrismaClient;
  const users: string[] = [], subjects: string[] = [], receipts: string[] = [];
  beforeAll(() => {
    if (!url || new URL(url).hostname !== "ep-wispy-field-b5wyn9o3.c-7.us-east-2.aws.neon.tech") throw new Error("Only isolated serverless gate branch is allowed");
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url, max: 4 }), transactionOptions: { timeout: 60_000 } });
  });
  afterAll(async () => {
    const ids = (await db.executionDispatch.findMany({ where: { subjectId: { in: subjects } }, select: { id: true } })).map(row => row.id);
    await db.executionInboxReceipt.deleteMany({ where: { deliveryId: { in: receipts } } });
    await db.executionArtifact.deleteMany({ where: { attempt: { dispatchId: { in: ids } } } });
    await db.executionAttempt.deleteMany({ where: { dispatchId: { in: ids } } });
    await db.executionDispatch.deleteMany({ where: { id: { in: ids } } });
    await db.workspace.deleteMany({ where: { ownerUserId: { in: users } } });
    await db.visualAsset.deleteMany({ where: { createdByUserId: { in: users } } });
    await db.user.deleteMany({ where: { id: { in: users } } }); await db.$disconnect();
  }, 60_000);
  async function fixture() {
    const user = await db.user.create({ data: { clerkId: `thumbnail-execution:${crypto.randomUUID()}` } }); users.push(user.id);
    const workspace = await db.workspace.create({ data: { name: "Thumbnail gate", ownerUserId: user.id, pricingTier: "business" } });
    const project = await db.project.create({ data: { workspaceId: workspace.id, title: "Thumbnail gate", sourceMediaUrl: "r2://gate/source", ingestStatus: "ready" } });
    const run = await db.workflowRun.create({ data: { projectId: project.id, stage: "clip_rendering", status: "completed", idempotencyKey: crypto.randomUUID() } });
    const clip = await db.clip.create({ data: { workflowRunId: run.id, projectId: project.id, index: 0, startSec: 0, endSec: 10, hookText: "gate", reasoning: "gate", category: "hook", transcriptSlice: [], viralityScore: 50, hookStrengthScore: 50, emotionalIntensityScore: 50, pacingScore: 50, durationOptimalityScore: 50, tiktokScore: 50, youtubeScore: 50, instagramScore: 50, llmProvider: "gate", llmModel: "gate", editorRevision: 1 } });
    const sourceSubject = crypto.randomUUID(); subjects.push(sourceSubject);
    const epoch = (await db.executionEpoch.findUniqueOrThrow({ where: { id: 1 } })).epoch;
    const sourceDispatch = await db.$transaction(tx => appendExecutionDispatch(tx, { deploymentEpoch: epoch, generation: 1, kind: "modal_execution", subject: { kind: "render_group", id: sourceSubject }, inputHash: "a".repeat(64), dueAt: new Date() }));
    const sourceToken = crypto.randomUUID(), sourceOwner = crypto.randomUUID();
    await db.executionAttempt.create({ data: { attemptToken: sourceToken, dispatchId: sourceDispatch.reference.dispatchId, deploymentEpoch: epoch, generation: 1, inputHash: "a".repeat(64), functionName: "render_group", status: "completed", operationDeadlineAt: new Date(Date.now() + 60_000), finishedAt: new Date() } });
    const storageKey = `execution/${epoch}/${sourceToken}/${sourceOwner}/source.mp4`;
    await db.executionArtifact.create({ data: { attemptToken: sourceToken, owner: sourceOwner, role: "render_variant", storageKey, contentType: "video/mp4", maxBytes: 1024n, byteLength: 1024n, etag: '"source"', checksumSha256: "b".repeat(64), bindingHash: "a".repeat(64), grantExpiresAt: new Date(Date.now() + 60_000), committedAt: new Date() } });
    const exported = await db.clipExport.create({ data: { projectId: project.id, workspaceId: workspace.id, clipId: clip.id, editorRevision: 1, fingerprint: "c".repeat(64), resolution: "1080p", watermark: false, status: "ready", variants: { create: { aspectRatio: "ratio_9_16", resolution: "1080p", watermark: false, status: "completed", storageKey, sizeBytes: 1024n, durationSec: 10 } } }, include: { variants: true } });
    const registered: string[] = [];
    const service = new ThumbnailFrameExecution(db, { register: async ids => { registered.push(...ids); }, head: async () => ({ contentType: "video/mp4", sizeBytes: 1024, etag: '"source"' }) });
    return { service, registered, input: { actorUserId: user.id, workspaceId: workspace.id, projectId: project.id, clipId: clip.id, exportVariantId: exported.variants[0]!.id, sourceTimeMs: 2500, idempotencyKey: crypto.randomUUID() } };
  }
  test("admission freezes one completed export/frame and registers pending execution without making a visual asset", async () => {
    const f = await fixture(); const opened = await f.service.request(f.input); subjects.push(opened.id);
    expect(opened.status).toBe("queued"); expect(opened.asset).toBeNull(); expect(f.registered).toHaveLength(1);
    const replay = await f.service.request({ ...f.input, idempotencyKey: crypto.randomUUID() });
    expect(replay.id).toBe(opened.id); expect(replay.replayed).toBe(true);
    await expect(f.service.request({ ...f.input, sourceTimeMs: 10000, idempotencyKey: crypto.randomUUID() })).rejects.toMatchObject({ code: "thumbnail_frame_time_invalid" });
    expect(await db.visualAsset.count({ where: { workspaceId: f.input.workspaceId } })).toBe(0);
  }, 180_000);
  test("metadata arriving before its binary cannot publish; one live started owner completes the thumbnail", async () => {
    const f = await fixture(); const opened = await f.service.request(f.input); subjects.push(opened.id);
    const planned = await f.service.prepareExecution((await readExecutionDispatch(db, f.registered[0]!))!.reference);
    if (planned.kind !== "waiting") throw new Error("Expected targeted thumbnail execution");
    const { reference, attemptToken } = planned.deadline; const owner = crypto.randomUUID(); const fence = { reference, attemptToken, owner };
    const evidence = { kind: "thumbnail" as const, sha256: "d".repeat(64), byteLength: 1234, contentType: "image/jpeg" as const, mediaKind: "image" as const, width: 1080, height: 1920, durationSec: null };
    const control = createExecutorControl({ database: db, subjectKind: "thumbnail_frame", domain: f.service, deliverWakes: async () => {}, artifacts: {
      head: async assignment => ({ etag: '"sealed"', contentType: assignment.contentType, byteLength: assignment.role === "probe" ? 512n : 1234n, sha256: assignment.role === "probe" ? "c".repeat(64) : "d".repeat(64) }),
      prepare: async (_assignment, artifact) => ({ ...artifact, ...(artifact.role === "probe" ? { evidence } : {}) }),
    } });
    function verified() { const deliveryId = crypto.randomUUID(); receipts.push(deliveryId); return { requestHash: crypto.randomUUID().replaceAll("-", "").repeat(2), metadata: { version: 1 as const, keyId: "thumbnail-gate", audience: "executor-control" as const, method: "POST" as const, canonicalTarget: "/api/execution/command", bodySha256: "0".repeat(64), timestamp: Math.floor(Date.now() / 1000), deliveryId, signature: "0".repeat(64) } }; }
    const execute = (command: unknown) => control.execute({ command, verifiedRequest: verified() });
    expect((await execute({ action: "acquire", reference, attemptToken, owner, leaseSeconds: 120 })).disposition).toBe("acquired");
    expect((await execute({ action: "acquire", reference, attemptToken, owner: crypto.randomUUID(), leaseSeconds: 120 })).disposition).toBe("busy");
    expect((await f.service.workInput(opened.id)).command).toMatchObject({ kind: "thumbnail", sourceTimeMs: 2500, expected: { sha256: "b".repeat(64) } });
    await execute({ action: "process-start", fence }); await execute({ action: "process-start", fence });
    expect((await f.service.get(f.input.workspaceId, f.input.projectId, opened.id)).attempt).toBe(1);
    const metadata = await db.executionArtifact.create({ data: { attemptToken, owner, role: "probe", storageKey: `execution/${reference.deploymentEpoch}/${attemptToken}/${owner}/validation.json`, contentType: "application/json", maxBytes: 65536n, bindingHash: reference.inputHash, grantExpiresAt: new Date(Date.now() + 120_000) } });
    const binary = await db.executionArtifact.create({ data: { attemptToken, owner, role: "thumbnail", storageKey: `execution/${reference.deploymentEpoch}/${attemptToken}/${owner}/frame.jpg`, contentType: "image/jpeg", maxBytes: 20n * 1024n ** 2n, bindingHash: reference.inputHash, grantExpiresAt: new Date(Date.now() + 120_000) } });
    const metadataRequest = verified();
    const metadataCommand = { action: "commit-artifact", fence, artifact: { artifactId: metadata.id, role: "probe", contentType: "application/json", byteLength: 512, sha256: "c".repeat(64), etag: '"sealed"', bindingHash: reference.inputHash } };
    await control.execute({ command: metadataCommand, verifiedRequest: metadataRequest });
    expect((await f.service.get(f.input.workspaceId, f.input.projectId, opened.id)).asset).toBeNull();
    expect(await db.visualAsset.count({ where: { workspaceId: f.input.workspaceId } })).toBe(0);
    const binaryRequest = verified();
    const binaryCommand = { action: "commit-artifact", fence, artifact: { artifactId: binary.id, role: "thumbnail", contentType: "image/jpeg", byteLength: 1234, sha256: "d".repeat(64), etag: '"sealed"', bindingHash: reference.inputHash } };
    await control.execute({ command: binaryCommand, verifiedRequest: binaryRequest });
    const completed = await f.service.get(f.input.workspaceId, f.input.projectId, opened.id);
    expect(completed).toMatchObject({ status: "completed", asset: { fingerprint: "d".repeat(64) }, attempt: 1 });
    const asset = await db.visualAsset.findUniqueOrThrow({ where: { id: completed.asset!.id } });
    expect(asset.storageKey).toBe(binary.storageKey); expect(asset.provenance).toBe("extracted_frame");
    expect((await control.execute({ command: binaryCommand, verifiedRequest: binaryRequest })).disposition).toBe("committed");
  }, 240_000);
});
