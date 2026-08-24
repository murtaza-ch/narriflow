# 02 — Settle render aggregates and late work atomically

**What to build:** Settle a frozen Render Work Set from its durable child outcomes and atomically admit a follow-up Workflow Run for variants that arrived too late to join it.

**Blocked by:** [01 — Establish durable Render Work Sets](01-establish-durable-render-work-sets.md).

**Status:** completed

**Specification:** [Deepen the Clip Render Attempt](../spec.md)

## Observable acceptance criteria

- [x] Aggregate counts are derived across the complete Render Work Set, including variants completed or permanently failed by earlier attempts.
- [x] Mixed surviving success and failure settles as a Partial Workflow Outcome without retrying failed variants inside that terminal run.
- [x] Zero success requeues when any causal failure is retryable and budget remains, fails immediately when all causal failures are permanent, and uses lifecycle retry exhaustion when budget is spent.
- [x] Requeue preserves completed and permanently failed variants while resetting only interrupted and retryable variants to pending.
- [x] Deleted or invalidated variants count as superseded rather than failed; an all-superseded set completes with zero artifacts.
- [x] Terminal settlement writes child disposition effects, run outcome and counts, terminal Workflow Event, and idempotent follow-up admission in one fenced transaction.
- [x] Late unassigned pending variants receive at most one follow-up run whose identifier is returned to the caller.

## Public-interface and failure-injection tests

- [x] Database-backed tests drive settlement through the Workflow Run lifecycle interface and observe run, child, event, and follow-up records.
- [x] Tests inject transaction failure before and after child settlement, aggregate update, event append, and follow-up admission; no partial combination commits.
- [x] Tests cover concurrent replay, unique-constraint contention, stale attempts, cross-attempt completion, permanent-plus-retryable mixes, and all terminal outcomes.

## Migration and mixed-version considerations

- [x] Settlement reads legacy null disposition conservatively only while the new path is disabled; new attempts always write a disposition for failures.
- [x] The follow-up idempotency key remains compatible with the existing one-live-render-run constraint.
- [x] No legacy worker may execute the new child-settlement semantics during rollout.

## Rollout and recovery safety

- [x] The behavior is dark-deployed and exercised by database tests before render cutover.
- [x] Replaying terminal settlement after an ambiguous database response is idempotent and cannot duplicate a run or event.

## Scope boundaries

- [x] Do not change lifecycle ownership, retry limits, backoff policy, or non-render stages.
- [x] Do not introduce clip-group claiming, dynamic mid-attempt adoption, new statuses, or render execution code.

## Completion evidence

- Commit `70d3fad` kept the render-attempt worker path disabled by default while database contracts for partial, superseded, exhaustion, and terminal-reaping outcomes were already present; the default-enabled cutover followed in `b003c05`.
- On 2026-08-24, the isolated PostgreSQL lifecycle suite passed 50 tests with 162 assertions, including eight BEFORE/AFTER transaction failpoints and deterministic concurrent replay serialization.
- On 2026-08-24, uncached repository verification passed all 33 test/typecheck/lint tasks and all 11 production-build tasks, including 52 Next.js routes.

## Fresh-task handoff

Implement in a fresh task with `/implement`; drive the change with `/tdd`, finish with `/code-review`, and run uncached focused tests, database tests, `bun run typecheck`, `bun run lint`, and a production build.
