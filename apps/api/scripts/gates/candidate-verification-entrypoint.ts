import { WorkerEntrypoint } from "cloudflare:workers";
import { createDatabaseScope, withDatabaseScope } from "@narriflow/db/client";
import { loadApiConfig } from "../../src/config";
import { createProductionApp } from "../../src/runtime";
import type { ApiWorkerBindings } from "../../src/worker-bindings";
import { withWorkerServices, workerServiceEnvironment } from "../../src/worker-services";
import { probePublicationMemory } from "./publication-memory-probe";

/** Temporary closed-candidate gate. Remove before the deletion-inclusive release. */
export class CutoverVerification extends WorkerEntrypoint<ApiWorkerBindings> {
  async #probe(copies: 1 | 2) {
    if (this.env.APP_ENV !== "development" || this.env.ADMISSION_STATE !== "closed") throw new Error("candidate_gate_unavailable");
    const environment = workerServiceEnvironment(this.env);
    return withWorkerServices(this.env, environment, () => withDatabaseScope(createDatabaseScope({ createClient() {
      throw new Error("candidate_memory_gate_cannot_query_database");
    } }), async () => {
      const app = createProductionApp(loadApiConfig(environment), environment, async operation => operation());
      const result = await probePublicationMemory(this.env.MEDIA_BUCKET, copies);
      // Read the real router after the probe, keeping it alive during decoding.
      return { ...result, productionRouteCount: app.routes.length, databaseRequests: 0 };
    }));
  }
  one() { return this.#probe(1); }
  two() { return this.#probe(2); }
}
