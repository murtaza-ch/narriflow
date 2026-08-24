# 06 — Own guarded uploads and attempt cleanup

**What to build:** Deliver rendered files through bounded uploads, reference them only after fenced persistence, and clean temporary or provisional artifacts deterministically.

**Blocked by:** [05 — Own required-source resolution and command execution](05-own-source-resolution-and-command-execution.md).

**Status:** completed

**Specification:** [Deepen the Clip Render Attempt](../spec.md)

## Observable acceptance criteria

- [x] Upload concurrency defaults to two, never exceeds four, and accounts for every scheduled task before settlement.
- [x] Ordinary and export-bound object keys are attempt-unique and retain current consumer-visible metadata and content type.
- [x] A provisional object becomes durable only when guarded variant completion references its exact key.
- [x] Lost ownership aborts active uploads where supported, rejects queued uploads, and prevents persistence.
- [x] A superseded row, rejected persistence write, or ownership loss triggers best-effort deletion of its provisional object.
- [x] Temporary workspaces are removed only after command termination, upload drain, and immediate cleanup attempts.
- [x] Cleanup failure emits a typed diagnostic without reversing an already durable variant or run outcome.

## Public-interface and failure-injection tests

- [x] Tests call only `ClipRenderAttempt.execute` and observe bounded adapter concurrency, persistence, deletion, settlement, and workspace state.
- [x] Failure injection covers upload rejection, hung upload cancellation, stale completion, ownership loss before and after upload, delete failure, workspace cleanup failure, and background task rejection.
- [x] R2/storage contract tests cover upload, download, delete, list/prefix isolation, metadata normalization, abort behavior where available, and attempt-unique keys.

## Migration and mixed-version considerations

- [x] New unique export keys are forward-only; existing referenced export objects remain valid and are never renamed.
- [x] Both object-key formats may coexist indefinitely, but only the new format is eligible for automatic orphan reconciliation.
- [x] Legacy upload helpers remain until every render path has moved behind the attempt interface.

## Rollout and recovery safety

- [x] The feature remains disabled for live claims, and isolated adapter tests never use a shared production prefix.
- [x] Every failure after upload leaves either a durable database reference, a successful deletion, or a structured orphan candidate for ticket 10.

## Scope boundaries

- [x] Do not change bucket layout outside render prefixes, public download contracts, multipart upload intake, upload concurrency above four, or output bytes.
- [x] Do not change lifecycle ownership, Studio, Ingest Jobs, or Clip Composition Plan.

## Completion evidence

- The Clip Render Attempt interface suite passes 47 tests with 339 assertions. It covers default and capped concurrency, full queue drain before settlement, active and queued cancellation, ordinary and export-bound attempt keys, exact guarded references, upload and persistence rejection, supersession, ownership loss, provisional deletion failure, workspace cleanup failure, and background task rejection.
- The complete worker suite passes 565 tests with 1,814 assertions after replacing the old queue-helper tests with behavior coverage through `ClipRenderAttempt.execute`.
- The real R2 contract passes eight tests against an isolated `tests/narriflow-ticket-06` prefix. It verifies upload, download, delete, prefix isolation, metadata normalization, content type, attempt-shaped unique keys, and both preflight and active multipart abort behavior, then cleans the created objects.
- The isolated PostgreSQL Workflow Run lifecycle suite passes 54 tests with 182 assertions, including guarded child completion, stale-attempt fencing, work-set settlement, retry, supersession, notification, and reaper invariants.
- One uncached Turborepo run passes all 44 typecheck, lint, test, and production-build tasks. The Next.js build generates 52 routes.
- Real Chrome verification loads authenticated `/home`, opens a ready project with 10 clips, observes a completed Render event, and plays an attempt-unique rendered MP4 to `readyState` 4 without a media error. A clean playback window records no console errors, failed network requests, or HTTP error responses.
- Live claims are opt-in: missing or empty `WORKER_CLIP_RENDER_ATTEMPT_ENABLED` remains disabled, the worker example configuration uses `0`, and only explicit `1` enables the claim loop.
- Failed persistence is classified separately from upload failure, and cleanup diagnostics include the exact attempt ID, object key, operation, failure code, disposition, and orphan-candidate result needed by ticket 10.

## Fresh-task handoff

Implement in a fresh task with `/implement`; drive the change with `/tdd`, finish with `/code-review`, and run uncached interface, storage, and database tests, `bun run typecheck`, `bun run lint`, and a production build.
