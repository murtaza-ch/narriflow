import type { Prisma, PrismaClient } from "@prisma/client";
import { getPrismaClient } from "@narriflow/db/client";
import { AsyncLocalStorage } from "node:async_hooks";
import { createExecutionDispatch, ExecutionDispatchError, ExecutionDispatchPendingError, type ExecutionDispatchOptions, type ExecutionDispatchScheduler } from "./execution-dispatch";

type Tx = Prisma.TransactionClient;

const invocation = new AsyncLocalStorage<Set<string>>();
const transactionIds = new WeakMap<Tx, Set<string>>();

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
}

/** Must run inside the invocation's DB scope. Only explicitly collected,
 * committed obligations are read, never the global outbox. */
export async function withExecutionDispatches<T>(operation: () => Promise<T>, options?: ExecutionDispatchScopeOptions): Promise<T> {
  if (invocation.getStore()) return operation();
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
