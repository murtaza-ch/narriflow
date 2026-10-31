import { getPrismaClient } from "@narriflow/db/client";
import { AsyncLocalStorage } from "node:async_hooks";
import { createExecutionDispatch, ExecutionDispatchError, type ExecutionDispatchOptions, type ExecutionDispatchScheduler } from "./execution-dispatch";

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
    if (results.some(result => result.status === "rejected" || (result.value.status !== "acknowledged" && result.value.status !== "superseded"))) {
      throw new ExecutionDispatchError("scheduler_unavailable");
    }
  }
}
