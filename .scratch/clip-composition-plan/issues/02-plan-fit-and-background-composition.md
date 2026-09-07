# 02 — Plan Fit and background composition end to end

**What to build:** Make Fit framing and background fallback one shared composition decision. Studio must preview the same contained video, background, and fallback that export will render for each target.

**Blocked by:** [01 — Establish the Center composition tracer](01-establish-center-composition-tracer.md).

**Status:** completed

**Specification:** [Deepen the Clip Composition Plan](../spec.md)

## Observable acceptance criteria

- [x] An active background selects Fit framing even when stale Auto, Center, Split, or Screen fields remain in the document.
- [x] Every target plan declares the exact contained-video frame and the color or image background beneath it.
- [x] The planner receives resolved image availability through logical asset facts and performs no storage, URL, or browser I/O.
- [x] A usable background image appears identically in Studio and export for all supported targets.
- [x] An unavailable optional image falls back to the selected color, keeps export available, and emits one stable target-scoped composition notice.
- [x] Invalid required source facts produce a stable invalid-plan result before FFmpeg starts.
- [x] Fit framing requests no speaker, face, scene, or picture-in-picture analysis.
- [x] Switching between Center and Fit preserves the selected target, playhead, play state, playback rate, and main media element.
- [x] Visual output, optional-image degradation, and output treatment remain compatible with the approved fixtures.

## Public-interface and failure-injection tests

- [x] Planning-interface tables cover color and image backgrounds, every target, landscape and portrait sources, deleted ranges, stale framing fields, usable images, missing images, failed images, and invalid source dimensions.
- [x] Web and FFmpeg adapter contracts consume the same Fit plan fixtures and assert canvas, contain frame, layer order, and fallback notice.
- [x] Real-browser checks cover Center-to-Fit switching, image arrival, image failure, and playback preservation.
- [x] Real-FFmpeg checks compare representative frames and probes with approved color, image, and fallback fixtures.
- [x] Failure injection proves that optional image failure omits only that image and that no signed URL or provider error enters the plan or diagnostics.

## Plan-only state

- [x] Extend the plan version additively and keep Center fixtures valid.
- [x] Both adapters consume the same Fit decisions and reject unknown plan versions.
- [x] Keep the current Fit and background paths available until both adapters pass shared fixtures and real-media checks.

## Rollout and recovery safety

- [x] Enable Fit independently of scene-aware modes and monitor requested mode, effective mode, notice code, and adapter mismatch counts.
- [x] Recovery keeps the plan-only Fit path and reverts the offending code change without rewriting editor documents or optional asset records.

## Scope boundaries

- [x] Do not change background selection UX, upload behavior, entitlements, or color semantics.
- [x] Do not migrate B-roll, text, captions, logos, transitions, watermark treatment, or audio policy.
- [x] Do not introduce face analysis or new output dimensions for Fit.

## Completion evidence

- The shared planner gives an active background Fit precedence and declares contained-video and background layers for every target. Logical availability facts select the image or the deterministic color fallback without storage or browser I/O.
- Shared planner and adapter tests cover landscape and portrait sources, all supported targets, color and image backgrounds, unavailable-image notices, invalid source facts, and optional-image degradation.
- Browser, real-media, full-suite, typecheck, lint, and production-build verification passed without changing background UX, entitlements, codecs, or output dimensions.

## Fresh-task handoff

Implement in a fresh task with `/implement`; use `/tdd` for precedence, geometry, availability, and adapter behavior; finish with `/code-review`; run uncached focused tests, `bun run typecheck`, `bun run lint`, and `bun run build`; and verify color, image, and fallback output in a real browser and through real FFmpeg.
