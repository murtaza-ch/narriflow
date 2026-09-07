# 04 — Apply subscription health, access, and retention policy

**What to build:** Make every realistic current subscription state produce one documented billing health, Workspace access projection, project-retention transition, and audit outcome. Provider outages and unknown catalog state must preserve the last verified entitlement instead of guessing.

**Blocked by:** [03 — Accept Stripe deliveries and reconcile asynchronously](03-accept-stripe-deliveries-and-reconcile-asynchronously.md).

**Status:** completed

**Specification:** [Deepen Workspace Billing synchronization](../spec.md)

## Observable acceptance criteria

- [x] `trialing` and `active` grant the mapped paid tier and normal Workspace access.
- [x] A first `incomplete` subscription grants no paid tier and keeps a newly created Workspace pending payment.
- [x] `past_due` preserves the last verified paid tier for seven days from its first durable observation and records payment action required.
- [x] Repeated events and reconciliations never reset or extend the past-due grace deadline.
- [x] Payment recovery to `active` or `trialing` within grace clears payment trouble without changing the verified plan.
- [x] Grace expiry while still past due removes paid entitlement at the fixed grace deadline.
- [x] `unpaid`, `paused`, `incomplete_expired`, and `canceled` grant no paid entitlement.
- [x] `cancel_at_period_end` keeps paid entitlement while the subscription remains active and exposes the exact end date.
- [x] Reactivation before period end removes the pending cancellation state on the next reconciliation.
- [x] A personal Workspace losing paid entitlement becomes active on Free.
- [x] A collaborative Workspace with non-owner members losing Business becomes restricted on Free while preserving owner billing, view, and download access.
- [x] Restricted status blocks processing, publishing, API and MCP access, and new billable collaboration for every affected role.
- [x] Provider timeout, unavailable current state, missing metadata, or unknown price leaves the last verified tier and retention state unchanged and schedules retry or attention.
- [x] Multiple entitlement-bearing subscriptions preserve the highest verified paid entitlement, record operator attention, and perform no automatic cancellation, merge, refund, or deletion.
- [x] Customer mismatch, multiple customers, duplicate seat-price items, and unmapped prices use stable attention reasons rather than raw provider errors.
- [x] Provider-effective trial, payment, period, and cancellation facts establish transition time. Receipt time and event ordering do not.
- [x] Workspace tier, Workspace status, Workspace Billing Account snapshot, project-retention transition, and append-only billing transition commit atomically.
- [x] A verified paid transition effective before a Project deadline clears only unexpired deadlines.
- [x] A paid-to-Free transition assigns the accepted downgrade-retention policy once and cannot extend it on replay.
- [x] A recovery after a Project deadline cannot restore that Project.
- [x] Reconciliation that produces no state change does not append a duplicate audit transition.
- [x] The billing view exposes verified plan, provider status in product language, renewal or end date, grace deadline, health, last successful sync, and safe owner actions.

## Public-interface and failure-injection tests

- [x] Table-driven interface tests cover every subscription status, cancellation flag, interval, personal or collaborative shape, and recovery transition.
- [x] Manual-clock tests prove first past-due observation, seven-day grace, exact grace expiry, repeated observation, and recovery just before and after the deadline.
- [x] Event-order tests prove old cancellation cannot remove a newer current subscription and old creation cannot restore a terminal one.
- [x] Multiple-subscription tests cover canonical single subscription, higher-tier conflict, lower-tier conflict, terminal extras, and no destructive provider calls.
- [x] Unknown-price and provider-outage tests assert the previous tier, Workspace status, and retention deadlines remain unchanged.
- [x] Retention tests cover pre-deadline rescue, point-of-no-return non-restoration, one-time downgrade assignment, transaction rollback, and replay.
- [x] Disposable PostgreSQL tests prove billing snapshot, access projection, retention, and transition history settle in one transaction under competing claims.
- [x] Hono and billing-view tests prove stable codes and product copy inputs without message parsing or provider identifiers.

## Rollout constraints

- [x] The seven-day grace policy and restricted collaborative behavior are documented in the billing runbook and product copy source.
- [x] Unknown catalog state must alert before any plan is enabled in a live account.
- [x] No state transition in this ticket mutates Stripe.

## Scope boundaries

- [x] Do not implement Checkout attempt recovery, customer creation, seat mutation, or final React polish.
- [x] Do not change the accepted retention durations or purge workflow.

## Completion evidence

- The subscription matrix now covers active, trialing, incomplete, past due with a fixed seven-day grace deadline, recovery, terminal states, cancellation-at-period-end, and reactivation using provider-derived effective times.
- Personal Workspaces fall back to active Free, while collaborative Workspaces with non-owner members become restricted. The centralized capability policy preserves only owner view, download, and billing access in restricted state.
- Provider outages, missing or mismatched metadata, unknown prices, duplicate seat items, and multiple paid subscriptions preserve verified entitlement and schedule retry or operator attention. Projection, retention, audit history, and delivery settlement commit atomically and pass manual-clock, retention, module, Hono, and PostgreSQL tests.

## Fresh-task handoff

Implement after ticket 03 with `/implement`; drive the status matrix, grace clock, retention transaction, and conflict policy through `/tdd`; finish with `/code-review`; run uncached module, retention, database, Hono, typecheck, lint, test, and build checks.
