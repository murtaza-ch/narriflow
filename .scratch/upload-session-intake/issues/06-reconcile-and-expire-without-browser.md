# 06 — Reconcile and expire sessions without a browser

**What to build:** Let bounded worker maintenance finish or compensate Upload Sessions after the browser and request process disappear. Initiating, finalizing, reconciling, compensating, and expired sessions must all converge under multi-worker contention.

**Blocked by:** [02 — Converge interrupted upload admission](02-converge-interrupted-upload-admission.md); [05 — Make finalization replayable](05-make-finalization-replayable.md).

**Status:** completed

**Specification:** [Deepen Upload Session intake and reconciliation](../spec.md)

## Observable acceptance criteria

- [x] Upload Session reconciliation claims use an immutable internal attempt ID and expiring lease. Every durable mutation checks the current claim.
- [x] Several workers can claim due sessions without processing one session concurrently, and an expired claim can be taken over safely.
- [x] A stale claimant that completes a provider call cannot replace a newer `queued_for_ingest`, compensation, or terminal outcome.
- [x] The maintenance loop claims at most 25 sessions per batch by default and runs at most four provider operations concurrently.
- [x] Batch size, concurrency, lease duration, operation deadlines, backoff base, and backoff ceiling are immutable validated worker configuration.
- [x] Retryable and ambiguous outcomes schedule exponential backoff with jitter. Permanent outcomes settle or compensate without futile retries.
- [x] Initiating recovery adopts exact-key provider state or compensates it using ticket 02 behavior.
- [x] Finalizing and reconciling recovery uses the persisted completion intent and exact-object truth from ticket 05.
- [x] Compensating recovery aborts unfinished multipart state or deletes a session-unique single object, treats already missing state as success, and records retryable cleanup failures.
- [x] Uploading sessions expire after 24 hours without accepted activity. Grant activity may renew idle expiry within a hard lifetime shorter than the provider's seven-day default cleanup.
- [x] Expiry moves through compensation before terminal `expired`; merely changing the database status is insufficient.
- [x] A finalization intent already accepted before expiry is reconciled rather than discarded.
- [x] Workspace suspension blocks new transfer grants but does not strand an accepted finalization intent.
- [x] Maintenance failure in one session does not stop unrelated due sessions or the worker's other poll loops.
- [x] Structured maintenance logs report claims, takeovers, outcomes, provider operation class, declared abandoned bytes, duration, and next retry without secrets.

## Public-interface and failure-injection tests

- [x] Disposable PostgreSQL concurrency tests cover competing claims, lease expiry, stale settlement, batch fairness, replay after worker crash, and exactly-once handoff.
- [x] Manual-clock tests cover due selection, idle renewal, hard lifetime, exponential backoff, jitter bounds, and expiry versus accepted finalization.
- [x] Failure injection covers every provider probe, completion, abort, delete, handoff, claim renewal, lease loss, and terminal write.
- [x] Tests prove one session's timeout or cleanup denial cannot block later batch entries.
- [x] Operation budgets cap provider calls per attempt and document the extra probes for each ambiguous state.
- [x] Worker-loop tests prove maintenance runs independently of long ingest, rendering, social, and retention work.

## Rollout and operational constraints

- [x] The provider's incomplete-multipart lifecycle rule is documented and checked as defense in depth, while application expiry remains the primary cleanup path.
- [x] Maintenance defaults are conservative relative to current R2 account limits and can never be configured as unbounded.
- [x] Recovery is idempotent after partial provider success, database failure, or process termination.
- [x] No bucket-wide garbage collector or unscoped destructive command is introduced.

## Scope boundaries

- [x] Do not merge Upload Session claims into Workflow Attempt or Ingest Job ownership.
- [x] Do not add user notifications, upload history, or a new operator dashboard.

## Completion evidence

- Worker reconciliation uses immutable attempt IDs, expiring leases, fresh per-claim timestamps, fenced mutations, a 25-row batch, four row workers, cancellable provider deadlines, and a validated 20-call per-attempt budget. Ambiguous work uses bounded exponential jitter with an eight-attempt ceiling.
- Maintenance independently converges initiating, uploading, finalizing, reconciling, and compensating rows. It retries due duplicate cleanup without a browser, honors initiating backoff in PostgreSQL, fences late grants/finalization, and terminalizes permanent cleanup denial without reclaim loops.
- Manual-clock and failure-injection tests cover idle renewal, hard lifetime, expiry compensation, provider call budgets, cancellation, batch fairness, claim takeover, stale settlement, retry isolation, and exact handoff replay. A dedicated worker-loop test proves Upload Session maintenance completes while ingest remains busy; the isolated database runner applies all 54 migrations before testing and drops its schema afterward.

## Fresh-task handoff

Implement after tickets 02 and 05 with `/implement`; drive leases, takeovers, expiry, and compensation with `/tdd`; finish with `/code-review`; run uncached worker, module, disposable database, typecheck, lint, and build verification.
