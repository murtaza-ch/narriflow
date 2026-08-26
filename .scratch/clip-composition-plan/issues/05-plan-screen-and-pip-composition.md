# 05 — Plan Screen and picture-in-picture composition end to end

**What to build:** Make Screen framing one shared plan for the full-screen source, speaker tile, picture-in-picture evidence, target geometry, and fallbacks. Studio must stop approximating a composition that export interprets differently.

**Blocked by:** [01 — Establish the Center composition tracer](01-establish-center-composition-tracer.md).

**Status:** ready-for-agent

**Specification:** [Deepen the Clip Composition Plan](../spec.md)

## Observable acceptance criteria

- [ ] A Screen plan declares the full source in the top tile and the selected speaker crop in the bottom tile for every eligible target.
- [ ] The planner owns the current picture-in-picture fitting margin, minimum crop-width gate, target tile geometry, trackability decision, and fallback order.
- [ ] A confirmed picture-in-picture rectangle, a trackable face band, and the static center fallback each produce a stable evidence source and fidelity classification.
- [ ] Studio and FFmpeg consume the same canonical integer geometry, including the current encodable odd-height result for 4:5 output.
- [ ] Missing evidence produces a neutral pending state. Failed or ineligible evidence produces the documented effective fallback rather than a confident but different preview.
- [ ] Durable screen evidence is reused only when its source window and versioned input fingerprint match.
- [ ] Repeated face confirmation is removed only after the evidence version records every fact required to make reuse deterministic. Until then, the current confirmation guard fulfills the evidence request.
- [ ] A disabled Screen capability degrades to the current single-speaker behavior and emits one stable target-scoped notice.
- [ ] Studio mounts a synchronized second view only while an active Screen scene needs it and preserves playback when evidence changes.
- [ ] Current Screen output remains available for B-roll documents until the B-roll composition ticket lands.

## Public-interface and failure-injection tests

- [ ] Planning-interface tables cover usable and unusable picture-in-picture rectangles, minimum-width boundaries, face-band fallback, static fallback, stale evidence, disabled capability, every target, and odd canvas dimensions.
- [ ] One shared fixture source replaces copied picture-in-picture margin and crop expectations across the web and FFmpeg adapter contracts.
- [ ] Browser tests assert exact tile geometry, pending and degraded messages, synchronized media behavior, target switching, and playback preservation.
- [ ] Real-FFmpeg tests inspect representative keyframes and probes for picture-in-picture, face-band, and static fallback paths at every target.
- [ ] Failure injection covers picture-in-picture analysis failure, face confirmation failure, stale completion, ownership loss, one unavailable target, and invalid geometry before encoding.
- [ ] Shadow tests compare evidence source, trackability, tile frames, crop rectangles, fallback reason, and adapter topology with the current worker path.

## Migration and mixed-version considerations

- [ ] Keep current screen evidence readable and introduce a new version only when deterministic reuse needs additional confirmation facts.
- [ ] Add Screen planning beside current Studio and worker behavior. Do not remove duplicate policy until the shared fixtures and cutover pass.
- [ ] A Screen-specific control excludes B-roll documents until ticket 06 is complete.

## Rollout and recovery safety

- [ ] Enable Screen only after the picture-in-picture, face-band, and static fallback corpus has zero unexplained shadow mismatches.
- [ ] Monitor evidence source and version, requested and effective mode, notice code, target geometry, secondary-media use, and mismatch class.
- [ ] Rollback restores current Screen behavior without deleting durable evidence or changing editor documents.

## Scope boundaries

- [ ] Do not change picture-in-picture detection models, face thresholds, target resolutions, or the current fallback order.
- [ ] Do not change B-roll precedence or introduce new screen layouts.
- [ ] Do not eliminate the confirmation pass until versioned evidence proves reuse is safe.

## Fresh-task handoff

Implement in a fresh task with `/implement`; use `/tdd` for evidence, geometry, fallback, and both adapters; finish with `/code-review`; run uncached focused and affected database tests, `bun run typecheck`, `bun run lint`, and `bun run build`; and verify all Screen evidence paths in a real browser and through real FFmpeg.
