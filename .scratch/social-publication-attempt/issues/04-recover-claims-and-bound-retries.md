# 04 — Recover claims and bound publication retries

**What to build:** Recover interrupted attempts from their durable phase, release workers during provider processing, serialize active submissions per account, and retry only operations that are known safe within bounded policy.

**Blocked by:** [03 — Establish the durable Social Publication Attempt tracer](03-establish-publication-attempt-tracer.md).

**Status:** done

**Specification:** [Deepen the Social Publication Attempt](../spec.md)

## Observable acceptance criteria

- [x] Long local preparation and upload work heartbeats its immutable claim before lease expiry.
- [x] An expired claim is reclaimed from its durable phase and is never converted directly to Failed.
- [x] A stale worker that returns after takeover cannot checkpoint, settle, schedule retry, or change the Social Post.
- [x] Pending provider work stores an exact operation identity and next check, releases the worker and active submission slot, and projects Processing on provider.
- [x] Unknown work with an available recovery method projects Reconciling and becomes due without another submission.
- [x] Unknown work without exact recovery, expired evidence, or a bounded reconciliation deadline projects Needs attention.
- [x] Definitive transient pre-submission failures create a linked new attempt with exponential backoff and jitter, provider `Retry-After` guidance, and visible next-attempt time.
- [x] Post-submission timeouts and non-idempotent operations are never automatically retried as a new attempt.
- [x] Attempt count, elapsed-time, provider-call, polling, and reconciliation budgets are finite, validated at startup, and have safe maximums.
- [x] Due work uses atomic keyset claiming and eventually processes items beyond several batches.
- [x] Only one active submission runs per Social Account, while unrelated accounts run with bounded concurrency.
- [x] Provider processing and reconciliation do not hold the account submission slot when another post can safely proceed.
- [x] One slow or failing provider does not block later accounts or ingest, Workflow Run, billing, notification, retention, or autopilot loops.
- [x] Workspace restriction blocks new submissions and retries while allowing read-only reconciliation of an already accepted operation.
- [x] Account revocation blocks new provider work and turns unrecoverable submitted work into Needs attention rather than Failed.
- [x] Publish and Calendar status mappers show Preparing video, Scheduled, Publishing, Processing on provider, Reconciling, Posted, Failed, Needs attention, and Cancelled with consistent live polling behavior.

## Public-interface and failure-injection tests

- [x] A manual clock proves heartbeat cadence, claim expiry, takeover, backoff bands, `Retry-After`, processing checks, and terminal deadlines.
- [x] Attempt-interface tests cover crash before checkpoint, after checkpoint, during upload, before submission, after submission, during pending processing, and after provider acceptance.
- [x] Database tests prove keyset fairness, one active account submission, unrelated-account concurrency, stale fencing, and atomic retry lineage.
- [x] Concurrency tests cover two workers, two posts for one account, manual recheck racing background work, revocation during submission, and restriction during processing.
- [x] Worker tests prove graceful shutdown aborts owned work without misclassifying it and resumes from the durable phase later.
- [x] Configuration tests reject non-finite values, unsafe lease and heartbeat relationships, unbounded concurrency, invalid deadlines, and unsupported API versions.

## Rollout and recovery safety

- [x] Replace the generic social reaper with due-attempt recovery; no path writes `worker_stalled` as a terminal publication failure.
- [x] Structured diagnostics distinguish claim loss, provider pending, reconciliation, safe retry, permanent failure, and attention without raw provider content.
- [x] A recovery drill processes more work than several batches and ends every injected crash as Posted, definitive Failed, scheduled safe retry, or Needs attention.

## Scope boundaries

- [x] Use the deterministic provider contract for generic recovery. Provider-specific recovery lands in tickets 05 through 10.
- [x] Do not add final manual confirmation, republish UX, or operator tooling beyond the state needed to expose truthful outcomes.

## Fresh-task handoff

Implement after ticket 03 with `/implement`; drive recovery and concurrency through `/tdd`; finish with `/code-review`; run uncached attempt, worker, database, configuration, UI status, typecheck, lint, test, and build checks.
