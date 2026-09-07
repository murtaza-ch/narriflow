# 05 — Own required-source resolution and command execution

**What to build:** Make the Clip Render Attempt own required source acquisition, probing, cancellable command execution, and typed command failures without changing generated media.

**Blocked by:** [04 — Establish the one-method Clip Render Attempt tracer](04-establish-clip-render-attempt-tracer.md).

**Status:** completed

**Specification:** [Deepen the Clip Render Attempt](../spec.md)

## Observable acceptance criteria

- [x] Required source resolution preserves ranged presign/probe first and full-download fallback, including current seek behavior.
- [x] Failure of both source paths records a stable typed failure and disposition.
- [x] Process and media operations receive the attempt signal and a positive per-operation deadline.
- [x] Timeout terminates and reaps the process tree; ownership loss or cancellation terminates active work and prevents dependent operations from starting.
- [x] Missing executables classify as permanent; timeouts and nonzero exits classify as retryable unless a specific permanent input classifier applies.
- [x] Structured diagnostics distinguish source presign, ranged probe, download, local probe, spawn, timeout, exit, cancellation, and termination.

## Public-interface and failure-injection tests

- [x] All orchestration behavior is tested through `ClipRenderAttempt.execute` with controllable process, media, clock, and storage adapters.
- [x] Failure injection covers every ranged and download step, corrupt media, spawn failure, timeout before and after output creation, nonzero exit, cancellation, and ownership loss.
- [x] Production adapter contract tests prove signal handling, TERM/KILL escalation, process reaping, timeout classification, probe normalization, and ranged-to-download fallback.

## Migration and mixed-version considerations

- [x] Existing command builders stay callable by both paths until cutover and keep their regression tests.
- [x] The new process and media adapters are additive; legacy wrappers are not removed in this ticket.
- [x] No environment variable is renamed or removed before final validated-config wiring.

## Rollout and recovery safety

- [x] The feature remains disabled in production and can be exercised with deterministic or isolated real-media fixtures.
- [x] Cancellation always waits for command termination before temporary source cleanup.

## Scope boundaries

- [x] Do not alter codecs, presets, arguments, seek placement, parallelism, hardware acceleration, media-analysis policy, or optional assets.
- [x] Do not change lifecycle ownership, Clip Composition Plan, Studio, or Ingest Jobs.

## Completion evidence

- The focused Clip Render Attempt, process-adapter, and media-adapter suites pass 50 tests with 306 assertions. They cover every required-source step, presign deadlines, corrupt media, command classification, timeout before and after output creation, cancellation and ownership loss at each source phase, TERM/KILL escalation, descendant reaping, probe normalization, and isolated real-media fixtures.
- A real-media contract drives `ClipRenderAttempt.execute` through presign, a failed production ranged probe, full download, and a successful production local probe.
- The complete worker suite passes 563 tests with 1,768 assertions, including existing FFmpeg smoke tests and ranged-source seek-order regressions.
- Uncached repository typecheck, lint, test, and production-build runs each pass all 11 tasks. The Next.js build generates 52 routes.
- Real Chrome verification loads authenticated `/home`, observes a completed Render event and 10 clips, plays an attempt-unique rendered MP4 to `readyState` 4 without a media error, and records no console errors, failed network requests, or HTTP error responses before returning to `/home`.
- This ticket leaves the cutover control unchanged. The baseline already includes the later `b003c05` default-enabled cutover documented by ticket 04, so ticket 05 does not reverse that subsequent rollout work.

## Fresh-task handoff

Implement in a fresh task with `/implement`; drive the change with `/tdd`, finish with `/code-review`, and run uncached interface and adapter tests, real-media tests where available, `bun run typecheck`, `bun run lint`, and a production build.
