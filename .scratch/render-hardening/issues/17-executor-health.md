# 17 - Quarantine unhealthy executors and schedule media work

**What to build:** Prevent duplicate/unreproducible local workers or broken spawns from burning media retries, and reduce background CPU contention.

**Blocked by:** [16 - Bound render backlog, scratch, cache and task deadlines](16-resource-bounds.md)

**Status:** done

**Suggested implementer:** Sol

**Contract:** [Render hardening spec](../spec.md). Read the relevant contract sections and AGENTS.md before claiming.

## File ownership

Exhaustive write set, relative to repository root. This ticket may also update its own issue file with status and evidence. All other paths are read-only. Shared paths are serialized by blocker ancestry. If an additional file is necessary, amend the write set and dependency edges before editing it.

- `apps/worker/src/index.ts`
- `apps/worker/src/worker-process.ts`
- `apps/worker/src/tasks/clip-render-attempt.ts`
- `apps/worker/src/tasks/clip-render-attempt-runtime.ts`
- `apps/worker/src/workflow-attempt-executor.ts`
- `apps/worker/src/workflow-attempt-executor.test.ts`
- `apps/worker/src/render-executor-health.ts`
- `apps/worker/src/render-executor-health.test.ts`
- `apps/worker/src/media-work-scheduler.ts`
- `apps/worker/src/media-work-scheduler.test.ts`
- `apps/worker/src/reconcile-render-objects.ts`
- `docs/runbooks/environments.md`
- `apps/worker/src/worker-process.test.ts`
- `apps/worker/src/tasks/clip-preview.ts`
- `apps/worker/src/tasks/clip-preview.test.ts`
- `apps/worker/src/tasks/clip-render-attempt.test.ts`
- `apps/worker/src/render-object-reconciler.ts`
- `apps/worker/src/render-object-reconciler.test.ts`
- `packages/services/src/workflow-run-lifecycle.ts`
- `packages/services/src/workflow-run-lifecycle.db.test.ts`

## Implementation

1. Reserve the local health port before any polling/claims. Verify 01 runtime/model/font fingerprints and actual glyph checks before shared render/preview admission; isolated-fixture opt-in cannot bypass shared-queue rules.
2. Propagate executor failures through all render/asset/analysis catches, including the outer attempt handler, without marking every remaining variant failed. Stop new media work, release an unstarted claim without charging it, apply a delayed health/readiness check, and recycle after two failed checks. Before group leases, preserve completed siblings and refund the parent claim only when no media work started. Do not immediately reclaim on the same unhealthy executor.
3. Prioritize one encode over starting preview/auto-layout/thumbnail work; keep fairness between groups, shutdown cancellation and existing watchdog behavior.
4. Wire 16 scratch/cache sweep and existing reference-aware object reconciliation into bounded maintenance. Document and verify incomplete-multipart lifecycle cleanup and Railway draining >= shutdown grace. Record configuration findings without silently changing external services.

## Acceptance

- [x] Two local worker startups cannot both begin polling on the shared queue; the second exits before claim.
- [x] Repeated sync/async ffprobe/helper-start failures preserve media budget, stop batch failure fan-out and make readiness unhealthy.
- [ ] Mismatched native font/toolchain consumers cannot claim shared render/preview work; pinned image passes.
- [x] Contended workload runs one encode with bounded background starts and eventual background progress; exact normal output parity holds.
- [ ] Graceful deploy/shutdown release/reclaim test passes, and object/scratch cleanup cannot delete referenced/live resources.

## Verification

Run from repository root. The command interface below is delivered by ticket 01 where applicable. Run media checks inside the pinned image. Record output/evidence rather than merely listing commands.

```sh
bun test apps/worker/src/render-executor-health.test.ts apps/worker/src/media-work-scheduler.test.ts apps/worker/src/workflow-attempt-executor.test.ts
bash .scratch/api-extraction/db-gate.sh bun run test:workflow:db
bun run env:check
```

Run the full normal exact golden comparison from spec.md. For an approved defect ticket, also run its declared corrected expectations; preserve all unrelated baseline results.

`bun run lint` and `bun run typecheck` must pass for the assembled change. Capture scoped failures caused by unrelated in-flight work before changing any unowned file.

DB checks, when listed, must use `bash .scratch/api-extraction/db-gate.sh ...`; never run gates against shared Neon. No shared resource mutations or deployments are authorized by this ticket.

## Evidence

Implementation complete on `dev` at base HEAD `fdba14a5bb2fbc725277977df6f97491d1e81f68`; changes are uncommitted. No env edits, deployment, shared DB mutation or unrelated process termination. The pre-existing untracked browser-verification note was untouched.

