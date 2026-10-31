import { createDatabaseScope, type DatabaseScope, withDatabaseScope } from "@narriflow/db/client";
import { type ServiceEnvironment } from "@narriflow/services/runtime-environment";
import { withWorkerServices, workerServiceEnvironment } from "./worker-services";
export { workerServiceEnvironment } from "./worker-services";
import { healthResponse } from "./domains/platform/health";
import type { ApiWorkerBindings } from "./worker-bindings";

interface WorkerApiApp {
  fetch(request: Request, bindings: ApiWorkerBindings, context: ExecutionContext): Response | Promise<Response>;
}

export interface ApiWorkerDependencies {
  createApp(environment: ServiceEnvironment): WorkerApiApp;
  createScope?(connectionString: string): DatabaseScope;
}

export function createApiWorker(dependencies: ApiWorkerDependencies) {
  return {
    async fetch(request: Request, bindings: ApiWorkerBindings, context: ExecutionContext): Promise<Response> {
      if (request.method === "GET" && new URL(request.url).pathname === "/api/health") {
        return healthResponse(bindings.CF_VERSION_METADATA?.id ?? "dev");
      }
      const environment = workerServiceEnvironment(bindings);
      return withWorkerServices(bindings, environment, () => withDatabaseScope(
        (dependencies.createScope ?? ((connectionString) => createDatabaseScope({ connectionString })))(bindings.HYPERDRIVE.connectionString),
        () => dependencies.createApp(environment).fetch(request, bindings, context),
      ));
    },
  };
}
