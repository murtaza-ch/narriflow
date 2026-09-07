# 05 — Plan Screen and picture-in-picture composition end to end

**What to build:** Make Screen framing one shared plan for the full-screen source, speaker tile, picture-in-picture evidence, target geometry, and fallbacks. Studio must stop approximating a composition that export interprets differently.

**Blocked by:** [01 — Establish the Center composition tracer](01-establish-center-composition-tracer.md).

**Status:** completed

**Specification:** [Deepen the Clip Composition Plan](../spec.md)

## Observable acceptance criteria

- [x] A Screen plan declares the full source in the top tile and the selected speaker crop in the bottom tile for every eligible target.
- [x] The planner owns the current picture-in-picture fitting margin, minimum crop-width gate, target tile geometry, trackability decision, and fallback order.
- [x] A confirmed picture-in-picture rectangle, a trackable face band, and the static center fallback each produce a stable evidence source and fidelity classification.
- [x] Studio and FFmpeg consume the same canonical integer geometry, including the current encodable odd-height result for 4:5 output.
- [x] Missing evidence produces a neutral pending state. Failed or ineligible evidence produces the documented effective fallback rather than a confident but different preview.
- [x] Durable screen evidence is reused only when its source window and versioned input fingerprint match.
- [x] Exact `screen-layout-v2` evidence records every PiP and face-band fact needed for deterministic reuse, so persisted evidence does not rerun face confirmation.
- [x] A disabled Screen capability degrades to the current single-speaker behavior and emits one stable target-scoped notice.
- [x] Studio mounts a synchronized second view only while an active Screen scene needs it and preserves playback when evidence changes.
- [x] B-roll conflicts resolve through the plan to a truthful whole-target single-speaker fallback.

## Public-interface and failure-injection tests

- [x] Planning-interface tables cover usable and unusable picture-in-picture rectangles, minimum-width boundaries, face-band fallback, static fallback, stale evidence, disabled capability, every target, and odd canvas dimensions.
- [x] One shared fixture source replaces copied picture-in-picture margin and crop expectations across the web and FFmpeg adapter contracts.
- [x] Browser tests assert exact tile geometry, pending and degraded messages, synchronized media behavior, target switching, and playback preservation.
- [x] Real-FFmpeg tests inspect representative keyframes and probes for picture-in-picture, face-band, and static fallback paths at every target.
- [x] Failure injection covers picture-in-picture analysis failure, face confirmation failure, stale completion, ownership loss, one unavailable target, and invalid geometry before encoding.
- [x] Shared plan and adapter tests cover evidence source, trackability, tile frames, crop rectangles, fallback reason, and adapter topology.

## Plan-only state and evidence versioning

- [x] Read only exact `screen-layout-v2` evidence. Do not migrate or reinterpret the incomplete v1 envelope.
- [x] Studio and the worker always consume the Screen plan. No duplicate Screen composition policy remains.
- [x] The Screen capability switch controls analysis only. The planner owns B-roll conflicts and disabled fallbacks.

## Rollout and recovery safety

- [x] Verify picture-in-picture, face-band, and static fallback cases through shared fixtures, browser checks, and real FFmpeg.
- [x] Monitor evidence source and version, requested and effective mode, notice code, target geometry, secondary-media use, and mismatch class.
- [x] Disabling Screen analysis yields a typed Center fallback without deleting durable evidence or selecting another renderer.

## Scope boundaries

- [x] Do not change picture-in-picture detection models, face thresholds, target resolutions, or the current fallback order.
- [x] Do not change B-roll precedence or introduce new screen layouts.
- [x] Require complete v2 evidence before skipping confirmation. Unavailable fresh analysis remains retryable and is not persisted as an exact result.

## Completion evidence

- Screen now plans the contained full source and speaker crop once, including confirmed PiP, face-band, static-center, stale-evidence, disabled, and minimum-width fallback policy.
- Authenticated Chrome verification exercised all four target switches with two synchronized media elements, stable media identity, advancing playback, the durable confirmed PiP crop, and no browser errors.
- Real worker exports and real FFmpeg fixtures covered Screen output at 9:16, 1:1, 16:9, and 4:5. Full tests, typecheck, lint, and the production build passed.

## Fresh-task handoff

Implement in a fresh task with `/implement`; use `/tdd` for evidence, geometry, fallback, and both adapters; finish with `/code-review`; run uncached focused and affected database tests, `bun run typecheck`, `bun run lint`, and `bun run build`; and verify all Screen evidence paths in a real browser and through real FFmpeg.
