import type { Prisma, PrismaClient } from "@prisma/client";
import { getPrismaClient } from "@narriflow/db/client";
import { AsyncLocalStorage } from "node:async_hooks";
import { createExecutionDispatch, ExecutionDispatchError, ExecutionDispatchPendingError, type ExecutionDispatchOptions, type ExecutionDispatchScheduler } from "./execution-dispatch";

type Tx = Prisma.TransactionClient;

const invocation = new AsyncLocalStorage<Set<string>>();
const transactionIds = new WeakMap<Tx, Set<string>>();

/** An invocation owns its aftercommit flush and the resulting safe receipt. */
export function hasExecutionDispatchCollector(): boolean { return invocation.getStore() !== undefined; }

export function collectExecutionDispatch(tx: Tx, id: string): void {
  let ids = transactionIds.get(tx);
  if (!ids) { ids = new Set(); transactionIds.set(tx, ids); }
  ids.add(id);
  invocation.getStore()?.add(id);
}

/** Include these IDs in the same native receipt as its domain changes. */
export function takeExecutionDispatchIds(tx: Tx): string[] {
  const ids = transactionIds.get(tx);
  transactionIds.delete(tx);
  return ids ? [...ids] : [];
}

export interface ExecutionDispatchScopeOptions {
  database: PrismaClient;
  deliver(ids: readonly string[]): Promise<void>;
  /** An actual RPC can outlive its outer HTTP response and must flush its own work. */
  independent?: boolean;
}

export interface ExecutionRegistrationReceipt {
  exportId?: string;
  receiptId?: string;
  sessionId?: string;
  uploadId?: string;
  projectId?: string;
  queuedJobId?: string;
  ingestJobId?: string;
  workflowRunId?: string;
  operationId?: string;
  taskId?: string;
  operation?: { kind: "intake" | "generation" | "export"; id: string };
}

/** The error transport retains only durable identifiers, never tool content,
 * grants, provider text or an arbitrary successful response body. */
export function executionRegistrationReceipt(value: unknown): ExecutionRegistrationReceipt {
  const record = (raw: unknown): Record<string, unknown> => raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const uuid = (raw: unknown): raw is string => typeof raw === "string" && raw.length === 36 && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(raw);
  const root = record(value), httpData = record(root.data), upload = record(root.upload), data = record(record(root.structuredContent).data), lineage = record(record(root._meta)["narriflow/operation"]);
  const receipt: ExecutionRegistrationReceipt = {};
  for (const key of ["sessionId", "uploadId", "projectId", "queuedJobId", "ingestJobId", "workflowRunId", "taskId", "receiptId", "exportId"] as const) {
    const id = [root[key], httpData[key], upload[key], data[key], key === "projectId" ? lineage.projectId : key === "exportId" ? record(root.export).id ?? record(httpData.export).id ?? record(data.export).id : undefined].find(uuid);
    if (id) receipt[key] = id;
  }
  if (!receipt.exportId) {
    const snapshot = [root, httpData, data].find(item => uuid(item.id) && uuid(item.clipId) && uuid(item.projectId) &&
      Number.isSafeInteger(item.editorRevision) && Array.isArray(item.variants) && ["queued", "rendering", "partial_ready", "ready", "failed"].includes(String(item.status)));
    if (snapshot) receipt.exportId = snapshot.id as string;
  }
  const operationId = [root.operationId, httpData.operationId, data.operationId, record(root.operation).operationId, record(upload.operation).operationId].find(id => uuid(id) || typeof id === "string" && id.length === 26 && /^op_[A-Za-z0-9_-]{23}$/.test(id));
  if (typeof operationId === "string") receipt.operationId = operationId;
  const operation = [record(root.operation), record(httpData.operation), record(data.operation), { kind: lineage.domainKind, id: lineage.domainId }, { kind: "export", id: receipt.exportId }]
    .find(item => ["intake", "generation", "export"].includes(String(item.kind)) && uuid(item.id));
  if (operation) receipt.operation = { kind: operation.kind as "intake" | "generation" | "export", id: operation.id as string };
  return receipt;
}

