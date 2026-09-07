# 02 — Establish the Workspace Billing Account tracer

**What to build:** Reconcile one mapped current Stripe subscription through a new Workspace Billing module into one durable Workspace Billing Account and one product billing view. Replace the current successful direct tier-write path without changing healthy active-plan behavior.

**Blocked by:** [01 — Make Workspace the sole entitlement source](01-make-workspace-the-sole-entitlement-source.md).

**Status:** completed

**Specification:** [Deepen Workspace Billing synchronization](../spec.md)

## Observable acceptance criteria

- [x] Add Workspace Billing Account to the domain glossary and record module ownership, adapters, access projection, and reconciliation responsibility in an ADR.
- [x] One Workspace has at most one Workspace Billing Account, and provider customer and canonical subscription identities remain unique across accounts.
- [x] Existing Workspace provider identity, interval, and current subscription facts migrate into the account before obsolete Workspace billing columns are removed.
- [x] The public Workspace Billing interface owns current-state reconciliation and billing-state reads; callers do not apply tiers, retention transitions, or provider snapshots themselves.
- [x] A mapped current `active` or `trialing` subscription produces the expected paid Workspace tier, active Workspace status, interval, renewal or trial facts, verified timestamp, and current billing health.
- [x] A successful reconciliation returns one typed billing view containing only product facts and allowed owner actions.
- [x] The current direct event-snapshot tier write is replaced by a Stripe current-state retrieval through the module.
- [x] An unsupported or incomplete provider state changes no entitlement in this tracer and returns a typed unresolved outcome for later policy tickets.
- [x] Stripe, persistence, clock, and diagnostics are internal adapters injected at construction, not caller obligations in the public interface.
- [x] The production Stripe adapter retrieves the customer and complete relevant subscription collection needed by reconciliation.
- [x] A fixed billing catalog maps every configured base price to exactly one tier and interval and every seat price to exactly one interval.
- [x] Duplicate price mappings, missing required prices for enabled flows, invalid worker limits, and unbounded numeric configuration fail process startup.
- [x] Structured diagnostics report Workspace, reconciliation phase, provider operation class, mapped plan, duration, and outcome without provider secrets or personal billing data.
- [x] The module remains re-exported through the shared services interface.

## Public-interface and failure-injection tests

- [x] Behavior tests call the Workspace Billing interface and assert returned billing view, Workspace projection, account snapshot, and diagnostics.
- [x] Active monthly, active annual, and trialing subscriptions map to the correct tier and interval.
- [x] Test adapters inject failure before retrieval, after retrieval, before transaction commit, and after commit.
- [x] A provider timeout or database rollback leaves the prior Workspace entitlement unchanged.
- [x] Replaying the same current provider state is idempotent and does not append duplicate visible changes.
- [x] A customer or subscription belonging to a different Workspace cannot be adopted.
- [x] Catalog tests reject duplicate base IDs, base-versus-seat collisions, missing enabled IDs, invalid intervals, and non-finite limits.
- [x] Disposable PostgreSQL tests prove one account per Workspace and unique customer and subscription bindings under concurrency.

## Migration and cutover constraints

- [x] Migrate current pre-production Workspace billing identity directly; do not add reads from both old and new storage.
- [x] Remove the former direct tier application path as soon as the tracer becomes active.
- [x] Keep current plan prices, feature flags, retention rules, and healthy billing UI behavior unchanged in this slice.
- [x] The repository stays green even though durable delivery acceptance and background claiming arrive in ticket 03.

## Scope boundaries

- [x] Do not implement the Stripe event inbox, full subscription-status policy, replayable Checkout, paid seats, or redesigned billing UX.
- [x] Do not introduce a generic billing platform or job framework.

## Completion evidence

- The shared Workspace Billing module now owns catalog validation, Stripe current-state retrieval, provider ownership checks, durable account projection, billing-state reads, diagnostics, and the typed product billing view behind one public interface.
- Workspace Billing Account uniqueness and provider identity constraints are enforced in Prisma and PostgreSQL; existing Workspace subscription facts migrate before obsolete provider columns are removed.
- Active, trialing, unresolved, timeout, ownership-conflict, idempotent replay, rollback, catalog, migration, and database uniqueness paths pass through module and disposable PostgreSQL tests.

## Fresh-task handoff

Implement after ticket 01 with `/implement`; drive the module tracer, catalog, and database uniqueness through `/tdd`; finish with `/code-review`; run uncached module, database, migration, typecheck, lint, test, and build checks.
