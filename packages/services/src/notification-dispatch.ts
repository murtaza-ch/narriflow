import { AsyncLocalStorage } from "node:async_hooks";
import { executionDispatchReferenceSchema, type ExecutionDispatchReference } from "@narriflow/validators/execution";
import { workspaceEventSchema } from "@narriflow/validators";
import type { CompletionCallback, Prisma, PrismaClient, WebhookSubscription } from "@prisma/client";
import { getPrismaClient } from "@narriflow/db/client";
import { appendExecutionDispatch, appendExecutionDispatches, readExecutionDispatch, type AppendExecutionDispatchInput } from "./execution-dispatch";
import { deliverExecutionDispatches } from "./execution-dispatch-runtime";
import { completionCallbackExecutionInputHash, notificationInputHash, webhookSubscriptionExecutionInputHash, workspaceEventExecutionInputHash } from "./notification-identity";
import { decodeOperationId } from "./operation-status";
import type { OperationReceipt } from "./operation-receipt";

type Tx = Prisma.TransactionClient;
const invocation = new AsyncLocalStorage<Set<string>>();
const transactionIds = new WeakMap<Tx, Set<string>>();

export function collectNotificationDispatch(tx: Tx, id: string): void {
  let ids = transactionIds.get(tx);
  if (!ids) { ids = new Set(); transactionIds.set(tx, ids); }
  ids.add(id);
  invocation.getStore()?.add(id);
}

/** Include these IDs in the same native receipt as its domain changes. */
export function takeNotificationDispatchIds(tx: Tx): string[] {
  const ids = transactionIds.get(tx);
  transactionIds.delete(tx);
  return ids ? [...ids] : [];
}

export interface NotificationDispatchScopeOptions {
  database: PrismaClient;
  deliver(ids: readonly string[]): Promise<void>;
}

/** Must run inside the invocation's DB scope. Only explicitly collected,
 * committed notification obligations are read, never the global outbox. */
export async function withNotificationDispatches<T>(operation: () => Promise<T>, options?: NotificationDispatchScopeOptions): Promise<T> {
  if (invocation.getStore()) return operation();
  const deliver = options?.deliver ?? deliverExecutionDispatches;
  return invocation.run(new Set(), async () => {
    let result: T | undefined;
    let failed = false;
    let failure: unknown;
    try { result = await operation(); } catch (error) { failed = true; failure = error; }
    const ids = [...invocation.getStore()!];
    // DO-only invocations must retain the database scope's lazy construction.
    const database = ids.length ? (options?.database ?? getPrismaClient()) : null;
    if (ids.length && !database) throw new Error("Notification dispatch requires a database scope");
    for (let offset = 0; offset < ids.length; offset += 128) {
      // A rolled-back transaction may have collected a tentative UUID. It
      // never escaped into PostgreSQL and cannot be scheduled here.
      const committed = await database!.executionDispatch.findMany({ where: { id: { in: ids.slice(offset, offset + 128) } }, select: { id: true } });
      if (committed.length) await deliver(committed.map(row => row.id));
    }
    if (failed) throw failure;
    return result as T;
  });
}

async function append(tx: Tx, kind: "completion_callback" | "webhook_subscription", id: string, inputHash: string, wakeKind?: string) {
  const { epoch } = await tx.executionEpoch.findUniqueOrThrow({ where: { id: 1 } });
  const record = await appendExecutionDispatch(tx, { deploymentEpoch: epoch, kind: "operation_driver", subject: { kind, id }, generation: 1, inputHash, dueAt: new Date(0), wakeKind });
  collectNotificationDispatch(tx, record.reference.dispatchId);
  return record.reference.dispatchId;
}

export function appendCompletionCallbackDispatch(tx: Tx, row: CompletionCallback, wakeKind?: string) {
  return append(tx, "completion_callback", row.id, completionCallbackExecutionInputHash(row), wakeKind);
}
export function appendWebhookSubscriptionDispatch(tx: Tx, row: WebhookSubscription, wakeKind?: string) {
  return append(tx, "webhook_subscription", row.id, webhookSubscriptionExecutionInputHash(row), wakeKind);
}

export function callbackReceiptWake(receiptId: string): string {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(receiptId)) throw new Error("Invalid callback receipt identity");
  return `receipt_${receiptId.replaceAll("-", "")}`;
}

