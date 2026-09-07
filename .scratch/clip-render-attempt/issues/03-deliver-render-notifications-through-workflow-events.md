# 03 — Deliver render notifications through Workflow Events

**What to build:** Make a terminal clip-rendering Workflow Event the durable notification intent so completion, partial, and failure messages survive worker crashes and retry independently from domain settlement.

**Blocked by:** [02 — Settle render aggregates and late work atomically](02-settle-render-aggregates-and-late-work-atomically.md).

**Status:** completed

**Specification:** [Deepen the Clip Render Attempt](../spec.md)

## Observable acceptance criteria

- [x] Terminal render events carry a typed completed, partial, or failed notification payload with only stable identifiers and counts.
- [x] Workflow Event records expose an explicit notification-required flag and delivery acknowledgement so pending work is queryable without parsing JSON.
- [x] The dispatcher idempotently hands notification intent to the existing ledger/provider delivery path and acknowledges the event only after durable handoff.
- [x] Provider or dispatcher failure retries without changing Workflow Run or Clip Render Variant state.
- [x] `WorkflowAttemptLost`, requeue, and superseded-only control outcomes produce no terminal notification.
- [x] Undelivered notification-required events are not purged or treated as fully dispatched.

## Public-interface and failure-injection tests

- [x] Tests settle through the lifecycle interface and dispatch through the event-dispatch interface; they do not call notification helpers directly.
- [x] Failure injection covers crashes before commit, after event commit, before ledger handoff, after idempotent handoff, during provider delivery, and before event acknowledgement.
- [x] Tests prove replay sends or hands off once, the three terminal outcome payloads remain distinct, and unrelated Workflow Events still dispatch normally.

## Migration and mixed-version considerations

- [x] Delivery columns are additive and nullable/default-safe for existing events.
- [x] The upgraded dispatcher is deployed before notification-producing settlement is enabled; old dispatchers ignore but cannot erase the new pending requirement.
- [x] Existing post-settlement notification calls remain active until the render-attempt cutover, then are removed in the final contraction.

## Rollout and recovery safety

- [x] Operators can query pending and dead-lettered render notification events by stable fields.
- [x] Rollback disables new production while leaving committed notification events recoverable by the upgraded dispatcher.

## Scope boundaries

- [x] Do not replace Workflow Event with a second generic outbox or change non-render notification product behavior.
- [x] Do not alter Workflow Run ownership, email templates, Studio, Ingest Jobs, or rendering outputs.

## Completion evidence

- On 2026-08-25, the PostgreSQL Workflow Run lifecycle suite passed 54 tests with 182 assertions, including atomic settlement failpoints, the three terminal payloads, ledger-handoff replay, malformed durable payload rejection, and unaffected non-render dispatch.
- On 2026-08-25, focused notification, retention, and worker-link suites passed 33 tests, including idempotent handoff and provider-delivery retry behavior.
- On 2026-08-25, repository typecheck, lint, the complete test suite, and all 11 production-build tasks passed. The Next.js build generated 52 routes.
- Real Chrome verification loaded authenticated `/home`, a completed project, and its live Activity timeline without console errors or failed HTTP responses. The original tab was restored to `/home`.

## Fresh-task handoff

Implement in a fresh task with `/implement`; drive the change with `/tdd`, finish with `/code-review`, and run uncached focused tests, database tests, `bun run typecheck`, `bun run lint`, and a production build.