/** Only HTTP/RPC boundaries construct this after the handler has returned.
 * The ordinary service/Workflow collector preserves its original failure. */
export class ExecutionRegistrationPendingError extends Error {
  readonly code = "scheduler_registration_pending";
  readonly receipt: ExecutionRegistrationReceipt;
  readonly retryAfterSeconds: number;
  constructor(receipt: ExecutionRegistrationReceipt, cause: unknown) {
    super("The request was saved, but scheduling is not confirmed. Retry the same request.", { cause });
    this.name = "ExecutionRegistrationPendingError";
    this.receipt = receipt;
    this.retryAfterSeconds = cause instanceof ExecutionDispatchPendingError ? Math.min(86400, Math.max(1, Math.ceil((cause.retryAt.getTime() - Date.now()) / 1000))) : 1;
  }
}

/** Must run inside the invocation's DB scope. Only explicitly collected,
 * committed obligations are read, never the global outbox. */
export async function withExecutionDispatches<T>(operation: () => Promise<T>, options?: Partial<ExecutionDispatchScopeOptions>): Promise<T> {
  if (invocation.getStore() && !options?.independent) return operation();
  const deliver = options?.deliver ?? deliverExecutionDispatches;
  return invocation.run(new Set(), async () => {
    let result: T | undefined;
    let failed = false;
    let failure: unknown;
    try { result = await operation(); } catch (error) { failed = true; failure = error; }
    // The current Workflow must register its prerequisite before dependent
    // work. Replaying the command after this persisted retry repairs the same
    // committed IDs; an automatic flush cannot bypass that prerequisite.
    if(failed&&failure instanceof ExecutionDispatchPendingError)throw failure;
    const ids = [...invocation.getStore()!];
    // DO-only invocations must retain the database scope's lazy construction.
    const database = ids.length ? (options?.database ?? getPrismaClient()) : null;
    if (ids.length && !database) throw new Error("Execution dispatch requires a database scope");
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


const scheduling = new AsyncLocalStorage<ExecutionDispatchScheduler>();
export function withExecutionDispatchScheduler<T>(scheduler: ExecutionDispatchScheduler, operation: () => T): T {
  return scheduling.run(scheduler, operation);
}

/** Resolve the current invocation's client; never cache a service across scopes. */
export function getExecutionDispatch(scheduler = scheduling.getStore(), options?: ExecutionDispatchOptions) {
  if (!scheduler) throw new ExecutionDispatchError("scheduler_unavailable");
  const database = getPrismaClient();
  if (!database) throw new Error("Execution dispatch requires a database scope");
  return createExecutionDispatch({ database, scheduler, options });
}

/** Domain commits return identifiers. Confirmation happens after commit, and
 * exact callback/Workflow replays redeliver any unconfirmed obligations. */
export async function deliverExecutionDispatches(ids: readonly string[]): Promise<void> {
  if (ids.length > 128) throw new ExecutionDispatchError("invalid_dispatch");
  if (!ids.length) return;
  const dispatch = getExecutionDispatch();
  const unique = [...new Set(ids)];
  for (let offset = 0; offset < unique.length; offset += 4) {
    const results = await Promise.allSettled(unique.slice(offset, offset + 4).map(id => dispatch.deliver(id)));
    if(results.some(result=>result.status==="rejected" || !["acknowledged","superseded","pending"].includes(result.value.status)))throw new ExecutionDispatchError("scheduler_unavailable");
    const retryTimes=results.flatMap(result=>result.status==="fulfilled"&&result.value.status==="pending"?[result.value.retryAt.getTime()]:[]);
    if(retryTimes.length)throw new ExecutionDispatchPendingError(new Date(Math.min(...retryTimes)));
  }
}
