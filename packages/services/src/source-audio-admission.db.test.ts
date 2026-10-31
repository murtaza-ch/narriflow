import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { ProcessingUsage } from "./processing-usage";

const url = process.env.SERVERLESS_TEST_DATABASE_URL;
const dbDescribe = process.env.ALLOW_SOURCE_AUDIO_DB_TESTS === "1" && url ? describe : describe.skip;

dbDescribe("Source Audio Processing Usage admission", () => {
  let db: PrismaClient;
  const users: string[] = [], projects: string[] = [];
  beforeAll(() => {
    if (!url || new URL(url).hostname !== "ep-wispy-field-b5wyn9o3.c-7.us-east-2.aws.neon.tech") throw new Error("Source admission gates require the isolated branch");
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url, max: 5 }), transactionOptions: { maxWait: 10_000, timeout: 30_000 } });
  });
  afterAll(async () => {
    await db.sourceRefundNeed.deleteMany({ where: { projectId: { in: projects } } });
    await db.workspace.deleteMany({ where: { ownerUserId: { in: users } } });
    await db.user.deleteMany({ where: { id: { in: users } } });
    await db.$disconnect();
  });
  async function fixture(seconds = 60.01) {
    const user = await db.user.create({ data: { clerkId: `audio-admission-gate:${randomUUID()}` } }); users.push(user.id);
    const workspace = await db.workspace.create({ data: { name: "Audio admission gate", ownerUserId: user.id } });
    const project = await db.project.create({ data: { workspaceId: workspace.id, title: "Audio-first", sourceMediaUrl: "https://youtu.be/dQw4w9WgXcQ", sourceType: "link", ingestStatus: "downloading" } });
    projects.push(project.id);
    const usage = new ProcessingUsage({ prisma: db, log() {} });
    await db.$transaction(tx => usage.reserve(tx, { workspaceId: workspace.id, projectId: project.id, actorUserId: user.id, intakeKind: "link" }));
    const audio = await db.sourceAudio.create({ data: { projectId: project.id, sourceRevision: 1, mediaProvider: "youtube", mediaId: "dQw4w9WgXcQ",
      audioTrack: { id: "251", language: "en", codec: "opus", sampleRate: 48000, channels: 2 },
      bindingHash: "a".repeat(64), storageKey: `execution/gate/${randomUUID()}/audio.webm`, etag: '"audio"', byteLength: 1000n,
      checksumSha256: "b".repeat(64), durationSeconds: seconds, audioStartTimeSec: 0, probeVersion: "normalized-probe-1", toolchainFingerprint: "c".repeat(64) } });
    return { usage, project, workspace, audio };
  }
  test("settles 60.01 seconds once while full video is still running", async () => {
    const f = await fixture();
    const results = await Promise.all([1, 2].map(() => db.$transaction(tx => f.usage.settle(tx, f.project.id))));
    expect(results).toContainEqual({ outcome: "settled", charged: true, settledSeconds: 120 });
    expect(results).toContainEqual({ outcome: "settled", charged: false, settledSeconds: 120 });
    expect((await db.project.findUniqueOrThrow({ where: { id: f.project.id } })).ingestStatus).toBe("downloading");
  }, 30_000);
  test("refuses cap overflow and workspace restriction before a new debit", async () => {
    for (const reason of ["duration", "restriction"] as const) {
      const f = await fixture(reason === "duration" ? 3600.01 : 60.01);
      if (reason === "restriction") await db.workspace.update({ where: { id: f.workspace.id }, data: { status: "restricted" } });
      const result = await db.$transaction(tx => f.usage.settle(tx, f.project.id));
      expect(result.outcome).toBe("refused");
      if (result.outcome !== "refused") throw new Error("Expected usage refusal");
      expect(result.failure.code).toBe(reason === "duration" ? "upload_too_long" : "project_access_denied");
      expect(await db.processingUsageReservation.findUniqueOrThrow({ where: { projectId: f.project.id } })).toMatchObject({ state: "released", settledSeconds: null });
    }
  }, 45_000);

  test("a missing reservation and an older source revision cannot admit processing", async () => {
    const f = await fixture();
    await db.project.update({ where: { id: f.project.id }, data: { sourceRevision: 2 } });
    expect(await db.$transaction(tx => f.usage.settle(tx, f.project.id))).toEqual({ outcome: "not_ready" });
    await db.project.update({ where: { id: f.project.id }, data: { sourceRevision: 1 } });
    await db.processingUsageReservation.delete({ where: { projectId: f.project.id } });
    await expect(db.$transaction(tx => f.usage.settle(tx, f.project.id))).rejects.toThrow("processing_usage_not_reserved");
  }, 30_000);

});
