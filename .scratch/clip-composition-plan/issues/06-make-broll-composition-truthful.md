# 06 — Make B-roll composition truthful end to end

**What to build:** Put B-roll windows and their current framing conflicts into the shared plan. Studio must show the same effective base layout and cutaways that export will use, including the whole-clip fallback for explicit Split or Screen.

**Blocked by:** [02 — Plan Fit and background composition end to end](02-plan-fit-and-background-composition.md); [04 — Plan explicit Split composition end to end](04-plan-explicit-split-composition.md); [05 — Plan Screen and picture-in-picture composition end to end](05-plan-screen-and-pip-composition.md).

**Status:** ready-for-agent

**Specification:** [Deepen the Clip Composition Plan](../spec.md)

## Observable acceptance criteria

- [ ] The plan maps every valid B-roll placement to the same edited-time window in Studio and export after deleted ranges are applied.
- [ ] B-roll appears above the planned base video only during its active window and preserves the current fit, crop, and optional audio behavior.
- [ ] Auto speaker scenes continue beneath B-roll cutaways according to current output behavior.
- [ ] Any active B-roll combined with requested Split or Screen produces the current whole-clip single-speaker fallback for that target.
- [ ] Studio previews that effective whole-clip fallback outside the cutaway instead of showing Split or Screen until export.
- [ ] The plan emits a stable, actionable notice that names the requested mode and effective fallback without blocking export.
- [ ] Missing or failed optional B-roll removes only that asset, keeps the rest of the composition available, and emits one scoped notice.
- [ ] Invalid or out-of-range placements are rejected or normalized by existing validation policy before plan execution.
- [ ] Scene boundaries created by base framing and B-roll merge into one contiguous, bounded edited-time plan without per-frame entries.
- [ ] Target switching and late optional-asset resolution preserve Studio playback and do not remount the main media element.

## Public-interface and failure-injection tests

- [ ] Planning-interface tables cover Auto, Center, Fit, Split, and Screen with no B-roll, one cutaway, adjacent cutaways, overlapping validated inputs, deleted ranges, unavailable assets, and every target.
- [ ] Shared browser and FFmpeg fixtures assert active windows, base mode, layer order, asset omission, fallback notice, and exact final-frame behavior.
- [ ] Browser tests prove that explicit Split and Screen display the whole-clip fallback before, during, and after the cutaway.
- [ ] Real-FFmpeg tests compare keyframes before, inside, and after each cutaway plus output probes and optional-audio behavior.
- [ ] Failure injection covers asset-resolution failure, storage failure before planning, stale availability, one failed optional asset among several, and ownership loss before encoding.
- [ ] Property tests prove merged scenes are ordered, contiguous, complete, capped, and free of zero-length B-roll layers.

## Migration and mixed-version considerations

- [ ] Shadow comparison includes base effective mode, B-roll window, source reference, layer order, and fallback reason.
- [ ] Keep current B-roll and explicit-layout paths available until Studio and worker consume the same plan for all supported combinations.
- [ ] Do not change persisted B-roll placements or require a document migration.

## Rollout and recovery safety

- [ ] Enable B-roll planning after Auto, Split, Screen, and Fit plan slices are stable for the approved corpus.
- [ ] Monitor requested and effective base mode, B-roll count, omitted optional assets, notice codes, scene count, and mismatch class.
- [ ] Rollback returns both adapters to current composition without rewriting placements or asset records.

## Scope boundaries

- [ ] Preserve the current whole-clip Split and Screen conflict policy. A more permissive composition rule needs a separate product decision.
- [ ] Do not add B-roll generation, search, upload, entitlement, or placement UX.
- [ ] Do not migrate captions, text, logos, transitions, watermark treatment, music, or sound effects.

## Fresh-task handoff

Implement in a fresh task with `/implement`; drive timing, fallback, availability, and both adapters with `/tdd`; finish with `/code-review`; run uncached focused and affected storage tests, `bun run typecheck`, `bun run lint`, and `bun run build`; and inspect all base-mode combinations in a real browser and through real FFmpeg.
