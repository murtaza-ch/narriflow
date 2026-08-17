# 01 — Establish durable Render Work Sets

**What to build:** Give every clip-rendering Workflow Run one durable, immutable Render Work Set so retries can identify their own variants without treating child rows as independently leased work.

**Blocked by:** None — can start immediately.

**Status:** completed

**Specification:** [Deepen the Clip Render Attempt](../spec.md)

## Observable acceptance criteria

- [x] The schema adds nullable Workflow Run lineage and nullable failure disposition to Clip Render rows, plus a nullable work-set-frozen marker to Workflow Runs and the indexes needed to select one run's variants.
- [x] The first owned begin transaction binds all eligible unassigned pending variants and records the frozen marker atomically.
- [x] A retry reads only variants already bound to that Workflow Run and cannot adopt variants created after the marker.
- [x] An initially empty work set remains empty on retry.
- [x] Work-set lineage never acts as a lease, attempt identity, or retry counter.
- [x] Existing completed outputs and export snapshots are not rewritten or backfilled.

## Public-interface and failure-injection tests

- [x] Database-backed tests drive work-set freezing through the Workflow Run lifecycle interface, not direct ORM calls.
- [x] Tests inject failure before commit and after each candidate selection to prove assignment and the frozen marker commit together or not at all.
- [x] Tests cover an empty set, concurrent late variant creation, retry, deleted variants, export-bound variants, and stale Workflow Attempt rejection.

## Migration and mixed-version considerations

- [x] The migration is additive and nullable, is safe while old workers still run, and is deployed before any code reads the new fields.
- [x] New readers tolerate legacy null lineage while the new render path is disabled.
- [x] No data backfill assigns historical completed or failed variants to a live Workflow Run.

## Rollout and recovery safety

- [x] The new claim path remains dark behind the render-attempt cutover control.
- [x] Rollback leaves the additive columns in place and returns to the legacy path without data loss.

## Scope boundaries

- [x] Do not change Workflow Run claiming, leases, heartbeats, attempt counts, reaping, or lifecycle protocol version.
- [x] Do not change Clip Render status values, render outputs, Studio Editing Session, Ingest Jobs, or Clip Composition Plan behavior.

## Fresh-task handoff

Implement in a fresh task with `/implement`; drive the change with `/tdd`, finish with `/code-review`, and run uncached focused tests, database tests, `bun run typecheck`, `bun run lint`, and a production build.
