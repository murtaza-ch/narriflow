# 04 — Establish the one-method Clip Render Attempt tracer

**What to build:** Render and settle one ordinary single-variant clip through the new Clip Render Attempt interface while production remains on the legacy orchestration path.

**Blocked by:** [02 — Settle render aggregates and late work atomically](02-settle-render-aggregates-and-late-work-atomically.md).

**Status:** ready-for-agent

**Specification:** [Deepen the Clip Render Attempt](../spec.md)

## Observable acceptance criteria

- [ ] The public module exposes only `execute` with one input object containing an owned clip-rendering Workflow Attempt and AbortSignal, returning typed outcome counts and an optional follow-up Workflow Run ID.
- [ ] A caller supplies no plan, asset, command, upload, persistence, settlement, notification, or cleanup sequencing.
- [ ] The tracer freezes one Render Work Set and Frozen Rendering State, renders through existing single-video behavior, uploads an attempt-unique object, persists it under fencing, and settles through the lifecycle interface.
- [ ] `WorkflowAttemptLost` aborts and escapes as control flow; owned deletion returns a superseded count; an unpersistable settlement error escapes for reaper recovery.
- [ ] Production construction and test construction use internal persistence, process, storage, media, workspace, clock, and diagnostic adapters without exposing them in the public interface.
- [ ] The new production path remains disabled.

## Public-interface and failure-injection tests

- [ ] Behavior tests call only `execute` and observe the result, durable state, object references, and diagnostics.
- [ ] Deterministic adapters inject failure at begin, state load, command, upload, guarded completion, settlement, and cleanup.
- [ ] Tests prove success, permanent failure, retryable requeue, cancellation, stale attempt, supersession, and idempotent replay without asserting FFmpeg strings or private helper calls.

## Migration and mixed-version considerations

- [ ] The tracer consumes the nullable lineage fields introduced by ticket 01 and refuses live execution when the cutover control is disabled.
- [ ] Legacy pending rows remain renderable by the old path until the drain-based cutover.
- [ ] No existing service export is removed while legacy callers remain.

## Rollout and recovery safety

- [ ] A dark-run test environment can execute the tracer against isolated fixtures without letting old and new workers claim the same run.
- [ ] Failure after object upload but before persistence leaves an observable cleanup attempt and a key eligible for later reconciliation.

## Scope boundaries

- [ ] Implement only one ordinary single-video path; shared multi-output, Studio edits, optional assets, auto framing, and final cutover remain later tickets.
- [ ] Do not change FFmpeg output policy, lifecycle ownership, Clip Composition Plan, Studio, or Ingest Jobs.

## Fresh-task handoff

Implement in a fresh task with `/implement`; drive the change with `/tdd`, finish with `/code-review`, and run uncached focused tests, relevant database tests, `bun run typecheck`, `bun run lint`, and a production build.
