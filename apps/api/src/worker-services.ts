import { registerProgressContinuations } from "./workflows/scheduler";
import { withProgressDelivery } from "@narriflow/services/progress-delivery";
import { withRateLimiter } from "@narriflow/services/rate-limit";
import { withPexelsSearchCache } from "@narriflow/services/pexels.service";
import { type ServiceEnvironment, withServiceEnvironment } from "@narriflow/services/runtime-environment";
import { createPexelsSearchCache } from "./pexels-cache";
import { createRateLimiterClient } from "./rate-limiter-client";
import type { ApiWorkerBindings } from "./worker-bindings";
import { withNativeValidationScheduler } from "@narriflow/services/native-validation-runtime";
import { getExecutionDispatch } from "@narriflow/services/execution-dispatch-runtime";
import { createWorkerExecutionScheduler } from "./workflows/scheduler";

/** Copy only this invocation's text settings. Resource bindings stay on c.env. */
export function workerServiceEnvironment(bindings: ApiWorkerBindings): ServiceEnvironment {
  const settings: Record<string, string> = {};
  for (const [name, value] of Object.entries(bindings)) if (typeof value === "string") settings[name] = value;
  settings.DEPLOYMENT_VERSION ??= bindings.CF_VERSION_METADATA?.id ?? "dev";
  return Object.freeze(settings);
}

/** Enter once per request or Workflow step, never around a durable sleep. */
export function withWorkerServices<Result>(bindings: ApiWorkerBindings, environment: ServiceEnvironment, operation: () => Result): Result {
  return withNativeValidationScheduler({ register: async ids => {
    const dispatch = getExecutionDispatch(createWorkerExecutionScheduler(bindings));
    for (const id of ids) if ((await dispatch.deliver(id)).status !== "acknowledged") throw new Error("Native validation scheduling is unconfirmed");
  } }, () => withServiceEnvironment(environment, () => withRateLimiter(createRateLimiterClient(bindings.RATE_LIMITER), () =>
    withPexelsSearchCache(typeof caches === "undefined" ? null : createPexelsSearchCache((caches as CacheStorage & { default: Cache }).default), () => withProgressDelivery({
      publish: (scope, event) => bindings.PROJECT_PROGRESS.getByName(scope.projectId).publish(scope, event),
      registerContinuations: (ids) => registerProgressContinuations(bindings, ids),
      revoke: (input) => bindings.PROJECT_PROGRESS.getByName(input.projectId).revoke(input),
    }, operation)))));
}
