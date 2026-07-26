# Plan 027: Make workflow claims, transitions, events, and reaping atomically idempotent

> **Production migration plan — approval required**: This changes the core
> worker state machine and database schema. Execute in a dedicated branch with
> a production-shaped concurrency test database. Do not combine deployment of
> this migration with unrelated product features.
>
> **Drift check**:
> `git diff --stat 05d273d..HEAD -- packages/db/prisma/schema.prisma packages/db/prisma/migrations packages/services/src/project.service.ts packages/services/src/workflow.service.ts packages/services/src/clip.service.ts packages/services/src/dubbing.service.ts apps/worker/src apps/web/app/api/stream`

## Status

- **Priority**: P1 release blocker
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: plans/023-secure-and-bound-media-ingest.md and
  plans/041-production-shaped-integration-gates.md
- **Category**: correctness, migration, tests
- **Planned at**: commit `05d273d`, 2026-07-09, live working tree

## Why this matters

Today a successful provider operation can be followed by a failed event or
analytics write and then be recorded as failed. Claims use check-then-create,
event sequencing uses `MAX(seq)+1`, reapers judge the original start timestamp
instead of an owned renewable lease, and render/dub rows can stay permanently
in `rendering/processing`. Retries can therefore reject accepted duplicate
work, overwrite completed state, strand a child stage, or mark live long jobs
dead.

## Current evidence

- `project.service.ts:1606+` performs transcript completion, duration update,
  run completion, event emission, and child-run creation as separate operations.
- `transcribe.ts:554+` catches a later failure by failing the workflow, even if
  transcript completion already succeeded.
- `workflow.service.ts:76+` allocates `MAX(seq)+1`, allowing concurrent inserts
  to choose the same sequence.
- Workflow admission checks then creates instead of returning the unique-key
  winner on a race.
- Reapers use stale timestamps and update only workflow rows; `ClipRender` and
  `ClipDub` can remain nonclaimable.
- Render/dub/post completion records analytics sequentially; telemetry failure
  can reverse or hide product success.
- Claim queries have no matching `(stage,status,createdAt)` or
  `(status,leaseExpiresAt)` indexes.

## Target invariants

1. One deterministic logical request has one workflow run.
2. A claim has one owner and renewable expiry; only that owner may heartbeat or
   finalize it.
3. Domain success is never reversed by telemetry/event delivery failure.
4. A terminal transition and its outbox record commit atomically.
5. Per-project event sequence values are unique and monotonic under concurrency.
6. Expired work moves every stage-specific row into a documented retryable or
   terminal state; late owners cannot overwrite the new attempt.

## Phase 1: Schema and rolling-deploy compatibility

Add nullable lease/attempt fields to claimable records first:

- `leaseOwner`, `leaseExpiresAt`, `heartbeatAt`, `attempt` on workflow/ingest
  ownership (choose the smallest authoritative model; do not create two sources
  of lease truth).
- a project event sequence counter or a dedicated counter row.
- an `OutboxEvent` with unique deterministic key, aggregate/project, type,
  payload, availability, attempts, delivered timestamp, and last safe error.
- indexes matching claim and reaper filters.

The first migration must be additive and safe while old workers still run.
Backfill/defaults happen separately; deploy readers before writers and writers
before enforcing non-null constraints.

## Phase 2: Atomic admission and owned claims

- Derive an idempotency key from user/project/stage/request intent.
- Create-or-read the unique winner inside a transaction; a uniqueness race is a
  successful duplicate, not an error.
- Claim with one conditional update (`pending/retryable`, unexpired lease), set
  owner/expiry/attempt, and return only when one row changed.
- Generate a unique worker instance ID at process start. Heartbeat at an
  interval shorter than half the lease and stop heartbeats in `finally`.
- Every progress/finalize/fail update includes owner + attempt + expected state.
  A zero-row update means lost lease; stop without altering domain state.

## Phase 3: Transactional stage transitions and outbox

For each stage, create one service transition that transactionally:

- validates owner/attempt/current state;
- updates transcript/clip/render/dub plus workflow status;
- creates deterministic child work with upsert/create-or-read;
- increments and records the project sequence;
- appends outbox events for SSE/Redis and analytics.

After commit, a dispatcher publishes outbox rows with retry/backoff and marks
them delivered. Redis/analytics outage may delay observability but cannot fail
the completed artifact. Never call an external provider inside the DB
transaction.

## Phase 4: Lease-aware reaping and partial outcomes

- Reap only expired leases, not elapsed `startedAt`.
- CAS on owner/attempt so a renewed or completed job wins.
- Reset or terminally fail related transcript/render/dub rows consistently.
- Define aggregate outcomes: all succeeded = completed; some succeeded =
  partial; zero succeeded = failed. Store requested/succeeded/failed counts and
  expose them to UI/error recovery.
- Bound attempts and separate retryable from permanent error taxonomy.

## Tests and rollout gates

- 50 concurrent identical admissions return one run without caller errors.
- Two workers racing for one row yield one lease owner.
- Old owner cannot complete after expiry/reclaim.
- Heartbeating long job is never reaped; crashed job is reclaimed.
- Inject failure after domain write, child creation, outbox insertion, Redis,
  and analytics; invariants still hold.
- Concurrent event writers produce strictly increasing unique project seq.
- Zero/partial/all render and dub outcomes map correctly.
- Migration tested from a production-shaped snapshot; rolling old/new worker
  compatibility demonstrated.
- Dashboard/SSE reconnect replays a bounded sequence without duplicates.

## Done criteria

- All six target invariants have automated concurrency/fault-injection tests.
- No stage service uses check-then-create for idempotent admission.
- No reaper relies only on original `startedAt`.
- Analytics/event publication cannot reverse a completed artifact.
- Claim/reaper queries use verified indexes (`EXPLAIN` on production shape).
- Deployment and rollback order is documented.

## STOP conditions

- There is no production-like database for concurrency and migration tests.
- A design creates lease truth in both `WorkflowRun` and child rows without an
  explicit ownership hierarchy.
- External calls remain inside transactions.
- Rolling deployment would let old workers overwrite leased state.
- The production migration is attempted without owner authorization and backup.
