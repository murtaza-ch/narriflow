import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { assertExecutionDatabaseTestTarget } from "./execution-db-test-support";
import { createCallbackCipher, prepareCallbackRegistration, receiptCallback, registerUploadCallback, resetCompletionCallbacks } from "./completion-callback";
import { withExecutionDispatches } from "./execution-dispatch-runtime";
import { createWorkspaceNotificationDispatcher, isCurrentNotificationTarget } from "./notification-dispatch";
import { flushWorkspaceEvents, queueWorkspaceEvent } from "./workspace-event";
import { encodeOperationId } from "./operation-status";
import { readExecutionDispatch } from "./execution-dispatch";
import { createOperationReceiptExecutor } from "./operation-receipt";
import { prismaOperationReceiptPersistence } from "./operation-receipt-runtime";
import { withServiceEnvironment } from "./runtime-environment";
import { createWebhookSubscriptions } from "./webhook-subscription";

const url = process.env.SERVERLESS_TEST_DATABASE_URL;
const suite = process.env.ALLOW_SERVERLESS_DB_TESTS === "1" && url ? describe : describe.skip;
suite("Notification producer registration", () => {
  let db: PrismaClient;
  beforeAll(() => {
    const schema = process.env.SERVERLESS_TEST_DATABASE_SCHEMA!;
    assertExecutionDatabaseTestTarget(url, schema);
    if (!schema.startsWith("serverless_execution_test_")) throw new Error("Disposable schema required");
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url, max: 4 }, { schema }) });
  });
  afterAll(async () => { await db?.$disconnect(); });

  async function fixture() {
    const user = await db.user.create({ data: { clerkId: `notification-producer:${crypto.randomUUID()}` } });
    const workspace = await db.workspace.create({ data: { name: "Notification producer gate", ownerUserId: user.id, personalOwnerUserId: user.id, pricingTier: "pro" } });
    const cipher = createCallbackCipher("notification-producer-gate");
    await db.callbackSigningSecret.create({ data: { workspaceId: workspace.id, encryptedSecret: cipher.seal(`whsec_${Buffer.alloc(32, 1).toString("base64")}`) } });
    return { workspace, registration: prepareCallbackRegistration(new URL("https://receiver.example/callback"), cipher) };
  }

  test("an accepted callback confirms its committed registration; a rolled-back callback cannot escape", async () => {
    const f = await fixture();
    const delivered: string[] = [];
    const options = { database: db, deliver: async (ids: readonly string[]) => {
      const rows = await db.executionDispatch.findMany({ where: { id: { in: [...ids] } } });
      expect(rows).toHaveLength(ids.length);
      delivered.push(...ids);
    } };
    const input = { workspaceId: f.workspace.id, sessionId: crypto.randomUUID(), registration: f.registration };
    await withExecutionDispatches(() => db.$transaction(tx => registerUploadCallback(tx, input)), options);
    expect(delivered).toHaveLength(1);
    expect((await db.executionDispatch.findUniqueOrThrow({ where: { id: delivered[0] } })).subjectKind).toBe("completion_callback");
    await expect(withExecutionDispatches(() => db.$transaction(async tx => {
      await registerUploadCallback(tx, { ...input, sessionId: crypto.randomUUID() });
      throw new Error("rollback");
    }), options)).rejects.toThrow("rollback");
    expect(delivered).toHaveLength(1);
    await db.workspace.delete({ where: { id: f.workspace.id } });
    await db.user.delete({ where: { id: f.workspace.ownerUserId } });
    await db.executionDispatch.deleteMany({ where: { id: { in: delivered } } });
  });

  test("a transaction registers one Workspace drain, then bounded event and recipient pages", async () => {
    const f = await fixture();
    const operationId = crypto.randomUUID();
    const callbacks = await db.completionCallback.createManyAndReturn({ data: Array.from({ length: 205 }, () => ({
      workspaceId: f.workspace.id, operationKind: "generation", operationId, receiptId: crypto.randomUUID(), ...f.registration, eventId: crypto.randomUUID(),
    })) });
    await db.webhookSubscription.createMany({ data: Array.from({ length: 10 }, (_, index) => ({ workspaceId: f.workspace.id, ...f.registration, urlFingerprint: `subscription-${index}`, types: ["operation.finished"], lastDeliveredSeq: 0n })) });
    const confirmed: string[] = [];
    const options = { database: db, deliver: async (ids: readonly string[]) => { confirmed.push(...ids); } };
    await withExecutionDispatches(() => db.$transaction(async tx => {
      for (let index = 0; index < 205; index++) queueWorkspaceEvent(tx, {
        workspaceId: f.workspace.id, projectId: null, type: "operation.finished", dedupeKey: `notification:${f.workspace.id}:${index}`,
        subject: { operation: { kind: "generation", id: encodeOperationId({ kind: "generation", id: operationId }) }, projectId: null, state: "completed" },
      });
      await flushWorkspaceEvents(tx);
    }), options);
    expect(confirmed).toHaveLength(1);
    const dispatcher = createWorkspaceNotificationDispatcher(options);
    const first = (await readExecutionDispatch(db, confirmed[0]!))!;
    const page = await dispatcher.dispatch(first.reference);
    expect(page.dispatchIds).toHaveLength(101);
    const event = await db.executionDispatch.findFirstOrThrow({ where: { id: { in: page.dispatchIds }, subjectKind: "workspace_event" }, orderBy: { subjectId: "asc" } });
    const eventRef = (await readExecutionDispatch(db, event.id))!.reference;
    const recipients = await dispatcher.dispatch(eventRef);
    expect(recipients.dispatchIds).toHaveLength(111);
    expect(await db.executionDispatch.count({ where: { id: { in: recipients.dispatchIds }, subjectKind: "completion_callback" } })).toBe(100);
    expect(await db.executionDispatch.count({ where: { id: { in: recipients.dispatchIds }, subjectKind: "webhook_subscription" } })).toBe(10);
    const next = await db.executionDispatch.findFirstOrThrow({ where: { id: { in: recipients.dispatchIds }, subjectKind: "workspace_event" } });
    expect((await dispatcher.dispatch((await readExecutionDispatch(db, next.id))!.reference)).dispatchIds).toHaveLength(101);
    expect((await dispatcher.dispatch(eventRef)).dispatchIds).toEqual(recipients.dispatchIds);
    expect((await dispatcher.dispatch({ ...eventRef, inputHash: "0".repeat(64) })).dispatchIds).toEqual([]);
    await db.workspace.delete({ where: { id: f.workspace.id } });
    await db.user.delete({ where: { id: f.workspace.ownerUserId } });
    await db.executionDispatch.deleteMany({ where: { OR: [{ subjectId: { in: callbacks.map(row => row.id) } }, { id: { in: [...new Set(confirmed)] } }] } });
  });

  test("a lost scheduler acknowledgement replays initial and reset callback receipt wakes without another mutation", async () => {
    const f = await fixture();
    const executor = createOperationReceiptExecutor(prismaOperationReceiptPersistence(db));
    const actor = { workspaceId: f.workspace.id, actorUserId: f.workspace.ownerUserId };
    const operation = { kind: "generation" as const, id: crypto.randomUUID() };
    const attempted: string[][] = [];
    let loseAck = true, mutations = 0;
    const options = { database: db, deliver: async (ids: readonly string[]) => { attempted.push([...ids]); if (loseAck) throw new Error("lost scheduler acknowledgement"); } };
    const callback = withServiceEnvironment({ SOCIAL_TOKEN_ENCRYPTION_KEY: "notification-producer-gate" }, () => receiptCallback(f.workspace.id, {
      clientIdempotencyKey: "initial", callback: { url: new URL("https://receiver.example/callback") },
    }, () => operation));
    const request = { identity: { ...actor, command: "submit_video" as const, clientIdempotencyKey: "initial" }, input: { video: "fixed" },
      authorize: async () => {}, callback, mutate: async () => { mutations++; return { resourceType: "workflow_run", resourceId: operation.id, value: { operationId: operation.id } }; } };
    await expect(withExecutionDispatches(() => executor.execute(request), options)).rejects.toThrow("lost scheduler acknowledgement");
    loseAck = false;
    expect((await withExecutionDispatches(() => executor.execute(request), options)).replayed).toBe(true);
    expect(attempted[1]).toEqual(attempted[0]);
    expect(mutations).toBe(1);
    const beforeConflict = attempted.length;
    await expect(withExecutionDispatches(() => executor.execute({ ...request, input: { video: "changed" } }), options)).rejects.toMatchObject({ code: "operation_idempotency_conflict" });
    expect(attempted).toHaveLength(beforeConflict);
    await db.completionCallback.updateMany({ where: { workspaceId: f.workspace.id }, data: { state: "delivered", attempts: 3, deliveredAt: new Date() } });
    const resetRequest = { identity: { ...actor, command: "redeliver_callback" as const, clientIdempotencyKey: "reset" }, input: { operation }, authorize: async () => {},
      mutate: async (tx: Parameters<typeof resetCompletionCallbacks>[0], context: { receiptId: string }) => {
        mutations++;
        return { resourceType: "completion_callback", resourceId: operation.id, value: { callbacks: await resetCompletionCallbacks(tx, actor, operation, new Date(), context.receiptId) } };
      } };
    loseAck = true;
    await expect(withExecutionDispatches(() => executor.execute(resetRequest), options)).rejects.toThrow("lost scheduler acknowledgement");
    loseAck = false;
    expect((await withExecutionDispatches(() => executor.execute(resetRequest), options)).replayed).toBe(true);
    expect(attempted[3]).toEqual(attempted[2]);
    expect(attempted[2]).not.toEqual(attempted[0]);
    expect(mutations).toBe(2);
    expect(await db.completionCallback.findFirst({ where: { workspaceId: f.workspace.id } })).toMatchObject({ state: "pending", attempts: 0 });
    await db.workspace.delete({ where: { id: f.workspace.id } });
    await db.user.delete({ where: { id: f.workspace.ownerUserId } });
    await db.executionDispatch.deleteMany({ where: { id: { in: attempted.flat() } } });
  });

  test("enabling a subscription confirms a fresh wake and rejects changed immutable target inputs", async () => {
    const f = await fixture();
    const service = createWebhookSubscriptions({ prisma: db, cipher: createCallbackCipher("notification-producer-gate") });
    const actor = { workspaceId: f.workspace.id, actorUserId: f.workspace.ownerUserId };
    const confirmed: string[] = [];
    const options = { database: db, deliver: async (ids: readonly string[]) => { confirmed.push(...ids); } };
    const sub = await withExecutionDispatches(() => service.create(actor, { url: new URL("https://receiver.example/webhook"), types: ["operation.finished"] }), options);
    expect(confirmed).toHaveLength(1);
    const original = (await readExecutionDispatch(db, confirmed[0]!))!;
    expect(await isCurrentNotificationTarget(db, original.reference)).toBe(true);
    expect(await isCurrentNotificationTarget(db, { ...original.reference, inputHash: "0".repeat(64) })).toBe(false);
    await db.webhookSubscription.update({ where: { id: sub.webhookId }, data: { status: "disabled", disabledReason: "delivery_failed", disabledAt: new Date() } });
    const enabled = await withExecutionDispatches(() => service.enable(actor, sub.webhookId), options);
    expect(enabled.status).toBe("active");
    expect(confirmed).toHaveLength(2);
    expect(confirmed[1]).not.toBe(confirmed[0]);
    expect(await isCurrentNotificationTarget(db, (await readExecutionDispatch(db, confirmed[1]!))!.reference)).toBe(true);
    await db.webhookSubscription.update({ where: { id: sub.webhookId }, data: { types: ["finishing.finished"] } });
    expect(await isCurrentNotificationTarget(db, original.reference)).toBe(false);
    await db.workspace.delete({ where: { id: f.workspace.id } });
    await db.user.delete({ where: { id: f.workspace.ownerUserId } });
    await db.executionDispatch.deleteMany({ where: { id: { in: confirmed } } });
  });
});
