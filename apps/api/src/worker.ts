import { createDatabaseScope, type DatabaseScope, withDatabaseScope } from "@narriflow/db/client";
import { type ServiceEnvironment } from "@narriflow/services/runtime-environment";
import { withWorkerServices, workerServiceEnvironment } from "./worker-services";
export { workerServiceEnvironment } from "./worker-services";
import { healthResponse } from "./domains/platform/health";
import type { ApiWorkerBindings } from "./worker-bindings";
import { executionRegistrationReceipt, ExecutionRegistrationPendingError, withExecutionDispatches } from "@narriflow/services/execution-dispatch-runtime";
import { continuesAcceptedWork, drainingResponse } from "./http/drain";
import { firstPartyRefusalHeaders } from "./http/cors";
import { loadCorsAllowedOrigins } from "./config";
import { GENERIC_SERVER_MESSAGE, jsonError } from "./http/errors";
import { logFailure } from "@narriflow/services/log-failure";
import { readExecutionRegistrationReceipt, executionRegistrationFailureResponse } from "./http/execution-registration";

interface WorkerApiApp {
  fetch(request: Request, bindings: ApiWorkerBindings, context: ExecutionContext): Response | Promise<Response>;
}

export type WorkerInvocation = <T>(operation: () => Promise<T>) => Promise<T>;

export interface ApiWorkerDependencies {
  createApp(environment: ServiceEnvironment, runInvocation: WorkerInvocation): WorkerApiApp;
  createScope?(connectionString: string): DatabaseScope;
}

/** The first-party CORS headers for an allowed origin, so a browser can still read a refusal. Invalid origin settings send none. */
function refusalHeaders(bindings: ApiWorkerBindings, request: Request): Record<string, string> {
  try {
    return firstPartyRefusalHeaders(loadCorsAllowedOrigins({
      CORS_ALLOWED_ORIGINS: typeof bindings.CORS_ALLOWED_ORIGINS === "string" ? bindings.CORS_ALLOWED_ORIGINS : undefined,
      WEB_ORIGIN: typeof bindings.WEB_ORIGIN === "string" ? bindings.WEB_ORIGIN : undefined,
    }))(request);
  } catch {
    return {};
  }
}

export function createApiWorker(dependencies: ApiWorkerDependencies) {
  return {
    async fetch(request: Request, bindings: ApiWorkerBindings, context: ExecutionContext): Promise<Response> {
      const path = new URL(request.url).pathname;
      if (request.method === "GET" && path === "/api/health") {
        return healthResponse(bindings.CF_VERSION_METADATA?.id ?? "dev", crypto.randomUUID(), bindings.ADMISSION_STATE);
      }
      if (bindings.ADMISSION_STATE === "fenced" || bindings.ADMISSION_STATE === "closed" && !continuesAcceptedWork(request.method,path)) {
        const headers = bindings.ADMISSION_STATE === "closed" ? refusalHeaders(bindings, request) : {};
        return drainingResponse(request, { state: bindings.ADMISSION_STATE, requestId: crypto.randomUUID(), headers });
      }
      try {
        const environment = workerServiceEnvironment(bindings);
        // MCP callbacks can continue after fetch returns an SSE Response. Capture
        // settings and a factory, never a Prisma client or an open socket.
        const invoke = <T>(operation: () => Promise<T>, independent: boolean): Promise<T> => withWorkerServices(bindings, environment, () => withDatabaseScope(
          (dependencies.createScope ?? ((connectionString) => createDatabaseScope({ connectionString })))(bindings.HYPERDRIVE.connectionString), async () => {
            let result: T | undefined, returned = false;
            try {
              return await withExecutionDispatches(async () => { result = await operation(); returned = true; return result; }, { independent });
            } catch (cause) {
              if (!returned) throw cause;
              // A nested RPC already owns its typed registration failure.
              if (cause instanceof ExecutionRegistrationPendingError) throw cause;
              if (result instanceof Response && result.status >= 400) return result as T;
              const receipt = result instanceof Response ? await readExecutionRegistrationReceipt(result) : executionRegistrationReceipt(result);
              throw new ExecutionRegistrationPendingError(receipt, cause);
            }
          },
        ));
        const runInvocation: WorkerInvocation = operation => invoke(operation, true);
        let response: Response | undefined;
        try { return await invoke(async () => response = await dependencies.createApp(environment, runInvocation).fetch(request, bindings, context), false); }
        catch (error) {
          if (!(error instanceof ExecutionRegistrationPendingError) || !response) throw error;
          return executionRegistrationFailureResponse(response, error);
        }
      } catch (error) {
        // Nothing below this line answered. Without this the runtime returns an opaque 1101 with no log.
        const requestId = crypto.randomUUID();
        logFailure("worker_unhandled_failure", error, { requestId, method: request.method });
        return jsonError(500, "internal_error", GENERIC_SERVER_MESSAGE, requestId, refusalHeaders(bindings, request));
      }
    },
  };
}
