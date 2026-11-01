import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { createDatabaseScope, withDatabaseScope } from "@narriflow/db/client";
import { withServiceEnvironment } from "@narriflow/services/runtime-environment";
import { withExecutionDispatchScheduler } from "@narriflow/services/execution-dispatch-runtime";
import { assertExecutionDatabaseTestTarget } from "@narriflow/services/execution-db-test-support";
import { readExecutionDispatch } from "@narriflow/services/execution-dispatch";
import { createMediaCleanupControl, queueMediaCleanupWithinTransaction } from "@narriflow/services/media-cleanup-control";
import { mediaCleanupObjectRetainUntil } from "@narriflow/services/media-cleanup-holds";
import { createWorkerExecutionScheduler } from "./scheduler";
import { dispatchContinuationInstanceId } from "./protocol";
import type { ApiWorkerBindings } from "../worker-bindings";
import { getWorkerMaintenanceRuntime } from "./maintenance-runtime";

const url = process.env.SERVERLESS_TEST_DATABASE_URL;
const suite = process.env.ALLOW_SERVERLESS_DB_TESTS === "1" && url ? describe : describe.skip;

suite("Production API Maintenance composition", () => {
  let database: PrismaClient;
  const schema = process.env.SERVERLESS_TEST_DATABASE_SCHEMA!;
  const client = () => new PrismaClient({ adapter: new PrismaPg({ connectionString: url!, max: 2 }, { schema }), transactionOptions: { timeout: 30_000, maxWait: 10_000 } });
  beforeAll(() => { assertExecutionDatabaseTestTarget(url, schema); database = client(); });
  afterAll(async () => { await database?.$disconnect(); });

  test("all actual hourly and daily planners stop on an empty schema without provider HTTP or executor admission", async () => {
    const registered: string[] = [];
    const http = spyOn(globalThis, "fetch").mockImplementation(async () => { throw Error("Empty maintenance must not call a provider"); });
    const environment = { R2_ACCOUNT_ID: "a".repeat(32), R2_BUCKET: "synthetic-empty-maintenance", R2_ACCESS_KEY_ID: "synthetic", R2_SECRET_ACCESS_KEY: "synthetic", MEDIA_RENDER_TOOLCHAIN_FINGERPRINT: "b".repeat(64) };
    const invoke = <T>(operation: () => Promise<T>) => withServiceEnvironment(environment, () => withExecutionDispatchScheduler({
      deliver: async delivery => { registered.push(delivery.reference.dispatchId); return { status: "confirmed_created", destinationId: delivery.instanceId }; },
    }, () => withDatabaseScope(createDatabaseScope({ createClient: () => { const db = client(); return { client: db, dispose: () => db.$disconnect() }; } }), operation)));
    try {
      for (const cadence of ["hourly", "daily"] as const) {
        await invoke(async () => (await getWorkerMaintenanceRuntime()).scheduled({ cadence, scheduledAt: new Date(0), admissionState: "closed" }));
        const dispatch = await readExecutionDispatch(database, registered.at(-1)!);
        expect(dispatch?.reference.subject.id.startsWith(`mt1.${cadence === "hourly" ? "h" : "d"}.`)).toBe(true);
        expect(await invoke(async () => (await getWorkerMaintenanceRuntime()).run(dispatch!.reference))).toEqual({ kind: "complete" });
      }
      expect(registered).toHaveLength(2);
      expect(await database.executionInboxReceipt.count({ where: { audience: "maintenance-page" } })).toBe(2);
      expect(await database.executionAttempt.count()).toBe(0);
      expect(await database.mediaCleanupObligation.count()).toBe(0);
      expect(http).not.toHaveBeenCalled();
    } finally { http.mockRestore(); }
  });

  test("hourly cleanup recovery reaches an independent Maintenance command after its acknowledged driver errored", async () => {
    const intent = await database.mediaCleanupObligation.create({ data: { origin: "clip_editor_document_persistence", cleanupClass: "mutable_render", objectKey: `fixture/${crypto.randomUUID()}.mp4`, nextAttemptAt: new Date(0) } });
    const base = (await database.$transaction(tx => queueMediaCleanupWithinTransaction(tx, intent.id)))!;
    await database.executionDispatch.update({ where: { id: base.dispatchId }, data: { acknowledgedAt: new Date(), destinationId: "errored-cleanup-driver" } });
    const before = await database.executionDispatch.findUniqueOrThrow({ where: { id: base.dispatchId } });
    const commands: Array<{ id: string; params: unknown }> = [];
    const bindings = { OPERATION_DRIVER: { get: async () => ({ sendEvent: async () => { throw Error("Errored original driver"); } }) },
      MAINTENANCE: { create: async (input: { id: string; params: unknown }) => { commands.push(input); return { id: input.id }; } } } as unknown as ApiWorkerBindings;
    const environment = { R2_ACCOUNT_ID: "a".repeat(32), R2_BUCKET: "synthetic-cleanup-maintenance", R2_ACCESS_KEY_ID: "synthetic", R2_SECRET_ACCESS_KEY: "synthetic", MEDIA_RENDER_TOOLCHAIN_FINGERPRINT: "b".repeat(64) };
    const invoke = <T>(operation: () => Promise<T>) => withServiceEnvironment(environment, () => withExecutionDispatchScheduler(createWorkerExecutionScheduler(bindings), () =>
      withDatabaseScope(createDatabaseScope({ createClient: () => { const db = client(); return { client: db, dispose: () => db.$disconnect() }; } }), operation)));
    await invoke(async () => (await getWorkerMaintenanceRuntime()).scheduled({ cadence: "hourly", scheduledAt: new Date(), admissionState: "closed" }));
    for (let index = 0; index < commands.length; index++) {
      const command = commands[index]!;
      if ((command.params as typeof base).subject.kind === "maintenance") await invoke(async () => (await getWorkerMaintenanceRuntime()).run(command.params as typeof base));
    }
    const wake = commands.map(command => command.params as typeof base).find(reference => reference.subject.kind === "media_cleanup");
    expect(wake).toBeDefined();
    expect(commands.find(command => command.params === wake)?.id).toBe(dispatchContinuationInstanceId(wake!));
    expect(await database.executionDispatch.findUniqueOrThrow({ where: { id: base.dispatchId } })).toEqual(before);
    let deletes = 0;
    const cleanup = createMediaCleanupControl({ database, register: async () => {}, hold: mediaCleanupObjectRetainUntil, storage: { deleteExact: async key => { expect(key).toBe(intent.objectKey); deletes++; } } });
    expect(await cleanup.run(wake!)).toMatchObject({ kind: "complete" });
    expect(deletes).toBe(1);
    expect((await database.mediaCleanupObligation.findUniqueOrThrow({ where: { id: intent.id } })).completedAt).not.toBeNull();
    expect(await cleanup.run(wake!)).toMatchObject({ kind: "complete" });
    expect(deletes).toBe(1);
  });
});
