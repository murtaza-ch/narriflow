# 11 — Build selection-scoped campaign actions

**What to build:** Expand the Clips selection bar with Brand Profile, style, Scene Template, motion, export, ZIP, review, and scheduling handoffs using Campaign Operation outcomes.

**Blocked by:** [Migrate Brand Kit with Brand Template compatibility](03-migrate-brand-kit-with-template-compatibility.md), [Establish Campaign Operation and export-bundle lifecycles](04-establish-campaign-operation-and-export-bundle-lifecycles.md), and [Add reusable and insertable Scene Blocks](08-add-reusable-and-insertable-scene-blocks.md).

**Status:** ready-for-agent

**Specification:** [Campaign bulk operations](../features/campaign-bulk-operations.md)

## Observable acceptance criteria

- [ ] The current selection model survives sort and row navigation and resets only on project change or explicit clear.
- [ ] One state-aware solid action and one secondary-action menu follow Blueline rules.
- [ ] Each action previews selected count, eligibility, expected usage, and exact stale or ineligible items before submit.
- [ ] Brand, style, scene, and motion actions use the same validators and editor-document services as single-clip Studio.
- [ ] Export and ZIP actions bind immutable Clip Export revisions.
- [ ] The result drawer displays every item outcome and retries only eligible failures.
- [ ] Existing Render selected and Studio apply-to-all remain available.

## Tests and failure injection

- [ ] UI and service tests cover mixed selection, all selected, empty state, stale revisions, duplicate submission, partial success, and retry.
- [ ] Browser checks cover keyboard selection, menus, drawers, responsive overflow, refresh, and opening Studio from a selected row.
- [ ] Permission and plan checks cannot be bypassed through internal routes.

## Rollout

- [ ] Route Render selected first, then export and ZIP, then style and Scene Template actions.
- [ ] Keep review and scheduling entries hidden until their target services are enabled.

## Scope boundaries

- [ ] Do not add cross-project selection or arbitrary JSON patches.

## Fresh-task handoff

Implement with `/tdd`, finish with `/code-review`, and run focused UI, service, operation, browser, typecheck, and repository tests.
