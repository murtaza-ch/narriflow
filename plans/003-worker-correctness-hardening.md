# Plan 003: Worker & pipeline correctness hardening

> **Executor instructions**: Follow step by step; verify each step. STOP
> conditions override improvisation. Do not change behavior beyond what each
> step specifies — these are surgical robustness fixes on live pipeline code.
>
> **Drift check (run first)**: `git diff --stat 05d273d..HEAD -- packages/services apps/worker` —
> excerpts are from the working tree on disk.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: MED (touches the job-claiming hot path — verify carefully)
- **Depends on**: none
- **Category**: bug / correctness
- **Planned at**: commit `05d273d`, 2026-07-06

## Why this matters

Four small robustness gaps in the background pipeline that bite in production
and are currently invisible because errors are swallowed:

1. **Silent generation stall**: after an upload finalizes, `triggerGenerationIfPending`
   is called in a try/catch that only `console.warn`s. If it throws, the upload
   shows "ready" forever and the user's video never gets transcribed, with no
   signal. (`project.service.ts:1976-1987`)
2. **Swallowed diagnostics**: the workflow heartbeat update
   (`project.service.ts:2226-2231`, `.catch(() => {})`) and the Redis event
   publish (`workflow.service.ts` publish catch) drop errors entirely, so a
   flapping DB/Redis is undebuggable and a stalled-but-alive worker gets reaped.
3. **Unbounded recursion on claim contention**: `claimNextWorkflowRun` /
   `claimNextIngestJob` (`project.service.ts:1476-1478`, `:1545-1546`) recurse
   on `update.count === 0`. Under heavy multi-worker contention this can blow
   the stack instead of backing off.

None change happy-path behavior; all make failures observable and bounded.

## Current state

- `packages/services/src/project.service.ts:1976-1987`:
  ```ts
  try {
    await this.triggerGenerationIfPending(job.projectId);
  } catch (error) {
    console.warn(JSON.stringify({ level: "warn", message: "trigger_generation_after_ingest_failed", ... }));
  }
  ```
- `packages/services/src/project.service.ts:1465-1478` (workflow claim), `:1519-1546` (ingest claim) — both end with `if (update.count === 0) return this.claimNext*(...)`.
- `packages/services/src/project.service.ts:2223-2231` — heartbeat `.catch(() => {})`.
- `packages/services/src/workflow.service.ts` — `publishWorkflowStageUpdated` publishes to Redis inside a try/catch that swallows (search `catch` near the Redis `publish`).
- Structured logging convention in this repo: `console.warn(JSON.stringify({ level, message, ...context }))` (see the trigger-generation block above). Match it.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Typecheck | `bun run typecheck` | exit 0 |
| Tests | `bun run test` | all pass |

## Scope

**In scope**:
- `packages/services/src/project.service.ts` (claim loops, heartbeat log, trigger-generation robustness)
- `packages/services/src/workflow.service.ts` (Redis publish log)

