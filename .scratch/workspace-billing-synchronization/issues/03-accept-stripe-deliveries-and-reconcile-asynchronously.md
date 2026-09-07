# 03 — Accept Stripe deliveries and reconcile asynchronously

**What to build:** Turn valid Stripe webhooks into a fast durable wake-up for current-state reconciliation. Duplicate, shuffled, crashed, and concurrent deliveries must converge through leased worker attempts without letting a stale response overwrite newer billing state.

**Blocked by:** [02 — Establish the Workspace Billing Account tracer](02-establish-workspace-billing-account-tracer.md).

**Status:** completed

**Specification:** [Deepen Workspace Billing synchronization](../spec.md)

## Observable acceptance criteria

- [x] Stripe becomes a supported provider in the durable webhook delivery ledger.
- [x] Signature verification uses the exact raw request body before any delivery row or billing work is accepted.
- [x] A valid new event commits one normalized delivery envelope and makes the affected Workspace Billing Account due in the same transaction.
- [x] The envelope stores only event identity, type, provider creation time, livemode, API version, normalized subject identities, Workspace hint, receipt time, and processing outcome.
- [x] Raw webhook bodies, signatures, payment details, addresses, complete provider objects, and customer email are never stored.
- [x] Exact event-ID redelivery returns success without another wake-up or side effect.
- [x] Separate event objects for the same subject and type remain safe and may coalesce onto the same due account.
- [x] Invalid or missing signatures return a typed client error; valid accepted and duplicate deliveries return success quickly; a database failure before acceptance returns a server error so Stripe retries.
- [x] Relevant Checkout, delayed-payment, subscription, invoice-payment, and customer events wake reconciliation; unrelated configured events are acknowledged without billing mutation.
- [x] Webhook processing never writes a tier from event payload state or compares event creation seconds to choose a winner.
- [x] Due account claims use an immutable attempt ID and expiring lease. Every settlement checks that attempt.
- [x] An expired claim can be taken over, while a stale claimant cannot replace a newer account snapshot, retry schedule, or terminal health state.
- [x] The worker defaults to a bounded batch of 25 and concurrency four, with finite provider deadlines and a finite per-attempt call budget.
- [x] Due selection orders by next reconciliation time and a stable identifier so work beyond the first batch is eventually processed.
- [x] Retryable and ambiguous failures use bounded exponential backoff with jitter. One account failure does not stop later accounts or other worker loops.
- [x] Current accounts receive a periodic due time as defense against lost wake-up signals.
- [x] The synchronous direct webhook reconciliation path is removed after the durable worker path is active.

## Public-interface and failure-injection tests

- [x] Module-interface tests cover valid acceptance, exact duplicate, equal-second events, reverse delivery order, ignored event, missing signature, invalid signature, and pre-acceptance database failure.
- [x] Every permutation of the supported event fixtures ends with the same active or trialing result as current Stripe state.
- [x] Failure injection covers process termination after acceptance, claim acquisition, provider retrieval, claim renewal, projection commit, delivery settlement, and retry scheduling.
- [x] Manual-clock tests cover lease expiry, stale settlement, backoff, jitter bounds, provider deadlines, periodic safety due times, and attention retry cadence.
- [x] Disposable PostgreSQL tests prove unique delivery acceptance, atomic delivery-plus-wake-up, competing claims, takeover, stale fencing, and fairness with more due accounts than one batch.
- [x] Hono tests prove 200 new and duplicate, 400 invalid signature, 500 database failure, raw-body preservation, and absence of entitlement logic in the route.
- [x] Worker tests prove billing reconciliation completes while ingest or another maintenance loop is busy and isolates one hung provider operation.

## Operational constraints

- [x] Register only the supported event types in Stripe sandbox before enabling the route.
- [x] Keep webhook delivery retention bounded and preserve the normalized billing transition history required by the spec.
- [x] Structured logs include delivery type, queue age, claim, operation class, disposition, elapsed time, and next retry without raw IDs in user-facing messages.

## Scope boundaries

- [x] Implement only the active and trialing current-state outcomes established by ticket 02; full payment-health and cancellation policy lands in ticket 04.
- [x] Do not add Checkout creation, customer recovery, seats, or final billing UI in this ticket.

## Completion evidence

- The Hono Stripe route verifies signatures against the exact raw body and durably stores only the normalized delivery envelope. New delivery acceptance and account wake-up commit atomically; exact redelivery is idempotent and unrelated events are acknowledged without entitlement work.
- The worker claims ordered due accounts with immutable attempt IDs, expiring leases, live-lease settlement fencing, bounded batch/concurrency/provider work, retry backoff with jitter, and periodic safety reconciliation.
- Module, Hono, worker, and disposable PostgreSQL tests cover delivery acceptance, raw-body preservation, duplicate handling, database failure, competing claims, takeover, stale fencing, work beyond one batch, successful delivery settlement, rollback, and independent worker-loop progress.

## Fresh-task handoff

Implement after ticket 02 with `/implement`; use `/tdd` for delivery idempotency, event permutations, leases, and stale fencing; finish with `/code-review`; run uncached module, Hono, worker, database, typecheck, lint, test, and build checks.
