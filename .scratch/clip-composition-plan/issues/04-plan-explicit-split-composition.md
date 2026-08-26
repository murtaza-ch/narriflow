# 04 — Plan explicit Split composition end to end

**What to build:** Replace Studio's fixed Split approximation with the same scene-aware two-speaker plan that export uses, including target-specific geometry and explicit fallback reasons.

**Blocked by:** [03 — Plan automatic speaker composition end to end](03-plan-automatic-speaker-composition.md).

**Status:** ready-for-agent

**Specification:** [Deepen the Clip Composition Plan](../spec.md)

## Observable acceptance criteria

- [ ] Explicit Split uses eligible scene evidence to identify two stable speaker crops over edited time.
- [ ] Studio shows the planned per-scene speakers and crop geometry rather than fixed left and right source positions.
- [ ] Each target receives canonical stacked or side-by-side geometry with bounded crops and encodable integer tile sizes.
- [ ] Odd canvas dimensions, including the supported 4:5 output, resolve to one documented rounding result in both adapters.
- [ ] Detection unavailable, fewer than two stable faces, no usable two-up scenes, incompatible target geometry, and disabled capability produce stable scoped fallback reasons.
- [ ] A fallback produces the current single-speaker result and never emits an empty or duplicated tile.
- [ ] An ineligible target can fall back without changing an eligible target in the same plan.
- [ ] Compatible durable multi-face evidence is reused only after shadow fixtures prove parity with the current explicit Split detector. Until then, the current detector fulfills the plan's evidence request.
- [ ] Studio shows pending or degraded fidelity honestly and preserves playback when exact Split evidence arrives.
- [ ] Current Split output remains available for B-roll documents until the B-roll composition ticket lands.

## Public-interface and failure-injection tests

- [ ] Planning-interface tables cover two speakers, one speaker, unstable faces, no two-up scenes, target-specific eligibility, disabled analysis, failed analysis, odd dimensions, deleted ranges, and exact scene boundaries.
- [ ] Shared plan fixtures replace fixed web-only Split geometry expectations and feed both adapter contracts.
- [ ] Browser tests assert per-scene crop changes, synchronized secondary media, target switching, fallback copy, and playback preservation.
- [ ] Real-FFmpeg tests compare representative Split frames and probes at every supported target and include the odd-height 4:5 case.
- [ ] Failure injection covers analysis timeout, stale evidence, one failed target, ownership loss during analysis, and invalid geometry before encoding.
- [ ] Shadow tests compare scene boundaries, speaker identity, crop rectangles, target geometry, and fallback classification with the current worker path.

## Migration and mixed-version considerations

- [ ] Add Split plan decisions beside the current worker detector and Studio approximation.
- [ ] Keep separate evidence versions distinguishable while compatibility is measured. Do not silently reinterpret old envelopes.
- [ ] A Split-specific control enables shadowing and cutover without enabling B-roll conflict handling or Screen composition.

## Rollout and recovery safety

- [ ] Cut over only the non-B-roll Split corpus after representative browser and real-media comparisons pass.
- [ ] Monitor requested and effective mode, evidence source, notice code, scene count, and mismatch class per target.
- [ ] Rollback restores both the fixed preview and current worker path without deleting shared evidence.

## Scope boundaries

- [ ] Do not change B-roll precedence, speaker detector models, thresholds, scene caps, or supported output dimensions.
- [ ] Do not introduce three-person grids or freeform speaker layouts.
- [ ] Do not remove the current explicit detector until durable evidence parity has been proved.

## Fresh-task handoff

Implement in a fresh task with `/implement`; use `/tdd` for evidence, fallback, geometry, and both adapters; finish with `/code-review`; run uncached focused and affected database tests, `bun run typecheck`, `bun run lint`, and `bun run build`; and inspect per-scene Split behavior in a real browser and through real FFmpeg for every supported target.
