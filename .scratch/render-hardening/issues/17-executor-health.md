# 17 - Quarantine unhealthy executors and schedule media work

**What to build:** Prevent duplicate/unreproducible local workers or broken spawns from burning media retries, and reduce background CPU contention.

**Blocked by:** [16 - Bound render backlog, scratch, cache and task deadlines](16-resource-bounds.md)

**Status:** ready-for-agent

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

## Implementation

1. Reserve the local health port before any polling/claims. Verify 01 runtime/model/font fingerprints and actual glyph checks before shared render/preview admission; isolated-fixture opt-in cannot bypass shared-queue rules.
2. Propagate executor failures through all render/asset/analysis catches, including the outer attempt handler, without marking every remaining variant failed. Stop new media work, release an unstarted claim without charging it, apply a delayed health/readiness check, and recycle after two failed checks. Before group leases, preserve completed siblings and refund the parent claim only when no media work started. Do not immediately reclaim on the same unhealthy executor.
3. Prioritize one encode over starting preview/auto-layout/thumbnail work; keep fairness between groups, shutdown cancellation and existing watchdog behavior.
4. Wire 16 scratch/cache sweep and existing reference-aware object reconciliation into bounded maintenance. Document and verify incomplete-multipart lifecycle cleanup and Railway draining >= shutdown grace. Record configuration findings without silently changing external services.

## Acceptance

- [ ] Two local worker startups cannot both begin polling on the shared queue; the second exits before claim.
- [ ] Repeated sync/async ffprobe/helper-start failures preserve media budget, stop batch failure fan-out and make readiness unhealthy.
- [ ] Mismatched native font/toolchain consumers cannot claim shared render/preview work; pinned image passes.
- [ ] Contended workload runs one encode with bounded background starts and eventual background progress; exact normal output parity holds.
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

Pending. Record commit/image hashes, commands, fixture reports and any unresolved acceptance here.

## Comments
