import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { Pool } from "pg";
import { ReviewService, hashReviewAccessToken, issueReviewSession, verifyReviewSession, encryptReviewValue, decryptReviewValue } from "../../../../../packages/services/src/review.service";

import { createReviewsCommands } from "../../../../../packages/services/src/reviews-commands";
import { createOperationReceiptExecutor } from "../../../../../packages/services/src/operation-receipt";
import { prismaOperationReceiptPersistence } from "../../../../../packages/services/src/operation-receipt-runtime";
import { createReviewNotificationStore } from "../../../../../packages/services/src/review-notification.service";

const enabled = process.env.ALLOW_REVIEW_REPLAY_DB_TESTS === "1";
const secret = "review-replay-test-secret-that-is-at-least-32-bytes";
const schema = `review_replay_${randomUUID().replaceAll("-", "")}`;
const service = new ReviewService(async (_key, limit) => ({ allowed: true, availability: "available", remaining: limit, limit }));
(enabled ? describe : describe.skip)("guest audit receipts, disposable PostgreSQL", () => {
  let prisma: PrismaClient;
  let pool: Pool;
  let admin: Pool;
  let oldClient: PrismaClient | undefined;
  let oldRedisUrl: string | undefined;
  const global = globalThis as unknown as { narriflowPrismaClient?: PrismaClient };
  beforeAll(async () => {
    oldRedisUrl = process.env.UPSTASH_REDIS_URL;
    delete process.env.UPSTASH_REDIS_URL;
    const url = process.env.DATABASE_URL!;
    if (!url.includes("localhost:55432/")) throw new Error("Run through .scratch/api-extraction/db-gate.sh");
    admin = new Pool({ connectionString: url, max: 1 });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const client = await admin.connect();
    try {
      await client.query(`SET search_path TO "${schema}"`);
      const root = resolve(import.meta.dir, "../../../../../packages/db/prisma/migrations");
      for (const name of readdirSync(root).filter((name) => /^\d/.test(name)).sort()) await client.query(readFileSync(resolve(root, name, "migration.sql"), "utf8"));
    } finally { client.release(); }
    pool = new Pool({ connectionString: url, max: 4, options: `-csearch_path=${schema}` });
    prisma = new PrismaClient({ adapter: new PrismaPg(pool, { schema }) });
    oldClient = global.narriflowPrismaClient; global.narriflowPrismaClient = prisma;
  }, 30_000);
  afterAll(async () => { if (oldRedisUrl === undefined) delete process.env.UPSTASH_REDIS_URL; else process.env.UPSTASH_REDIS_URL = oldRedisUrl; global.narriflowPrismaClient = oldClient; await prisma?.$disconnect(); await pool?.end(); if (admin) { await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await admin.end(); } });
  async function fixture() {
    const id = randomUUID();
    const user = await prisma.user.create({ data: { clerkId: id, primaryEmail: `${id}@example.test` } });
    const workspace = await prisma.workspace.create({ data: { ownerUserId: user.id, name: "Review", pricingTier: "business" } });
    const project = await prisma.project.create({ data: { title: "Review", sourceMediaUrl: "https://example.test/video", workspaceId: workspace.id, createdByUserId: user.id, ingestStatus: "ready" } });
    const token = randomUUID();
    const round = await prisma.reviewRound.create({ data: { workspaceId: workspace.id, projectId: project.id, createdByUserId: user.id, revision: 1, title: "Review", accessTokenHash: hashReviewAccessToken(token), deliveryTokenEncrypted: "unused", recipientEmails: [], approvalRequired: false } });
    const subject = randomUUID();
    const guest = await prisma.reviewGuest.create({ data: { reviewRoundId: round.id, displayName: "Client", emailHash: id, emailEncrypted: "unused", sessionGrantHash: hashReviewAccessToken(subject) } });
    const claims = { roundId: round.id, guestId: guest.id, identity: "Client", subject, grant: hashReviewAccessToken(token) };
    return { user, workspace, project, round, guest, claims, session: issueReviewSession(claims, secret), token };
  }
  test("two processes serialize one key and commit exactly one domain row plus immutable event", async () => {
    const f = await fixture();
    const results = await Promise.all([1, 2].map(async () => {
      const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "guest-replay-child.ts")], { stdout: "pipe", stderr: "pipe", env: { ...process.env, REVIEW_TEST_URL: process.env.DATABASE_URL, REVIEW_TEST_SCHEMA: schema, REVIEW_TEST_SESSION: f.session, REVIEW_TEST_SECRET: secret } });
      const output = await new Response(child.stdout).text(); const error = await new Response(child.stderr).text();
      expect(await child.exited, error).toBe(0); return JSON.parse(output);
    }));
    expect(results[0].value).toEqual(results[1].value);
    expect(results.map((result) => result.replayed).sort()).toEqual([false, true]);
    expect(await prisma.reviewComment.count({ where: { reviewRoundId: f.round.id } })).toBe(1);
    const events = await prisma.reviewAuditEvent.findMany({ where: { reviewRoundId: f.round.id } });
    expect(events).toHaveLength(1);
    for (const value of [f.session, f.token, f.claims.subject, "cross-process-key"]) expect(JSON.stringify(events)).not.toContain(value);
    expect(await prisma.operationReceipt.count()).toBe(0);
  }, 30_000);
  test("lost response and later edit/delete replay the original snapshot, and changed input conflicts", async () => {
    const f = await fixture(); const mutation = { clientIdempotencyKey: randomUUID() };
    const accepted = await service.addComment(f.session, secret, { body: "Original" }, mutation);
    await service.editComment(f.session, secret, accepted.value.id, { body: "Edited" });
    expect(await service.addComment(f.session, secret, { body: "Original" }, mutation)).toEqual({ value: accepted.value, replayed: true });
    await service.deleteComment(f.session, secret, accepted.value.id);
    expect(await service.addComment(f.session, secret, { body: "Original" }, mutation)).toEqual({ value: accepted.value, replayed: true });
    await expect(service.addComment(f.session, secret, { body: "Changed" }, mutation)).rejects.toMatchObject({ code: "operation_idempotency_conflict" });
  });
  test("decision replay survives subsequent decisions and precedes unavailable limiter refusal", async () => {
    const f = await fixture(); const mutation = { clientIdempotencyKey: randomUUID() };
    const first = await service.decide(f.session, secret, { decision: "approved" }, mutation);
    await service.decide(f.session, secret, { decision: "changes_requested" }, { clientIdempotencyKey: randomUUID() });
    const unavailable = new ReviewService(async (_key, limit) => ({ availability: "unavailable", allowed: true, remaining: limit, limit }));
    expect(await unavailable.decide(f.session, secret, { decision: "approved" }, mutation)).toEqual({ value: first.value, replayed: true });
    await expect(unavailable.decide(f.session, secret, { decision: "approved" }, { clientIdempotencyKey: randomUUID() })).rejects.toMatchObject({ code: "mutations_unavailable" });
    await expect(unavailable.addComment(f.session, secret, { body: "new" }, { clientIdempotencyKey: randomUUID() })).rejects.toMatchObject({ code: "mutations_unavailable" });
  });
  test("rotation and expiry refuse replay; a new grant has independent caller-key identity", async () => {
    const f = await fixture(); const mutation = { clientIdempotencyKey: randomUUID() };
    await service.authorizeSession(f.session, secret);
    await service.addComment(f.session, secret, { body: "Original" }, mutation);
    const subject = randomUUID(); await prisma.reviewGuest.update({ where: { id: f.guest.id }, data: { sessionGrantHash: hashReviewAccessToken(subject) } });
    await expect(service.addComment(f.session, secret, { body: "Original" }, mutation)).rejects.toMatchObject({ code: "review_session_invalid" });
    await expect(service.authorizeSession(f.session, secret)).rejects.toMatchObject({ code: "review_session_invalid" });
    const rotated = issueReviewSession({ ...f.claims, subject }, secret);
    await service.authorizeSession(rotated, secret);
    expect((await service.addComment(rotated, secret, { body: "New grant" }, mutation)).replayed).toBe(false);
    const expired = issueReviewSession({ ...f.claims, subject }, secret, new Date(Date.now() - 13 * 3600_000));
    await expect(service.addComment(expired, secret, { body: "New grant" }, mutation)).rejects.toMatchObject({ code: "review_session_invalid" });
    expect(verifyReviewSession(rotated, secret).grant).toBe(hashReviewAccessToken(f.token));
    await prisma.reviewRound.update({ where: { id: f.round.id }, data: { revokedAt: new Date(), status: "revoked" } });
    await expect(service.addComment(rotated, secret, { body: "New grant" }, mutation)).rejects.toMatchObject({ code: "review_session_invalid" });
  });
  test("internal commands commit receipts with their writes and reauthorize before immutable replay", async () => {
    const f = await fixture();
    let authorized = true; let checkedLimit = 0;
    const commands = createReviewsCommands({ service, receipts: createOperationReceiptExecutor(prismaOperationReceiptPersistence(prisma)),
      authorize: async () => { if (!authorized) throw new Error("membership revoked"); },
      retry: async (tx, scope, roundId, ledgerId) => ({ retrying: await createReviewNotificationStore(tx).retry(scope, roundId, ledgerId, new Date()) }),
      protect: (value) => encryptReviewValue(JSON.stringify(value), secret), reveal: (value) => JSON.parse(decryptReviewValue(value, secret)),
    });
    const scope = { actorUserId: f.user.id, workspaceId: f.workspace.id, projectId: f.project.id, pricingTier: "business" as const };
    const mutation = { clientIdempotencyKey: randomUUID(), beforeAccept: async () => { checkedLimit++; } };
    const [first, concurrent] = await Promise.all([1, 2].map(() => commands.comment(scope, f.round.id, { body: "Internal" }, mutation)));
    expect(first.value).toEqual(concurrent.value); expect(checkedLimit).toBe(1);
    await commands.resolve(scope, f.round.id, first.value.id, true, { clientIdempotencyKey: randomUUID() });
    expect((await commands.comment(scope, f.round.id, { body: "Internal" }, mutation)).value).toEqual(first.value);
    await expect(commands.comment(scope, f.round.id, { body: "Different" }, mutation)).rejects.toMatchObject({ code: "operation_idempotency_conflict" });
    authorized = false;
    await expect(commands.comment(scope, f.round.id, { body: "Internal" }, mutation)).rejects.toThrow("membership revoked"); authorized = true;
    const inviteKey = { clientIdempotencyKey: randomUUID() };
    const invite = await commands.invite(scope, f.round.id, { recipientEmails: ["client@example.test"] }, inviteKey);
    expect((await commands.invite(scope, f.round.id, { recipientEmails: ["client@example.test"] }, inviteKey)).value).toEqual(invite.value);
    expect(invite.value.addedCount).toBe(1);
    const ledger = await prisma.reviewNotificationLedger.findFirstOrThrow({ where: { reviewRoundId: f.round.id } });
    await prisma.reviewNotificationLedger.update({ where: { id: ledger.id }, data: { status: "failed" } });
    const retryKey = { clientIdempotencyKey: randomUUID() };
    await commands.retry(scope, f.round.id, ledger.id, retryKey);
    expect((await commands.retry(scope, f.round.id, ledger.id, retryKey)).value).toEqual({ retrying: true });
    const revoked = { clientIdempotencyKey: randomUUID() };
    await commands.revoke(scope, f.round.id, revoked);
    expect((await commands.revoke(scope, f.round.id, revoked)).value).toEqual({ revoked: true });
    expect(await prisma.operationReceipt.count({ where: { workspaceId: f.workspace.id } })).toBe(5);
  });
  test("round creation and its notification intent share one receipt transaction, without plaintext links", async () => {
    const f = await fixture();
    const workflow = await prisma.workflowRun.create({ data: { projectId: f.project.id, idempotencyKey: randomUUID(), stage: "moment_detection", status: "completed" } });
    const clip = await prisma.clip.create({ data: { projectId: f.project.id, workflowRunId: workflow.id, index: 0, startSec: 0, endSec: 10, title: "Teaser", hookText: "Hook", reasoning: "Fixture", category: "hook", transcriptSlice: [], viralityScore: 80, hookStrengthScore: 80, emotionalIntensityScore: 80, pacingScore: 80, durationOptimalityScore: 80, tiktokScore: 80, youtubeScore: 80, instagramScore: 80, llmProvider: "test", llmModel: "test" } });
    const exported = await prisma.clipExport.create({ data: { projectId: f.project.id, workspaceId: f.workspace.id, clipId: clip.id, editorRevision: 0, fingerprint: randomUUID(), resolution: "1080p", watermark: false, status: "ready", variants: { create: { aspectRatio: "ratio_9_16", resolution: "1080p", watermark: false, status: "completed", storageKey: "review-test.mp4" } } }, include: { variants: true } });
    const commands = createReviewsCommands({ service, receipts: createOperationReceiptExecutor(prismaOperationReceiptPersistence(prisma)), authorize: async () => {}, retry: async () => ({ retrying: true }), protect: (value) => encryptReviewValue(JSON.stringify(value), secret), reveal: (value) => JSON.parse(decryptReviewValue(value, secret)) });
    // The production delivery secret is injected only for the duration of this test.
    const prior = process.env.REVIEW_ACCESS_SECRET; process.env.REVIEW_ACCESS_SECRET = secret;
    try {
      const scope = { actorUserId: f.user.id, workspaceId: f.workspace.id, projectId: f.project.id, pricingTier: "business" as const };
      const input = { title: "Second round", recipientEmails: ["client@example.test"], items: [{ clipId: clip.id, exportId: exported.id, expectedEditorRevision: 0, variantIds: [exported.variants[0]!.id] }] };
      const mutation = { clientIdempotencyKey: randomUUID() };
      const [first, second] = await Promise.all([1, 2].map(() => commands.createRound(scope, input, mutation)));
      expect(first.value).toEqual(second.value); expect([first.replayed, second.replayed].sort()).toEqual([false, true]);
      expect(await prisma.reviewRound.count({ where: { projectId: f.project.id } })).toBe(2);
      expect(await prisma.reviewNotificationLedger.count({ where: { reviewRoundId: first.value.id } })).toBe(1);
      const receipt = await prisma.operationReceipt.findFirstOrThrow({ where: { workspaceId: f.workspace.id } });
      expect(JSON.stringify(receipt.result)).not.toContain(first.value.token);
    } finally { if (prior === undefined) delete process.env.REVIEW_ACCESS_SECRET; else process.env.REVIEW_ACCESS_SECRET = prior; }
  });
});