export async function recoverReceiptNotificationDispatches(tx: Tx, receipt: OperationReceipt): Promise<void> {
  for (const row of await tx.completionCallback.findMany({ where: { receiptId: receipt.id, workspaceId: receipt.workspaceId } })) await appendCompletionCallbackDispatch(tx, row);
  if (receipt.command === "create_webhook" && receipt.resourceType === "webhook_subscription") {
    const row = await tx.webhookSubscription.findFirst({ where: { id: receipt.resourceId, workspaceId: receipt.workspaceId } });
    if (row) await appendWebhookSubscriptionDispatch(tx, row);
  }
  if (receipt.command === "redeliver_callback" && receipt.resourceType === "completion_callback") {
    const result = receipt.result as { callbacks?: Array<{ eventId?: unknown }> } | null;
    if (!result || !Array.isArray(result.callbacks)) throw new Error("Invalid callback reset receipt");
    const eventIds = result.callbacks.map(row => row.eventId);
    if (eventIds.some(id => typeof id !== "string" || !/^[a-f0-9-]{36}$/.test(id))) throw new Error("Invalid callback reset receipt");
    for (let offset = 0; offset < eventIds.length; offset += 100) {
      const rows = await tx.completionCallback.findMany({ where: { workspaceId: receipt.workspaceId, eventId: { in: eventIds.slice(offset, offset + 100) as string[] } }, orderBy: { id: "asc" } });
      for (const row of rows) if (row.state !== "cancelled") await appendCompletionCallbackDispatch(tx, row, callbackReceiptWake(receipt.id));
    }
  }
}

function rangeId(workspaceId: string, after: bigint, through: bigint) {
  return `wn1.${workspaceId.replaceAll("-", "")}.${after}.${through}`;
}
function range(id: string) {
  const match = /^wn1\.([a-f0-9]{32})\.(0|[1-9][0-9]{0,18})\.([1-9][0-9]{0,18})$/.exec(id);
  if (!match) return null;
  const hex = match[1]!, lower = match[2]!, upper = match[3]!;
  const after = BigInt(lower), through = BigInt(upper);
  if (through <= after || through > 9223372036854775807n) return null;
  const workspaceId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  return { workspaceId, after, through };
}

export async function appendWorkspaceNotificationRange(tx: Tx, workspaceId: string, after: bigint, through: bigint, deploymentEpoch?: number) {
  const id = rangeId(workspaceId, after, through);
  if (!range(id)) throw new Error("Invalid Workspace notification range");
  const epoch = deploymentEpoch ?? (await tx.executionEpoch.findUniqueOrThrow({ where: { id: 1 } })).epoch;
  const record = await appendExecutionDispatch(tx, { deploymentEpoch: epoch, kind: "operation_driver", subject: { kind: "maintenance", id }, generation: 1,
    inputHash: notificationInputHash(["workspace-notification-range-v1", id]), dueAt: new Date(0), wakeKind: "notifications" });
  collectNotificationDispatch(tx, record.reference.dispatchId);
  return record.reference.dispatchId;
}

/** The exact stored tuple and immutable target identity must be checked before
 * a Workflow asks the domain to prepare an outbound delivery. */
export async function isCurrentNotificationTarget(database: PrismaClient | Tx, value: ExecutionDispatchReference): Promise<boolean> {
  const parsed = executionDispatchReferenceSchema.safeParse(value);
  if (!parsed.success || value.kind !== "operation_driver" || value.generation !== 1) return false;
  value = parsed.data;
  const [epoch, record] = await Promise.all([database.executionEpoch.findUnique({ where: { id: 1 } }), readExecutionDispatch(database, value.dispatchId)]);
  if (epoch?.epoch !== value.deploymentEpoch || !record || JSON.stringify(record.reference) !== JSON.stringify(value)) return false;
  if (value.subject.kind === "completion_callback") {
    const row = await database.completionCallback.findUnique({ where: { id: value.subject.id } });
    return Boolean(row && completionCallbackExecutionInputHash(row) === value.inputHash);
  }
  if (value.subject.kind === "webhook_subscription") {
    const row = await database.webhookSubscription.findUnique({ where: { id: value.subject.id } });
    return Boolean(row && webhookSubscriptionExecutionInputHash(row) === value.inputHash);
  }
  return false;
}

/** A range creates at most100 event wakes. An event creates at most100 callback
 * wakes,10 subscription wakes and one persisted callback cursor. No receiver
 * request or waiting-operation timer is performed by this coordinator. */
