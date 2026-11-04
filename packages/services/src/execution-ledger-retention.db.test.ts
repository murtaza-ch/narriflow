import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { assertExecutionDatabaseTestTarget } from "./execution-db-test-support";
import { appendExecutionDispatch, readExecutionDispatch } from "./execution-dispatch";
import { expireCleanupObligationPage, expireExecutionArtifactPage, expireExecutionAttemptPage, expireExecutionDispatchPage, expireOperationReceiptPage, expireOutboundDeliveryPage, expireSocialOAuthStatePage, expireUploadSessionPage, expireZoomWebhookJobPage } from "./execution-ledger-retention";
import type { MaintenancePage, MaintenancePhaseHandler } from "./execution-maintenance";

const url = process.env.SERVERLESS_TEST_DATABASE_URL;
const suite = process.env.ALLOW_SERVERLESS_DB_TESTS === "1" && url ? describe : describe.skip;
const OLD = new Date("2025-01-01T00:00:00.000Z"), CUTOFF = new Date("2026-11-01T00:00:00.000Z"), RECENT = new Date("2026-10-30T00:00:00.000Z");

suite("Execution ledger retention", () => {
  let db: PrismaClient, epoch: number;
  beforeAll(async () => {
    const schema = process.env.SERVERLESS_TEST_DATABASE_SCHEMA!;
    assertExecutionDatabaseTestTarget(url, schema);
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url, max: 4 }, { schema }), transactionOptions: { maxWait: 10_000, timeout: 30_000 } });
    epoch = (await db.executionEpoch.findUniqueOrThrow({ where: { id: 1 } })).epoch;
  });
  afterAll(async () => { await db?.$disconnect(); });
  const page: MaintenancePage = { get deploymentEpoch() { return epoch; }, cutoff: CUTOFF, after: null, limit: 32 };
  const run = (handler: MaintenancePhaseHandler) => db.$transaction(tx => handler(tx, page));

  async function dispatch(input: { acknowledgedAt?: Date | null; dueAt?: Date; wakeKind?: string; subjectKind?: "ingest_job" | "maintenance"; subjectId?: string; kind?: "operation_driver" | "modal_execution" }) {
    const record = await db.$transaction(tx => appendExecutionDispatch(tx, { deploymentEpoch: epoch, generation: 1, kind: input.kind ?? "operation_driver",
      subject: { kind: input.subjectKind ?? "maintenance", id: input.subjectId ?? `retention-${crypto.randomUUID()}` }, inputHash: "a".repeat(64), dueAt: input.dueAt ?? OLD, wakeKind: input.wakeKind ?? null }));
    if (input.acknowledgedAt !== null) await db.executionDispatch.update({ where: { id: record.reference.dispatchId }, data: { acknowledgedAt: input.acknowledgedAt ?? OLD, destinationId: "fixture" } });
    return record.reference;
  }
  async function attempt(status = "completed", operationDeadlineAt = OLD) {
    const native = await dispatch({ kind: "modal_execution" });
    const live = status === "running" ? { owner: crypto.randomUUID(), leaseExpiresAt: operationDeadlineAt, processStartedAt: new Date(operationDeadlineAt.getTime() - 1_000) } : { finishedAt: operationDeadlineAt };
    const row = await db.executionAttempt.create({ data: { attemptToken: crypto.randomUUID(), dispatchId: native.dispatchId, deploymentEpoch: epoch, generation: 1, inputHash: native.inputHash, functionName: "fetch_source",
      operationDeadlineAt, createdAt: new Date(operationDeadlineAt.getTime() - 60_000), status, ...live } });
    return { native, attempt: row };
  }
  const artifact = (attemptToken: string, storageKey = `execution/retention/${crypto.randomUUID()}`) => db.executionArtifact.create({ data: { attemptToken, owner: crypto.randomUUID(), role: "probe", bindingHash: "b".repeat(64), storageKey, contentType: "application/json", maxBytes: 1n, createdAt: new Date(OLD.getTime() - 1_000), grantExpiresAt: OLD } });
  const obligation = (objectKey: string, completedAt: Date | null, origin = "assigned_execution_artifact") => db.mediaCleanupObligation.create({ data: { origin, cleanupClass: "assigned_artifact", objectKey, completedAt } });

  test("an artifact leaves only after its object's deletion was acknowledged, then attempt, then dispatch, in FK order", async () => {
    const removed = await attempt(), live = await attempt(), reopened = await attempt(), recent = await attempt();
    const gone = await artifact(removed.attempt.attemptToken), held = await artifact(live.attempt.attemptToken), open = await artifact(reopened.attempt.attemptToken), fresh = await artifact(recent.attempt.attemptToken);
    const proof = await obligation(gone.storageKey, OLD);
    await obligation(open.storageKey, OLD); const pending = await obligation(open.storageKey, null, "project_retention");
    await obligation(fresh.storageKey, RECENT);
    await run(expireCleanupObligationPage);
    expect(await db.mediaCleanupObligation.count({ where: { id: proof.id } })).toBe(1);
    await run(expireExecutionArtifactPage);
    expect(await db.executionArtifact.findMany({ where: { id: { in: [gone.id, held.id, open.id, fresh.id] } }, select: { id: true } })).toHaveLength(3);
    expect(await db.executionArtifact.count({ where: { id: gone.id } })).toBe(0);
    await run(expireCleanupObligationPage);
    expect(await db.mediaCleanupObligation.count({ where: { id: proof.id } })).toBe(0);
    expect(await db.mediaCleanupObligation.count({ where: { id: pending.id } })).toBe(1);
    await run(expireExecutionAttemptPage);
    expect(await db.executionAttempt.count({ where: { attemptToken: removed.attempt.attemptToken } })).toBe(0);
    expect(await db.executionAttempt.count({ where: { attemptToken: live.attempt.attemptToken } })).toBe(1);
    await run(expireExecutionDispatchPage);
    expect(await db.executionDispatch.count({ where: { id: removed.native.dispatchId } })).toBe(0);
    expect(await db.executionDispatch.count({ where: { id: live.native.dispatchId } })).toBe(1);
  });

  test("a live or recently finished attempt keeps its fence", async () => {
    const running = await attempt("running"), recent = await attempt("completed", RECENT);
    await run(expireExecutionAttemptPage);
    expect(await db.executionAttempt.count({ where: { attemptToken: { in: [running.attempt.attemptToken, recent.attempt.attemptToken] } } })).toBe(2);
  });

  test("wakes expire while a live subject's registration and every unacknowledged obligation stay", async () => {
    const user = await db.user.create({ data: { clerkId: `ledger:${crypto.randomUUID()}` } });
    const workspace = await db.workspace.create({ data: { name: "Ledger", ownerUserId: user.id } });
    const project = await db.project.create({ data: { workspaceId: workspace.id, title: "Ledger", sourceMediaUrl: "r2://gate/source" } });
    const job = await db.ingestJob.create({ data: { projectId: project.id, jobType: "upload_finalize", payload: {}, status: "completed", deploymentEpoch: epoch } });
    const registration = await dispatch({ subjectKind: "ingest_job", subjectId: job.id }), orphan = await dispatch({ subjectKind: "ingest_job", subjectId: crypto.randomUUID() });
    const wake = await dispatch({ wakeKind: "hourly_1" }), recent = await dispatch({ wakeKind: "hourly_2", acknowledgedAt: RECENT }), unacknowledged = await dispatch({ wakeKind: "hourly_3", acknowledgedAt: null }), future = await dispatch({ wakeKind: "hourly_4", dueAt: new Date("2027-01-01T00:00:00.000Z") });
    await run(expireExecutionDispatchPage);
    expect(await db.executionDispatch.count({ where: { id: { in: [wake.dispatchId, orphan.dispatchId] } } })).toBe(0);
    expect((await db.executionDispatch.findMany({ where: { id: { in: [registration.dispatchId, recent.dispatchId, unacknowledged.dispatchId, future.dispatchId] } } })).length).toBe(4);
    expect(await readExecutionDispatch(db, registration.dispatchId)).not.toBeNull();
    await db.executionDispatch.deleteMany({ where: { id: { in: [registration.dispatchId, recent.dispatchId, unacknowledged.dispatchId, future.dispatchId] } } });
    await db.workspace.delete({ where: { id: workspace.id } });
    await db.user.delete({ where: { id: user.id } });
  });

  test("terminal product rows expire on their own windows and live ones stay", async () => {
    const user = await db.user.create({ data: { clerkId: `ledger:${crypto.randomUUID()}` } });
    const workspace = await db.workspace.create({ data: { name: "Ledger rows", ownerUserId: user.id } });
    const delivery = (status: string, expiresAt: Date) => db.outboundDelivery.create({ data: { workspaceId: workspace.id, targetKind: "completion_callback", targetId: crypto.randomUUID(), eventId: crypto.randomUUID(), encryptedUrl: "x", urlHost: "example.com", urlFingerprint: "f".repeat(64), bodyStorageKey: `body/${crypto.randomUUID()}`, bodySha256: "e".repeat(64), bodyByteLength: 1n, bodyEtag: '"body"', inputHash: "a".repeat(64), status, deploymentEpoch: epoch, createdAt: new Date(expiresAt.getTime() - 60_000), expiresAt, maxAttempts: 3, completedAt: status === "queued" ? null : expiresAt } });
    const [oldDelivery, queued, recentDelivery] = await Promise.all([delivery("completed", OLD), delivery("queued", OLD), delivery("failed", RECENT)]);
    const zoom = (status: string, completedAt: Date | null) => db.zoomWebhookJob.create({ data: { eventKey: crypto.randomUUID(), payload: {}, status, availableAt: OLD, completedAt, createdAt: OLD, operationDeadlineAt: new Date(OLD.getTime() + 30 * 86_400_000) } });
    const [oldZoom, runningZoom, recentZoom] = await Promise.all([zoom("completed", OLD), zoom("queued", null), zoom("failed", RECENT)]);
    const receipt = (createdAt: Date) => db.operationReceipt.create({ data: { workspaceId: workspace.id, actorUserId: user.id, command: "gate", clientIdempotencyKey: crypto.randomUUID(), fingerprint: "f", resourceType: "project", resourceId: "x", result: {}, createdAt } });
    const [oldReceipt, recentReceipt] = await Promise.all([receipt(OLD), receipt(RECENT)]);
    const state = (expiresAt: Date) => db.socialOAuthState.create({ data: { userId: user.id, platform: "tiktok", state: crypto.randomUUID(), expiresAt } });
    const [oldState, liveState] = await Promise.all([state(OLD), state(new Date("2027-01-01T00:00:00.000Z"))]);
    await run(expireOutboundDeliveryPage); await run(expireZoomWebhookJobPage); await run(expireOperationReceiptPage); await run(expireSocialOAuthStatePage); await run(expireUploadSessionPage);
    expect((await db.outboundDelivery.findMany({ where: { id: { in: [oldDelivery.id, queued.id, recentDelivery.id] } }, select: { id: true } })).map(row => row.id).sort()).toEqual([queued.id, recentDelivery.id].sort());
    expect((await db.zoomWebhookJob.findMany({ where: { id: { in: [oldZoom.id, runningZoom.id, recentZoom.id] } }, select: { id: true } })).map(row => row.id).sort()).toEqual([runningZoom.id, recentZoom.id].sort());
    expect((await db.operationReceipt.findMany({ where: { id: { in: [oldReceipt.id, recentReceipt.id] } }, select: { id: true } })).map(row => row.id)).toEqual([recentReceipt.id]);
    expect((await db.socialOAuthState.findMany({ where: { id: { in: [oldState.id, liveState.id] } }, select: { id: true } })).map(row => row.id)).toEqual([liveState.id]);
    await db.outboundDelivery.deleteMany({ where: { workspaceId: workspace.id } });
    await db.zoomWebhookJob.deleteMany({ where: { id: { in: [runningZoom.id, recentZoom.id] } } });
    await db.operationReceipt.deleteMany({ where: { workspaceId: workspace.id } });
    await db.workspace.delete({ where: { id: workspace.id } });
    await db.user.delete({ where: { id: user.id } });
  });

  test("a page reports inside the page contract and continues past its bulk delete", async () => {
    const small: MaintenancePage = { ...page, limit: 1 };
    const marker = crypto.randomUUID(), workspaceId = crypto.randomUUID(), rows = Array.from({ length: 40 }, () => ({ workspaceId, actorUserId: marker, command: "gate", clientIdempotencyKey: crypto.randomUUID(), fingerprint: "f", resourceType: "project", resourceId: marker, result: {}, createdAt: OLD }));
    await db.operationReceipt.createMany({ data: rows });
    const first = await db.$transaction(tx => expireOperationReceiptPage(tx, small));
    expect(first.processed).toBe(1);
    expect(first.next).not.toBeNull();
    await db.$transaction(tx => expireOperationReceiptPage(tx, { ...small, after: first.next }));
    expect(await db.operationReceipt.count({ where: { actorUserId: marker } })).toBe(0);
  });
});
