import { createDatabaseScope, type DatabaseScope, withDatabaseScope } from "@narriflow/db/client";
import { type ServiceEnvironment, withServiceEnvironment } from "@narriflow/services/runtime-environment";
import { healthResponse } from "./domains/platform/health";
import type { ApiWorkerBindings } from "./worker-bindings";

interface WorkerApiApp {
  fetch(request: Request, bindings: ApiWorkerBindings, context: ExecutionContext): Response | Promise<Response>;
}

export interface ApiWorkerDependencies {
  createApp(environment: ServiceEnvironment): WorkerApiApp;
  createScope?(connectionString: string): DatabaseScope;
}

/** Copy only this invocation's text settings. Resource bindings stay on c.env. */
export function workerServiceEnvironment(bindings: ApiWorkerBindings): ServiceEnvironment {
  const settings: Record<string, string> = {};
  for (const [name, value] of Object.entries(bindings)) {
    if (typeof value === "string") settings[name] = value;
  }
  settings.DEPLOYMENT_VERSION ??= bindings.CF_VERSION_METADATA?.id ?? "dev";
  return Object.freeze(settings);
}

export function createApiWorker(dependencies: ApiWorkerDependencies) {
  return {
    async fetch(request: Request, bindings: ApiWorkerBindings, context: ExecutionContext): Promise<Response> {
      if (request.method === "GET" && new URL(request.url).pathname === "/api/health") {
        return healthResponse(bindings.CF_VERSION_METADATA?.id ?? "dev");
      }
      const environment = workerServiceEnvironment(bindings);
      return withServiceEnvironment(environment, () => withDatabaseScope(
        (dependencies.createScope ?? ((connectionString) => createDatabaseScope({ connectionString })))(bindings.HYPERDRIVE.connectionString),
        () => dependencies.createApp(environment).fetch(request, bindings, context),
      ));
    },
  };
}
