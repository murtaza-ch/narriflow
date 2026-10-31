import {DatabaseScope} from "@narriflow/db/client";
import {deliverExecutionDispatches,withExecutionDispatchScheduler} from "./execution-dispatch-runtime";
import { assertExecutionDatabaseTestTarget } from "./execution-db-test-support";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import {
  appendExecutionDispatch, appendExecutionDispatches, createExecutionDispatch, ExecutionDispatchError, ExecutionDispatchPendingError,
  type AppendExecutionDispatchInput, type ExecutionDispatchDatabase, type ExecutionDispatchScheduler,
} from "./execution-dispatch";

const databaseUrl = process.env.SERVERLESS_TEST_DATABASE_URL;
const enabled = process.env.ALLOW_SERVERLESS_DB_TESTS === "1" && Boolean(databaseUrl);
const dbDescribe = enabled ? describe : describe.skip;


dbDescribe("Transactional Execution Dispatch", () => {
  let database: PrismaClient;
  let currentEpoch: number;
  let fixtureIds: string[] = [];
  beforeAll(async () => {
    assertExecutionDatabaseTestTarget(databaseUrl, process.env.SERVERLESS_TEST_DATABASE_SCHEMA ?? "public");
    const schema = process.env.SERVERLESS_TEST_DATABASE_SCHEMA ?? "public";
    if (schema !== "public" && !/^serverless_execution_test_[a-z0-9]+$/.test(schema)) throw new Error("A disposable execution schema is required");
    database = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl, max: 4 }, { schema }), transactionOptions: { timeout: 20_000, maxWait: 20_000 } });
    const [actual] = await database.$queryRaw<Array<{ schema: string }>>`SELECT current_schema() AS "schema"`;
    if (actual?.schema !== schema) throw new Error("Wrong execution gate schema");
    const row = await database.executionEpoch.findUniqueOrThrow({ where: { id: 1 } });
    currentEpoch = row.epoch;
  }, 60_000);
  afterEach(async () => {
    if (database && fixtureIds.length) await database.executionDispatch.deleteMany({ where: { id: { in: fixtureIds } } });
    fixtureIds = [];
  }, 60_000);
  afterAll(async () => { await database?.$disconnect(); });

  function command(changes: Partial<AppendExecutionDispatchInput> = {}): AppendExecutionDispatchInput {
    return { deploymentEpoch: currentEpoch, kind: "import_pipeline", subject: { kind: "ingest_job", id: crypto.randomUUID() }, generation: 1,
      inputHash: "a".repeat(64), dueAt: new Date("2026-10-31T00:00:00.000Z"), ...changes };
  }
  async function append(input = command()) {
    const record = await database.$transaction((tx) => appendExecutionDispatch(tx, input));
    fixtureIds.push(record.reference.dispatchId);
    return record;
  }
  const scheduler: ExecutionDispatchScheduler = { deliver: async ({ instanceId }) => ({ status: "confirmed_created", destinationId: instanceId }) };
  function service(port: ExecutionDispatchScheduler = scheduler, maxDeliveryAttempts = 20) {
    return createExecutionDispatch({ database, scheduler: port, options: { retryBaseMs: 1, retryMaxMs: 1, maxDeliveryAttempts } });
  }
  async function ready(id: string) {
    await database.executionDispatch.update({ where: { id }, data: { nextDeliveryAt: new Date(0) } });
  }
  function barrier<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((settle) => { resolve = settle; });
    return { promise, resolve };
  }

  test("future domain due time registers immediately before acceptance", async () => {
    const input = command({ dueAt: new Date("2099-01-01T00:00:00.000Z") });
    const record = await append(input);
    expect(record.nextDeliveryAt < record.dueAt).toBe(true);
    const receipt = { id: crypto.randomUUID(), operationId: "intake:fixed" };
    const result = await service().confirmAccepted([record.reference.dispatchId], receipt);
    expect(result).toEqual({ accepted: true, receipt });
    expect(result.receipt).toBe(receipt);
  }, 60_000);

  test("concurrent append replays one identity and changed input or due time conflicts", async () => {
    const input = command();
    const [first, replay] = await Promise.all([append(input), append(input)]);
    expect(replay.reference.dispatchId).toBe(first.reference.dispatchId);
    await expect(append({ ...input, inputHash: "b".repeat(64) })).rejects.toMatchObject({ code: "dispatch_conflict" });
    await expect(append({ ...input, dueAt: new Date("2026-11-01T00:00:00.000Z") })).rejects.toMatchObject({ code: "dispatch_conflict" });
    expect((await service().read(first.reference.dispatchId))?.reference.inputHash).toBe(input.inputHash);
  }, 60_000);

  test("bounded fan-out replays exact identities and a conflicting member rolls back the entire new page", async () => {
    const inputs = [command(), command()];
    const first = await database.$transaction(tx => appendExecutionDispatches(tx, inputs));
    fixtureIds.push(...first.map(row => row.reference.dispatchId));
    expect((await database.$transaction(tx => appendExecutionDispatches(tx, inputs))).map(row => row.reference)).toEqual(first.map(row => row.reference));
    const unrelated = command();
    await expect(database.$transaction(tx => appendExecutionDispatches(tx, [unrelated, { ...inputs[0]!, inputHash: "b".repeat(64) }]))).rejects.toMatchObject({ code: "dispatch_conflict" });
    expect(await database.executionDispatch.count({ where: { subjectId: unrelated.subject.id } })).toBe(0);
    await expect(database.$transaction(tx => appendExecutionDispatches(tx, Array.from({ length: 129 }, () => command())))).rejects.toMatchObject({ code: "invalid_dispatch" });
  });

  test("rollback cannot leave an orphan scheduler obligation", async () => {
    let dispatchId = "";
    await expect(database.$transaction(async (tx) => {
      const record = await appendExecutionDispatch(tx, command());
      dispatchId = record.reference.dispatchId;
      throw new Error("injected domain rollback");
    })).rejects.toThrow("injected domain rollback");
    expect(await service().read(dispatchId)).toBeNull();
    expect(await service().deliver(dispatchId)).toEqual({ status: "missing", dispatchId });
  }, 60_000);

  test("lost scheduler acknowledgement preserves receipt and retries the same instance", async () => {
    const registered = new Set<string>();
    let loseResponse = true;
    const port: ExecutionDispatchScheduler = { deliver: async ({ instanceId }) => {
      const exists = registered.has(instanceId);
      registered.add(instanceId);
      if (loseResponse) { loseResponse = false; throw new ExecutionDispatchError("confirmation_unknown"); }
      return { status: exists ? "confirmed_existing" : "confirmed_created", destinationId: instanceId };
    } };
    const dispatch = service(port);
    const record = await append();
    const id = record.reference.dispatchId;
    const receipt = { id: crypto.randomUUID() };
    expect(await dispatch.confirmAccepted([id], receipt)).toEqual({ accepted: false, receipt, retryable: true, code: "scheduler_registration_pending", retryAfterSeconds: 1 });
    expect((await dispatch.read(id))?.acknowledgedAt).toBeNull();
    await ready(id);
    expect(await dispatch.confirmAccepted([id], receipt)).toEqual({ accepted: true, receipt });
    expect(registered.size).toBe(1);
    expect((await dispatch.read(id))?.deliveryAttempts).toBe(2);
  }, 60_000);

  test("lost database acknowledgement after commit does not create another scheduler instance", async () => {
    let commits = 0, calls = 0;
    const faulty = {
      $queryRaw: database.$queryRaw.bind(database),
      $transaction: async (action: (tx: unknown) => Promise<unknown>) => {
        const result = await database.$transaction(action);
        if (++commits === 2) throw new Error("injected lost database acknowledgement after commit");
        return result;
      },
    } as unknown as ExecutionDispatchDatabase;
    const dispatch = createExecutionDispatch({ database: faulty, scheduler: { deliver: async ({ instanceId }) => {
      calls++; return { status: "confirmed_created", destinationId: instanceId };
    } } });
    const { reference } = await append();
    const receipt = { id: crypto.randomUUID() };
    expect(await dispatch.confirmAccepted([reference.dispatchId], receipt)).toMatchObject({ accepted: false, receipt, retryable: true });
    expect((await dispatch.read(reference.dispatchId))?.acknowledgedAt).not.toBeNull();
    expect(await dispatch.confirmAccepted([reference.dispatchId], receipt)).toEqual({ accepted: true, receipt });
    expect(calls).toBe(1);
  }, 60_000);

  test("one live delivery owner holds no transaction during the scheduler call", async () => {
    const entered = barrier<void>();
    const release = barrier<void>();
    let calls = 0;
    const dispatch = service({ deliver: async ({ instanceId }) => {
      calls++; entered.resolve(); await release.promise;
      return { status: "confirmed_created", destinationId: instanceId };
    } });
    const record = await append();
    const first = dispatch.deliver(record.reference.dispatchId);
    await entered.promise;
    try {
      const second = await dispatch.deliver(record.reference.dispatchId);
      expect(second).toMatchObject({ status: "pending", reason: "leased" });
      expect(calls).toBe(1);
      expect((await dispatch.read(record.reference.dispatchId))?.nextDeliveryAt).toEqual((second as { retryAt: Date }).retryAt);
      expect(await dispatch.reconcile()).toMatchObject({ inspected: 0, acknowledged: 0 });
    } finally { release.resolve(); }
    expect(await first).toMatchObject({ status: "acknowledged" });
  }, 60_000);

  test("a stale delivery token cannot acknowledge after takeover", async () => {
    const entered = barrier<void>(), release = barrier<void>();
    const dispatch = service({ deliver: async ({ instanceId }) => {
      entered.resolve(); await release.promise;
      return { status: "confirmed_created", destinationId: instanceId };
    } });
    const record = await append();
    const id = record.reference.dispatchId;
    const pending = dispatch.deliver(id);
    await entered.promise;
    try {
      await database.executionDispatch.update({ where: { id }, data: { deliveryToken: crypto.randomUUID(), deliveryLeaseExpiresAt: new Date("2099-01-01T00:00:00.000Z") } });
    } finally { release.resolve(); }
    expect(await pending).toMatchObject({ status: "pending", reason: "lease_lost" });
    expect((await dispatch.read(id))?.acknowledgedAt).toBeNull();
  }, 60_000);

  test("an expired owner cannot acknowledge even without a replacement owner", async () => {
    const entered = barrier<void>(), release = barrier<void>();
    const dispatch = service({ deliver: async ({ instanceId }) => {
      entered.resolve(); await release.promise;
      return { status: "confirmed_created", destinationId: instanceId };
    } });
    const { reference } = await append();
    const pending = dispatch.deliver(reference.dispatchId);
    await entered.promise;
    try { await database.executionDispatch.update({ where: { id: reference.dispatchId }, data: { deliveryLeaseExpiresAt: new Date(0), nextDeliveryAt: new Date(0) } }); }
    finally { release.resolve(); }
    expect(await pending).toMatchObject({ status: "pending", reason: "lease_lost" });
    expect((await dispatch.read(reference.dispatchId))?.acknowledgedAt).toBeNull();
    expect(await service().deliver(reference.dispatchId)).toMatchObject({ status: "acknowledged" });
  }, 60_000);

  test("existing instance alone never acknowledges a child wake", async () => {
    let notify = false;
    const dispatch = service({ deliver: async ({ instanceId }) => ({ status: notify ? "confirmed_notified" : "confirmed_existing", destinationId: instanceId }) });
    const record = await append(command({ wakeKind: "audio_ready" }));
    const id = record.reference.dispatchId;
    expect(await dispatch.deliver(id)).toMatchObject({ status: "pending", reason: "delivery_failed" });
    expect((await dispatch.read(id))?.errorCode).toBe("invalid_confirmation");
    notify = true;
    await ready(id);
    expect(await dispatch.deliver(id)).toMatchObject({ status: "acknowledged" });
  }, 60_000);

  test("another epoch stays visible but cannot be delivered or acknowledged", async () => {
    const entered = barrier<void>(), release = barrier<void>();
    const dispatch = service({ deliver: async ({ instanceId }) => {
      entered.resolve(); await release.promise;
      return { status: "confirmed_created", destinationId: instanceId };
    } });
    const { reference } = await append();
    const pending = dispatch.deliver(reference.dispatchId);
    await entered.promise;
    try { await database.executionDispatch.update({ where: { id: reference.dispatchId }, data: { deploymentEpoch: currentEpoch + 1 } }); }
    finally { release.resolve(); }
    expect(await pending).toEqual({ status: "superseded", dispatchId: reference.dispatchId });
    expect((await dispatch.read(reference.dispatchId))?.acknowledgedAt).toBeNull();
    expect(await dispatch.deliver(reference.dispatchId)).toEqual({ status: "superseded", dispatchId: reference.dispatchId });
    await expect(append(command({ deploymentEpoch: currentEpoch + 1 }))).rejects.toMatchObject({ code: "epoch_superseded" });
  }, 60_000);

  test("bounded retry dead-letters identifier-only failures without another domain attempt", async () => {
    let calls = 0;
    const dispatch = service({ deliver: async () => { calls++; throw new Error("injected secret body must not be retained"); } }, 2);
    const { reference } = await append();
    const id = reference.dispatchId;
    expect(await dispatch.deliver(id)).toMatchObject({ status: "pending" });
    await ready(id);
    expect(await dispatch.deliver(id)).toMatchObject({ status: "dead_lettered", errorCode: "scheduler_unavailable" });
    expect(await dispatch.deliver(id)).toMatchObject({ status: "dead_lettered" });
    expect(calls).toBe(2);
    expect((await dispatch.read(id))?.errorCode).toBe("scheduler_unavailable");
  }, 60_000);

  test("strict registration exposes its persisted retry without creating another domain attempt",async()=>{
    const record=await append();let calls=0;
    const rejected:ExecutionDispatchScheduler={deliver:async()=>{calls++;throw Error("controlled_transport_failure");}};
    let failure:unknown;
    await new DatabaseScope({createClient:()=>({client:database,dispose:async()=>{}})}).run(()=>withExecutionDispatchScheduler(rejected,()=>deliverExecutionDispatches([record.reference.dispatchId]))).catch(error=>{failure=error;});
    expect(failure).toBeInstanceOf(ExecutionDispatchPendingError);
    const persisted=await database.executionDispatch.findUniqueOrThrow({where:{id:record.reference.dispatchId}});
    expect((failure as ExecutionDispatchPendingError).retryAt).toEqual(persisted.nextDeliveryAt);
    expect(persisted).toMatchObject({deliveryAttempts:1,acknowledgedAt:null,errorCode:"scheduler_unavailable"});expect(calls).toBe(1);
    expect(await database.executionAttempt.count({where:{dispatchId:record.reference.dispatchId}})).toBe(0);
  });
  test("hourly safety reconciliation consumes at most one bounded indexed page", async () => {
    await Promise.all(Array.from({ length: 4 }, () => append()));
    const dispatch = service();
    expect(await dispatch.reconcile({ limit: 2 })).toMatchObject({ inspected: 2, acknowledged: 2 });
    expect(await dispatch.reconcile({ limit: 2 })).toMatchObject({ inspected: 2, acknowledged: 2 });
    expect(await dispatch.reconcile({ limit: 2 })).toMatchObject({ inspected: 0, acknowledged: 0, results: [] });
  }, 60_000);
});
