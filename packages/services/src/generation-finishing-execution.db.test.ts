import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { assertExecutionDatabaseTestTarget } from "./execution-db-test-support";
import { createGenerationFinishing, FINISHING_MAX_WAIT_MS, freezeGenerationFinishing, queueGenerationFinishing, transitionGenerationFinishing, type GenerationFinishingDependencies } from "./generation-finishing";

const url = process.env.SERVERLESS_TEST_DATABASE_URL;
const suite = process.env.ALLOW_SERVERLESS_DB_TESTS === "1" && url ? describe : describe.skip;
suite("Targeted generation finishing obligations", () => {
  let db: PrismaClient;
  const users: string[] = [], workspaces: string[] = [], finishings: string[] = [];
  beforeAll(() => {
    const schema = process.env.SERVERLESS_TEST_DATABASE_SCHEMA ?? "public";
    assertExecutionDatabaseTestTarget(url,schema);
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url, max: 5 }, { schema }), transactionOptions: { timeout: 30_000, maxWait: 10_000 } });
  });
  afterEach(async () => {
    await db.executionDispatch.deleteMany({ where: { subjectKind: "generation_finishing", subjectId: { in: finishings } } });
    await db.workspace.deleteMany({ where: { id: { in: workspaces } } });
    await db.user.deleteMany({ where: { id: { in: users } } });
    users.length = workspaces.length = finishings.length = 0;
  });
  afterAll(async () => { await db.$disconnect(); });
  async function fixture() {
    const user = await db.user.create({ data: { clerkId: `finishing-execution:${crypto.randomUUID()}` } }); users.push(user.id);
    const workspace = await db.workspace.create({ data: { name: "Finishing gate", ownerUserId: user.id, pricingTier: "business" } }); workspaces.push(workspace.id);
    const project = await db.project.create({ data: { workspaceId: workspace.id, title: "Finishing gate", sourceMediaUrl: "r2://synthetic/source" } });
    const origin = await db.workflowRun.create({ data: { projectId: project.id, stage: "stt", status: "completed", idempotencyKey: crypto.randomUUID() } });
    await db.$transaction(tx => freezeGenerationFinishing(tx, { workspaceId: workspace.id, projectId: project.id, originRunId: origin.id, actorUserId: user.id,
      settings: { topClips: 2, minScore: 0, resolution: "720p", copyPlatforms: [], delivery: "ready_to_review", queueAccountIds: [] }, defaultAspectRatio: "9:16" }));
    const row = await db.generationFinishing.findUniqueOrThrow({ where: { originRunId: origin.id } }); finishings.push(row.id);
    return { row, origin };
  }
  test("generation settlement atomically freezes a database-clock deadline and one replayable wake", async () => {
    const { row, origin } = await fixture();
    expect(await db.executionDispatch.count({ where: { subjectId: row.id } })).toBe(0);
    await db.$transaction(tx => transitionGenerationFinishing(tx,origin.id,"completed",new Date(0)));
    const first = await db.generationFinishing.findUniqueOrThrow({ where: { id: row.id } });
    expect(first).toMatchObject({ state: "due", generation: 1, attempts: 0, claimToken: null, leaseExpiresAt: null });
    expect(first.dueAt!.getTime()).toBeGreaterThan(Date.now()-30_000);
    expect(first.operationDeadlineAt!.getTime()-first.dueAt!.getTime()).toBe(FINISHING_MAX_WAIT_MS);
    const reference = await db.$transaction(tx => queueGenerationFinishing(tx,row.id));
    await db.$transaction(tx => transitionGenerationFinishing(tx,origin.id,"completed"));
    expect(await db.$transaction(tx => queueGenerationFinishing(tx,row.id))).toEqual(reference);
    expect(await db.executionDispatch.count({ where: { subjectId: row.id } })).toBe(1);
    expect((await db.generationFinishing.findUniqueOrThrow({ where: { id: row.id } })).operationDeadlineAt).toEqual(first.operationDeadlineAt);
    await expect(Promise.resolve(db.generationFinishing.update({ where: { id: row.id }, data: { operationDeadlineAt: new Date(first.operationDeadlineAt!.getTime()+1) } }))).rejects.toThrow("generation finishing input is immutable");
    await expect(Promise.resolve(db.generationFinishing.update({ where: { id: row.id }, data: { autopilotAuthority: { inventedGrant: crypto.randomUUID() } } }))).rejects.toThrow("generation finishing input is immutable");
  });
  test("rolled-back settlement creates neither a due job nor an orphan dispatch", async () => {
    const { row, origin } = await fixture();
    await expect(db.$transaction(async tx => { await transitionGenerationFinishing(tx,origin.id,"completed"); throw Error("injected_finishing_rollback"); })).rejects.toThrow("injected_finishing_rollback");
    expect(await db.generationFinishing.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({ state: "waiting", generation: 0, dueAt: null, operationDeadlineAt: null });
    expect(await db.executionDispatch.count({ where: { subjectId: row.id } })).toBe(0);
  });
  function driver(overrides: Partial<GenerationFinishingDependencies> = {}) {
    const unexpected = async (): Promise<never> => { throw Error("No clips must create no child work"); };
    return createGenerationFinishing({ prisma: db, register: async () => {}, requireActor: async () => ({ pricingTier: "business" }), canManagePublishing: async () => true,
      createExport: unexpected, retryExport: unexpected, writeCopy: unexpected, queueAccounts: async () => [], propose: unexpected,
      acceptUnderGrant: unexpected, sendReviewRound: unexpected, notify: unexpected, ...overrides });
  }
  async function due() {
    const value = await fixture();
    await db.$transaction(tx => transitionGenerationFinishing(tx,value.origin.id,"completed"));
    return { ...value, reference: (await db.$transaction(tx => queueGenerationFinishing(tx,value.row.id)))! };
  }
  test("one exact driver confirms its watchdog before work and a concurrent duplicate waits", async () => {
    const first = await due(), unrelated = await due(); let calls = 0, registrations = 0;
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { entered=resolve; }), barrier = new Promise<void>(resolve => { release=resolve; });
    const service = driver({ register: async ids => { expect(ids.length).toBeGreaterThan(0); registrations++; }, requireActor: async () => {
      calls++; expect(registrations).toBeGreaterThan(0); entered(); await barrier; return { pricingTier: "business" }; } });
    const pending = service.run(first.reference); await started;
    expect((await service.run(first.reference)).kind).toBe("wait"); expect(calls).toBe(1);
    release(); expect((await pending).kind).toBe("complete");
    expect(await db.generationFinishing.findUniqueOrThrow({ where: { id: first.row.id } })).toMatchObject({ state: "skipped", reason: "no_clips", claimToken: null, leaseExpiresAt: null, attempts: 0 });
    expect(await db.generationFinishing.findUniqueOrThrow({ where: { id: unrelated.row.id } })).toMatchObject({ state: "due", attempts: 0 });
    expect((await service.run(first.reference)).kind).toBe("complete"); expect(calls).toBe(1);
  });
  test("an unconfirmed watchdog leaves the exact job uncharged and starts no child action", async () => {
    const value = await due(); let actors=0;
    const before = await db.generationFinishing.findUniqueOrThrow({ where: { id: value.row.id } });
    await expect(driver({ register: async () => { throw Error("watchdog_unconfirmed"); }, requireActor: async () => { actors++; return { pricingTier:"business" }; } }).run(value.reference)).rejects.toThrow("watchdog_unconfirmed");
    expect(actors).toBe(0);
    expect(await db.generationFinishing.findUniqueOrThrow({ where: { id: value.row.id } })).toMatchObject({ state: "due", attempts: 0, generation: before.generation, operationDeadlineAt: before.operationDeadlineAt, claimToken: null, leaseExpiresAt: null });
  });
});
