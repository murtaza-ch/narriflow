/** Bindings are supplied to an invocation. They are never copied into process.env. */
export interface ApiWorkerBindings {
  [name: string]: unknown;
  HYPERDRIVE: { readonly connectionString: string };
  MEDIA_BUCKET: R2Bucket;
  IMPORT_PIPELINE: Workflow;
  RENDER_RUN: Workflow;
  OPERATION_DRIVER: Workflow;
  MAINTENANCE: Workflow;
  PROJECT_PROGRESS: DurableObjectNamespace;
  RATE_LIMITER: DurableObjectNamespace;
  LOCAL_FETCH_MAILBOX: DurableObjectNamespace;
  CF_VERSION_METADATA?: { readonly id: string; readonly tag?: string; readonly timestamp?: string };
}
