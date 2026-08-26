# 02 — Plan Fit and background composition end to end

**What to build:** Make Fit framing and background fallback one shared composition decision. Studio must preview the same contained video, background, and fallback that export will render for each target.

**Blocked by:** [01 — Establish the Center composition tracer](01-establish-center-composition-tracer.md).

**Status:** ready-for-agent

**Specification:** [Deepen the Clip Composition Plan](../spec.md)

## Observable acceptance criteria

- [ ] An active background selects Fit framing even when stale Auto, Center, Split, or Screen fields remain in the document.
- [ ] Every target plan declares the exact contained-video frame and the color or image background beneath it.
- [ ] The planner receives resolved image availability through logical asset facts and performs no storage, URL, or browser I/O.
- [ ] A usable background image appears identically in Studio and export for all supported targets.
- [ ] An unavailable optional image falls back to the selected color, keeps export available, and emits one stable target-scoped composition notice.
- [ ] Invalid required source facts produce a stable invalid-plan result before FFmpeg starts.
- [ ] Fit framing requests no speaker, face, scene, or picture-in-picture analysis.
- [ ] Switching between Center and Fit preserves the selected target, playhead, play state, playback rate, and main media element.
- [ ] Current visual output, optional-image degradation, and output treatment remain compatible during cutover.

## Public-interface and failure-injection tests

- [ ] Planning-interface tables cover color and image backgrounds, every target, landscape and portrait sources, deleted ranges, stale framing fields, usable images, missing images, failed images, and invalid source dimensions.
- [ ] Web and FFmpeg adapter contracts consume the same Fit plan fixtures and assert canvas, contain frame, layer order, and fallback notice.
- [ ] Real-browser checks cover Center-to-Fit switching, image arrival, image failure, and playback preservation.
- [ ] Real-FFmpeg checks compare representative frames and probes with the current path for color, image, and fallback cases.
- [ ] Failure injection proves that optional image failure omits only that image and that no signed URL or provider error enters the plan or diagnostics.

## Migration and mixed-version considerations

- [ ] Extend the plan version additively and keep Center fixtures valid.
- [ ] Run Fit decisions in shadow mode before either adapter consumes them.
- [ ] Keep the current Fit and background paths available until both adapters pass shared fixtures and real-media checks.

## Rollout and recovery safety

- [ ] Enable Fit independently of scene-aware modes and monitor requested mode, effective mode, notice code, and adapter mismatch counts.
- [ ] Rollback restores current Fit rendering without rewriting the editor document or optional asset records.

## Scope boundaries

- [ ] Do not change background selection UX, upload behavior, entitlements, or color semantics.
- [ ] Do not migrate B-roll, text, captions, logos, transitions, watermark treatment, or audio policy.
- [ ] Do not introduce face analysis or new output dimensions for Fit.

## Fresh-task handoff

Implement in a fresh task with `/implement`; use `/tdd` for precedence, geometry, availability, and adapter behavior; finish with `/code-review`; run uncached focused tests, `bun run typecheck`, `bun run lint`, and `bun run build`; and verify color, image, and fallback output in a real browser and through real FFmpeg.
