# 02 — Establish the Workspace Billing Account tracer

**What to build:** Reconcile one mapped current Stripe subscription through a new Workspace Billing module into one durable Workspace Billing Account and one product billing view. Replace the current successful direct tier-write path without changing healthy active-plan behavior.

**Blocked by:** [01 — Make Workspace the sole entitlement source](01-make-workspace-the-sole-entitlement-source.md).

**Status:** ready-for-agent

**Specification:** [Deepen Workspace Billing synchronization](../spec.md)

## Observable acceptance criteria

- [ ] Add Workspace Billing Account to the domain glossary and record module ownership, adapters, access projection, and reconciliation responsibility in an ADR.
- [ ] One Workspace has at most one Workspace Billing Account, and provider customer and canonical subscription identities remain unique across accounts.
- [ ] Existing Workspace provider identity, interval, and current subscription facts migrate into the account before obsolete Workspace billing columns are removed.
- [ ] The public Workspace Billing interface owns current-state reconciliation and billing-state reads; callers do not apply tiers, retention transitions, or provider snapshots themselves.
- [ ] A mapped current `active` or `trialing` subscription produces the expected paid Workspace tier, active Workspace status, interval, renewal or trial facts, verified timestamp, and current billing health.
- [ ] A successful reconciliation returns one typed billing view containing only product facts and allowed owner actions.
- [ ] The current direct event-snapshot tier write is replaced by a Stripe current-state retrieval through the module.
- [ ] An unsupported or incomplete provider state changes no entitlement in this tracer and returns a typed unresolved outcome for later policy tickets.
- [ ] Stripe, persistence, clock, and diagnostics are internal adapters injected at construction, not caller obligations in the public interface.
- [ ] The production Stripe adapter retrieves the customer and complete relevant subscription collection needed by reconciliation.
- [ ] A fixed billing catalog maps every configured base price to exactly one tier and interval and every seat price to exactly one interval.
- [ ] Duplicate price mappings, missing required prices for enabled flows, invalid worker limits, and unbounded numeric configuration fail process startup.
- [ ] Structured diagnostics report Workspace, reconciliation phase, provider operation class, mapped plan, duration, and outcome without provider secrets or personal billing data.
- [ ] The module remains re-exported through the shared services interface.

## Public-interface and failure-injection tests

- [ ] Behavior tests call the Workspace Billing interface and assert returned billing view, Workspace projection, account snapshot, and diagnostics.
- [ ] Active monthly, active annual, and trialing subscriptions map to the correct tier and interval.
- [ ] Test adapters inject failure before retrieval, after retrieval, before transaction commit, and after commit.
- [ ] A provider timeout or database rollback leaves the prior Workspace entitlement unchanged.
- [ ] Replaying the same current provider state is idempotent and does not append duplicate visible changes.
- [ ] A customer or subscription belonging to a different Workspace cannot be adopted.
- [ ] Catalog tests reject duplicate base IDs, base-versus-seat collisions, missing enabled IDs, invalid intervals, and non-finite limits.
- [ ] Disposable PostgreSQL tests prove one account per Workspace and unique customer and subscription bindings under concurrency.

## Migration and cutover constraints

- [ ] Migrate current pre-production Workspace billing identity directly; do not add reads from both old and new storage.
- [ ] Remove the former direct tier application path as soon as the tracer becomes active.
- [ ] Keep current plan prices, feature flags, retention rules, and healthy billing UI behavior unchanged in this slice.
- [ ] The repository stays green even though durable delivery acceptance and background claiming arrive in ticket 03.

## Scope boundaries

- [ ] Do not implement the Stripe event inbox, full subscription-status policy, replayable Checkout, paid seats, or redesigned billing UX.
- [ ] Do not introduce a generic billing platform or job framework.

## Fresh-task handoff

Implement after ticket 01 with `/implement`; drive the module tracer, catalog, and database uniqueness through `/tdd`; finish with `/code-review`; run uncached module, database, migration, typecheck, lint, test, and build checks.