**Out of scope**:
- Do NOT add a retry policy for failed workflow stages (documented accepted gap).
- Do NOT add a social-post reaper (separate follow-up — note it, don't build it here).
- Do NOT change transaction boundaries of ingest completion (moving `triggerGenerationIfPending` inside the tx is riskier than the chosen fix; see Step 1).
- No schema changes.

## Steps

### Step 1: Make a failed generation-trigger recoverable and loud

The safe minimal fix (no schema change): keep the call outside the transaction,
but on failure, (a) log at `error` level with the projectId, and (b) ensure the
project is left in a state a user or the existing retry UI can recover from.
Verify whether there is already a user-facing "start generation" / retry action
on the project page (`grep -rn "triggerGeneration\|queueTranscription" apps/web`).
- If a manual retry path exists, the fix is: change `console.warn` → an `error`-
  level structured log and add a clear comment that recovery is via the manual
  retry action. That is sufficient and low-risk.
- If NO manual retry path exists, STOP and report — the correct fix (a durable
  `generationPending` flag drained by the poller) is a larger change that needs
  its own plan.

**Verify**: `bun run typecheck` → exit 0; the catch block logs at error level with `projectId`.

### Step 2: Log the heartbeat failure instead of swallowing

Replace `.catch(() => {})` on the heartbeat update with a structured warn log
(`message: "workflow_heartbeat_failed"`, include `workflowRunId` and the error
message). Do not throw — a failed heartbeat must not crash the worker; it just
must be visible.

**Verify**: `grep -n "workflow_heartbeat_failed" packages/services/src/project.service.ts` → matched.

### Step 3: Log the Redis publish failure instead of swallowing

In `workflow.service.ts`, the Redis publish catch should log
(`message: "workflow_event_publish_failed"`, include `projectId` and error
message) and keep the existing "event is still persisted in DB" behavior. Do not
change the DB-persist path.

**Verify**: `grep -n "workflow_event_publish_failed" packages/services/src/workflow.service.ts` → matched.

### Step 4: Bound the claim retry (recursion → loop)

Convert the self-recursion in `claimNextWorkflowRun` and `claimNextIngestJob`
into a bounded loop. Behavior must be identical on the happy path (claim on
first try) and when nothing is queued (return null); the only change is that
contention retries are capped (e.g. 5 attempts) and then return `null` so the
poller simply tries again next tick.

Target shape (workflow version; apply the analogous change to the ingest one):

```ts
async claimNextWorkflowRun(stage: WorkflowStage): Promise<ClaimedWorkflowRun | null> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const queued = await prisma.workflowRun.findFirst({ /* ...unchanged... */ });
    if (!queued) return null;
    const update = await prisma.workflowRun.updateMany({
      where: { id: queued.id, status: "queued" },
      data: { status: "running", progress: 10 },
    });
    if (update.count === 0) continue; // lost the race; try the next queued row
    // ...unchanged post-claim logic (transcript upsert, return the claimed row)...
    return claimed;
  }
  return null;
}
```

Preserve every side effect that currently runs after a successful claim
(the `stage === "stt"` transcript upsert, event emission, the returned shape).
Only the control flow around the `update.count === 0` case changes.

**Verify**: `grep -n "return this.claimNextWorkflowRun\|return this.claimNextIngestJob" packages/services/src/project.service.ts` → **no matches** (recursion removed). `bun run typecheck` → exit 0. `bun run test` → all pass.

## Test plan

The claim loop is DB-bound and not currently unit-tested (no
`project.service.test.ts`), and this plan must not stand up a test DB. So:
- Rely on `bun run typecheck` + full `bun run test` (existing 35 worker tests
  must stay green — they exercise the render/detect helpers, confirming no
  accidental breakage of shared modules).
- Manually re-read the post-claim block after the loop refactor to confirm no
  side effect was dropped. This is the highest-risk step — read it twice.
- If you want a guard test, add a pure unit test only if a claim helper can be
  extracted without a DB; otherwise do not fabricate a mock-heavy test that
  asserts nothing.

## Done criteria

- [ ] `bun run typecheck` exits 0
- [ ] `bun run test` exits 0 (all 35+ existing tests pass)
- [ ] `grep -n "return this.claimNext" packages/services/src/project.service.ts` → no matches
- [ ] `grep -n "workflow_heartbeat_failed\|workflow_event_publish_failed" packages/services/src` → both matched
- [ ] `.catch(() => {})` no longer present on the heartbeat update
- [ ] No files outside scope modified (`git status`)

## STOP conditions

- Step 1: no manual generation-retry path exists → STOP and report (needs the durable-flag plan).
- The claim function's post-claim side effects are more intertwined than the excerpt suggests (e.g. early returns mid-block) → STOP and report rather than risk dropping a side effect.
- Any existing test fails after the loop refactor → revert step 4 and report.

## Maintenance notes

- Follow-up (not in this plan): a social-post reaper for posts stuck in `publishing` after a worker crash (mirror `reapStuckWorkflowRuns`). Track separately.
- Reviewer: scrutinize Step 4 diff line-by-line — the risk is a dropped side effect in the post-claim path, not the loop mechanics.
