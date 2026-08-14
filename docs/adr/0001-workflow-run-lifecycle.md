# Workflow Runs own one fenced lifecycle

Workflow Runs, but not Ingest Jobs, are owned by one deep lifecycle module. Each execution claim receives an immutable Workflow Attempt ID and a renewable lease stored on the run; render and dub rows inherit that attempt instead of creating independent leases. External-provider waits use an explicit lease-free `waiting` state, aggregate stages may terminate as `partial`, and the existing Workflow Event record is also the transactional outbox and replay source. This keeps one source of ownership truth and prevents a reaped worker, event-delivery failure, or telemetry failure from reversing newer domain state.

## Considered options

We rejected a generalized ingest/workflow job module because their lifecycles and payloads differ; a separate Workflow Attempt table because it would add a second state model without improving fencing; long provider leases because no worker exists to renew them; independent child leases because they create competing ownership truth; and a second generic outbox table because Workflow Event already provides durable ordered replay.

## Consequences

Deployments use a lifecycle protocol version so bridge workers drain version 1 rows while version 2 rows use attempt fencing. Prisma and transaction construction remain private to the lifecycle module, and worker adapters must treat `WorkflowAttemptLost` as a control signal rather than a workflow failure.
