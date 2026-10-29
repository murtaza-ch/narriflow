# Worker silently stops polling (2026-10-29)

## Root cause
- `@neondatabase/serverless` Pool defaults: `connectionTimeoutMillis` 0 (none), no `query_timeout`. The worker (unlike the API, which sets `DATABASE_POOL_*` in `apps/api/src/runtime.ts`) used those defaults.
- A pooled websocket that dies without a clean close, or a reconnect whose websocket never opens, leaves `pool.connect()` / the query pending forever. Reproduced in `packages/db/src/client.test.ts`: bare defaults keep the query pending; with the timeouts it rejects in about the timeout.
  A socket that does close mid-query rejects at once with "Connection terminated unexpectedly" (the burst of `worker_poll_failed` seen).
- `createIsolatedPollLoop` set `polling = true` for the whole tick and only cleared it in `finally`. A tick that never settles keeps every later `setInterval` tick a no-op, so `lastPollAt` freezes, no failure is counted (so no `worker_poll_failures_exceeded`), and the process idles at 0% CPU. About 15 loops hit it together, so nothing was claimed.

## Fix
- `packages/db/src/client.ts`: `DATABASE_POOL_DEFAULTS` (connect 10 s, idle 30 s, client-side `query_timeout` 60 s) under the env overrides (`DATABASE_POOL_QUERY_TIMEOUT_MS` is new). Applies to worker, API and web. Not a server `statement_timeout` (the Neon pooler rejects it as a startup parameter) and Prisma transaction timeouts are untouched.
- `apps/worker/src/poll-loop.ts`: watchdog. A tick over `stallBudgetMs(interval)` = max(15 min, 10 x interval) is abandoned: logged `worker_poll_stalled`, guard released, late result ignored. Work under a heartbeated lease (ingest `runClaim`, workflow attempt execution) runs inside `ctx.holdingLease(...)`, which pauses the budget; the lease heartbeat already aborts that work when the lease lapses (`workflow-run-lifecycle.ts` `runAttempt`). Only the claim before and the bookkeeping after are bounded.
- `/health`: 503 with `stalledLoops` when a loop has 3 consecutive abandoned ticks, or has not started a tick for 2 budgets while not holding a lease. Per-loop status adds `consecutiveStalls`, `totalStalls`, `stallAfterMs`, `holdingLease`.

## Safety of abandoning a tick
- Claims are conditional updates with a lease (`claim` in `workflow-run-lifecycle.ts`: `updateMany where status = queued`, plus ingest job claims), so a later tick or a peer can only take unowned or expired work. Test: a late claim after abandonment does not double-run a job.
- If a claim committed but its reply was lost, the row sits leased with no heartbeat, expires in 2 min, and the lease reaper requeues it (costs one attempt).
- Residual: a late-resuming abandoned tick still runs the job it claimed, so a process can briefly run two ticks of one loop (e.g. two renders). Unleased loops (preview, auto_layout, publish, ...) use the 15 min floor; a legitimate batch longer than that would overlap, never double-claim.
