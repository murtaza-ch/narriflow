# 06 — Own guarded uploads and attempt cleanup

**What to build:** Deliver rendered files through bounded uploads, reference them only after fenced persistence, and clean temporary or provisional artifacts deterministically.

**Blocked by:** [05 — Own required-source resolution and command execution](05-own-source-resolution-and-command-execution.md).

**Status:** ready-for-agent

**Specification:** [Deepen the Clip Render Attempt](../spec.md)

## Observable acceptance criteria

- [ ] Upload concurrency defaults to two, never exceeds four, and accounts for every scheduled task before settlement.
- [ ] Ordinary and export-bound object keys are attempt-unique and retain current consumer-visible metadata and content type.
- [ ] A provisional object becomes durable only when guarded variant completion references its exact key.
- [ ] Lost ownership aborts active uploads where supported, rejects queued uploads, and prevents persistence.
- [ ] A superseded row, rejected persistence write, or ownership loss triggers best-effort deletion of its provisional object.
- [ ] Temporary workspaces are removed only after command termination, upload drain, and immediate cleanup attempts.
- [ ] Cleanup failure emits a typed diagnostic without reversing an already durable variant or run outcome.

## Public-interface and failure-injection tests

- [ ] Tests call only `ClipRenderAttempt.execute` and observe bounded adapter concurrency, persistence, deletion, settlement, and workspace state.
- [ ] Failure injection covers upload rejection, hung upload cancellation, stale completion, ownership loss before and after upload, delete failure, workspace cleanup failure, and background task rejection.
- [ ] R2/storage contract tests cover upload, download, delete, list/prefix isolation, metadata normalization, abort behavior where available, and attempt-unique keys.

## Migration and mixed-version considerations

- [ ] New unique export keys are forward-only; existing referenced export objects remain valid and are never renamed.
- [ ] Both object-key formats may coexist indefinitely, but only the new format is eligible for automatic orphan reconciliation.
- [ ] Legacy upload helpers remain until every render path has moved behind the attempt interface.

## Rollout and recovery safety

- [ ] The feature remains disabled for live claims, and isolated adapter tests never use a shared production prefix.
- [ ] Every failure after upload leaves either a durable database reference, a successful deletion, or a structured orphan candidate for ticket 10.

## Scope boundaries

- [ ] Do not change bucket layout outside render prefixes, public download contracts, multipart upload intake, upload concurrency above four, or output bytes.
- [ ] Do not change lifecycle ownership, Studio, Ingest Jobs, or Clip Composition Plan.

## Fresh-task handoff

Implement in a fresh task with `/implement`; drive the change with `/tdd`, finish with `/code-review`, and run uncached interface, storage, and database tests, `bun run typecheck`, `bun run lint`, and a production build.
