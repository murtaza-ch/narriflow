# Workflow Runs own one fenced lifecycle

Workflow Runs, but not Ingest Jobs, are owned by one deep lifecycle module. Each execution claim is itself an explicit `WorkflowAttemptRef`, with an immutable Workflow Attempt ID and renewable lease stored on the run. Workers pass that reference to every stage entrypoint and lifecycle command; render and dub rows inherit the attempt instead of creating independent leases. External-provider waits use an explicit lease-free `waiting` state, aggregate stages may terminate as `partial`, and the existing Workflow Event record is also the transactional outbox and replay source. This keeps one source of ownership truth and prevents a reaped worker, event-delivery failure, or telemetry failure from reversing newer domain state.

## Considered options

We rejected a generalized ingest/workflow job module because their lifecycles and payloads differ; a separate Workflow Attempt table because it would add a second state model without improving fencing; long provider leases because no worker exists to renew them; independent child leases because they create competing ownership truth; and a second generic outbox table because Workflow Event already provides durable ordered replay. We also reject protocol-versioned bridge workers: Narriflow's pre-production policy has no production data or mixed-version deployments to protect, so a V1/V2 split would preserve obsolete writers and weaken the ownership boundary without a real compatibility requirement.

## Consequences

`WorkflowRunLifecycle` is the sole externally visible Workflow Run write interface. Prisma and transaction construction remain private to it; claims always return a non-null attempt identity; and stage entrypoints receive both that exact attempt and their execution context without ambient storage. Worker adapters must treat `WorkflowAttemptLost` as a control signal rather than a workflow failure. Ingest Jobs retain their separate Project Service lifecycle and maintenance reaper.
