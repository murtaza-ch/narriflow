# 01 — Make Workspace the sole entitlement source

**What to build:** Remove the remaining user-level billing truth so every entitlement, quota, retention, export, dubbing, content, and authorization decision reads the active Workspace. Personal and collaborative Workspaces must keep their current behavior while one obsolete data shape and its dual writes disappear.

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

**Specification:** [Deepen Workspace Billing synchronization](../spec.md)

## Observable acceptance criteria

- [ ] Every plan and feature decision for authenticated product work reads Workspace pricing through an explicit Workspace identity.
- [ ] Processing quotas, upload admission, exports, watermarking, dubbing, content generation, project retention, API and MCP access, and render snapshots no longer fall back to a User tier.
- [ ] Authentication returns Workspace actor context from a validated membership and does not reconstruct billing state from obsolete User fields.
- [ ] Personal Workspaces remain the product home for individual users and retain their current plan, projects, usage, and access after migration.
- [ ] Collaborative Workspaces retain their independent plan and cannot inherit the owner's personal plan.
- [ ] User-level Stripe customer identity, billing event ordering, and pricing tier stop participating in runtime billing or entitlement decisions.
- [ ] Billing no longer dual-writes User and Workspace rows.
- [ ] The legacy interpretation that treats a Checkout client reference as a User identity is removed.
- [ ] Retention observation and enforcement query Workspace pricing, including personal Workspace projects.
- [ ] All remaining callers that lack Workspace identity are changed to require or derive it before making an entitlement decision.
- [ ] Obsolete schema fields and dead helpers are removed in the same cutover. No dual read, dual write, compatibility selector, or fallback parser remains.
- [ ] Shared service exports continue to present one supported entitlement interface to web, worker, and MCP callers.

## Public-interface and migration tests

- [ ] Behavior tests prove the same user receives different entitlements in two Workspaces with different plans.
- [ ] Personal Workspace tests prove current Free and paid limits remain unchanged.
- [ ] Collaborative Workspace tests prove owner personal billing cannot grant or revoke Workspace access.
- [ ] Retention tests prove Workspace upgrades and downgrades affect only projects owned by that Workspace.
- [ ] Export, dubbing, content, upload, and API contract tests use Workspace pricing fixtures and fail if a User-tier fallback is reintroduced.
- [ ] Authentication tests prove an invalid active-workspace cookie cannot select another Workspace's entitlement.
- [ ] Migration tests preserve current personal and collaborative Workspace tiers and reject inconsistent local fixture data instead of guessing.
- [ ] Repository search and schema checks prove no runtime reference to retired User billing fields remains.

## Cutover constraints

- [ ] Treat this as the one approved wide refactor. Keep the repository green while the call sites move together.
- [ ] Apply the migration before deploying code that reads the new shape.
- [ ] Reset inconsistent local fixtures under the pre-production policy rather than adding compatibility behavior.
- [ ] Do not change prices, quota amounts, feature matrices, Workspace roles, or retention durations.

## Scope boundaries

- [ ] Do not add the Workspace Billing Account, Stripe event inbox, Checkout recovery, subscription policy, or seat reconciliation in this ticket.
- [ ] Do not broaden the change into the separate authenticated request-policy architecture candidate.

## Fresh-task handoff

Implement first with `/implement`; use `/tdd` for cross-Workspace entitlement isolation and migration; finish with `/code-review`; run uncached focused tests, the full migration chain, typecheck, lint, tests, and a production build.
