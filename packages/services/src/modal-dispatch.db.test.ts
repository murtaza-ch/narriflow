import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { assertExecutionDatabaseTestTarget } from "./execution-db-test-support";
import { appendExecutionDispatch, readExecutionDispatch } from "./execution-dispatch";
import { createModalDispatch, MODAL_ACQUISITION_DEADLINE_MS, MODAL_ACQUISITION_MAX_RESPAWNS } from "./modal-dispatch";
import type { ModalBridgeCommand } from "@narriflow/validators/execution";

const url = process.env.SERVERLESS_TEST_DATABASE_URL;
const suite = process.env.ALLOW_SERVERLESS_DB_TESTS === "1" && url ? describe : describe.skip;
suite("Modal transport resolves only admitted execution references", () => {
  let db: PrismaClient;
  const ids: string[] = [];
  beforeAll(() => {
    const schema = process.env.SERVERLESS_TEST_DATABASE_SCHEMA ?? "public";
    assertExecutionDatabaseTestTarget(url, schema);
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url, max: 4 }, { schema }) });
  });
  afterAll(async () => {
    await db.executionAttempt.deleteMany({ where: { dispatchId: { in: ids } } });
    await db.executionDispatch.deleteMany({ where: { id: { in: ids } } });
    await db.$disconnect();
  });
  async function fixture(subject: { kind: "native_validation" | "ingest_job"; id: string } = { kind: "native_validation", id: crypto.randomUUID() }) {
    const epoch = await db.executionEpoch.findUniqueOrThrow({ where: { id: 1 } });
    const record = await db.$transaction(tx => appendExecutionDispatch(tx, { deploymentEpoch: epoch.epoch, generation: 1,
      kind: "modal_execution", subject, inputHash: "a".repeat(64), dueAt: new Date() }));
    ids.push(record.reference.dispatchId);
    const attempt = await db.executionAttempt.create({ data: { attemptToken: crypto.randomUUID(), dispatchId: record.reference.dispatchId,
      deploymentEpoch: epoch.epoch, generation: 1, inputHash: record.reference.inputHash, functionName: "asset_validation", operationDeadlineAt: new Date(Date.now() + 600_000) } });
    const calls: Array<{ command: ModalBridgeCommand; deliveryId: string }> = [];
    const service = createModalDispatch(db, { command: async (command, deliveryId) => { calls.push({ command, deliveryId }); return { disposition: "spawned", callId: "fc-public-gate" }; } });
    return { reference: record.reference, attempt, calls, service };
  }
  test("exact retries keep the persisted token and bridge delivery identity", async () => {
    const f = await fixture();
    expect(await f.service.spawn(f.reference)).toEqual({ status: "confirmed_created", destinationId: "fc-public-gate" });
    await f.service.spawn(f.reference);
    expect(f.calls).toEqual([0, 1].map(() => ({ deliveryId: f.reference.dispatchId, command: { action: "spawn", reference: f.reference,
      attemptToken: f.attempt.attemptToken, function: "asset_validation" } })));
    await expect(f.service.spawn({ ...f.reference, inputHash: "b".repeat(64) })).rejects.toMatchObject({ code: "invalid_dispatch" });
    expect(f.calls.length).toBe(2);
  });
  async function spawned(past = MODAL_ACQUISITION_DEADLINE_MS + 1_000, subject?: { kind: "ingest_job"; id: string }) {
    const f = await fixture(subject);
    await f.service.spawn(f.reference);
    await db.executionDispatch.update({ where: { id: f.reference.dispatchId }, data: { acknowledgedAt: new Date(Date.now() - past), destinationId: "fc-public-gate" } });
    const check = await db.executionDispatch.findUniqueOrThrow({ where: { id: (await f.service.watchAcquisition(f.reference))! } });
    ids.push(check.id);
    const record = (await readExecutionDispatch(db, check.id))!;
    return { ...f, check: record.reference };
  }
  function bridged(state: "pending" | "succeeded" | "failed" | "cancelled" | "unknown") {
    const calls: Array<{ command: ModalBridgeCommand; deliveryId: string }> = [];
    return { calls, bridge: { command: async (command: ModalBridgeCommand, deliveryId: string) => { calls.push({ command, deliveryId });
      return command.action === "status" ? { disposition: "observed" as const, callId: "fc-public-gate", state } : { disposition: "spawned" as const, callId: `fc-respawn-${calls.length}` }; } } };
  }
  afterEach(async () => { await db.executionDispatch.deleteMany({ where: { wakeKind: { startsWith: "respawn_" } } }); });
  const users: string[] = [];
  afterAll(async () => {
    await db.workspace.deleteMany({ where: { ownerUserId: { in: users } } });
    await db.user.deleteMany({ where: { id: { in: users } } });
  });
  /** An import whose native call has been lost, owned by a Workspace in the given state. */
  async function importAcquisition(workspaceStatus: "active" | "restricted", jobStatus: "queued" | "failed" = "queued") {
    const user = await db.user.create({ data: { clerkId: `modal-dispatch:${crypto.randomUUID()}` } }); users.push(user.id);
    const workspace = await db.workspace.create({ data: { name: "Modal dispatch", ownerUserId: user.id, status: workspaceStatus } });
    const project = await db.project.create({ data: { workspaceId: workspace.id, title: "Lost call", sourceType: "youtube", sourceMediaUrl: "https://youtube.com/watch?v=dQw4w9WgXcQ", ingestStatus: "queued" } });
    const job = await db.ingestJob.create({ data: { projectId: project.id, jobType: "link_import", status: jobStatus, payload: {} } });
    return { workspace, job, ...await spawned(MODAL_ACQUISITION_DEADLINE_MS + 1_000, { kind: "ingest_job", id: job.id }) };
  }
  const respawnRows = (f: { reference: { subject: { id: string } } }) => db.executionDispatch.count({ where: { subjectId: f.reference.subject.id, wakeKind: { startsWith: "respawn_" } } });
  test("a restricted Workspace is polled again later without spending a respawn, and the budget is whole after reactivation", async () => {
    const f = await importAcquisition("restricted"), { calls, bridge } = bridged("failed"), service = createModalDispatch(db, bridge);
    for (let round = 0; round < MODAL_ACQUISITION_MAX_RESPAWNS + 2; round++) {
      expect((await service.recoverAcquisition(f.check))!.getTime()).toBeGreaterThan(Date.now());
    }
    expect(calls).toEqual([]);
    expect(await respawnRows(f)).toBe(0);
    await db.workspace.update({ where: { id: f.workspace.id }, data: { status: "active" } });
    expect((await service.recoverAcquisition(f.check))!.getTime()).toBeGreaterThan(Date.now());
    expect(calls.map(call => call.command.action)).toEqual(["status", "spawn"]);
    expect(await respawnRows(f)).toBe(1);
  });
  test("a closed import ends the watch without asking the bridge", async () => {
    const f = await importAcquisition("active", "failed"), { calls, bridge } = bridged("failed");
    expect(await createModalDispatch(db, bridge).recoverAcquisition(f.check)).toBeNull();
    expect(calls).toEqual([]);
    expect(await respawnRows(f)).toBe(0);
  });

  test("an unacquired call waits out its acquisition deadline without calling the bridge", async () => {
    const f = await spawned(0), { calls, bridge } = bridged("failed");
    const next = await createModalDispatch(db, bridge).recoverAcquisition(f.check);
    expect(next!.getTime()).toBeGreaterThan(Date.now());
    expect(calls).toEqual([]);
  });
  test("a failed call respawns the same attempt under a new delivery and only the exact token can own it", async () => {
    const f = await spawned(), { calls, bridge } = bridged("failed");
    const next = await createModalDispatch(db, bridge).recoverAcquisition(f.check);
    expect(next!.getTime()).toBeGreaterThan(Date.now());
    expect(calls[0]).toMatchObject({ command: { action: "status", reference: f.reference, attemptToken: f.attempt.attemptToken, spawnDeliveryId: f.reference.dispatchId } });
    expect(calls[1]).toMatchObject({ command: { action: "spawn", reference: f.reference, attemptToken: f.attempt.attemptToken, function: "asset_validation" } });
    expect(calls[1]!.deliveryId).not.toBe(f.reference.dispatchId);
    const respawn = await db.executionDispatch.findUniqueOrThrow({ where: { id: calls[1]!.deliveryId } });
    expect(respawn).toMatchObject({ wakeKind: "respawn_1", destinationId: "fc-respawn-2" });
    expect(respawn.acknowledgedAt).not.toBeNull();
    expect(await db.executionAttempt.count({ where: { dispatchId: f.reference.dispatchId } })).toBe(1);
  });
  test("a pending call is left alone and a live owner ends the watch", async () => {
    const f = await spawned(), { calls, bridge } = bridged("pending"), service = createModalDispatch(db, bridge);
    expect((await service.recoverAcquisition(f.check))!.getTime()).toBeGreaterThan(Date.now());
    expect(calls.map(call => call.command.action)).toEqual(["status"]);
    await db.executionAttempt.update({ where: { attemptToken: f.attempt.attemptToken }, data: { owner: crypto.randomUUID(), leaseExpiresAt: new Date(Date.now() + 60_000) } });
    expect(await service.recoverAcquisition(f.check)).toBeNull();
    expect(calls.length).toBe(1);
  });
  test("respawns stop at their budget and leave the outcome to the operation deadline", async () => {
    const f = await spawned(), { calls, bridge } = bridged("unknown"), service = createModalDispatch(db, bridge);
    for (let round = 1; round <= MODAL_ACQUISITION_MAX_RESPAWNS; round++) {
      await service.recoverAcquisition(f.check);
      await db.$executeRaw`UPDATE "ExecutionDispatch" SET "createdAt" = '2026-01-01' WHERE "subjectId" = ${f.reference.subject.id} AND "wakeKind" LIKE 'respawn_%'`;
    }
    expect(calls.filter(call => call.command.action === "spawn").length).toBe(MODAL_ACQUISITION_MAX_RESPAWNS);
    expect(await service.recoverAcquisition(f.check)).toBeNull();
    expect(calls.filter(call => call.command.action === "spawn").length).toBe(MODAL_ACQUISITION_MAX_RESPAWNS);
  });
  test("ambiguous attempt rows cannot cause an arbitrary native spawn", async () => {
    const f = await fixture();
    await db.executionAttempt.create({ data: { attemptToken: crypto.randomUUID(), dispatchId: f.reference.dispatchId,
      deploymentEpoch: f.reference.deploymentEpoch, generation: 1, inputHash: f.reference.inputHash, functionName: "asset_validation", operationDeadlineAt: new Date(Date.now() + 600_000) } });
    await expect(f.service.spawn(f.reference)).rejects.toMatchObject({ code: "invalid_dispatch" });
    expect(f.calls.length).toBe(0);
  });
});
