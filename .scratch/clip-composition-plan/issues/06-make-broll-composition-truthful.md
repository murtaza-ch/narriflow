# 06 — Make B-roll composition truthful end to end

**What to build:** Put B-roll windows and their current framing conflicts into the shared plan. Studio must show the same effective base layout and cutaways that export will use, including the whole-clip fallback for explicit Split or Screen.

**Blocked by:** [02 — Plan Fit and background composition end to end](02-plan-fit-and-background-composition.md); [04 — Plan explicit Split composition end to end](04-plan-explicit-split-composition.md); [05 — Plan Screen and picture-in-picture composition end to end](05-plan-screen-and-pip-composition.md).

**Status:** completed

**Specification:** [Deepen the Clip Composition Plan](../spec.md)

## Observable acceptance criteria

- [x] The plan maps every valid B-roll placement to the same edited-time window in Studio and export after deleted ranges are applied.
- [x] B-roll appears above the planned base video only during its active window and preserves the current fit, crop, and optional audio behavior.
- [x] Auto speaker scenes continue beneath B-roll cutaways according to current output behavior.
- [x] Any active B-roll combined with requested Split or Screen produces the current whole-clip single-speaker fallback for that target.
- [x] Studio previews that effective whole-clip fallback outside the cutaway instead of showing Split or Screen until export.
- [x] The plan emits a stable, actionable notice that names the requested mode and effective fallback without blocking export.
- [x] Missing or failed optional B-roll removes only that asset, keeps the rest of the composition available, and emits one scoped notice.
- [x] Invalid or out-of-range placements are rejected or normalized by existing validation policy before plan execution.
- [x] Scene boundaries created by base framing and B-roll merge into one contiguous, bounded edited-time plan without per-frame entries.
- [x] Target switching and late optional-asset resolution preserve Studio playback and do not remount the main media element.

## Public-interface and failure-injection tests

- [x] Planning-interface tables cover Auto, Center, Fit, Split, and Screen with no B-roll, one cutaway, adjacent cutaways, overlapping validated inputs, deleted ranges, unavailable assets, and every target.
- [x] Shared browser and FFmpeg fixtures assert active windows, base mode, layer order, asset omission, fallback notice, and exact final-frame behavior.
- [x] Browser tests prove that explicit Split and Screen display the whole-clip fallback before, during, and after the cutaway.
- [x] Real-FFmpeg tests compare keyframes before, inside, and after each cutaway plus output probes and optional-audio behavior.
- [x] Failure injection covers asset-resolution failure, storage failure before planning, stale availability, one failed optional asset among several, and ownership loss before encoding.
- [x] Property tests prove merged scenes are ordered, contiguous, complete, capped, and free of zero-length B-roll layers.

## Plan-only state

- [x] Studio and the worker consume the same B-roll plan for every supported base-mode combination.
- [x] Manual and generated B-roll availability is resolved before plan adoption; failed optional media is omitted through a typed notice.
- [x] Persisted B-roll placements and editor document versions remain unchanged.

## Rollout and recovery safety

- [x] Verify B-roll planning with Auto, Split, Screen, Fit, and Center through shared fixtures, Chrome, and FFmpeg.
- [x] Monitor requested and effective base mode, B-roll count, omitted optional assets, notice codes, and scene count.
- [x] Recovery keeps the plan-only path and omits unavailable B-roll without rewriting placements or asset records.

## Scope boundaries

- [x] Preserve the current whole-clip Split and Screen conflict policy. A more permissive composition rule needs a separate product decision.
- [x] Do not add B-roll generation, search, upload, entitlement, or placement UX.
- [x] Do not migrate captions, text, logos, transitions, watermark treatment, music, or sound effects.

## Completion evidence

- The plan owns edited-time B-roll windows, layer order, Split and Screen conflicts, and optional-media notices. Studio and FFmpeg translate the same scenes.
- Browser media validation distinguishes pending, available, and failed manual B-roll without claiming export fidelity before the media is usable.
- Planner, web adapter, worker adapter, Clip Render Attempt, real-FFmpeg, full-suite, typecheck, lint, database, and production-build checks passed.

## Fresh-task handoff

For future B-roll composition changes, use `/implement` and `/tdd`, finish with `/code-review`, run uncached focused tests plus repository verification, and inspect the affected base modes in a real browser and through real FFmpeg.
