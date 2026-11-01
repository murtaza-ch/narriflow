import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { createDatabaseTestContext } from "@narriflow/db/testing";
import { CampaignOperationService } from "./campaign-operation.service";
import { dubbingService } from "./dubbing.service";
import { assertExecutionDatabaseTestTarget } from "./execution-db-test-support";
import { withExecutionDispatches } from "./execution-dispatch-runtime";
import { bindServiceTestEnvironment } from "./runtime-test-support";
import { WorkflowRunLifecycle } from "./workflow-run-lifecycle";

const url = process.env.SERVERLESS_TEST_DATABASE_URL;
const suite = process.env.ALLOW_SERVERLESS_DB_TESTS === "1" && url ? describe : describe.skip;
suite("Workflow atomic scheduler handoff", () => {
  let db: PrismaClient;
  const users: string[] = [];
  const context = createDatabaseTestContext();
  const scoped = <T>(run: () => Promise<T>) => bindServiceTestEnvironment(context.bind(run))();
  beforeAll(() => {
    const schema = process.env.SERVERLESS_TEST_DATABASE_SCHEMA!;
    assertExecutionDatabaseTestTarget(url, schema);
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url, max: 5 }, { schema }), transactionOptions: { timeout: 30_000, maxWait: 10_000 } });
    context.client = db;
  });
  afterAll(async () => { await db?.$disconnect(); });
  afterEach(async () => {
    const projects = await db.project.findMany({ where: { workspace: { ownerUserId: { in: users } } }, select: { id: true } });
    const projectIds = projects.map(project => project.id);
    const runs = await db.workflowRun.findMany({ where: { projectId: { in: projectIds } }, select: { id: true } });
    const events = await db.workflowEvent.findMany({ where: { projectId: { in: projectIds } }, select: { id: true } });
    const workspaceEvents = await db.workspaceEvent.findMany({ where: { workspace: { ownerUserId: { in: users } } }, select: { id: true } });
    await db.executionDispatch.deleteMany({ where: { subjectId: { in: [...projectIds, ...runs.map(run => run.id), ...events.map(event => event.id), ...workspaceEvents.map(event => event.id)] } } });
    await db.processingUsageReservation.deleteMany({ where: { projectId: { in: projectIds } } });
    await db.workspace.deleteMany({ where: { ownerUserId: { in: users } } });
    await db.user.deleteMany({ where: { id: { in: users.splice(0) } } });
  });
  async function fixture() {
    const user = await db.user.create({ data: { clerkId: `workflow-handoff:${crypto.randomUUID()}` } });
    users.push(user.id);
    const workspace = await db.workspace.create({ data: { name: "Workflow handoff", ownerUserId: user.id, personalOwnerUserId: user.id, pricingTier: "business", members: { create: { userId: user.id, role: "owner" } } } });
    const project = await db.project.create({ data: { workspaceId: workspace.id, createdByUserId: user.id, title: "Workflow handoff", ingestStatus: "ready", sourceMediaUrl: "r2://fixture/source", sourceStorageKey: "fixture/source", sourceDurationSeconds: 30 } });
    await db.processingUsageReservation.create({ data: { projectId: project.id, workspaceId: workspace.id, intakeKind: "upload", periodStart: new Date("2026-11-01T00:00:00Z"), reservedSeconds: 60, settledSeconds: 60, state: "settled" } });
    const origin = await db.workflowRun.create({ data: { projectId: project.id, stage: "moment_detection", status: "completed", idempotencyKey: crypto.randomUUID() } });
    const clip = await db.clip.create({ data: { projectId: project.id, workflowRunId: origin.id, index: 0, startSec: 0, endSec: 10, hookText: "Bundle", reasoning: "Fixture", category: "hook", transcriptSlice: [],
      viralityScore: 50, hookStrengthScore: 50, emotionalIntensityScore: 50, pacingScore: 50, durationOptimalityScore: 50, tiktokScore: 50, youtubeScore: 50, instagramScore: 50, llmProvider: "fixture", llmModel: "fixture" } });
    const frozen = await db.clipExport.create({ data: { projectId: project.id, clipId: clip.id, editorRevision: 0, fingerprint: crypto.randomUUID(), resolution: "1080p", watermark: false, status: "ready" } });
    await db.clipExportVariant.create({ data: { exportId: frozen.id, aspectRatio: "ratio_9_16", resolution: "1080p", watermark: false, status: "completed", storageKey: `fixture/${frozen.id}.mp4`, sizeBytes: 3n, durationSec: 10 } });
    await db.clipRender.create({ data: { clipId: clip.id, aspectRatio: "ratio_9_16", status: "completed", storageKey: `fixture/${clip.id}.mp4`, sizeBytes: 3n, durationSec: 10 } });
    const scope = { actorUserId: user.id, workspaceId: workspace.id, projectId: project.id, pricingTier: "business" as const, role: "owner" as const, status: "active" as const, idempotencyKey: crypto.randomUUID() };
    const service = new CampaignOperationService();
    const create = () => service.createExportBundle(scope, { clips: [{ clipId: clip.id, expectedEditorRevision: 0 }], aspectRatios: ["9:16"], resolution: "1080p" });
    return { project, clip, scope, create, lifecycle: new WorkflowRunLifecycle({ prisma: db }) };
  }
  test("bundle admission delivers its committed initial operation driver", () => scoped(async () => {
    const f = await fixture();
    const delivered: string[] = [];
    const accepted = await withExecutionDispatches(f.create, { database: db, deliver: async ids => {
      const bundle = await db.exportBundle.findFirstOrThrow({ where: { operation: { idempotencyKey: f.scope.idempotencyKey } } });
      const dispatch = await db.executionDispatch.findFirstOrThrow({ where: { kind: "operation_driver", subjectId: bundle.workflowRunId } });
      expect(ids).toContain(dispatch.id);
      delivered.push(...ids);
    } });
    const driver = await db.executionDispatch.findFirstOrThrow({ where: { kind: "operation_driver", subjectId: accepted.workflowRunId } });
    expect(delivered.filter(id => id === driver.id)).toHaveLength(1);
    expect(await db.executionAttempt.count({ where: { dispatch: { subjectId: accepted.workflowRunId } } })).toBe(0);
  }));
  test("same-key bundle replay redelivers the stored driver after lost registration without changing accepted state", () => scoped(async () => {
    const f = await fixture(), accepted = await f.create();
    const run = await db.workflowRun.findUniqueOrThrow({ where: { id: accepted.workflowRunId } });
    const bundle = await db.exportBundle.findUniqueOrThrow({ where: { operationId: accepted.operationId } });
    const operation = await db.campaignOperation.findUniqueOrThrow({ where: { id: accepted.operationId } });
    const driver = await db.executionDispatch.findFirstOrThrow({ where: { kind: "operation_driver", subjectId: run.id, wakeKind: null, deadlineKind: null } });
    let calls = 0;
    const deliver = async (ids: readonly string[]) => { expect(ids).toContain(driver.id); calls++; if (calls === 1) throw Error("registration_ack_lost"); };
    await expect(withExecutionDispatches(f.create, { database: db, deliver })).rejects.toThrow("registration_ack_lost");
    expect(await withExecutionDispatches(f.create, { database: db, deliver })).toEqual({ ...accepted, replayed: true });
    expect(calls).toBe(2);
    expect(await db.workflowRun.findUniqueOrThrow({ where: { id: run.id } })).toEqual(run);
    expect(await db.exportBundle.findUniqueOrThrow({ where: { id: bundle.id } })).toEqual(bundle);
    expect(await db.campaignOperation.findUniqueOrThrow({ where: { id: operation.id } })).toEqual(operation);
    expect(await db.executionDispatch.findUniqueOrThrow({ where: { id: driver.id } })).toEqual(driver);
    expect(await db.executionAttempt.count({ where: { dispatch: { subjectId: run.id } } })).toBe(0);
    expect(await db.workflowRun.count({ where: { projectId: f.project.id, stage: "export_bundle" } })).toBe(1);
    expect(await db.campaignOperation.count({ where: { projectId: f.project.id } })).toBe(1);
  }));
  test("bundle replay cannot schedule a terminal run or an obsolete generation", () => scoped(async () => {
    const f = await fixture(), accepted = await f.create();
    const before = await db.executionDispatch.count({ where: { subjectId: accepted.workflowRunId } });
    let calls = 0;
    await db.workflowRun.update({ where: { id: accepted.workflowRunId }, data: { generation: { increment: 1 } } });
    await withExecutionDispatches(f.create, { database: db, deliver: async () => { calls++; } });
    expect(calls).toBe(0);
    expect(await db.executionDispatch.count({ where: { subjectId: accepted.workflowRunId } })).toBe(before);
    await db.workflowRun.update({ where: { id: accepted.workflowRunId }, data: { generation: { decrement: 1 }, status: "completed" } });
    await withExecutionDispatches(f.create, { database: db, deliver: async () => { calls++; } });
    expect(calls).toBe(0);
    expect(await db.executionDispatch.count({ where: { subjectId: accepted.workflowRunId } })).toBe(before);
  }));
  test("accepted live dub replay redelivers its exact driver without another reservation or paid intent", () => scoped(async () => {
    const f = await fixture();
    const input = { clipId: f.clip.id, targetLanguageCode: "es", voice: "marin" as const, aspectRatio: "9:16" as const };
    const request = () => dubbingService.requestClipDub(f.scope, f.project.id, "dub-handoff", input);
    const accepted = await request();
    const dub = await db.clipDub.findUniqueOrThrow({ where: { id: accepted.dub.id } });
    const run = await db.workflowRun.findUniqueOrThrow({ where: { id: accepted.workflowRunId! } });
    const usage = await db.generatedMediaUsageReservation.findMany({ where: { jobId: dub.id } });
    const driver = await db.executionDispatch.findFirstOrThrow({ where: { kind: "operation_driver", subjectId: run.id, wakeKind: null, deadlineKind: null } });
    let calls = 0;
    const replay = await withExecutionDispatches(request, { database: db, deliver: async ids => { expect(ids).toContain(driver.id); calls++; } });
    expect(calls).toBe(1);
    expect(replay.dub.id).toBe(dub.id);
    expect(replay.workflowRunId).toBe(run.id);
    expect(await db.clipDub.findUniqueOrThrow({ where: { id: dub.id } })).toEqual(dub);
    expect(await db.workflowRun.findUniqueOrThrow({ where: { id: run.id } })).toEqual(run);
    expect(await db.generatedMediaUsageReservation.findMany({ where: { jobId: dub.id } })).toEqual(usage);
    expect(await db.executionAttempt.count({ where: { dispatch: { subjectId: run.id } } })).toBe(0);
    expect(await db.clipDub.count({ where: { projectId: f.project.id } })).toBe(1);
  }));
  test.each(["stt", "moment_detection", "dubbing"] as const)("atomic %s handoff and replay collect the same operation driver once", stage => scoped(async () => {
    const f = await fixture(), input = { projectId: f.project.id, stage, idempotencyKey: crypto.randomUUID() };
    const batches: string[][] = [];
    const invoke = () => withExecutionDispatches(async () => {
      const first = await f.lifecycle.admitWithHandoff(input, async () => null);
      expect((await f.lifecycle.admitWithHandoff(input, async () => null)).id).toBe(first.id);
      return first;
    }, { database: db, deliver: async ids => { batches.push([...ids]); } });
    const admitted = await invoke();
    const dispatch = await db.executionDispatch.findFirstOrThrow({ where: { subjectId: admitted.id, kind: "operation_driver" } });
    expect(batches.flat().filter(id => id === dispatch.id)).toHaveLength(1);
    expect((await invoke()).id).toBe(admitted.id);
    expect(batches[1]!.filter(id => id === dispatch.id)).toHaveLength(1);
    expect(await db.executionAttempt.count({ where: { dispatch: { subjectId: admitted.id } } })).toBe(0);
  }));
  test("rollback after tentative collection never delivers or persists its run and driver", () => scoped(async () => {
    const f = await fixture(), key = crypto.randomUUID();
    let calls = 0, tentativeId: string | undefined;
    await expect(withExecutionDispatches(() => db.$transaction(async tx => {
      const admitted = await f.lifecycle.admitWithHandoff({ projectId: f.project.id, stage: "export_bundle", idempotencyKey: key }, async handoffTx => handoffTx.project.update({ where: { id: f.project.id }, data: { title: "Tentative handoff" } }), tx);
      tentativeId = (await tx.executionDispatch.findFirstOrThrow({ where: { subjectId: admitted.id } })).id;
      throw Error("handoff_transaction_rolled_back");
    }), { database: db, deliver: async () => { calls++; } })).rejects.toThrow("handoff_transaction_rolled_back");
    expect(calls).toBe(0);
    expect(tentativeId).toBeDefined();
    expect(await db.executionDispatch.findUnique({ where: { id: tentativeId! } })).toBeNull();
    expect((await db.project.findUniqueOrThrow({ where: { id: f.project.id } })).title).toBe(f.project.title);
    expect(await db.workflowRun.count({ where: { projectId: f.project.id, idempotencyKey: key } })).toBe(0);
    expect(await db.executionDispatch.count({ where: { kind: "operation_driver", subjectId: { in: (await db.workflowRun.findMany({ where: { projectId: f.project.id } })).map(run => run.id) } } })).toBe(0);
  }));
});
