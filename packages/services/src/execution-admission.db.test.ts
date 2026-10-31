import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { assertExecutionDatabaseTestTarget } from "./execution-db-test-support";
import { readExecutionAdmission, assertExecutionAdmissionOpen } from "./execution-admission";
import { ProcessingUsage } from "./processing-usage";

const url = process.env.SERVERLESS_TEST_DATABASE_URL;
const suite = process.env.ALLOW_SERVERLESS_DB_TESTS === "1" && url ? describe : describe.skip;
suite("Execution admission authority", () => {
  let db: PrismaClient;
  beforeAll(() => {
    const schema = process.env.SERVERLESS_TEST_DATABASE_SCHEMA!;
    assertExecutionDatabaseTestTarget(url, schema);
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url, max: 5 }, { schema }), transactionOptions: { timeout: 10_000, maxWait: 10_000 } });
  });
  afterAll(async () => { await db?.$disconnect(); });
  test("closing admission rolls back a new usage reservation, while its existing reservation remains replayable", async () => {
    const user = await db.user.create({ data: { clerkId: `admission:${crypto.randomUUID()}` } });
    const workspace = await db.workspace.create({ data: { name: "Admission", ownerUserId: user.id } });
    const usage = new ProcessingUsage({ prisma: db, log: () => {} });
    const input = { projectId: crypto.randomUUID(), workspaceId: workspace.id, actorUserId: user.id, intakeKind: "link" as const, declaredSeconds: 10 };
    await db.executionEpoch.update({ where: { id: 1 }, data: { admissionOpen: true } });
    const first = await db.$transaction(tx => usage.reserve(tx, input));
    await db.executionEpoch.update({ where: { id: 1 }, data: { admissionOpen: false } });
    try {
      const next = { ...input, projectId: crypto.randomUUID() };
      await expect(db.$transaction(tx => usage.reserve(tx, next))).rejects.toMatchObject({ code: "execution_admission_closed", kind: "unavailable" });
      expect(await db.processingUsageReservation.findUnique({ where: { projectId: next.projectId } })).toBeNull();
      expect(await db.$transaction(tx => usage.reserve(tx, input))).toMatchObject({ projectId: first.projectId, reservedSeconds: first.reservedSeconds, replayed: true });
    } finally { await db.executionEpoch.update({ where: { id: 1 }, data: { admissionOpen: true } }); }
  });
  test("the close transaction waits for an admitted transaction and every later admission sees closed", async () => {
    await db.executionEpoch.update({ where: { id: 1 }, data: { admissionOpen: true } });
    let enter!: () => void, finish!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const finished = new Promise<void>(resolve => { finish = resolve; });
    const inFlight = db.$transaction(async tx => { const state = await readExecutionAdmission(tx); assertExecutionAdmissionOpen(state); enter(); await finished; });
    await entered;
    let closed = false;
    const close = db.executionEpoch.update({ where: { id: 1 }, data: { admissionOpen: false } }).then(() => { closed = true; });
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(closed).toBe(false);
    finish(); await inFlight; await close;
    try {
      await expect(db.$transaction(async tx => { assertExecutionAdmissionOpen(await readExecutionAdmission(tx)); })).rejects.toMatchObject({ code: "execution_admission_closed" });
    } finally { await db.executionEpoch.update({ where: { id: 1 }, data: { admissionOpen: true } }); }
  });
});
