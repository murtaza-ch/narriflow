import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { assertExecutionDatabaseTestTarget } from "./execution-db-test-support";
import { appendExecutionDispatch } from "./execution-dispatch";
import { createModalDispatch } from "./modal-dispatch";
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
  async function fixture() {
    const epoch = await db.executionEpoch.findUniqueOrThrow({ where: { id: 1 } });
    const record = await db.$transaction(tx => appendExecutionDispatch(tx, { deploymentEpoch: epoch.epoch, generation: 1,
      kind: "modal_execution", subject: { kind: "native_validation", id: crypto.randomUUID() }, inputHash: "a".repeat(64), dueAt: new Date() }));
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
  test("ambiguous attempt rows cannot cause an arbitrary native spawn", async () => {
    const f = await fixture();
    await db.executionAttempt.create({ data: { attemptToken: crypto.randomUUID(), dispatchId: f.reference.dispatchId,
      deploymentEpoch: f.reference.deploymentEpoch, generation: 1, inputHash: f.reference.inputHash, functionName: "asset_validation", operationDeadlineAt: new Date(Date.now() + 600_000) } });
    await expect(f.service.spawn(f.reference)).rejects.toMatchObject({ code: "invalid_dispatch" });
    expect(f.calls.length).toBe(0);
  });
});
