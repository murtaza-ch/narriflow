import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { assertExecutionDatabaseTestTarget } from "./execution-db-test-support";
import { ExecutionMaintenanceService, HOURLY_MAINTENANCE_PHASES, DAILY_MAINTENANCE_PHASES } from "./execution-maintenance";
import { expireMcpTaskPage, recoverPendingDispatchPage, recoverExecutionDeadlinePage, expireExecutionInboxPage } from "./execution-maintenance-pages";
import { appendExecutionDispatch, readExecutionDispatch } from "./execution-dispatch";
import { recoverIngestWakePage, recoverRenderGroupWakePage } from "./execution-safety-pages";

const url = process.env.SERVERLESS_TEST_DATABASE_URL;
const suite = process.env.ALLOW_SERVERLESS_DB_TESTS === "1" && url ? describe : describe.skip;
suite("Durable bounded execution maintenance", () => {
  let database: PrismaClient;
  beforeAll(() => {
    const schema = process.env.SERVERLESS_TEST_DATABASE_SCHEMA!;
    assertExecutionDatabaseTestTarget(url, schema);
    database = new PrismaClient({ adapter: new PrismaPg({ connectionString: url, max: 4 }, { schema }), transactionOptions: { maxWait: 10_000, timeout: 30_000 } });
  });
  afterAll(async () => { await database?.$disconnect(); });
  test("a lost scheduling acknowledgement reuses the hourly identity and an empty pass stops without a continuation", async () => {
    let loseAcknowledgement = true;
    const registered: string[][] = [];
    const service = new ExecutionMaintenanceService({ database, register: async ids => { registered.push([...ids]); if (loseAcknowledgement) throw new Error("Lost maintenance acknowledgement"); },
      phases: Object.fromEntries(HOURLY_MAINTENANCE_PHASES.map(phase => [phase, async () => ({ processed: 0, next: null })])) });
    const scheduledAt = new Date("2026-10-31T10:32:00.000Z");
    await expect(service.start({ cadence: "hourly", scheduledAt })).rejects.toThrow("Lost maintenance acknowledgement");
    loseAcknowledgement = false;
    const reference = await service.start({ cadence: "hourly", scheduledAt: new Date("2026-10-31T10:59:00.000Z") });
    expect(registered[0]).toEqual(registered[1]);
    expect(await database.executionDispatch.count({ where: { subjectId: reference.subject.id } })).toBe(1);
    expect(await service.run(reference)).toEqual({ kind: "complete", processed: 0, dispatchIds: [] });
    expect(await database.executionDispatch.count({ where: { subjectId: { startsWith: "mt1.h.1793440800000." } } })).toBe(1);
    await expect(service.run({ ...reference, inputHash: "0".repeat(64) })).rejects.toMatchObject({ code: "maintenance_reference_invalid" });
  });
  test("daily task expiry advances in bounded durable pages and keeps unexpired task handles", async () => {
    const marker = crypto.randomUUID();
    await database.mcpTask.createMany({ data: Array.from({ length: 6 }, (_, index) => ({ ownerUserId: marker, callerId: marker, workspaceId: marker,
      toolName: "maintenance-fixture", domainKind: "generation", domainId: crypto.randomUUID(), projectId: marker, originatingOperationId: marker,
      resultContract: {}, initialResult: {}, expiresAt: new Date(index < 5 ? "2026-10-30T00:00:00.000Z" : "2026-11-02T00:00:00.000Z") })) });
    const registered: string[][] = [];
    const service = new ExecutionMaintenanceService({ database, limit: 2, register: async ids => { registered.push([...ids]); },
      phases: { ...Object.fromEntries(DAILY_MAINTENANCE_PHASES.map(phase => [phase, async () => ({ processed: 0, next: null })])), tasks: expireMcpTaskPage } });
    let reference = await service.start({ cadence: "daily", scheduledAt: new Date("2026-10-31T10:00:00.000Z") });
    for (let page = 0; page < 4; page++) {
      const result = await service.run(reference);
      expect(result.processed).toBeLessThanOrEqual(2);
      if (result.kind === "complete") break;
      const id = result.dispatchIds.at(-1)!;
      expect(registered.at(-1)).toContain(id);
      reference = (await readExecutionDispatch(database, id))!.reference;
    }
    expect(await database.mcpTask.count({ where: { ownerUserId: marker } })).toBe(1);
    expect(await service.run(reference)).toMatchObject({ kind: "complete", processed: 0 });
  });
  test("a committed page replays its exact continuation after ACK loss without consuming another task page", async () => {
    const marker = crypto.randomUUID();
    await database.mcpTask.createMany({ data: Array.from({ length: 5 }, () => ({ ownerUserId: marker, callerId: marker, workspaceId: marker, toolName: "maintenance-receipt", domainKind: "generation", domainId: crypto.randomUUID(), projectId: marker, originatingOperationId: marker, resultContract: {}, initialResult: {}, expiresAt: new Date("2026-10-27T00:00:00.000Z") })) });
    let loseAcknowledgement = false;
    const registered: string[][] = [];
    const service = new ExecutionMaintenanceService({ database, limit: 2, register: async ids => { registered.push([...ids]); if (loseAcknowledgement) throw new Error("Page ACK lost"); },
      phases: { ...Object.fromEntries(DAILY_MAINTENANCE_PHASES.map(phase => [phase, async () => ({ processed: 0, next: null })])), tasks: expireMcpTaskPage } });
    const reference = await service.start({ cadence: "daily", scheduledAt: new Date("2026-10-28T10:00:00.000Z") });
    loseAcknowledgement = true;
    await expect(service.run(reference)).rejects.toThrow("Page ACK lost");
    expect(await database.mcpTask.count({ where: { ownerUserId: marker } })).toBe(3);
    loseAcknowledgement = false;
    const replay = await service.run(reference);
    expect(replay.dispatchIds).toEqual(registered[1]!);
    expect(registered[2]).toEqual(registered[1]);
    expect(await database.mcpTask.count({ where: { ownerUserId: marker } })).toBe(3);
    expect(await database.executionInboxReceipt.findUnique({ where: { audience_deliveryId: { audience: "maintenance-page", deliveryId: reference.dispatchId } } })).toMatchObject({ wakeDispatchIds: replay.dispatchIds, disposition: { kind: "continue", processed: 2 } });
    await database.mcpTask.deleteMany({ where: { ownerUserId: marker } });
  });
  test("one render group without a domain registration is skipped and logged, never failing its page", async () => {
    const user = await database.user.create({ data: { clerkId: `safety-page:${crypto.randomUUID()}` } });
    const workspace = await database.workspace.create({ data: { name: "Safety page", ownerUserId: user.id } });
    const project = await database.project.create({ data: { workspaceId: workspace.id, title: "Waiting for video", sourceMediaUrl: "r2://gate/source", ingestStatus: "downloading" } });
    const epoch = (await database.executionEpoch.findUniqueOrThrow({ where: { id: 1 } })).epoch;
    const run = await database.workflowRun.create({ data: { projectId: project.id, stage: "clip_rendering", status: "waiting", idempotencyKey: crypto.randomUUID(), renderWorkSetGeneration: crypto.randomUUID(), renderWorkSetFrozenAt: new Date(), deploymentEpoch: epoch } });
    const clip = await database.clip.create({ data: { projectId: project.id, workflowRunId: run.id, index: 0, startSec: 0, endSec: 10, hookText: "gate", reasoning: "gate", category: "hook", transcriptSlice: [], viralityScore: 50, hookStrengthScore: 50, emotionalIntensityScore: 50, pacingScore: 50, durationOptimalityScore: 50, tiktokScore: 50, youtubeScore: 50, instagramScore: 50, llmProvider: "gate", llmModel: "gate", editorRevision: 1 } });
    const group = (exportIdentity: string) => database.renderGroup.create({ data: { workflowRunId: run.id, workSetGeneration: run.renderWorkSetGeneration!, clipId: clip.id, exportIdentity, deploymentEpoch: epoch, createdAt: new Date("2026-10-30T00:00:00.000Z") } });
    const [waiting, registered] = await Promise.all([group("unregistered"), group("registered")]);
    const dispatch = await database.$transaction(tx => appendExecutionDispatch(tx, { deploymentEpoch: epoch, generation: 1, kind: "operation_driver", subject: { kind: "render_group", id: registered.id }, inputHash: "a".repeat(64), dueAt: new Date(0) }));
    const warnings: string[] = [], warn = console.warn;
    console.warn = (line: string) => { warnings.push(line); };
    try {
      const cutoff = new Date("2026-10-31T10:00:00.000Z");
      const result = await database.$transaction(tx => recoverRenderGroupWakePage(tx, { deploymentEpoch: epoch, cutoff, after: null, limit: 100 }));
      expect(result.processed).toBeGreaterThanOrEqual(2);
      const wakes = await database.executionDispatch.findMany({ where: { subjectId: { in: [waiting.id, registered.id] }, wakeKind: `hourly_${cutoff.getTime()}` } });
      expect(wakes.map(row => row.subjectId)).toEqual([registered.id]);
      expect(wakes[0]!.inputHash).toBe(dispatch.reference.inputHash);
      expect(warnings.some(line => line.includes("maintenance_domain_registration_missing") && line.includes(waiting.id))).toBe(true);
    } finally {
      console.warn = warn;
      await database.executionDispatch.deleteMany({ where: { subjectId: { in: [waiting.id, registered.id] } } });
      await database.workspace.delete({ where: { id: workspace.id } });
      await database.user.delete({ where: { id: user.id } });
    }
  });
  test("an undeliverable recovered wake cannot stall the next phase of the sweep", async () => {
    const epoch = (await database.executionEpoch.findUniqueOrThrow({ where: { id: 1 } })).epoch;
    const stuck = await database.$transaction(tx => appendExecutionDispatch(tx, { deploymentEpoch: epoch, generation: 1, kind: "operation_driver", subject: { kind: "maintenance", id: `fixture-${crypto.randomUUID()}` }, inputHash: "a".repeat(64), dueAt: new Date(0) }));
    const healthy = await database.$transaction(tx => appendExecutionDispatch(tx, { deploymentEpoch: epoch, generation: 1, kind: "operation_driver", subject: { kind: "maintenance", id: `fixture-${crypto.randomUUID()}` }, inputHash: "a".repeat(64), dueAt: new Date(0) }));
    const delivered: string[][] = [], warn = console.warn;
    const ids = [stuck.reference.dispatchId, ...Array.from({ length: 3 }, () => crypto.randomUUID()), healthy.reference.dispatchId];
    const service = new ExecutionMaintenanceService({ database, limit: 8, register: async batch => { delivered.push([...batch]); if (batch.includes(stuck.reference.dispatchId)) throw new Error("Undeliverable"); },
      phases: { ...Object.fromEntries(HOURLY_MAINTENANCE_PHASES.map(phase => [phase, async () => ({ processed: 0, next: null })])), dispatches: async () => ({ processed: 1, next: null, dispatchIds: ids }) } });
    console.warn = () => {};
    try {
      const reference = await service.start({ cadence: "hourly", scheduledAt: new Date("2026-08-14T12:00:00.000Z") });
      const result = await service.run(reference);
      const continuation = result.dispatchIds.at(-1)!;
      expect(result.kind).toBe("continue");
      expect(delivered[1]).toEqual([continuation]);
      expect(delivered.at(-1)).toEqual([healthy.reference.dispatchId]);
    } finally { console.warn = warn; }
  });

  test("hourly recovery leaves drafts and inaccessible Projects alone until they can make progress", async () => {
    const user = await database.user.create({ data: { clerkId: `safety-draft:${crypto.randomUUID()}` } });
    const workspace = await database.workspace.create({ data: { name: "Draft sweep", ownerUserId: user.id } });
    const epoch = (await database.executionEpoch.findUniqueOrThrow({ where: { id: 1 } })).epoch;
    const createdAt = new Date("2026-08-01T00:00:00.000Z"), cutoff = new Date("2026-08-02T00:00:00.000Z");
    const source = async (title: string, project: { expiresAt?: Date; purgeStartedAt?: Date } = {}) => {
      const row = await database.project.create({ data: { workspaceId: workspace.id, title, sourceMediaUrl: "r2://gate/source", sourceStorageKey: "gate/source", ingestStatus: "ready", ...project } });
      const job = await database.ingestJob.create({ data: { projectId: row.id, jobType: "upload_finalize", payload: {}, status: "completed", createdAt, deploymentEpoch: epoch } });
      await database.$transaction(tx => appendExecutionDispatch(tx, { deploymentEpoch: epoch, generation: 1, kind: "import_pipeline", subject: { kind: "ingest_job", id: job.id }, inputHash: "a".repeat(64), dueAt: new Date(0) }));
      return { project: row, job };
    };
    const pack = (projectId: string, draft: boolean) => database.contentPack.create({ data: { projectId, draft, outputTypes: ["short_clip"], clipGenerationMode: "best", clipCountTarget: 10, clipDurationSecTarget: 45, platformTargets: ["tiktok"], toneConstraints: [], captionPreset: "brand_default", platformPlaybookVersion: "2026-07-01" } });
    const draft = await source("Abandoned draft"), none = await source("No pack"), committed = await source("Committed pack"), expired = await source("Expired", { expiresAt: new Date(0) });
    await Promise.all([pack(draft.project.id, true), pack(committed.project.id, false), pack(expired.project.id, false)]);
    const jobs = [draft, none, committed, expired].map(row => row.job.id);
    try {
      await database.$transaction(tx => recoverIngestWakePage(tx, { deploymentEpoch: epoch, cutoff, after: null, limit: 100 }));
      const wakes = await database.executionDispatch.findMany({ where: { subjectId: { in: jobs }, wakeKind: `hourly_${cutoff.getTime()}` } });
      expect(wakes.map(row => row.subjectId)).toEqual([committed.job.id]);
      await database.workspace.update({ where: { id: workspace.id }, data: { status: "restricted" } });
      const later = new Date(cutoff.getTime() + 3_600_000);
      await database.$transaction(tx => recoverIngestWakePage(tx, { deploymentEpoch: epoch, cutoff: later, after: null, limit: 100 }));
      expect(await database.executionDispatch.count({ where: { subjectId: { in: jobs }, wakeKind: `hourly_${later.getTime()}` } })).toBe(0);
    } finally {
      await database.executionDispatch.deleteMany({ where: { subjectId: { in: jobs } } });
      await database.workspace.delete({ where: { id: workspace.id } });
      await database.user.delete({ where: { id: user.id } });
    }
  });

  test("hourly safety pages only due unacknowledged dispatches and confirms their persisted exact identities", async () => {
    const epoch = (await database.executionEpoch.findUniqueOrThrow({ where: { id: 1 } })).epoch;
    const records = await database.$transaction(async tx => {
      const rows = [];
      for (let index = 0; index < 3; index++) rows.push(await appendExecutionDispatch(tx, { deploymentEpoch: epoch, generation: 1, kind: "operation_driver", subject: { kind: "maintenance", id: `fixture-${crypto.randomUUID()}` }, inputHash: "a".repeat(64), dueAt: new Date(0) }));
      return rows;
    });
    await database.executionDispatch.updateMany({ where: { id: { in: records.map(row => row.reference.dispatchId) } }, data: { nextDeliveryAt: new Date(0) } });
    await database.executionDispatch.update({ where: { id: records[2]!.reference.dispatchId }, data: { acknowledgedAt: new Date(), destinationId: "confirmed" } });
    const registered: string[][] = [];
    const service = new ExecutionMaintenanceService({ database, limit: 1, register: async ids => { registered.push([...ids]); },
      phases: { ...Object.fromEntries(HOURLY_MAINTENANCE_PHASES.map(phase => [phase, async () => ({ processed: 0, next: null })])), dispatches: recoverPendingDispatchPage } });
    const reference = await service.start({ cadence: "hourly", scheduledAt: new Date("1970-01-02T00:00:00.000Z") });
    const first = await service.run(reference);
    expect(first).toMatchObject({ kind: "continue", processed: 1 });
    expect(records.slice(0, 2).map(row => row.reference.dispatchId)).toContain(first.dispatchIds[0]!);
    expect(first.dispatchIds).not.toContain(records[2]!.reference.dispatchId);
    expect(registered.at(-2)).toEqual([first.dispatchIds.at(-1)!]);
    expect(registered.at(-1)).toEqual(first.dispatchIds.slice(0, -1));
    expect(await service.run(reference)).toEqual(first);
    await database.executionDispatch.updateMany({ where: { id: { in: records.map(row => row.reference.dispatchId) } }, data: { nextDeliveryAt: new Date("2099-01-01") } });
  });
  test("hourly deadline repair registers the authoritative nearest admitted attempt observation without executing a domain mutation", async () => {
    const epoch = (await database.executionEpoch.findUniqueOrThrow({ where: { id: 1 } })).epoch;
    const record = await database.$transaction(tx => appendExecutionDispatch(tx, { deploymentEpoch: epoch, generation: 1, kind: "modal_execution", subject: { kind: "clip_preparation", id: crypto.randomUUID() }, inputHash: "b".repeat(64), dueAt: new Date(0) }));
    const token = crypto.randomUUID();
    await database.executionAttempt.create({ data: { attemptToken: token, dispatchId: record.reference.dispatchId, deploymentEpoch: epoch, generation: 1, inputHash: record.reference.inputHash, functionName: "prepare_clip", status: "running", owner: crypto.randomUUID(),
      createdAt: new Date(0), processStartedAt: new Date(1), leaseExpiresAt: new Date(2), operationDeadlineAt: new Date(3) } });
    const service = new ExecutionMaintenanceService({ database, limit: 2, register: async () => {},
      phases: { ...Object.fromEntries(HOURLY_MAINTENANCE_PHASES.map(phase => [phase, async () => ({ processed: 0, next: null })])), deadlines: recoverExecutionDeadlinePage, expireExecutionInboxPage } });
    const reference = await service.start({ cadence: "hourly", scheduledAt: new Date("1970-01-03T00:00:00.000Z") });
    const result = await service.run(reference);
    expect(result).toMatchObject({ kind: "continue", processed: 1 });
    const deadline = await readExecutionDispatch(database, result.dispatchIds[0]!);
    expect(deadline).toMatchObject({ deadlineKind: "lease", observedDeadlineAt: new Date(2), dueAt: new Date(2), wakeKind: "hourly_deadline.172800000", reference: { subject: record.reference.subject, inputHash: record.reference.inputHash } });
    expect((await database.executionAttempt.findUniqueOrThrow({ where: { attemptToken: token } })).status).toBe("running");
    const later = await service.start({ cadence: "hourly", scheduledAt: new Date("1970-01-04T00:00:00.000Z") });
    const repaired = await service.run(later);
    expect(repaired.dispatchIds[0]).not.toBe(result.dispatchIds[0]);
    expect((await readExecutionDispatch(database, repaired.dispatchIds[0]!))!.observedDeadlineAt).toEqual(new Date(2));
  });
  test("daily inbox expiry pages same-time same-ID receipts across audience ties without skipping or deleting live receipts", async () => {
    const deliveryId = crypto.randomUUID();
    await database.executionInboxReceipt.createMany({ data: ["executor-control", "watchdog"].map(audience => ({ audience, deliveryId, requestHash: "a".repeat(64), keyId: "fixture", disposition: {}, committedAt: new Date(1), expiresAt: new Date(3) })) });
    const live = await database.executionInboxReceipt.create({ data: { audience: "executor-control", deliveryId: crypto.randomUUID(), requestHash: "a".repeat(64), keyId: "fixture", disposition: {}, committedAt: new Date(), expiresAt: new Date(Date.now() + 86_400_000) } });
    const service = new ExecutionMaintenanceService({ database, limit: 1, register: async () => {},
      phases: { ...Object.fromEntries(DAILY_MAINTENANCE_PHASES.map(phase => [phase, async () => ({ processed: 0, next: null })])), receipts: expireExecutionInboxPage } });
    let reference = await service.start({ cadence: "daily", scheduledAt: new Date("1970-01-02T00:00:00.000Z") });
    const first = await service.run(reference);
    expect(first).toMatchObject({ kind: "continue", processed: 1 });
    expect(await database.executionInboxReceipt.count({ where: { deliveryId } })).toBe(1);
    reference = (await readExecutionDispatch(database, first.dispatchIds.at(-1)!))!.reference;
    expect(reference.subject.id).toContain(".executor-control");
    expect(await service.run(reference)).toMatchObject({ kind: "continue", processed: 1 });
    expect(await database.executionInboxReceipt.count({ where: { deliveryId } })).toBe(0);
    expect(await database.executionInboxReceipt.findUnique({ where: { audience_deliveryId: { audience: live.audience, deliveryId: live.deliveryId } } })).not.toBeNull();
  });
  test("a cursor-registration SQL failure rolls the task page back with its continuation", async () => {
    const marker = crypto.randomUUID();
    await database.mcpTask.createMany({ data: Array.from({ length: 3 }, () => ({ ownerUserId: marker, callerId: marker, workspaceId: marker,
      toolName: "maintenance-rollback", domainKind: "generation", domainId: crypto.randomUUID(), projectId: marker, originatingOperationId: marker,
      resultContract: {}, initialResult: {}, expiresAt: new Date("2026-10-29T00:00:00.000Z") })) });
    const service = new ExecutionMaintenanceService({ database, limit: 2, register: async () => {},
      phases: { ...Object.fromEntries(DAILY_MAINTENANCE_PHASES.map(phase => [phase, async () => ({ processed: 0, next: null })])), tasks: expireMcpTaskPage } });
    const reference = await service.start({ cadence: "daily", scheduledAt: new Date("2026-10-30T10:00:00.000Z") });
    const trigger = `maintenance_rollback_${marker.replaceAll("-", "")}`;
    await database.$executeRawUnsafe(`CREATE FUNCTION "${trigger}"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."subjectId" LIKE 'mt1.d.1793318400000.tasks.%' THEN RAISE EXCEPTION 'injected_continuation_failure'; END IF; RETURN NEW; END $$`);
    await database.$executeRawUnsafe(`CREATE TRIGGER "${trigger}" BEFORE INSERT ON "ExecutionDispatch" FOR EACH ROW EXECUTE FUNCTION "${trigger}"()`);
    try {
      await expect(service.run(reference)).rejects.toThrow();
      expect(await database.mcpTask.count({ where: { ownerUserId: marker } })).toBe(3);
    } finally {
      await database.$executeRawUnsafe(`DROP TRIGGER "${trigger}" ON "ExecutionDispatch"`);
      await database.$executeRawUnsafe(`DROP FUNCTION "${trigger}"()`);
    }
    expect(await service.run(reference)).toMatchObject({ kind: "continue", processed: 2 });
    expect(await database.mcpTask.count({ where: { ownerUserId: marker } })).toBe(1);
  });
});
