import type { ProjectProgress } from "./durable-objects/project-progress";
import type { RateLimiter } from "./durable-objects/rate-limiter";
import type { LocalFetchMailbox } from "./durable-objects/local-fetch-mailbox";
/** Bindings are supplied to an invocation. They are never copied into process.env. */
export interface ApiWorkerBindings {
  [name: string]: unknown;
  HYPERDRIVE: { readonly connectionString: string };
  MEDIA_BUCKET: R2Bucket;
  IMPORT_PIPELINE: Workflow;
  RENDER_RUN: Workflow;
  OPERATION_DRIVER: Workflow;
  MAINTENANCE: Workflow;
  PROJECT_PROGRESS: DurableObjectNamespace<ProjectProgress>;
  RATE_LIMITER: DurableObjectNamespace<RateLimiter>;
  LOCAL_FETCH_MAILBOX: DurableObjectNamespace<LocalFetchMailbox>;
  CF_VERSION_METADATA?: { readonly id: string; readonly tag?: string; readonly timestamp?: string };
}
