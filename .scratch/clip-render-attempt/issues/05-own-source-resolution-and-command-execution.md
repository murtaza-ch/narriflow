# 05 — Own required-source resolution and command execution

**What to build:** Make the Clip Render Attempt own required source acquisition, probing, cancellable command execution, and typed command failures without changing generated media.

**Blocked by:** [04 — Establish the one-method Clip Render Attempt tracer](04-establish-clip-render-attempt-tracer.md).

**Status:** ready-for-agent

**Specification:** [Deepen the Clip Render Attempt](../spec.md)

## Observable acceptance criteria

- [ ] Required source resolution preserves ranged presign/probe first and full-download fallback, including current seek behavior.
- [ ] Failure of both source paths records a stable typed failure and disposition.
- [ ] Process and media operations receive the attempt signal and a positive per-operation deadline.
- [ ] Timeout terminates and reaps the process tree; ownership loss or cancellation terminates active work and prevents dependent operations from starting.
- [ ] Missing executables classify as permanent; timeouts and nonzero exits classify as retryable unless a specific permanent input classifier applies.
- [ ] Structured diagnostics distinguish source presign, ranged probe, download, local probe, spawn, timeout, exit, cancellation, and termination.

## Public-interface and failure-injection tests

- [ ] All orchestration behavior is tested through `ClipRenderAttempt.execute` with controllable process, media, clock, and storage adapters.
- [ ] Failure injection covers every ranged and download step, corrupt media, spawn failure, timeout before and after output creation, nonzero exit, cancellation, and ownership loss.
- [ ] Production adapter contract tests prove signal handling, TERM/KILL escalation, process reaping, timeout classification, probe normalization, and ranged-to-download fallback.

## Migration and mixed-version considerations

- [ ] Existing command builders stay callable by both paths until cutover and keep their regression tests.
- [ ] The new process and media adapters are additive; legacy wrappers are not removed in this ticket.
- [ ] No environment variable is renamed or removed before final validated-config wiring.

## Rollout and recovery safety

- [ ] The feature remains disabled in production and can be exercised with deterministic or isolated real-media fixtures.
- [ ] Cancellation always waits for command termination before temporary source cleanup.

## Scope boundaries

- [ ] Do not alter codecs, presets, arguments, seek placement, parallelism, hardware acceleration, media-analysis policy, or optional assets.
- [ ] Do not change lifecycle ownership, Clip Composition Plan, Studio, or Ingest Jobs.

## Fresh-task handoff

Implement in a fresh task with `/implement`; drive the change with `/tdd`, finish with `/code-review`, and run uncached interface and adapter tests, real-media tests where available, `bun run typecheck`, `bun run lint`, and a production build.