export function createWorkspaceNotificationDispatcher(options: NotificationDispatchScopeOptions) {
  const { database, deliver } = options;
  return { async dispatch(value: ExecutionDispatchReference): Promise<{ dispatchIds: string[] }> {
    const reference = executionDispatchReferenceSchema.parse(value);
    const dispatchIds = await database.$transaction(async tx => {
      const [epoch] = await tx.$queryRaw<Array<{ epoch: number }>>`SELECT epoch FROM "ExecutionEpoch" WHERE id = 1 FOR SHARE`;
      const record = await readExecutionDispatch(tx, reference.dispatchId);
      if (epoch?.epoch !== reference.deploymentEpoch || reference.kind !== "operation_driver" || reference.generation !== 1 ||
        !record || JSON.stringify(record.reference) !== JSON.stringify(reference)) return [];
      const ids: string[] = [];
      const pending: AppendExecutionDispatchInput[] = [];
      if (reference.subject.kind === "maintenance") {
        const bounds = range(reference.subject.id);
        if (!bounds || record.wakeKind !== "notifications" || reference.inputHash !== notificationInputHash(["workspace-notification-range-v1", reference.subject.id])) return [];
        const events = await tx.workspaceEvent.findMany({ where: { workspaceId: bounds.workspaceId, seq: { gt: bounds.after, lte: bounds.through } }, orderBy: { seq: "asc" }, take: 101 });
        for (const event of events.slice(0, 100)) {
          pending.push({ deploymentEpoch: epoch.epoch, kind: "operation_driver", subject: { kind: "workspace_event", id: event.id }, generation: 1,
            inputHash: workspaceEventExecutionInputHash(event), dueAt: new Date(0), wakeKind: "notifications" });
        }
        if (events.length > 100) ids.push(await appendWorkspaceNotificationRange(tx, bounds.workspaceId, events[99]!.seq, bounds.through, epoch.epoch));
      } else if (reference.subject.kind === "workspace_event") {
        const event = await tx.workspaceEvent.findUnique({ where: { id: reference.subject.id } });
        const cursor = record.wakeKind === "notifications" ? null : /^after_([a-f0-9]{32})$/.exec(record.wakeKind ?? "")?.[1];
        if (!event || cursor === undefined || workspaceEventExecutionInputHash(event) !== reference.inputHash) return [];
        const validated = workspaceEventSchema.parse({ id: event.id, seq: Number(event.seq), type: event.type, version: event.version, subject: event.subject, occurredAt: event.occurredAt.toISOString() });
        if (cursor === null) {
          const subscriptions = await tx.webhookSubscription.findMany({ where: { workspaceId: event.workspaceId, status: "active", lastDeliveredSeq: { lt: event.seq }, types: { has: validated.type } }, orderBy: { id: "asc" }, take: 10 });
          for (const subscription of subscriptions) pending.push({ deploymentEpoch: epoch.epoch, kind: "operation_driver", subject: { kind: "webhook_subscription", id: subscription.id }, generation: 1,
            inputHash: webhookSubscriptionExecutionInputHash(subscription), dueAt: new Date(0), wakeKind: `event_${event.id.replaceAll("-", "")}` });
        }
        if (validated.type === "operation.finished") {
          const operation = decodeOperationId(validated.subject.operation.id);
          if (!operation || operation.kind !== validated.subject.operation.kind) throw new Error("Invalid Workspace operation reference");
          const after = cursor ? `${cursor.slice(0, 8)}-${cursor.slice(8, 12)}-${cursor.slice(12, 16)}-${cursor.slice(16, 20)}-${cursor.slice(20)}` : null;
          const callbacks = await tx.completionCallback.findMany({ where: { workspaceId: event.workspaceId, operationKind: operation.kind, operationId: operation.id,
            state: { in: ["waiting", "pending"] }, ...(after ? { id: { gt: after } } : {}) }, orderBy: { id: "asc" }, take: 101 });
          for (const callback of callbacks.slice(0, 100)) pending.push({ deploymentEpoch: epoch.epoch, kind: "operation_driver", subject: { kind: "completion_callback", id: callback.id }, generation: 1,
            inputHash: completionCallbackExecutionInputHash(callback), dueAt: new Date(0), wakeKind: `event_${event.id.replaceAll("-", "")}` });
          if (callbacks.length > 100) {
            pending.push({ ...reference, deploymentEpoch: epoch.epoch, dueAt: new Date(0), wakeKind: `after_${callbacks[99]!.id.replaceAll("-", "")}` });
          }
        }
      }
      for (const next of await appendExecutionDispatches(tx, pending)) {
        ids.push(next.reference.dispatchId);
        collectNotificationDispatch(tx, next.reference.dispatchId);
      }
      return ids;
    }, { maxWait: 10_000, timeout: 30_000 });
    if (dispatchIds.length) await deliver(dispatchIds);
    return { dispatchIds };
  } };
}
