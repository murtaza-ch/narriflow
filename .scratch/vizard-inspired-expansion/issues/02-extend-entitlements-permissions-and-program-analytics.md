# 02 — Extend entitlements, permissions, and program analytics

**What to build:** Add named plan features, review capabilities, rollout controls, and the analytics events needed by every later ticket.

**Blocked by:** None. This is a frontier ticket.

**Status:** done

**Specification:** [Program map](../spec.md)

## Observable acceptance criteria

- [x] `PlanFeature` contains explicit capabilities for brand profiles, custom fonts, scenes, censoring, motion, assisted copy, campaign operations, export bundles, review rooms, generated images, and generated video.
- [x] The tier matrix follows the program packaging and has an explicit compatibility answer for legacy `starter` values.
- [x] Workspace capabilities add `review.manage` for owner, admin, and editor and `review.override` for owner and admin.
- [x] Server helpers distinguish entitlement from separately metered generation usage.
- [x] Typed analytics events cover the approved campaign interval and cross-feature guardrails.
- [x] Analytics validation rejects transcript, prompt, comment, reviewer identity, token, passcode, and signed-URL fields.
- [x] Server rollout controls can stop new writes for each release group without blocking reads of existing rows.

## Tests and failure injection

- [x] Matrix tests cover every tier and every feature, including unknown and legacy tier values.
- [x] Role and workspace-status tests cover active, pending-payment, restricted, downgrade, and owner-only override.
- [x] Analytics tests prove allowed metadata and reject sensitive keys recursively.
- [x] Rollout tests prove disabled creation does not break old project, export, asset, or review reads.

## Migration and rollout

- [x] Land shared checks before any feature route uses them.
- [x] Update pricing copy only when its server capability is deployable.

## Scope boundaries

- [x] Do not implement feature-specific UI or payment-pack pricing.
- [x] Do not add direct tier comparisons outside the central matrix.

## Fresh-task handoff

Implement with `/tdd`, finish with `/code-review`, and run entitlement, permission, analytics, pricing, typecheck, and repository tests.
