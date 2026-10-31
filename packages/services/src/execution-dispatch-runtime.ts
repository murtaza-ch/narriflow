import { getPrismaClient } from "@narriflow/db/client";
import { createExecutionDispatch, type ExecutionDispatchOptions, type ExecutionDispatchScheduler } from "./execution-dispatch";

/** Resolve the current invocation's client; never cache a service across scopes. */
export function getExecutionDispatch(scheduler: ExecutionDispatchScheduler, options?: ExecutionDispatchOptions) {
  const database = getPrismaClient();
  if (!database) throw new Error("Execution dispatch requires a database scope");
  return createExecutionDispatch({ database, scheduler, options });
}
