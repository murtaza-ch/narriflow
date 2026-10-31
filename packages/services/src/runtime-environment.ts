import { AsyncLocalStorage } from "node:async_hooks";

export type ServiceEnvironment = Readonly<Record<string, string | undefined>>;
const invocationEnvironment = new AsyncLocalStorage<ServiceEnvironment>();

/** Inject settings at the Worker, Workflow step or CLI boundary. */
export function withServiceEnvironment<Result>(environment: ServiceEnvironment, operation: () => Result): Result {
  return invocationEnvironment.run(environment, operation);
}

/** Missing scope is a wiring error. Never consult the host process environment. */
export function readServiceEnvironment(): ServiceEnvironment {
  const environment = invocationEnvironment.getStore();
  if (!environment) throw new Error("Service environment is unavailable");
  return environment;
}
