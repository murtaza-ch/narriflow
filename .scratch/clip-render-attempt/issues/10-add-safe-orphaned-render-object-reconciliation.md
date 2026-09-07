# 10 — Add safe orphaned-render-object reconciliation

**What to build:** Give operators a project-scoped, dry-run-first command that finds and optionally deletes old attempt-unique render objects not referenced by durable render or export records.

**Blocked by:** [06 — Own guarded uploads and attempt cleanup](06-own-guarded-uploads-and-attempt-cleanup.md).

**Status:** completed

**Specification:** [Deepen the Clip Render Attempt](../spec.md)

## Observable acceptance criteria

- [x] The command requires an explicit project, lists only that project's attempt-unique render prefixes, and ignores legacy/shared key formats.
- [x] It compares candidates with all durable ordinary-render and export-variant references before classifying an orphan.
- [x] Objects newer than 24 hours are protected from deletion, even when unreferenced.
- [x] Dry-run is the default; deletion requires an explicit destructive flag and never accepts an unscoped bucket or workspace root.
- [x] Output reports examined, referenced, age-protected, orphaned, deleted, and failed counts plus stable object identifiers.
- [x] Re-running after partial deletion is idempotent, and a delete failure cannot cause a referenced object to be retried as an orphan.

## Public-interface and failure-injection tests

- [x] Command tests exercise its public invocation interface with in-memory storage and persistence adapters rather than private classifiers.
- [x] Failure injection covers paginated listing, database read failure, object appearing in the database during reconciliation, delete failure, cancellation, and replay.
- [x] Production storage contract tests cover scoped prefix listing, pagination, object timestamps, missing-object deletion, and access-denied classification.

## Migration and mixed-version considerations

- [x] The command recognizes only the new attempt-unique format, so deployment is safe before or after cutover and cannot reinterpret legacy objects.
- [x] No schema backfill or object rename is required.
- [x] Documentation states that mixed-version periods must use dry-run only until old render workers are drained.

## Rollout and recovery safety

- [x] Initial production use is dry-run with reviewed counts; destructive mode is enabled manually per project only after the 24-hour guard.
- [x] Diagnostics and exit status distinguish a clean scan, discovered orphans, partial deletion, and unsafe/unavailable state.

## Scope boundaries

- [x] Do not build a global bucket garbage collector, scheduled deletion loop, legacy-key cleanup, storage migration, or unrelated asset reconciliation.
- [x] Do not change render execution, lifecycle ownership, Studio, Ingest Jobs, or Clip Composition Plan.

## Completion evidence

- The project-scoped public command defaults to dry-run, recognizes attempt-unique keys only, protects objects younger than 24 hours, paginates, actively cancels, and refreshes durable references immediately before every deletion.
- In-memory public-interface tests cover database failure, a racing reference, delete failure, cancellation, pagination, partial replay, and idempotence; the live isolated R2 contract covers timestamps, pagination, double deletion, and stable access classification.
- A production-project dry-run examined 10 referenced objects and reported zero orphans, deletions, or failures; no destructive shared-prefix test was performed.

## Fresh-task handoff

Implement in a fresh task with `/implement`; drive the change with `/tdd`, finish with `/code-review`, and run uncached command and storage contract tests, `bun run typecheck`, `bun run lint`, and a production build. Never test destructive mode against a shared or production prefix.
