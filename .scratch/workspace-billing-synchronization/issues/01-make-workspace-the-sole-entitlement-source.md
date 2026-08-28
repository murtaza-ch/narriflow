# 01 — Make Workspace the sole entitlement source

**What to build:** Remove the remaining user-level billing truth so every entitlement, quota, retention, export, dubbing, content, and authorization decision reads the active Workspace. Personal and collaborative Workspaces must keep their current behavior while one obsolete data shape and its dual writes disappear.

**Blocked by:** None — can start immediately.

**Status:** completed

**Specification:** [Deepen Workspace Billing synchronization](../spec.md)

## Observable acceptance criteria

- [x] Every plan and feature decision for authenticated product work reads Workspace pricing through an explicit Workspace identity.
- [x] Processing quotas, upload admission, exports, watermarking, dubbing, content generation, project retention, API and MCP access, and render snapshots no longer fall back to a User tier.
- [x] Authentication returns Workspace actor context from a validated membership and does not reconstruct billing state from obsolete User fields.
- [x] Personal Workspaces remain the product home for individual users and retain their current plan, projects, usage, and access after migration.
- [x] Collaborative Workspaces retain their independent plan and cannot inherit the owner's personal plan.
- [x] User-level Stripe customer identity, billing event ordering, and pricing tier stop participating in runtime billing or entitlement decisions.
- [x] Billing no longer dual-writes User and Workspace rows.
- [x] The legacy interpretation that treats a Checkout client reference as a User identity is removed.
- [x] Retention observation and enforcement query Workspace pricing, including personal Workspace projects.
- [x] All remaining callers that lack Workspace identity are changed to require or derive it before making an entitlement decision.
- [x] Obsolete schema fields and dead helpers are removed in the same cutover. No dual read, dual write, compatibility selector, or fallback parser remains.
- [x] Shared service exports continue to present one supported entitlement interface to web, worker, and MCP callers.

## Public-interface and migration tests

- [x] Behavior tests prove the same user receives different entitlements in two Workspaces with different plans.
- [x] Personal Workspace tests prove current Free and paid limits remain unchanged.
- [x] Collaborative Workspace tests prove owner personal billing cannot grant or revoke Workspace access.
- [x] Retention tests prove Workspace upgrades and downgrades affect only projects owned by that Workspace.
- [x] Export, dubbing, content, upload, and API contract tests use Workspace pricing fixtures and fail if a User-tier fallback is reintroduced.
- [x] Authentication tests prove an invalid active-workspace cookie cannot select another Workspace's entitlement.
- [x] Migration tests preserve current personal and collaborative Workspace tiers and reject inconsistent local fixture data instead of guessing.
- [x] Repository search and schema checks prove no runtime reference to retired User billing fields remains.

## Cutover constraints

- [x] Treat this as the one approved wide refactor. Keep the repository green while the call sites move together.
- [x] Apply the migration before deploying code that reads the new shape.
- [x] Reset inconsistent local fixtures under the pre-production policy rather than adding compatibility behavior.
- [x] Do not change prices, quota amounts, feature matrices, Workspace roles, or retention durations.

## Scope boundaries

- [x] Do not add the Workspace Billing Account, Stripe event inbox, Checkout recovery, subscription policy, or seat reconciliation in this ticket.
- [x] Do not broaden the change into the separate authenticated request-policy architecture candidate.

## Completion evidence

- User-level pricing, Stripe customer identity, and billing event ordering were removed from the Prisma schema and runtime. Projects now require Workspace ownership, and entitlement-sensitive services consume validated Workspace actor context.
- The cutover migration preserves matching personal and collaborative Workspace billing, rejects inconsistent fixtures, and removes obsolete User billing columns without a dual-read or compatibility path.
- Workspace isolation, retention, schema-cutover, full migration, typecheck, lint, test, production-build, and authenticated Chrome checks passed. Independent Standards and Spec reviews reported no remaining findings.

## Fresh-task handoff

Implement first with `/implement`; use `/tdd` for cross-Workspace entitlement isolation and migration; finish with `/code-review`; run uncached focused tests, the full migration chain, typecheck, lint, tests, and a production build.
