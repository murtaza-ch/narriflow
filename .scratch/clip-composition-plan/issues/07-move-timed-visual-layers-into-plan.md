# 07 — Move timed visual layers into the shared plan

**What to build:** Make the Clip Composition Plan declare the visible order and timing of captions, text, logos, transitions, watermark treatment, and the already-planned base video and B-roll. Both adapters translate that order without keeping their own composition policy.

**Blocked by:** [02 — Plan Fit and background composition end to end](02-plan-fit-and-background-composition.md); [06 — Make B-roll composition truthful end to end](06-make-broll-composition-truthful.md).

**Status:** ready-for-agent

**Specification:** [Deepen the Clip Composition Plan](../spec.md)

## Observable acceptance criteria

- [ ] Each target plan declares stable visual layer IDs, active edited-time ranges, destination frames, crop or fit behavior, rotation, opacity, and z-order where the existing feature supports them.
- [ ] Background and base video compose first, B-roll replaces its planned windows, text and captions retain their established relative order, and logo, output treatment, and transitions retain current output order.
- [ ] The planner composes the existing shared caption cue model and does not create another chunking, positioning, emoji, or deleted-range interpretation.
- [ ] Text timing and transforms match current Studio playback and export after deleted ranges.
- [ ] Logo settings and watermark entitlement arrive as resolved facts. Missing optional logo media omits only the logo and emits one scoped notice.
- [ ] Transition timing and output treatment remain compatible with current rendered output.
- [ ] Studio renders the active scene and layers from the plan without recomputing crop, timing, precedence, or fallback policy.
- [ ] The FFmpeg adapter preserves plan layer and timing order and owns only command syntax, input mapping, labels, and escaping.
- [ ] The plan remains bounded by existing scene, text, caption cue, and target limits and never expands into per-frame entries.
- [ ] Optional visual degradation remains exportable, while deterministic invalid geometry fails before encoding with a stable user-facing classification.

## Public-interface and failure-injection tests

- [ ] Planning-interface tables cover all supported base modes, B-roll, captions, text, logos, transitions, watermark treatment, deleted ranges, boundary timestamps, missing optional assets, and mixed target sets.
- [ ] Shared fixtures feed both adapters and assert layer IDs, timing, order, destination geometry, active final-frame behavior, and notice scope.
- [ ] Browser tests inspect visible stacking, scene changes, target switching, optional omission, and playback preservation.
- [ ] Real-FFmpeg tests inspect representative keyframes at every layer boundary and compare current output within approved visual tolerances.
- [ ] Failure injection covers unavailable logo media, invalid optional references, stale asset resolution, malformed geometry, and a transition boundary at clip end.
- [ ] Existing copied geometry and ordering tests are removed only after the planner and adapter contracts cover the same external behavior.

## Plan-only implementation constraints

- [ ] Extend plan fixtures additively and keep earlier Center, Fit, Auto, Split, Screen, and B-roll behavior green.
- [ ] Compare planned layer topology, timing, order, geometry, fallback, and adapter translation through shared fixtures.
- [ ] Remove adapter-owned overlay policy as each decision moves into the plan. Keep only syntax and platform translation in the adapters.

## Rollout and recovery safety

- [ ] Deploy visual-layer plan changes only after representative compositions for every base mode pass shared-fixture, browser, and FFmpeg checks.
- [ ] Monitor scene and layer counts, optional omissions, notice codes, command size, planning time, and mismatch class.
- [ ] Recovery reverts the offending plan or adapter change without restoring a second composition-policy path or changing editor documents and entitlement snapshots.

## Scope boundaries

- [ ] Do not change caption cue semantics, text validation, logo settings, watermark entitlement, transition design, or visual styling.
- [ ] Do not add freeform canvas editing, new layer types, or collaborative document behavior.
- [ ] Do not migrate source audio, music, ducking, sound effects, or audio-only topology.

## Fresh-task handoff

Implement in a fresh task with `/implement`; use `/tdd` for layer timing, order, availability, and adapter translation; finish with `/code-review`; run uncached focused tests, `bun run typecheck`, `bun run lint`, and `bun run build`; and inspect boundary keyframes in a real browser and through real FFmpeg.
