import { admitMediaCleanupObligations } from "./media-cleanup-admission";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { assertExecutionDatabaseTestTarget } from "./execution-db-test-support";
import * as safety from "./execution-safety-pages";
import { recoverOutboundProbeWakePage } from "./execution-safety-pages";
import { appendWorkflowRunDispatch } from "./workflow-dispatch";
import { appendExecutionDispatch, readExecutionDispatch } from "./execution-dispatch";
import { expireWorkflowEventPage, expireWorkspaceEventPage, expireWebhookLogPage, recoverMediaCleanupPage } from "./execution-retention-pages";
const url = process.env.SERVERLESS_TEST_DATABASE_URL;
const suite = process.env.ALLOW_SERVERLESS_DB_TESTS === "1" && url ? describe : describe.skip;
suite("Production retention pages", () => {
  let db: PrismaClient;
  beforeAll(() => { const schema = process.env.SERVERLESS_TEST_DATABASE_SCHEMA!; assertExecutionDatabaseTestTarget(url, schema); db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url, max: 4 }, { schema }), transactionOptions: { maxWait: 10_000, timeout: 30_000 } }); });
  afterAll(async () => { await db?.$disconnect(); });
  async function fixture() { const user = await db.user.create({ data: { clerkId: `maintenance-${crypto.randomUUID()}` } }); const workspace = await db.workspace.create({ data: { name: "Maintenance", ownerUserId: user.id } }); return { workspace, project: await db.project.create({ data: { workspaceId: workspace.id, title: "Retention", sourceMediaUrl: "https://example.test/source" } }) }; }
  const cutoff = new Date("2026-10-31T00:00:00.000Z"), old = new Date("2026-01-01T00:00:00.000Z");
  async function page(after: { at: Date; id: string } | null = null) { return { deploymentEpoch: (await db.executionEpoch.findUniqueOrThrow({ where: { id: 1 } })).epoch, cutoff, after, limit: 2 }; }
  test("strict event pages retain unfinished delivery, fresh events and permanent dedupe keys", async () => {
    const { workspace, project } = await fixture();
    try {
      await db.workflowEvent.createMany({ data: Array.from({ length: 5 }, (_, i) => ({ projectId: project.id, workflowRunId: crypto.randomUUID(), seq: i + 1, stage: "ingest", status: "completed", emittedAt: i === 4 ? cutoff : old, dedupeKey: crypto.randomUUID(), notificationRequired: i === 3 })) });
      const first = await db.$transaction(async tx => expireWorkflowEventPage(tx, await page()));
      expect(first).toMatchObject({ processed: 2, dispatchIds: [] }); expect(first.next).not.toBeNull();
      const second = await db.$transaction(async tx => expireWorkflowEventPage(tx, await page(first.next)));
      expect(second.processed).toBe(1); expect(second.next).toBeNull();
      expect(await db.workflowEvent.count({ where: { projectId: project.id } })).toBe(2);
      const key = `retained-${crypto.randomUUID()}`;
      await db.workspaceEventKey.create({ data: { dedupeKey: key, workspaceId: workspace.id, projectId: project.id } });
      await db.workspaceEvent.create({ data: { workspaceId: workspace.id, seq: 1, type: "project.completed", subject: {}, occurredAt: old, createdAt: old, dedupeKey: key } });
      expect((await db.$transaction(async tx => expireWorkspaceEventPage(tx, await page()))).processed).toBe(1);
      expect(await db.workspaceEventKey.findUnique({ where: { dedupeKey: key } })).not.toBeNull();
    } finally { await db.workspace.delete({ where: { id: workspace.id } }); }
  });
  test("log deletion is bounded and cleanup repair schedules known due intents without completing future holds", async () => {
    const marker = crypto.randomUUID();
    await db.webhookDeliveryLog.createMany({ data: Array.from({ length: 3 }, (_, i) => ({ provider: "stripe", eventId: `${marker}-${i}`, eventType: "test", status: "processed", createdAt: old })) });
    const result = await db.$transaction(async tx => expireWebhookLogPage(tx, await page()));
    expect(result.processed).toBe(2); expect(result.next).not.toBeNull();
    await db.webhookDeliveryLog.deleteMany({ where: { eventId: { startsWith: marker } } });
    const intents = await db.mediaCleanupObligation.createManyAndReturn({ data: [old, old, new Date("2027-01-01T00:00:00.000Z")].map((at, i) => ({ origin: "clip_preparation_input", cleanupClass: "execution_input", objectKey: `projects/${marker}/preparations/${crypto.randomUUID()}/${i}.json`, nextAttemptAt: at })) });
    const cleanup = await db.$transaction(async tx => recoverMediaCleanupPage(tx, await page()));
    expect(cleanup.processed).toBe(2); expect(cleanup.dispatchIds).toHaveLength(2);
    expect(await db.mediaCleanupObligation.count({ where: { id: { in: intents.map(row => row.id) }, completedAt: null } })).toBe(3);
  });
  test("an hourly observation repairs an acknowledged current driver without new ownership, retry generation or charge", async () => {
    const { workspace } = await fixture();
    const epoch = (await page()).deploymentEpoch;
    const row = await db.outboundProbe.create({ data: { workspaceId: workspace.id, createdByUserId: workspace.ownerUserId, kind: "rss_feed", requestFingerprint: "1".repeat(64), input: { url: "https://example.test/feed" }, inputHash: "2".repeat(64), deploymentEpoch: epoch, operationDeadlineAt: new Date("2027-01-01T00:00:00.000Z"), createdAt: old } });
    const base = await db.$transaction(tx => appendExecutionDispatch(tx, { kind: "operation_driver", subject: { kind: "outbound_probe", id: row.id }, generation: 1, deploymentEpoch: epoch, inputHash: row.inputHash, dueAt: old }));
    await db.executionDispatch.update({ where: { id: base.reference.dispatchId }, data: { acknowledgedAt: old, destinationId: "old-completed-instance" } });
    const observed = await db.$transaction(async tx => recoverOutboundProbeWakePage(tx, await page()));
    expect(observed.processed).toBe(1); expect(observed.dispatchIds).toHaveLength(1);
    const delivery = await readExecutionDispatch(db, observed.dispatchIds![0]!);
    expect(delivery).toMatchObject({ reference: { generation: 1, inputHash: row.inputHash }, wakeKind: `hourly_${cutoff.getTime()}`, dueAt: cutoff });
    expect(await db.outboundProbe.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({ generation: 1, chargedAttempts: 0, attemptToken: null, executorOwner: null });
    expect(await db.$transaction(async tx => recoverOutboundProbeWakePage(tx, await page()))).toEqual(observed);
    await db.outboundProbe.delete({ where: { id: row.id } }); await db.workspace.delete({ where: { id: workspace.id } });
  });

  test("every fixed domain safety selector terminates on an empty cutoff and has valid PostgreSQL predicates", async () => {
    for (const handler of Object.values(safety)) {
      const empty = { ...(await page()), cutoff: new Date(0) };
      expect(await db.$transaction(tx => handler(tx, empty))).toEqual({ processed: 0, next: null, dispatchIds: [] });
    }
  });

  test("accepted STT waiting is recovered by its current driver with provider lineage and deadlines intact",async()=>{
    const {workspace,project}=await fixture(),epoch=(await page()).deploymentEpoch;
    const run=await db.workflowRun.create({data:{projectId:project.id,stage:"stt",status:"waiting",idempotencyKey:crypto.randomUUID(),deploymentEpoch:epoch,attemptId:crypto.randomUUID(),createdAt:old,operationDeadlineAt:new Date("2027-01-01T00:00:00.000Z"),attemptCount:2}});
    await db.$transaction(tx=>appendWorkflowRunDispatch(tx,run.id));
    const observation=await db.$transaction(async tx=>safety.recoverProviderWaitPage(tx,await page()));
    expect(observation.processed).toBe(1);expect(observation.dispatchIds).toHaveLength(1);
    expect(await db.workflowRun.findUniqueOrThrow({where:{id:run.id}})).toMatchObject({status:"waiting",attemptId:run.attemptId,attemptCount:2,operationDeadlineAt:run.operationDeadlineAt,leaseOwner:null,leaseExpiresAt:null});
    await db.workspace.delete({where:{id:workspace.id}});
  });

  test("restore object planning refuses open admission before creating a deferred cleanup intent",async()=>{
    const key=`projects/${crypto.randomUUID()}/preparations/${crypto.randomUUID()}/${crypto.randomUUID()}.json`;
    await expect(db.$transaction(tx=>admitMediaCleanupObligations(tx,[{origin:"clip_preparation_input",cleanupClass:"execution_input",objectKey:key}],{deferDispatch:true}))).rejects.toThrow("cleanup_restore_requires_closed_admission");
    expect(await db.mediaCleanupObligation.count({where:{objectKey:key}})).toBe(0);
  });

});