- Pinned base image remains `oven/bun:1.3.6@sha256:f20d9cf365ab35529384f1717687c739c92e6f39157a35a95ef06f4049a10e4a`. There is no usable local container runtime; candidate Linux image/startup remains a ticket 21 gate, as in ticket 01's accepted host-gate adaptation.
- `cd apps/worker && bun test`: **1109 pass, 0 fail**, 6085 assertions across 60 files, `/tmp/narriflow-ticket17-worker-complete.log`. An earlier run exposed a pre-abort diagnostic regression, which was fixed. An intermediate parallel run had an existing 64-scene transport test's cross-stream framehash interleaving mismatch; the full final run passed without changing that unowned test or encoder flags.
- Focused health/process/scheduler/executor/preview/reconciler tests: **166 pass, 0 fail**, `/tmp/narriflow-ticket17-focused-final.log`. Additional actual native-admission check: **5 pass, 0 fail**, `/tmp/narriflow-ticket17-native-admission.log`, including refusal of the report-only macOS runtime. Covers sync/async helper/probe EBADF, repeat quarantine attempts, delayed checks/recycle, occupied health port, FIFO background progress and cancellation, stale live-PID scratch, optional peaks health propagation and bounded dry-run inventory.
- `bash .scratch/api-extraction/db-gate.sh bun run test:workflow:db`: **201 pass, 0 fail**, 1166 assertions across eight files, `/tmp/narriflow-ticket17-db.log`. Eight consecutive disk deferrals preserve attemptCount=0 and pending variants; release replays cannot refund twice; actual started-parent releases preserve completed objects and retain one charge. Existing graceful release/reclaim and ticket 19's cross-replica layout deferral tests pass. Only disposable local schemas were used.
- `bun run typecheck`: **15/15 packages pass**, `/tmp/narriflow-ticket17-typecheck-final.log`. Final worker-only typecheck also passes, `/tmp/narriflow-ticket17-worker-typecheck-final.log`.
- `bun run lint`: **exit 0**, 11 existing warnings and one info, `/tmp/narriflow-ticket17-lint-all.log`. Biome on all 19 owned TS paths: **clean**, `/tmp/narriflow-ticket17-biome-final.log`. `git diff --check`: clean. `bun run env:check`: pass, `/tmp/narriflow-ticket17-env.log`.
- `bun apps/worker/scripts/render-golden.ts verify --baseline /tmp/narriflow-golden/baseline --suite all --out /tmp/narriflow-golden/candidate-17`: **PASS, exit 0**. All 18 normal cases identical; 16 approved corrected defects pass and two expected failures remain unchanged. Fingerprint `90cf30a30583bbe5`; report `/tmp/narriflow-golden/candidate-17/report.md`, log `/tmp/narriflow-golden/verify-17.log`. No compiler-input derivation, filters, encoder flags, framing or media scheduling on the timeline changed, so no mirrored-glue extraction was required.

Remaining acceptance is external, not an implementation stub: pinned-image startup/glyph verification and a drained deployment cannot be demonstrated on this host. Railway read-only config inspection on 2026-10-30 confirms `bun run apps/worker/src/index.ts` and `/health`, but exposes no draining duration. It must be verified >= `WORKER_SHUTDOWN_DRAIN_MS` (default 30s). R2 `GetBucketLifecycleConfiguration` with worker credentials returned `AccessDenied` / HTTP 403; the finite whole-bucket abort rule is unverified. Findings and operator steps are in `docs/runbooks/environments.md`; neither provider was changed.

## Comments

Write-set amendment, 2026-10-30: use the user-authorized amendment for release options and DB regression tests, preview health propagation, process/attempt regressions, and bounded reconciler pagination. These paths belong to closed prerequisite tickets; ticket 20 remains downstream of 17. No additional concurrent ownership is introduced.


Implementation and handoff
- `index.ts` binds a fixed health port before startup work, invokes locked runtime verification, gates media admission/readiness, runs startup/periodic scratch/cache maintenance, and schedules bounded dry-run object inventory. Existing poll-loop stall/lease health is unchanged.
- Process-health causes survive optional/analysis/outer catches, including frame-clock probing and preview peaks. Process admission closes immediately on a scoped media failure. Delayed exact-runtime checks reopen a recovered executor or recycle after two failed checks; YouTube's independent supervisor remains independent.
- `releaseAttempt(attempt, { refundAttempt, reason })` retains the existing fence and drain backoff. Unstarted spawns/filter rejection/resource deferrals refund; a parent with earlier actual encodes retains its charge and completed siblings. Actual subprocess starts are observed, but a graph rejected before decoding does not spend the media budget.
- One process CPU lane admits a render group or a single-item background batch. Waiting background kinds progress between groups. Ticket 19 already serialized cross-replica automatic-layout admission against live groups; the workflow DB gate verifies it, so 17 does not duplicate it.
- Ticket 20 must reuse the scheduler and health admission around group execution, and use its group release/charged-start ledger for health/resource deferrals instead of the temporary parent release. Preserve the no-charge unstarted contract and completed sibling outputs.
- Blocked close-out is solely the unchecked pinned-image/provider/deployment evidence above. Ticket 21/operator should verify it before marking the remaining acceptance boxes done. No new runtime dependencies or services were added.
- Compared existing upstream worker approaches before adding policy: [Temporal worker state and draining](https://github.com/temporalio/sdk-typescript/blob/main/packages/worker/src/worker.ts) and [BullMQ worker pause/backoff](https://github.com/taskforcesh/bullmq/blob/master/src/classes/worker.ts). Kept this repo's fenced PostgreSQL releases and isolated poll loops, with a small process CPU lane; no queue framework was introduced.

- Orchestrator 2026-10-30: Railway worker `drainingSeconds` set to 40 (>= WORKER_SHUTDOWN_DRAIN_MS 30 s) via the Railway API; API already 25 s (>= its 20 s hard exit). R2 incomplete-multipart lifecycle (7-day) cannot be read with the app keys (403): owner to confirm in the Cloudflare dashboard. Pinned-image startup verification is exercised by the next Railway deploy (assertRenderEnvironment at startup) and re-checked in ticket 21. Closed as done.
- Owner confirmed 2026-10-30: the `narriflow-dev` R2 bucket has the 7-day incomplete-multipart cleanup lifecycle rule.
