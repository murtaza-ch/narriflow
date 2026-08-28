# 08 — Prove Stripe contracts, recovery, and direct cutover

**What to build:** Close the Workspace Billing change with Stripe sandbox contracts, database recovery drills, bounded reconciliation evidence, safe repair commands, browser proof, operational documentation, and removal of every obsolete billing path.

**Blocked by:** [07 — Finish billing and member recovery UX](07-finish-billing-and-member-recovery-ux.md).

**Status:** ready-for-agent

**Specification:** [Deepen Workspace Billing synchronization](../spec.md)

## Observable acceptance criteria

- [ ] Every Stripe delivery, Checkout, portal, customer, current subscription, entitlement projection, retention transition, and paid-seat path uses the Workspace Billing interface.
- [ ] Hono, React, membership, worker, persistence, and Stripe remain adapters and contain no competing billing state machine or recovery policy.
- [ ] Old direct tier application, second-resolution ordering, User billing dual writes, legacy Checkout identity fallback, foreground Stripe seat calls, old fixed-page sweep, optimistic upgrade toast, and obsolete schema fields are absent.
- [ ] Billing catalog and worker configuration validate once at process startup with safe finite defaults and hard maximums.
- [ ] Webhook and portal configuration documentation lists the exact required event classes, sandbox and live separation, portal catalog requirements, API version expectations, and secret placement without real credentials.
- [ ] An idempotent operator inspect-and-reconcile command can target one Workspace Billing Account, defaults to read-only inspection, and reports normalized provider and local state without personal or secret data.
- [ ] Operator repair never cancels, merges, refunds, deletes, or changes provider billing automatically.
- [ ] Structured diagnostics and metrics cover acceptance, duplicates, queue age, claims, stale settlement, current-state retrieval, access transitions, retention, grace recovery, customer and subscription conflicts, desired and synchronized seats, provider calls, retries, attention, duration, and terminal health.
- [ ] Logs and metrics contain no API keys, signatures, webhook bodies, customer email, billing address, payment details, raw provider errors, Checkout URLs, portal URLs, or full provider IDs.
- [ ] The runbook explains event diagnosis, payment-health diagnosis, safe manual reconciliation, conflict escalation, migration deploy order, worker controls, rollback, and direct pre-production reset.
- [ ] The architecture review marks Workspace Billing complete only after the full evidence below is reproducible.

## Stripe sandbox proof

- [ ] Contract tests verify raw-body signature success and failure under the configured Stripe API version.
- [ ] Delivery fixtures cover Checkout completion and delayed outcomes, subscription creation, update, pause, resume, deletion, invoice payment success and failure, and relevant customer changes.
- [ ] Customer contracts cover stable idempotent create, metadata binding, retrieval after lost response, exact metadata lookup, and conflict classification.
- [ ] Checkout contracts cover idempotent creation, immutable metadata, expiration, completed and unpaid retrieval, delayed payment, and workspace-bound return facts.
- [ ] Portal contracts cover configured catalog access, temporary sessions, return handling, subscription changes, interval changes, cancellation, and payment-method recovery.
- [ ] Subscription contracts cover complete pagination, every supported status, cancellation-at-period-end, trial and period facts, invoice payment evidence, unknown prices, multiple subscriptions, and provider timeouts.
- [ ] Seat contracts cover item discovery, interval-specific price, create, quantity update, proration behavior, zero-seat removal, idempotent retries where supported, and current-state retrieval after ambiguous outcomes.
- [ ] Every fixture uses an isolated sandbox customer prefix, cleans up its own safe test objects, and never operates on live mode or unrelated customers.

## Database and recovery proof

- [ ] A disposable PostgreSQL drill applies the complete migration chain and migrates representative personal, collaborative, pending, paid, past-due, and conflicted fixtures.
- [ ] The drill proves unique delivery acceptance, one account per Workspace, unique provider bindings, concurrent Checkout starts, customer lost-bind recovery, event permutations, lease takeover, stale fencing, atomic retention projection, grace expiry, payment recovery, and latest-seat convergence.
- [ ] Failure injection before and after every provider operation and durable transition leaves one verified prior state, scheduled retry, or attention outcome with no duplicate account, customer binding, Checkout attempt, transition, or seat item.
- [ ] A fairness fixture with more than two batches proves every due account is eventually claimed and one timeout does not block later accounts.
- [ ] Active safety reconciliation, activating cadence, grace deadlines, retry backoff, attention cadence, operation deadlines, and per-attempt provider-call budgets are measured and asserted.
- [ ] Full module behavior tests use the Workspace Billing interface. Superseded helper tests are deleted once equivalent public behavior coverage exists.

## End-to-end verification

- [ ] Authenticated browser verification covers first Free-to-paid Checkout, lost start response, lost return response, leaving during activation, completed replay, active paid portal, plan change, cancellation-at-period-end, payment recovery, and non-owner read-only billing.
- [ ] Business verification covers Viewer invite, billable acceptance, concurrent billable changes, seat synchronization delay, latest-count convergence, attention blocking, safe demotion, and safe removal.
- [ ] Retention verification proves a verified pre-deadline upgrade saves unexpired Projects and a post-deadline recovery does not restore an expired Project.
- [ ] Repository typecheck, lint, full tests, production build, full migration deploy chain, uncached focused suites, disposable database drill, Stripe sandbox contracts, and browser checks all pass.
- [ ] Final Standards and Spec review reports no unresolved findings.

## Rollout and recovery safety

- [ ] Apply pending migrations before deploying code that requires Workspace Billing Accounts or delivery claims.
- [ ] Use the pre-production direct cutover. Do not add a feature flag, shadow processing, mixed old and new webhook handlers, dual writes, or fallback billing renderer.
- [ ] Reset inconsistent local billing fixtures and sandbox customers deliberately; do not migrate obsolete local-only protocol state.
- [ ] Rollback instructions preserve durable delivery and billing-account evidence or deliberately reset local data and never mutate live Stripe objects without a separate approved procedure.
- [ ] Run live-mode mutations only after the sandbox matrix, portal configuration, event registration, secrets, migration, and operator runbook gates pass.

## Scope boundaries

- [ ] Do not add usage billing, credits, taxes, refunds, coupons, volume seats, custom payment UI, automated destructive repair, or unrelated architecture candidates.
- [ ] Do not mark the recommendation complete from mocks, unit tests, or a single happy-path Checkout alone.

## Fresh-task handoff

Implement after ticket 07 with `/implement`; use `/tdd` for any uncovered contract or recovery gap; finish with `/code-review`; run the full uncached verification matrix and record reproducible completion evidence in this ticket and the architecture review.
