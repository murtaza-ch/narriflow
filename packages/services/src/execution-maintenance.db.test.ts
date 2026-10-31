import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { assertExecutionDatabaseTestTarget } from "./execution-db-test-support";
import { ExecutionMaintenanceService, HOURLY_MAINTENANCE_PHASES, DAILY_MAINTENANCE_PHASES } from "./execution-maintenance";
import { expireMcpTaskPage } from "./execution-maintenance-pages";
import { readExecutionDispatch } from "./execution-dispatch";

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
