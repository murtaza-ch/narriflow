# 09 — Preserve framing and media-analysis paths inside the Clip Render Attempt

**What to build:** Move automatic reframing, screen and split layout detection, picture-in-picture analysis, and their fallbacks behind the attempt interface without changing composition decisions.

**Blocked by:** [08 — Preserve optional-asset fallbacks inside the Clip Render Attempt](08-preserve-optional-asset-fallbacks.md).

**Status:** completed

**Specification:** [Deepen the Clip Render Attempt](../spec.md)

## Observable acceptance criteria

- [x] Auto-reframe, layout-engine, screen-layout, picture-in-picture, split-layout, and disabled-feature paths execute through internal media and process adapters.
- [x] Existing enablement precedence, thresholds, sampling rates, model selection, crop/layout results, and fallback order remain unchanged.
- [x] Analysis commands honor the attempt signal and per-operation deadlines and cannot write or be adopted after ownership loss.
- [x] Missing optional analysis capability preserves current fallback; required command or input failure receives the existing effective disposition.
- [x] Stale analysis output is ignored by attempt identity and Frozen Rendering State.
- [x] Diagnostics identify the analysis phase, selected/fallback mode, duration, and failure classification without leaking raw frames or command lines.

## Public-interface and failure-injection tests

- [x] Tests drive every analysis branch through `ClipRenderAttempt.execute` with deterministic media/process results and assert final observable render requests and outcomes.
- [x] Failure injection covers missing model/executable, invalid detector output, timeout, nonzero exit, no-face/no-screen results, corrupt background, cancellation, and ownership loss.
- [x] Existing geometry, crop, layout, and real-media regression fixtures remain authoritative for compatibility and are not replaced by assertions on adapter call order.

## Migration and mixed-version considerations

- [x] Existing analysis helpers and model assets remain available to the legacy path until final cutover.
- [x] No stored analysis format or Studio preview contract changes.
- [x] Feature kill switches keep their literal `0` behavior through both paths.

## Rollout and recovery safety

- [x] Dark-run comparison covers each enabled and disabled branch on representative vertical, horizontal, screen, split, and audiogram inputs.
- [x] A mismatch in crop/layout output blocks cutover and is assigned to the separate composition recommendation if resolving it requires shared policy.

## Scope boundaries

- [x] Do not implement the Clip Composition Plan, alter geometry constants, unify preview and render policy, add models, or change quality/performance policy.
- [x] Do not change lifecycle ownership, Studio Editing Session, or Ingest Jobs.

## Completion evidence

- Execute-seam tests cover auto-reframe, layout engine, screen, positive PiP, valid no-screen, split, kill switches, detector failures, cancellation, and ownership loss without replacing the authoritative geometry and real-media fixtures.
- Analysis helpers run through bounded process/media adapters; persistence is transactionally fenced to a live attempt and a rendering variant in its frozen Render Work Set.
- Both independent code-review axes report no remaining findings, and the isolated PostgreSQL regressions prove stale and out-of-set analysis cannot publish.

## Fresh-task handoff

Implement in a fresh task with `/implement`; drive the change with `/tdd`, finish with `/code-review`, and run uncached interface, media-analysis, and real-media regression tests, `bun run typecheck`, `bun run lint`, and a production build.
