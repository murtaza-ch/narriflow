# 03 — Migrate Brand Kit with Brand Template compatibility

**What to build:** Backfill compatible Brand Profiles and replace the flat Brand Kit projection while keeping every existing template ID, route, default, snapshot, and service call valid.

**Blocked by:** [Establish Brand Profile and Visual Asset ownership](01-establish-brand-profile-and-visual-asset-ownership.md).

**Status:** ready-for-agent

**Specifications:** [Program map](../spec.md), [Brand profiles and asset library](../features/brand-profiles-and-assets.md)

## Observable acceptance criteria

- [ ] A resumable bounded backfill creates one compatibility Brand Profile per owner with custom templates and attaches every eligible template exactly once.
- [ ] Built-in templates remain global and are not copied.
- [ ] Old Brand Kit URLs resolve inside the owning profile with the same template selected.
- [ ] Workspace and user defaults continue to identify the same Brand Template.
- [ ] Brand Kit presents Identity, Styles, Assets, Scenes, Audio, and Voice without duplicating Audio Asset rows.
- [ ] New projects may select a profile and optional style preset while legacy project creation input remains accepted.
- [ ] Project snapshots freeze the resolved identity and do not change when the profile changes.

## Tests and failure injection

- [ ] Backfill tests cover rerun, interruption, deleted templates, mixed user and workspace ownership, and empty owners.
- [ ] Route tests cover old links, new profile links, built-ins, missing membership, downgrade, and deleted profiles.
- [ ] Browser checks cover two profiles in one workspace, default selection, asset and font tabs, and Blueline responsive layout.

## Migration and rollout

- [ ] Deploy tolerant reads, run backfill in observe mode, compare counts, then enable profile projections.
- [ ] Keep compatibility adapters and old routes for the full program.

## Scope boundaries

- [ ] Do not enable Scene Block insertion or generated assets here.
- [ ] Do not rewrite historical project snapshots.

## Fresh-task handoff

Implement with `/tdd`, finish with `/code-review`, and run migration tests, affected service tests, a production build, `bun run typecheck`, and `bun run test`.
