# 04 — Plan explicit Split composition end to end

**What to build:** Replace Studio's fixed Split approximation with the same scene-aware two-speaker plan that export uses, including target-specific geometry and explicit fallback reasons.

**Blocked by:** [03 — Plan automatic speaker composition end to end](03-plan-automatic-speaker-composition.md).

**Status:** completed

**Specification:** [Deepen the Clip Composition Plan](../spec.md)

## Observable acceptance criteria

- [x] Explicit Split uses eligible scene evidence to identify two stable speaker crops over edited time.
- [x] Studio shows the planned per-scene speakers and crop geometry rather than fixed left and right source positions.
- [x] Each target receives canonical stacked or side-by-side geometry with bounded crops and encodable integer tile sizes.
- [x] Odd canvas dimensions, including the supported 4:5 output, resolve to one documented rounding result in both adapters.
- [x] Detection unavailable, fewer than two stable faces, no usable two-up scenes, incompatible target geometry, and disabled capability produce stable scoped fallback reasons.
- [x] A fallback produces the current single-speaker result and never emits an empty or duplicated tile.
- [x] An ineligible target can fall back without changing an eligible target in the same plan.
- [x] Compatible durable multi-face evidence is reused only after shadow fixtures prove parity with the current explicit Split detector. Until then, the current detector fulfills the plan's evidence request.
- [x] Studio shows pending or degraded fidelity honestly and preserves playback when exact Split evidence arrives.
- [x] Current Split output remains available for B-roll documents until the B-roll composition ticket lands.

## Public-interface and failure-injection tests

- [x] Planning-interface tables cover two speakers, one speaker, unstable faces, no two-up scenes, target-specific eligibility, disabled analysis, failed analysis, odd dimensions, deleted ranges, and exact scene boundaries.
- [x] Shared plan fixtures replace fixed web-only Split geometry expectations and feed both adapter contracts.
- [x] Browser tests assert per-scene crop changes, synchronized secondary media, target switching, fallback copy, and playback preservation.
- [x] Real-FFmpeg tests compare representative Split frames and probes at every supported target and include the odd-height 4:5 case.
- [x] Failure injection covers analysis timeout, stale evidence, one failed target, ownership loss during analysis, and invalid geometry before encoding.
- [x] Shadow tests compare scene boundaries, speaker identity, crop rectangles, target geometry, and fallback classification with the current worker path.

## Migration and mixed-version considerations

- [x] Add Split plan decisions beside the current worker detector and Studio approximation.
- [x] Keep separate evidence versions distinguishable while compatibility is measured. Do not silently reinterpret old envelopes.
- [x] A Split-specific control enables shadowing and cutover without enabling B-roll conflict handling or Screen composition.

## Rollout and recovery safety

- [x] Cut over only the non-B-roll Split corpus after representative browser and real-media comparisons pass.
- [x] Monitor requested and effective mode, evidence source, notice code, scene count, and mismatch class per target.
- [x] Rollback restores both the fixed preview and current worker path without deleting shared evidence.

## Scope boundaries

- [x] Do not change B-roll precedence, speaker detector models, thresholds, scene caps, or supported output dimensions.
- [x] Do not introduce three-person grids or freeform speaker layouts.
- [x] Do not remove the current explicit detector until durable evidence parity has been proved.

## Completion evidence

- Explicit Split now plans scene-aware one- and two-speaker crops once for every target, with exact even tile geometry, stable target-scoped fallbacks, and the same plan consumed by Studio and FFmpeg.
- Authenticated Chrome verification exercised persisted one-layer and two-layer scenes without playback errors. Real FFmpeg rendered and probed 9:16, 1:1, 16:9, and 4:5 outputs, including the 720×900 odd-height case.
- Explicit detector evidence is source-bound, fingerprinted, and stored with an `explicit-split-v1` discriminator so Automatic framing cannot silently reinterpret it.

## Fresh-task handoff

Implement in a fresh task with `/implement`; use `/tdd` for evidence, fallback, geometry, and both adapters; finish with `/code-review`; run uncached focused and affected database tests, `bun run typecheck`, `bun run lint`, and `bun run build`; and inspect per-scene Split behavior in a real browser and through real FFmpeg for every supported target.
