# Social Publication Attempt owns provider delivery and uncertainty

One Social Post freezes the exact editor revision, Clip Export variant, account, caption, provider settings, capability version, and schedule before work becomes eligible. A Social Publication Attempt then owns provider delivery behind one platform contract. Every irreversible boundary is checkpointed before the request or bytes may be accepted. A Publication Claim fences checkpoints and settlements, expires through a heartbeat lease, and owns the account concurrency slot only while a pre-submission operation could create duplicate work.

Provider responses normalize to accepted, pending, definitive failure, or unknown. Accepted creates the Provider Receipt and settles the attempt and Social Post in one transaction. Publication creates a durable analytics intent; inbox delivery settles without a publication event. Pending and recoverable unknown outcomes release the worker and schedule reconciliation of the same provider operation. Unrecoverable uncertainty becomes Needs attention and is never submitted again automatically. Only definitive pre-submission failures may create a bounded, linked retry attempt with a new provider idempotency key.

Recovery remains attempt-owned. Recheck moves the same uncertain attempt back to reconciliation. Manual confirmation records a Publication Manual Decision and a clearly manual receipt without provider metrics. Publish again requires explicit duplicate-risk acknowledgement and creates a new linked attempt while leaving the uncertain attempt unchanged. All three transitions use compare-and-set rules. Provider operation identifiers needed by inbound evidence are stored only as one-way lookup hashes; checkpoint state remains encrypted.

## Considered options

We rejected Social Post status as execution ownership because a status cannot fence stale workers or preserve provider evidence; a generic stalled-post reaper because it turns possible acceptance into a retryable failure; selecting the latest render at execution because edits can silently change approved content; reusing one idempotency key across retry attempts because it conflates distinct provider operations; and treating webhook 2xx as acceptance because transport success is not a durable receiver receipt.

## Consequences

The worker only claims and executes Social Publication Attempts. Platform adapters receive frozen content and return normalized outcomes. Native credentials and scoped media locations are resolved at execution but never become mutable publication policy. Provider operation state is encrypted at rest. Worker concurrency, leases, heartbeats, provider deadlines, call budgets, processing deadlines, and retry backoff are bounded configuration. Posts and Calendar share the states Draft, Preparing video, Scheduled, Publishing, Processing on provider, Reconciling, Sent to TikTok, Posted, Failed, Needs attention, and Cancelled.

YouTube resumes its provider-reported byte range. A confirmed YouTube video ID settles Posted while a receipt-enrichment loop records later processing success or failure without discarding the accepted receipt or uploading again. Instagram resumes the same container. TikTok releases moderation to exponentially backed-off status checks and verified, replay-bounded webhooks keyed to the same `publish_id`; an explicit Publish again fences that lookup before new work is eligible. LinkedIn and X perform bounded exact media-identity lookups when the connected account grants read access and otherwise surface explicit Needs attention rather than retrying a create request.

Operational signals are part of the module boundary: structured diagnostics preserve identifier-safe incident context, and explicit metrics cover admission, claim fencing, provider operations, aging, retry, attention, receipt, cleanup, manual decisions, and terminal outcomes.

This is a direct pre-production cutover. The former status-only claim, generic social reaper, provider switch, execution-time render selection, bare-2xx webhook success, and blind manual retry path are removed rather than retained behind compatibility logic.

## Publishing composition and inbox settlement (2026-09-09)

Final submission confirms the exact account-specific content and records the actor in frozen publication settings. Assisted Copy Variants are immutable generation provenance. Their mutable confirmation fields and confirmation endpoint are removed. Browser Publishing Drafts and pending submission identities are separate: retrying a response loss reuses the exact request, while an intentional additional or corrected post uses a new identity. Campaign admission accepts explicit clip/account items and stores per-item outcomes; successful items are not repeated in a corrected selection.

Frozen Publication State includes delivery mode (`direct` or `tiktok_inbox`). An accepted inbox delivery creates a receipt and settles the attempt, releases its claim, and sets Social Post to `inbox_delivered`, without a `social_posted` analytics intent. The executor returns an inbox delivery outcome. Waiting for the creator to publish is outside delivery deadlines and never triggers automatic resend.

Verified TikTok publication events remain admissible after delivery settlement. An explicit provider status read uses the same monotonic settlement transaction. PublishedSocialVideo child rows deduplicate provider post IDs and retain every public link; publication without a public ID records the fact without inventing a URL. Row locking serializes duplicate and out-of-order events, and terminal publication evidence cannot be downgraded by delayed delivery/failure events. Polling stops once inbox delivery is known.
