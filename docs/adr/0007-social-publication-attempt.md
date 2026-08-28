# Social Publication Attempt owns provider delivery and uncertainty

One Social Post freezes the exact editor revision, Clip Export variant, account, caption, provider settings, capability version, and schedule before work becomes eligible. A Social Publication Attempt then owns provider delivery behind one platform contract. Every irreversible boundary is checkpointed before the request or bytes may be accepted. A Publication Claim fences checkpoints and settlements, expires through a heartbeat lease, and owns the account concurrency slot only while a pre-submission operation could create duplicate work.

Provider responses normalize to accepted, pending, definitive failure, or unknown. Accepted creates the Provider Receipt, settles the attempt and Social Post, and creates a durable analytics intent in one transaction. Pending and recoverable unknown outcomes release the worker and schedule reconciliation of the same provider operation. Unrecoverable uncertainty becomes Needs attention and is never submitted again automatically. Only definitive pre-submission failures may create a bounded, linked retry attempt with a new provider idempotency key.

## Considered options

We rejected Social Post status as execution ownership because a status cannot fence stale workers or preserve provider evidence; a generic stalled-post reaper because it turns possible acceptance into a retryable failure; selecting the latest render at execution because edits can silently change approved content; reusing one idempotency key across retry attempts because it conflates distinct provider operations; and treating webhook 2xx as acceptance because transport success is not a durable receiver receipt.

## Consequences

The worker only claims and executes Social Publication Attempts. Platform adapters receive frozen content and return normalized outcomes. Native credentials and scoped media locations are resolved at execution but never become mutable publication policy. Provider operation state is encrypted at rest. Worker concurrency, leases, heartbeats, provider deadlines, call budgets, processing deadlines, and retry backoff are bounded configuration. Publish and Calendar share the states Draft, Preparing video, Scheduled, Publishing, Processing on provider, Reconciling, Posted, Failed, Needs attention, and Cancelled.

This is a direct pre-production cutover. The former status-only claim, generic social reaper, provider switch, execution-time render selection, bare-2xx webhook success, and blind manual retry path are removed rather than retained behind compatibility logic.
