# 06 — Reconcile and expire sessions without a browser

**What to build:** Let bounded worker maintenance finish or compensate Upload Sessions after the browser and request process disappear. Initiating, finalizing, reconciling, compensating, and expired sessions must all converge under multi-worker contention.

**Blocked by:** [02 — Converge interrupted upload admission](02-converge-interrupted-upload-admission.md); [05 — Make finalization replayable](05-make-finalization-replayable.md).

**Status:** ready-for-agent

**Specification:** [Deepen Upload Session intake and reconciliation](../spec.md)

## Observable acceptance criteria

- [ ] Upload Session reconciliation claims use an immutable internal attempt ID and expiring lease. Every durable mutation checks the current claim.
- [ ] Several workers can claim due sessions without processing one session concurrently, and an expired claim can be taken over safely.
- [ ] A stale claimant that completes a provider call cannot replace a newer `queued_for_ingest`, compensation, or terminal outcome.
- [ ] The maintenance loop claims at most 25 sessions per batch by default and runs at most four provider operations concurrently.
- [ ] Batch size, concurrency, lease duration, operation deadlines, backoff base, and backoff ceiling are immutable validated worker configuration.
- [ ] Retryable and ambiguous outcomes schedule exponential backoff with jitter. Permanent outcomes settle or compensate without futile retries.
- [ ] Initiating recovery adopts exact-key provider state or compensates it using ticket 02 behavior.
- [ ] Finalizing and reconciling recovery uses the persisted completion intent and exact-object truth from ticket 05.
- [ ] Compensating recovery aborts unfinished multipart state or deletes a session-unique single object, treats already missing state as success, and records retryable cleanup failures.
- [ ] Uploading sessions expire after 24 hours without accepted activity. Grant activity may renew idle expiry within a hard lifetime shorter than the provider's seven-day default cleanup.
- [ ] Expiry moves through compensation before terminal `expired`; merely changing the database status is insufficient.
- [ ] A finalization intent already accepted before expiry is reconciled rather than discarded.
- [ ] Workspace suspension blocks new transfer grants but does not strand an accepted finalization intent.
- [ ] Maintenance failure in one session does not stop unrelated due sessions or the worker's other poll loops.
- [ ] Structured maintenance logs report claims, takeovers, outcomes, provider operation class, declared abandoned bytes, duration, and next retry without secrets.

## Public-interface and failure-injection tests

- [ ] Disposable PostgreSQL concurrency tests cover competing claims, lease expiry, stale settlement, batch fairness, replay after worker crash, and exactly-once handoff.
- [ ] Manual-clock tests cover due selection, idle renewal, hard lifetime, exponential backoff, jitter bounds, and expiry versus accepted finalization.
- [ ] Failure injection covers every provider probe, completion, abort, delete, handoff, claim renewal, lease loss, and terminal write.
- [ ] Tests prove one session's timeout or cleanup denial cannot block later batch entries.
- [ ] Operation budgets cap provider calls per attempt and document the extra probes for each ambiguous state.
- [ ] Worker-loop tests prove maintenance runs independently of long ingest, rendering, social, and retention work.

## Rollout and operational constraints

- [ ] The provider's incomplete-multipart lifecycle rule is documented and checked as defense in depth, while application expiry remains the primary cleanup path.
- [ ] Maintenance defaults are conservative relative to current R2 account limits and can never be configured as unbounded.
- [ ] Recovery is idempotent after partial provider success, database failure, or process termination.
- [ ] No bucket-wide garbage collector or unscoped destructive command is introduced.

## Scope boundaries

- [ ] Do not merge Upload Session claims into Workflow Attempt or Ingest Job ownership.
- [ ] Do not add user notifications, upload history, or a new operator dashboard.

## Fresh-task handoff

Implement after tickets 02 and 05 with `/implement`; drive leases, takeovers, expiry, and compensation with `/tdd`; finish with `/code-review`; run uncached worker, module, disposable database, typecheck, lint, and build verification.
