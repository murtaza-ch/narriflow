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
- [x] Exact source-bound `explicit-split-v1` evidence is reused without detection. Missing or stale evidence produces one Split analysis request.
- [x] Studio shows pending or degraded fidelity honestly and preserves playback when exact Split evidence arrives.
- [x] B-roll conflicts resolve through the plan to a truthful whole-target single-speaker fallback.

## Public-interface and failure-injection tests

- [x] Planning-interface tables cover two speakers, one speaker, unstable faces, no two-up scenes, target-specific eligibility, disabled analysis, failed analysis, odd dimensions, deleted ranges, and exact scene boundaries.
- [x] Shared plan fixtures replace fixed web-only Split geometry expectations and feed both adapter contracts.
- [x] Browser tests assert per-scene crop changes, synchronized secondary media, target switching, fallback copy, and playback preservation.
- [x] Real-FFmpeg tests compare representative Split frames and probes at every supported target and include the odd-height 4:5 case.
- [x] Failure injection covers analysis timeout, stale evidence, one failed target, ownership loss during analysis, and invalid geometry before encoding.
- [x] Shared plan and adapter tests cover scene boundaries, speaker identity, crop rectangles, target geometry, and fallback classification.

## Plan-only state and evidence versioning

- [x] Store Split evidence in its own field with the `explicit-split-v1` discriminator. Do not read Automatic evidence as Split evidence.
- [x] Reject stale, source-mismatched, and unknown Split evidence instead of migrating or reinterpreting it.
- [x] The Split capability switch controls analysis only. It never selects a different renderer.

## Rollout and recovery safety

- [x] Verify Split and B-roll conflict cases through representative browser and real-media comparisons.
- [x] Monitor requested and effective mode, evidence source, notice code, scene count, and mismatch class per target.
- [x] Disabling Split analysis yields a typed target-scoped fallback without deleting durable evidence or selecting another renderer.

## Scope boundaries

- [x] Do not change B-roll precedence, speaker detector models, thresholds, scene caps, or supported output dimensions.
- [x] Do not introduce three-person grids or freeform speaker layouts.
- [x] Keep the explicit detector as an evidence producer, not a second composition implementation.

## Completion evidence

- Explicit Split now plans scene-aware one- and two-speaker crops once for every target, with exact even tile geometry, stable target-scoped fallbacks, and the same plan consumed by Studio and FFmpeg.
- Authenticated Chrome verification exercised persisted one-layer and two-layer scenes without playback errors. Real FFmpeg rendered and probed 9:16, 1:1, 16:9, and 4:5 outputs, including the 720×900 odd-height case.
- Explicit detector evidence is source-bound, fingerprinted, and stored with an `explicit-split-v1` discriminator so Automatic framing cannot silently reinterpret it.

## Fresh-task handoff

Implement in a fresh task with `/implement`; use `/tdd` for evidence, fallback, geometry, and both adapters; finish with `/code-review`; run uncached focused and affected database tests, `bun run typecheck`, `bun run lint`, and `bun run build`; and inspect per-scene Split behavior in a real browser and through real FFmpeg for every supported target.
