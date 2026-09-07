# Plan 008: Social-post reaper + polling backoff

> **Executor**: follow step by step, verify each step. MED risk (touches worker loop + pipeline). STOP if excerpts don't match.
> **Drift check**: `git status --short packages/services apps/worker` — uncommitted tree; excerpts from disk.

## Status
- **Priority**: P2 · **Effort**: M · **Risk**: MED · **Depends on**: none
- **Category**: bug/correctness · **Planned at**: `05d273d`, 2026-07-06

## Why this matters
Two robustness gaps:
1. **Stuck social posts**: `reapStuckWorkflowRuns`/`reapStuckIngestJobs` recover
   crashed-worker jobs, but a social post moved to `publishing` by a worker that
   then crashes stays stuck forever — no reaper covers it. Users see a post that
   never completes and never fails.
2. **Fixed-interval polling without jitter**: AssemblyAI transcription polling
   and social provider status polls use a constant interval with no jitter, so
   many concurrent workers hit provider APIs in lockstep (thundering herd → 429s).

## Current state (verified)
- Reaper methods live in `packages/services/src/project.service.ts`
  (`reapStuckWorkflowRuns` ~2242, `reapStuckIngestJobs` ~2285). They flip stalled
  rows (updatedAt older than a timeout) back to a terminal state. Mirror this
  shape for social posts.
- Worker wires reaping in `apps/worker/src/index.ts` (`reapStalledRunsIfDue`,
  ~line 25, calls `projectService.reapStuckWorkflowRuns` + `reapStuckIngestJobs`).
  Add the social reaper call here.
- Social posts: `packages/services/src/social.service.ts` — `claimDuePosts`
  moves rows to `publishing`; `completePublishedPost`/`failPublishingPost` are
  the terminal transitions. A stuck row = `status: "publishing"` with an old
  `updatedAt`.
- Polling sites: `apps/worker/src/tasks/transcribe.ts` (~361-398, fixed
  `pollIntervalMs` loop to a deadline); `apps/worker/src/tasks/social-publisher.ts`
  has a `wait(ms)` helper (~line 122) and fixed-interval poll loops
  (`pollInstagramContainer`, `pollTikTokStatus`, `pollXMedia`).

Conventions: structured logs `console.warn(JSON.stringify({ level, message, ...ctx }))`.
Env-tunable knobs read via `Number(process.env.X ?? default)`.

## Commands
| Purpose | Command | Expected |
|---|---|---|
| Typecheck | `bun run typecheck` | exit 0 |
| Tests | `bun run test` | all pass |

## Scope
**In scope**:
- `packages/services/src/social.service.ts` — add `reapStuckPublishingPosts(timeoutMs)`.
- `apps/worker/src/index.ts` — call it inside the existing reap tick.
- `apps/worker/src/tasks/transcribe.ts` — add small jitter to the poll sleep.
- `apps/worker/src/tasks/social-publisher.ts` — add jitter to the provider poll sleeps.

**Out of scope**: no retry policy for failed workflow stages (accepted gap); no
schema change; do not change claim logic or terminal transitions; do not add
exponential growth that meaningfully increases user-perceived latency — jitter
only (±20%), keep the base interval.

## Steps

### Step 1: Social-post reaper
In `social.service.ts`, add a method mirroring `reapStuckWorkflowRuns`:

```ts
/** Fails social posts stuck in `publishing` past the stall timeout (worker
 *  likely crashed mid-publish). Returns the number reaped. */
async reapStuckPublishingPosts(stallTimeoutMs: number): Promise<number> {
  const prisma = requirePrisma();
  const cutoff = new Date(Date.now() - stallTimeoutMs);
  const stuck = await prisma.socialPost.findMany({
    where: { status: "publishing", updatedAt: { lt: cutoff } },
    select: { id: true },
  });
  let reaped = 0;
  for (const post of stuck) {
    const res = await prisma.socialPost.updateMany({
      where: { id: post.id, status: "publishing" },
      data: { status: "failed", errorCode: "worker_stalled" },
    });
    if (res.count > 0) reaped += 1;
  }
  return reaped;
}
```

Confirm the actual field/column names (`status`, `updatedAt`, `errorCode`) against
the `SocialPost` model in `packages/db/prisma/schema.prisma` before writing.
Add `worker_stalled` to the friendly error map only if trivial; otherwise the
generic fallback covers it.

**Verify**: `grep -n "reapStuckPublishingPosts" packages/services/src/social.service.ts` → matched; `bun run typecheck` → 0.

### Step 2: Wire into the worker reap tick
In `apps/worker/src/index.ts`, inside `reapStalledRunsIfDue` (next to the
existing `reapStuckWorkflowRuns`/`reapStuckIngestJobs` calls), add
`const reapedPosts = await socialService.reapStuckPublishingPosts(reapStallTimeoutMs);`
and log when `reapedPosts > 0` using the same structured-log style as the
existing reaper logs. Import `socialService` from `@narriflow/services` if not
already imported.

**Verify**: `grep -n "reapStuckPublishingPosts" apps/worker/src/index.ts` → matched; `bun run typecheck` → 0.

### Step 3: Jitter on poll sleeps
In `transcribe.ts` and `social-publisher.ts`, where a fixed interval is slept
between polls, apply ±20% jitter. Add a tiny helper (local to each file, or one
shared function) — but note `Math.random()` is available in worker runtime code
(the ban is only in Workflow scripts):

```ts
function jitter(ms: number): number {
  return Math.round(ms * (0.9 + Math.random() * 0.2)); // 90%–110%
}
```

Apply as `await wait(jitter(intervalMs))` / `await sleep(jitter(pollIntervalMs))`.
Keep deadlines/attempt caps unchanged. Do not jitter the AssemblyAI upload or any
non-poll sleep.

**Verify**: `grep -n "jitter" apps/worker/src/tasks/transcribe.ts apps/worker/src/tasks/social-publisher.ts` → matched; `bun run test` → all 35 worker tests still pass.

## Test plan
- The reaper and poll loops are DB/time/network-bound; do not fabricate a test
  DB or fake timers. Rely on typecheck + the existing worker suite staying green.
- If a poll interval was extracted into a pure helper, a trivial unit test that
  `jitter(1000)` returns a value in `[900, 1100]` is welcome (add to an existing
  worker test file only if it fits cleanly).

## Done criteria
- [ ] `bun run typecheck` exits 0; `bun run test` exits 0 (35+ worker tests pass)
- [ ] `grep -n "reapStuckPublishingPosts" packages/services/src/social.service.ts apps/worker/src/index.ts` → both matched
- [ ] `grep -n "jitter" apps/worker/src/tasks/transcribe.ts apps/worker/src/tasks/social-publisher.ts` → matched
- [ ] Only in-scope files modified (`git status`)

## STOP conditions
- The `SocialPost` model has no `updatedAt` or the status enum lacks `failed`/`publishing` → STOP and report the actual schema.
- The transcribe/social poll loops are structured so jitter can't be applied without changing deadline semantics → apply only where safe and report the rest.

## Maintenance notes
- Tune `WORKER_REAP_STALL_TIMEOUT_MS` covers workflow/ingest; the social reaper reuses it. If social publishing legitimately takes longer than that timeout, give it its own env knob.
- Reviewer: confirm the reaper only touches rows older than the cutoff and uses the same conditional-update guard as the workflow reaper.
