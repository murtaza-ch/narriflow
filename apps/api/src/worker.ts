import { createDatabaseScope, type DatabaseScope, withDatabaseScope } from "@narriflow/db/client";
import { type ServiceEnvironment } from "@narriflow/services/runtime-environment";
import { withWorkerServices, workerServiceEnvironment } from "./worker-services";
export { workerServiceEnvironment } from "./worker-services";
import { healthResponse } from "./domains/platform/health";
import type { ApiWorkerBindings } from "./worker-bindings";
import { withNotificationDispatches } from "@narriflow/services/notification-dispatch";
import { failureResponse } from "./http/errors";

interface WorkerApiApp {
  fetch(request: Request, bindings: ApiWorkerBindings, context: ExecutionContext): Response | Promise<Response>;
}

export type WorkerInvocation = <T>(operation: () => Promise<T>) => Promise<T>;

export interface ApiWorkerDependencies {
  createApp(environment: ServiceEnvironment, runInvocation: WorkerInvocation): WorkerApiApp;
  createScope?(connectionString: string): DatabaseScope;
}

export function createApiWorker(dependencies: ApiWorkerDependencies) {
  return {
    async fetch(request: Request, bindings: ApiWorkerBindings, context: ExecutionContext): Promise<Response> {
      const path = new URL(request.url).pathname;
      if (request.method === "GET" && path === "/api/health") {
        return healthResponse(bindings.CF_VERSION_METADATA?.id ?? "dev");
      }
      if (bindings.ADMISSION_STATE === "closed" && path !== "/api/ready") return failureResponse({ code: "server_draining", category: "unavailable", status: 503,
        message: "The service is restarting. Try again shortly.", requestId: crypto.randomUUID(), retryAfterSeconds: 5 });
      const environment = workerServiceEnvironment(bindings);
      // MCP callbacks can continue after fetch returns an SSE Response. Capture
      // settings and a factory, never a Prisma client or an open socket.
      const runInvocation: WorkerInvocation = (operation) => withWorkerServices(bindings, environment, () => withDatabaseScope(
        (dependencies.createScope ?? ((connectionString) => createDatabaseScope({ connectionString })))(bindings.HYPERDRIVE.connectionString), () => withNotificationDispatches(operation),
      ));
      return runInvocation(async () => dependencies.createApp(environment, runInvocation).fetch(request, bindings, context));
    },
  };
}
