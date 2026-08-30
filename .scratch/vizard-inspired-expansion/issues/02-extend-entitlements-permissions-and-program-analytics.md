# 02 — Extend entitlements, permissions, and program analytics

**What to build:** Add named plan features, review capabilities, rollout controls, and the analytics events needed by every later ticket.

**Blocked by:** None. This is a frontier ticket.

**Status:** ready-for-agent

**Specification:** [Program map](../spec.md)

## Observable acceptance criteria

- [ ] `PlanFeature` contains explicit capabilities for brand profiles, custom fonts, scenes, censoring, motion, assisted copy, campaign operations, export bundles, review rooms, generated images, and generated video.
- [ ] The tier matrix follows the program packaging and has an explicit compatibility answer for legacy `starter` values.
- [ ] Workspace capabilities add `review.manage` for owner, admin, and editor and `review.override` for owner and admin.
- [ ] Server helpers distinguish entitlement from separately metered generation usage.
- [ ] Typed analytics events cover the approved campaign interval and cross-feature guardrails.
- [ ] Analytics validation rejects transcript, prompt, comment, reviewer identity, token, passcode, and signed-URL fields.
- [ ] Server rollout controls can stop new writes for each release group without blocking reads of existing rows.

## Tests and failure injection

- [ ] Matrix tests cover every tier and every feature, including unknown and legacy tier values.
- [ ] Role and workspace-status tests cover active, pending-payment, restricted, downgrade, and owner-only override.
- [ ] Analytics tests prove allowed metadata and reject sensitive keys recursively.
- [ ] Rollout tests prove disabled creation does not break old project, export, asset, or review reads.

## Migration and rollout

- [ ] Land shared checks before any feature route uses them.
- [ ] Update pricing copy only when its server capability is deployable.

## Scope boundaries

- [ ] Do not implement feature-specific UI or payment-pack pricing.
- [ ] Do not add direct tier comparisons outside the central matrix.

## Fresh-task handoff

Implement with `/tdd`, finish with `/code-review`, and run entitlement, permission, analytics, pricing, typecheck, and repository tests.
