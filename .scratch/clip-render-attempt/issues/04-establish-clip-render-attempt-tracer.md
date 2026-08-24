# 04 — Establish the one-method Clip Render Attempt tracer

**What to build:** Render and settle one ordinary single-variant clip through the new Clip Render Attempt interface while production remains on the legacy orchestration path.

**Blocked by:** [02 — Settle render aggregates and late work atomically](02-settle-render-aggregates-and-late-work-atomically.md).

**Status:** completed

**Specification:** [Deepen the Clip Render Attempt](../spec.md)

## Observable acceptance criteria

- [x] The public module exposes only `execute` with one input object containing an owned clip-rendering Workflow Attempt and AbortSignal, returning typed outcome counts and an optional follow-up Workflow Run ID.
- [x] A caller supplies no plan, asset, command, upload, persistence, settlement, notification, or cleanup sequencing.
- [x] The tracer freezes one Render Work Set and Frozen Rendering State, renders through existing single-video behavior, uploads an attempt-unique object, persists it under fencing, and settles through the lifecycle interface.
- [x] `WorkflowAttemptLost` aborts and escapes as control flow; owned deletion returns a superseded count; an unpersistable settlement error escapes for reaper recovery.
- [x] Production construction and test construction use internal persistence, process, storage, media, workspace, clock, and diagnostic adapters without exposing them in the public interface.
- [x] The new production path remains disabled.

## Public-interface and failure-injection tests

- [x] Behavior tests call only `execute` and observe the result, durable state, object references, and diagnostics.
- [x] Deterministic adapters inject failure at begin, state load, command, upload, guarded completion, settlement, and cleanup.
- [x] Tests prove success, permanent failure, retryable requeue, cancellation, stale attempt, supersession, and idempotent replay without asserting FFmpeg strings or private helper calls.

## Migration and mixed-version considerations

- [x] The tracer consumes the nullable lineage fields introduced by ticket 01 and refuses live execution when the cutover control is disabled.
- [x] Legacy pending rows remain renderable by the old path until the drain-based cutover.
- [x] No existing service export is removed while legacy callers remain.

## Rollout and recovery safety

- [x] A dark-run test environment can execute the tracer against isolated fixtures without letting old and new workers claim the same run.
- [x] Failure after object upload but before persistence leaves an observable cleanup attempt and a key eligible for later reconciliation.

## Scope boundaries

- [x] Implement only one ordinary single-video path; shared multi-output, Studio edits, optional assets, auto framing, and final cutover remain later tickets.
- [x] Do not change FFmpeg output policy, lifecycle ownership, Clip Composition Plan, Studio, or Ingest Jobs.

## Completion evidence

- The `ClipRenderAttempt.execute` behavior suite passes 19 tests with 67 assertions. It covers ordinary success, permanent failure, retryable command and upload failures, cancellation, stale ownership, supersession, idempotent replay, every ticket-04 failure-injection point, cleanup ordering, and the disabled cutover guard.
- The isolated PostgreSQL Workflow Run lifecycle suite passes 54 tests with 182 assertions, including frozen work sets, attempt fencing, atomic settlement failpoints, replay, follow-up admission, and reaper recovery.
- Uncached repository typecheck, lint, the complete test suite, and all 11 production-build tasks pass. The Next.js build generates 52 routes.
- Real Chrome verification loads authenticated `/home`, opens a completed project with 10 clips and a completed Render stage, plays an attempt-unique rendered object to `readyState` 4 without a media error, and returns to `/home` without console errors.
- The tracer rejects `execute` when the cutover control is disabled. Commit `70d3fad` kept the production path disabled during dark deployment; the later `b003c05` cutover default-enabled it as subsequent rollout work.

## Fresh-task handoff

Implement in a fresh task with `/implement`; drive the change with `/tdd`, finish with `/code-review`, and run uncached focused tests, relevant database tests, `bun run typecheck`, `bun run lint`, and a production build.
