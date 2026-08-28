# 04 — Apply subscription health, access, and retention policy

**What to build:** Make every realistic current subscription state produce one documented billing health, Workspace access projection, project-retention transition, and audit outcome. Provider outages and unknown catalog state must preserve the last verified entitlement instead of guessing.

**Blocked by:** [03 — Accept Stripe deliveries and reconcile asynchronously](03-accept-stripe-deliveries-and-reconcile-asynchronously.md).

**Status:** ready-for-agent

**Specification:** [Deepen Workspace Billing synchronization](../spec.md)

## Observable acceptance criteria

- [ ] `trialing` and `active` grant the mapped paid tier and normal Workspace access.
- [ ] A first `incomplete` subscription grants no paid tier and keeps a newly created Workspace pending payment.
- [ ] `past_due` preserves the last verified paid tier for seven days from its first durable observation and records payment action required.
- [ ] Repeated events and reconciliations never reset or extend the past-due grace deadline.
- [ ] Payment recovery to `active` or `trialing` within grace clears payment trouble without changing the verified plan.
- [ ] Grace expiry while still past due removes paid entitlement at the fixed grace deadline.
- [ ] `unpaid`, `paused`, `incomplete_expired`, and `canceled` grant no paid entitlement.
- [ ] `cancel_at_period_end` keeps paid entitlement while the subscription remains active and exposes the exact end date.
- [ ] Reactivation before period end removes the pending cancellation state on the next reconciliation.
- [ ] A personal Workspace losing paid entitlement becomes active on Free.
- [ ] A collaborative Workspace with non-owner members losing Business becomes restricted on Free while preserving owner billing, view, and download access.
- [ ] Restricted status blocks processing, publishing, API and MCP access, and new billable collaboration for every affected role.
- [ ] Provider timeout, unavailable current state, missing metadata, or unknown price leaves the last verified tier and retention state unchanged and schedules retry or attention.
- [ ] Multiple entitlement-bearing subscriptions preserve the highest verified paid entitlement, record operator attention, and perform no automatic cancellation, merge, refund, or deletion.
- [ ] Customer mismatch, multiple customers, duplicate seat-price items, and unmapped prices use stable attention reasons rather than raw provider errors.
- [ ] Provider-effective trial, payment, period, and cancellation facts establish transition time. Receipt time and event ordering do not.
- [ ] Workspace tier, Workspace status, Workspace Billing Account snapshot, project-retention transition, and append-only billing transition commit atomically.
- [ ] A verified paid transition effective before a Project deadline clears only unexpired deadlines.
- [ ] A paid-to-Free transition assigns the accepted downgrade-retention policy once and cannot extend it on replay.
- [ ] A recovery after a Project deadline cannot restore that Project.
- [ ] Reconciliation that produces no state change does not append a duplicate audit transition.
- [ ] The billing view exposes verified plan, provider status in product language, renewal or end date, grace deadline, health, last successful sync, and safe owner actions.

## Public-interface and failure-injection tests

- [ ] Table-driven interface tests cover every subscription status, cancellation flag, interval, personal or collaborative shape, and recovery transition.
- [ ] Manual-clock tests prove first past-due observation, seven-day grace, exact grace expiry, repeated observation, and recovery just before and after the deadline.
- [ ] Event-order tests prove old cancellation cannot remove a newer current subscription and old creation cannot restore a terminal one.
- [ ] Multiple-subscription tests cover canonical single subscription, higher-tier conflict, lower-tier conflict, terminal extras, and no destructive provider calls.
- [ ] Unknown-price and provider-outage tests assert the previous tier, Workspace status, and retention deadlines remain unchanged.
- [ ] Retention tests cover pre-deadline rescue, point-of-no-return non-restoration, one-time downgrade assignment, transaction rollback, and replay.
- [ ] Disposable PostgreSQL tests prove billing snapshot, access projection, retention, and transition history settle in one transaction under competing claims.
- [ ] Hono and billing-view tests prove stable codes and product copy inputs without message parsing or provider identifiers.

## Rollout constraints

- [ ] The seven-day grace policy and restricted collaborative behavior are documented in the billing runbook and product copy source.
- [ ] Unknown catalog state must alert before any plan is enabled in a live account.
- [ ] No state transition in this ticket mutates Stripe.

## Scope boundaries

- [ ] Do not implement Checkout attempt recovery, customer creation, seat mutation, or final React polish.
- [ ] Do not change the accepted retention durations or purge workflow.

## Fresh-task handoff

Implement after ticket 03 with `/implement`; drive the status matrix, grace clock, retention transaction, and conflict policy through `/tdd`; finish with `/code-review`; run uncached module, retention, database, Hono, typecheck, lint, test, and build checks.
