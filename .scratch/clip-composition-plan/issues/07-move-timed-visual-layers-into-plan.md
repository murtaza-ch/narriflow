# 07 — Move timed visual layers into the shared plan

**What to build:** Make the Clip Composition Plan declare the visible order and timing of captions, text, logos, transitions, watermark treatment, and the already-planned base video and B-roll. Both adapters translate that order without keeping their own composition policy.

**Blocked by:** [02 — Plan Fit and background composition end to end](02-plan-fit-and-background-composition.md); [06 — Make B-roll composition truthful end to end](06-make-broll-composition-truthful.md).

**Status:** completed

**Specification:** [Deepen the Clip Composition Plan](../spec.md)

## Observable acceptance criteria

- [x] Each target plan declares stable visual layer IDs, active edited-time ranges, destination frames, crop or fit behavior, rotation, opacity, and z-order where the existing feature supports them.
- [x] Background and base video compose first, B-roll replaces its planned windows, text and captions retain their established relative order, and logo, output treatment, and transitions retain current output order.
- [x] The planner composes the existing shared caption constants, formatting, emoji, and deleted-range time map rather than delegating those decisions to either adapter.
- [x] Text timing and transforms match current Studio playback and export after deleted ranges.
- [x] Logo settings and watermark entitlement arrive as resolved facts. Missing optional logo media omits only the logo and emits one scoped notice.
- [x] Transition timing and output treatment remain compatible with current rendered output.
- [x] Studio renders the active scene and layers from the plan without recomputing crop, timing, precedence, or fallback policy.
- [x] The FFmpeg adapter preserves plan layer and timing order and owns only command syntax, input mapping, labels, and escaping.
- [x] The plan remains bounded by existing scene, text, caption cue, and target limits and never expands into per-frame entries.
- [x] Optional visual degradation remains exportable, while deterministic invalid geometry fails before encoding with a stable user-facing classification.

## Public-interface and failure-injection tests

- [x] Planning-interface tables cover all supported base modes, B-roll, captions, text, logos, transitions, watermark treatment, deleted ranges, boundary timestamps, missing optional assets, and mixed target sets.
- [x] Shared planner output feeds both adapters and asserts layer IDs, timing, order, destination geometry, active final-frame behavior, and notice scope.
- [x] Chrome checks inspect visible stacking, scene changes, target switching, optional omission, and playback preservation.
- [x] Real-FFmpeg tests decode representative keyframes at every visual-stack boundary and probe the completed H.264/AAC output.
- [x] Failure injection covers unavailable logo media, missing resolved caption/logo inputs, malformed geometry, and end-bound transition output.
- [x] Existing adapter-owned video overlay policy is removed after planner and adapter contracts cover the same external behavior.

## Plan-only implementation constraints

- [x] Extend plan fixtures additively and keep earlier Center, Fit, Auto, Split, Screen, and B-roll behavior green.
- [x] Compare planned layer topology, timing, order, geometry, fallback, and adapter translation through shared fixtures.
- [x] Remove adapter-owned overlay policy as each decision moves into the plan. Keep only syntax and platform translation in the adapters.

## Rollout and recovery safety

- [x] Representative compositions for every base mode pass plan, adapter, browser, and FFmpeg checks before deployment.
- [x] Existing structured plan diagnostics carry layer/scene counts, optional omissions, notice codes, and stable plan identity.
- [x] Recovery can revert the offending plan or adapter change without restoring a second composition-policy path or changing editor documents and entitlement snapshots.

## Scope boundaries

- [x] Do not change caption cue semantics, text validation, logo settings, watermark entitlement, transition design, or visual styling.
- [x] Do not add freeform canvas editing, new product layer types, or collaborative document behavior.
- [x] Do not migrate source audio, music, ducking, sound effects, or audio-only topology.

## Completion evidence

- Planner tests cover edited-time text/caption schedules, stable order, logo availability notices, transition windows, output treatment, and deleted-range retiming.
- Web and worker adapter tests prove both consumers translate the ordered plan and reject invalid or unresolved inputs before encoding.
- A real FFmpeg fixture renders text, captions, logo, dip-white transition, 720p treatment, and watermark together, then probes output streams and boundary frames.
- Authenticated Chrome verification at `/home` exercised Studio timing boundaries, captions, transitions, 9:16/1:1/16:9 switching, playback preservation, persistence, and a clean post-fix console.
- `bun run typecheck`, `bun run test`, `bun run lint`, and `bun run build` pass repository-wide.

## Fresh-task handoff

Implement in a fresh task with `/implement`; use `/tdd` for layer timing, order, availability, and adapter translation; finish with `/code-review`; run uncached focused tests, `bun run typecheck`, `bun run lint`, and `bun run build`; and inspect boundary keyframes in a real browser and through real FFmpeg.
