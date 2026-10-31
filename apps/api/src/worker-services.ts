import { registerProgressContinuations } from "./workflows/scheduler";
import { withProgressDelivery } from "@narriflow/services/progress-delivery";
import { withRateLimiter } from "@narriflow/services/rate-limit";
import { withPexelsSearchCache } from "@narriflow/services/pexels.service";
import { type ServiceEnvironment, withServiceEnvironment } from "@narriflow/services/runtime-environment";
import { createPexelsSearchCache } from "./pexels-cache";
import { createRateLimiterClient } from "./rate-limiter-client";
import type { ApiWorkerBindings } from "./worker-bindings";
import { withExecutionDispatchScheduler } from "@narriflow/services/execution-dispatch-runtime";
import { createWorkerExecutionScheduler } from "./workflows/scheduler";
import { withLocalFetchPresence } from "@narriflow/services/source-fetch-capability";
import { localDeviceMailbox, projectProgressPort, rateLimiterNamespace } from "./resource-ports";

/** Copy only this invocation's text settings. Resource bindings stay on c.env. */
export function workerServiceEnvironment(bindings: ApiWorkerBindings): ServiceEnvironment {
  const settings: Record<string, string> = {};
  for (const [name, value] of Object.entries(bindings)) if (typeof value === "string") settings[name] = value;
  settings.DEPLOYMENT_VERSION ??= bindings.CF_VERSION_METADATA?.id ?? "dev";
  return Object.freeze(settings);
}

/** Enter once per request or Workflow step, never around a durable sleep. */
export function withWorkerServices<Result>(bindings: ApiWorkerBindings, environment: ServiceEnvironment, operation: () => Result): Result {
  return withExecutionDispatchScheduler(createWorkerExecutionScheduler(bindings), () => withServiceEnvironment(environment, () => withLocalFetchPresence(workspaceId => localDeviceMailbox(bindings, workspaceId).presence(), () => withRateLimiter(createRateLimiterClient(rateLimiterNamespace(bindings)), () =>
    withPexelsSearchCache(typeof caches === "undefined" ? null : createPexelsSearchCache((caches as CacheStorage & { default: Cache }).default), () => withProgressDelivery({
      publish: (scope, event) => projectProgressPort(bindings, scope.projectId).publish(scope, event),
      registerContinuations: (ids) => registerProgressContinuations(bindings, ids),
      revoke: async (input) => { await projectProgressPort(bindings, input.projectId).revoke(input); if (bindings.DEV_CLOUD || bindings.LOCAL_FETCH_MAILBOX) await localDeviceMailbox(bindings, input.workspaceId).revoke(input); },
    }, operation))))));
}
