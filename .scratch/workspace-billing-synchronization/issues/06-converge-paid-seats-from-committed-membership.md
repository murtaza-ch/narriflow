# 06 — Converge paid seats from committed membership

**What to build:** Make committed Workspace membership the desired paid-seat truth and synchronize Stripe in the background. Member actions stay responsive, rapid changes converge to the latest Admin and Editor count, and ambiguous provider responses cannot create duplicate seat items or overwrite newer intent.

**Blocked by:** [04 — Apply subscription health, access, and retention policy](04-apply-subscription-health-access-and-retention-policy.md).

**Status:** completed

**Specification:** [Deepen Workspace Billing synchronization](../spec.md)

## Observable acceptance criteria

- [ ] The owner seat is included; only non-owner Admin and Editor memberships count as additional paid seats; Viewers count as zero.
- [ ] Invite creation does not change desired seats. Acceptance into Admin or Editor, billable promotion, demotion, and removal do.
- [ ] A membership mutation and durable billing-due marker commit in the same database transaction.
- [ ] Foreground invite acceptance, role change, and removal do not call Stripe or wait on provider network latency.
- [ ] Existing member access remains stable during transient seat synchronization retries.
- [ ] A claimed reconciliation computes desired quantity from current committed membership rather than a caller-supplied projected count.
- [ ] Rapid or concurrent member changes coalesce onto the latest desired quantity.
- [ ] Reconciliation retrieves current subscription items and identifies the seat item only by the configured interval-specific seat price.
- [ ] A missing known seat item with positive desired quantity is created once with durable idempotency.
- [ ] One known seat item is updated to the latest desired quantity with the documented proration behavior.
- [ ] A zero desired quantity removes only the known seat item and verifies ambiguous deletion by retrieving current subscription state.
- [ ] A local stored seat item identity is treated as a cache and corrected from verified provider state.
- [ ] A lost create or update response is reconciled before another provider mutation.
- [ ] A stale claimant cannot settle synchronized quantity, health, or provider identity after lease loss.
- [ ] If an older provider call finishes after a newer membership change, the account remains due until provider quantity equals current desired quantity.
- [ ] Multiple matching seat items, an unknown seat price, customer mismatch, or multiple subscriptions produce operator attention and no destructive automated repair.
- [ ] Transient provider failure preserves membership, schedules retry, and reports desired versus synchronized quantity to the owner.
- [ ] Attention state blocks new billable invite acceptance and promotion but allows Viewer invitations, demotions, removals, portal access, view, and download.
- [ ] Payment-restricted Workspaces cannot add billable roles until subscription health recovers.
- [ ] Obsolete foreground payment-operation markers, compensating seat calls, and the fixed first-page hourly seat sweep are removed.
- [ ] Structured diagnostics report desired and observed counts, item state class, operation disposition, attempt, duration, and retry without invoice or customer details.

## Public-interface and failure-injection tests

- [ ] Interface tests cover owner-only, Viewer, Admin, Editor, acceptance, promotion, demotion, removal, and no-op role changes.
- [ ] Concurrent tests cover two acceptances, acceptance plus removal, rapid role toggles, and an old provider call completing after a newer desired count.
- [ ] Failure injection covers membership transaction rollback, due-marker rollback, item retrieval, create, update, delete, ambiguous response, provider timeout, claim loss, and final settlement.
- [ ] Tests prove the foreground member action succeeds independently of a transient provider error and that the account remains due.
- [ ] Tests prove one item create after concurrent reconciliation and no duplicate mutation after response loss.
- [ ] Manual-clock tests cover retry coalescing, backoff, periodic safety reconciliation, and stale attempt fencing.
- [ ] Disposable PostgreSQL tests prove membership-plus-wake-up atomicity and current desired count under concurrent role mutations.
- [ ] Stripe sandbox contracts prove item discovery, interval prices, quantity updates, proration behavior, zero-seat removal, idempotent create and update, and retrieval after ambiguous outcomes.
- [ ] Member action and UI contract tests prove safe operations remain available in retrying and attention states.

## Product and rollout constraints

- [ ] Preserve current role permissions and the product promise that Viewers are free and the owner seat is included.
- [ ] Do not roll membership backward because Stripe rejected or delayed a seat update.
- [ ] New billable additions remain bounded by the billing-health gates while unresolved conflicts exist.

## Scope boundaries

- [ ] Do not add usage-based billing, volume seat pricing, seat limits, payment collection UI, or automatic financial repair.
- [ ] Leave final visual polish and the unified billing/member status presentation to ticket 07.

## Fresh-task handoff

Implement after ticket 04 with `/implement`; use `/tdd` for transaction coupling, latest-count convergence, ambiguity, and concurrency; finish with `/code-review`; run uncached module, membership, worker, database, Stripe sandbox, typecheck, lint, test, and build checks.

## Completion evidence — 2026-08-28

- Membership acceptance, role changes, demotions, and removals now commit the current desired paid-seat count, revision, and due marker in the same PostgreSQL transaction without a foreground Stripe call.
- Fenced reconciliation discovers only the interval-specific seat item, uses stable revision keys and prorations, converges to the latest committed Admin/Editor count, and removes the known item at zero.
- Obsolete payment-operation markers, compensating provider calls, and the fixed-page hourly sweep are removed. Module, sandbox seat create/update/delete/retrieval, and disposable PostgreSQL concurrency/fairness checks pass.
