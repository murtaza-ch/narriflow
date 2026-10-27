import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { Pool } from "pg";
import { workspaceLibraryService } from "./workspace-library.service";
import {
  createReviewNotificationStore,
  ReviewNotificationService,
} from "./review-notification.service";
import {
  encryptReviewValue,
  hashReviewAccessToken,
  reviewDeliverySecret,
  reviewService,
} from "./review.service";

const databaseUrl = process.env.VIZARD_EXPANSION_TEST_DATABASE_URL;
const databaseSchema = process.env.VIZARD_EXPANSION_TEST_DATABASE_SCHEMA;
const enabled = process.env.ALLOW_VIZARD_EXPANSION_DB_TESTS === "1" && Boolean(databaseUrl);
const dbDescribe = enabled ? describe : describe.skip;
const sessionSecret = "review-access-isolated-session-secret-for-tests";

dbDescribe("Review access PostgreSQL contracts", () => {
  let prisma: PrismaClient;
  let pool: Pool;
  let priorPrisma: PrismaClient | undefined;
  let priorRedisUrl: string | undefined;
  const prismaGlobal = globalThis as unknown as { narriflowPrismaClient?: PrismaClient };
  const workspaceIds: string[] = [];
  const userIds: string[] = [];

  beforeAll(() => {
    if (!databaseUrl) throw new Error("Review access test database is required");
    pool = new Pool({ connectionString: databaseUrl, max: 4,
      options: databaseSchema ? `-csearch_path=${databaseSchema}` : undefined });
    prisma = new PrismaClient({ adapter: new PrismaPg(pool, databaseSchema ? { schema: databaseSchema } : undefined) });
    priorPrisma = prismaGlobal.narriflowPrismaClient;
    prismaGlobal.narriflowPrismaClient = prisma;
    priorRedisUrl = process.env.UPSTASH_REDIS_URL;
    delete process.env.UPSTASH_REDIS_URL;
  });

  afterAll(async () => {
    await prisma?.workspace.deleteMany({ where: { id: { in: workspaceIds } } });
    await prisma?.user.deleteMany({ where: { id: { in: userIds } } });
    prismaGlobal.narriflowPrismaClient = priorPrisma;
    if (priorRedisUrl === undefined) delete process.env.UPSTASH_REDIS_URL;
    else process.env.UPSTASH_REDIS_URL = priorRedisUrl;
    await prisma?.$disconnect();
    await pool?.end();
  });

  async function fixture() {
    const suffix = randomUUID();
    const user = await prisma.user.create({ data: {
      clerkId: `review-access-${suffix}`, primaryEmail: `review-access-${suffix}@example.test`,
    } });
    userIds.push(user.id);
    const workspace = await prisma.workspace.create({ data: {
      name: "Review access", ownerUserId: user.id, pricingTier: "business",
    } });
    workspaceIds.push(workspace.id);
    const project = await prisma.project.create({ data: {
      title: "Review access", sourceMediaUrl: "https://media.example.test/source.mp4",
      workspaceId: workspace.id, createdByUserId: user.id, ingestStatus: "ready",
    } });
    const token = `review-access-${suffix}`;
    const round = await prisma.reviewRound.create({ data: {
      workspaceId: workspace.id, projectId: project.id, createdByUserId: user.id,
      revision: 1, title: "Client review", accessTokenHash: hashReviewAccessToken(token),
      deliveryTokenEncrypted: encryptReviewValue(token, reviewDeliverySecret()),
      recipientEmails: ["client@example.test"],
    } });
    return { user, workspace, project, round, token };
  }

  for (const state of ["expired", "purging"] as const) {
    test(`blocks new guest sessions and existing guest access when the Project is ${state}`, async () => {
      const current = await fixture();
      const identity = { identity: "Client", email: "client@example.test" };
      const session = await reviewService.authenticate(current.token, identity, randomUUID(), sessionSecret);
      expect((await reviewService.readRound(session, sessionSecret)).round.id).toBe(current.round.id);
      await prisma.project.update({ where: { id: current.project.id }, data: state === "expired"
        ? { expiresAt: new Date(Date.now() - 60_000) }
        : { purgeStartedAt: new Date() } });

      await expect(reviewService.readRound(session, sessionSecret)).rejects.toMatchObject({ code: "review_session_invalid" });
      await expect(reviewService.addComment(session, sessionSecret, { body: "Too late", itemId: null, parentId: null, timestampSec: null }))
        .rejects.toMatchObject({ code: "review_session_invalid" });
      await expect(reviewService.authenticate(current.token, identity, randomUUID(), sessionSecret))
        .rejects.toMatchObject({ code: "review_access_invalid" });
      expect(await prisma.reviewGuest.count({ where: { reviewRoundId: current.round.id } })).toBe(1);
      expect(await prisma.reviewComment.count({ where: { reviewRoundId: current.round.id } })).toBe(0);
    });
  }

  test("the Workspace export library excludes expired and purging Projects", async () => {
    const current = await fixture();
    await prisma.workspaceMember.create({ data: { workspaceId: current.workspace.id, userId: current.user.id, role: "owner" } });
    const workflow = await prisma.workflowRun.create({ data: {
      projectId: current.project.id, idempotencyKey: randomUUID(), stage: "moment_detection", status: "completed",
    } });
    const clip = await prisma.clip.create({ data: {
      projectId: current.project.id, workflowRunId: workflow.id, index: 0, startSec: 0, endSec: 10,
      title: "Client teaser", hookText: "A hook", reasoning: "Fixture", category: "hook", transcriptSlice: [],
      viralityScore: 80, hookStrengthScore: 80, emotionalIntensityScore: 80, pacingScore: 80,
      durationOptimalityScore: 80, tiktokScore: 80, youtubeScore: 80, instagramScore: 80, llmProvider: "test", llmModel: "test",
    } });
    const exported = await prisma.clipExport.create({ data: {
      projectId: current.project.id, workspaceId: current.workspace.id, clipId: clip.id,
      editorRevision: 0, fingerprint: randomUUID(), resolution: "1080p", watermark: false, status: "ready",
    } });
    const actor = { actorUserId: current.user.id, workspaceId: current.workspace.id };
    expect((await workspaceLibraryService.listExports(actor)).items.map((item) => item.id)).toEqual([exported.id]);
    for (const state of ["expired", "purging"] as const) {
      await prisma.project.update({ where: { id: current.project.id }, data: state === "expired"
        ? { expiresAt: new Date(Date.now() - 60_000) }
        : { expiresAt: null, purgeStartedAt: new Date() } });
      expect((await workspaceLibraryService.listExports(actor)).items).toEqual([]);
      expect((await workspaceLibraryService.listExports(actor, { query: "Client" })).items).toEqual([]);
    }
  });

  test("does not email unusable guest review links or inaccessible Projects", async () => {
    const store = createReviewNotificationStore();
    const invalidLedgerIds: string[] = [];
    for (const state of ["revoked", "superseded", "round_expired", "project_expired", "project_purging"] as const) {
      const current = await fixture();
      if (state === "revoked" || state === "superseded") {
        await prisma.reviewRound.update({ where: { id: current.round.id }, data: {
          status: state, ...(state === "revoked" ? { revokedAt: new Date() } : { supersededAt: new Date() }),
        } });
      } else if (state === "round_expired") {
        await prisma.reviewRound.update({ where: { id: current.round.id }, data: { expiresAt: new Date(Date.now() - 60_000) } });
      } else {
        await prisma.project.update({ where: { id: current.project.id }, data: state === "project_expired"
          ? { expiresAt: new Date(Date.now() - 60_000) } : { purgeStartedAt: new Date() } });
      }
      for (const kind of ["round_sent", "mention"] as const) {
        const ledger = await prisma.reviewNotificationLedger.create({ data: {
          reviewRoundId: current.round.id, recipientEmail: "client@example.test", kind, scopeKey: "round",
        } });
        invalidLedgerIds.push(ledger.id);
      }
    }
    const active = await fixture();
    const validLedger = await prisma.reviewNotificationLedger.create({ data: {
      reviewRoundId: active.round.id, recipientEmail: "client@example.test", kind: "round_sent", scopeKey: "round",
    } });
    const sentIds: string[] = [];
    const notifications = new ReviewNotificationService({ store, enabled: () => true,
      mailer: async (input) => { sentIds.push(input.idempotencyKey); return { sent: true }; } });
    const result = await notifications.deliverDue(50, "https://review.example.test");
    expect(sentIds).toEqual([`review-notification-${validLedger.id}`]);
    expect(result.sent).toBe(1);
    for (const id of invalidLedgerIds) {
      expect(await prisma.reviewNotificationLedger.findUnique({ where: { id }, select: { status: true, failureCode: true } }))
        .toEqual({ status: "failed", failureCode: "context_unavailable" });
    }
  });
});
