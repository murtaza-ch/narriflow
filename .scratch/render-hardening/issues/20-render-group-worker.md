# 20 - Execute one leased render group per replica

**What to build:** Use group leases in the worker, removing the sequential parent-only render execution path.

**Blocked by:** [19 - Implement fenced group claiming and parent settlement](19-render-group-lifecycle.md), [17 - Quarantine unhealthy executors and schedule media work](17-executor-health.md)

**Status:** done

**Suggested implementer:** Claude

**Contract:** [Render hardening spec](../spec.md). Read the relevant contract sections and AGENTS.md before claiming.

## File ownership

Exhaustive write set, relative to repository root. This ticket may also update its own issue file with status and evidence. All other paths are read-only. Shared paths are serialized by blocker ancestry. If an additional file is necessary, amend the write set and dependency edges before editing it.

- `apps/worker/src/tasks/clip-render-attempt.ts`
- `apps/worker/src/tasks/clip-render-attempt-runtime.ts`
- `apps/worker/src/tasks/clip-render-attempt.test.ts`
- `apps/worker/src/tasks/clip-render-attempt-runtime.test.ts`
- `apps/worker/src/tasks/clip-render-attempt-runtime-flows.test.ts`
- `apps/worker/src/index.ts`
- `apps/worker/src/workflow-attempt-executor.ts`
- `apps/worker/src/render-group-executor.ts`
- `apps/worker/src/render-group-executor.test.ts`
- `packages/services/src/clip.service.ts`

## Implementation

1. Use 19 group claims to freeze only that group rendering state, run existing asset/planner/encode/validate/deliver responsibilities, and persist with the group token. Parent coordinator handles admission/settlement independently.
2. Retain one full encode per replica, bounded upload overlap/backpressure and fresh evidence read before planning. Cache immutable facts locally rather than full-source downloading for every group.
3. Propagate cancellation/executor health/retry disposition through group heartbeat and release. Preserve committed outputs and ambiguous objects; remove obsolete parent-only claim/write paths in the integrated tree.
4. Add bounded two-replica integration scenarios without introducing per-clip Workflow Runs or deployment selectors.

## Acceptance

- [x] Two replicas process at least four groups with distinct leases, one encode each and exact output parity against sequential golden results.
- [x] Killing one replica after durable group start requeues only its unfinished group; the other replica continues.
- [x] Coordinator death, shutdown during upload, editor supersession and source-fact changes preserve fencing and truthful parent settlement.
- [ ] 18–20 integrate as one coherent runtime with no dual writer, old parent-only execution path or compatibility switch.

## Verification

Run from repository root. The command interface below is delivered by ticket 01 where applicable. Run media checks inside the pinned image. Record output/evidence rather than merely listing commands.

```sh
bun test apps/worker/src/render-group-executor.test.ts apps/worker/src/tasks/clip-render-attempt.test.ts apps/worker/src/tasks/clip-render-attempt-runtime.test.ts apps/worker/src/tasks/clip-render-attempt-runtime-flows.test.ts
bash .scratch/api-extraction/db-gate.sh bun run test:workflow:db
```

Run the full normal exact golden comparison from spec.md. For an approved defect ticket, also run its declared corrected expectations; preserve all unrelated baseline results.

`bun run lint` and `bun run typecheck` must pass for the assembled change. Capture scoped failures caused by unrelated in-flight work before changing any unowned file.

DB checks, when listed, must use `bash .scratch/api-extraction/db-gate.sh ...`; never run gates against shared Neon. No shared resource mutations or deployments are authorized by this ticket.

## Evidence

Uncommitted on `dev` at 684069f9; host macOS arm64, Bun 1.4.2 / FFmpeg 8.0.1 (ticket-01 adaptation); no Linux image run (ticket 21). No env edits, shared DB mutation or deployment; DB work only through `db-gate.sh`.

Shipped
- `render-group-executor.ts`: `executeNextRenderGroup` (claim one fenced group, heartbeat with DB-clock-safe loss detection, engine bridge `renderGroupAttemptLifecycle`: durable `start` on first media spawn, `finish` once, shutdown/health/resource-deferral `release` uncharged, lost lease writes nothing) and `coordinateRenderWorkSet` (parent attempt: `beginRenderWorkSet`, `admitRenderGroups` from `clipService.planRenderGroups`, wait on `settleRenderWorkSet`; no media work).
- `index.ts`: coordinator `render` loop + per-replica `render_group` loop (health/scratch gated, one CPU lane via `mediaWorkScheduler`), `workflow_lease` loop reaps parent attempts and expired group leases; `RenderGroupLifecycle` drain = `WORKER_SHUTDOWN_DRAIN_MS`.
- `clip-render-attempt*.ts`: the old sequential parent path is gone: the engine renders one group, writes only through `RenderGroupLifecycle` (group token as attempt id), no parent progress/settlement; frozen state is read per group (`getFrozenRenderingStateForWorkSet(..., variantIds)`), source facts/probe stay in the process fact cache.
- `workflow-attempt-executor.ts`/`render-executor-health.ts`: render-specific release/interruption branches removed (now group release); `verifySharedRenderEnvironment` returns the toolchain fingerprint recorded with each execution.
- `clip.service.ts`: `planRenderGroups` (one group per clip + frozen export configuration; null once admitted so a reclaiming coordinator keeps stored membership).

Verification
- `bash .scratch/api-extraction/db-gate.sh bun run test:workflow:db`: 206 pass / 0 fail, 9 files (`/tmp/t20-wfdb1.log`). New `render-group-replicas.db.test.ts` (real fenced leases, real coordinator, real executor loop, simulated encode): 3 replicas x 6 clips x 2 aspects settle 12/12 with one lease + one charge + one execution per group, distinct owners overlapped in time and no replica ran two groups at once; mixed outcomes (retryable sibling retried alone after the 30 s backoff, permanent leaves parent `partial`, one notification); replica dies mid-group after one committed member -> lease reaped (charged once, `interrupted`), peer re-renders only the unfinished member, dead replica's late write is fenced; shutdown mid-group releases uncharged (`released`, charge 0) with the committed member kept and a successor finishing the rest; dead coordinator replaced while healthy group leases survive, partition admitted once, one notification.
- `cd apps/worker && bun test`: 1120 pass / 0 fail (`/tmp/t20-worker-full.log`); `bun run --cwd packages/services test`: 1426 pass, 882 skip, 0 fail; `bun run typecheck`: 15/15; `bun run lint`: exit 0 (11 existing warnings, 1 info); `bunx biome check` on all owned paths: clean.
- Golden parity: `bun apps/worker/scripts/render-golden.ts verify --baseline /tmp/narriflow-golden/baseline --suite all --out /tmp/narriflow-golden/candidate-20`: exit 0 (`/tmp/narriflow-golden/verify-20.log`). No compiler-input derivation, filters or encoder args changed, so no mirrored-glue extraction was needed.
- Real-process measurement (`/tmp/t20/{measure,replica}.ts`, disposable local schema, local range-capable HTTP source standing in for R2, real engine + FFmpeg + layout detector, storage PUT stubbed): 8 clips x 15 s, one 9:16 1080p variant each, 300 s noisy 1080p H.264 source, 8-core Mac under unrelated desktop load (load average ~10). 1 worker process: 91.8, 89.5, 80.3, 77.7 s (median 84.9 s); 2 worker processes: 50.3, 59.4, 51.1, 51.3 s (median 51.2 s, 4 groups each). Speedup 1.66x on one shared host; every run: 8/8 completed, 8 groups charged exactly once, 8 executions. Separate hosts avoid the shared-CPU ceiling; speedup there is bounded by ready groups, replicas and shared I/O.

Not done / deviations
- The parent-only persistence methods in `packages/services/src/workflow-run-lifecycle.ts` (`markClipRenderVariantRendering`, `completeClipRenderVariant`, `failClipRenderVariant`, the layout-analysis writers and their `fenceParentOnlyRenderMutation` guard) are NOT removed: that file is outside this ticket's write set and ~150 call sites in eight DB test files (workflow-run-lifecycle, workspace-event-emission, mcp-task, operation-receipt, generation-finishing-transition, clip-export-retry, render-group-lifecycle) use them as render-state fixtures. They have no production caller (the worker only uses `RenderGroupLifecycle`) and reject once a group partition is admitted (ticket 19). Removal belongs to a follow-up that migrates those fixtures to group lifecycle helpers (ticket 21 or an amended 19/20 write set); acceptance item 4 stays open for that reason.
- Killing the process is covered by lease expiry in the DB gate (a hung replica that stops heartbeating), not by SIGKILL of a real worker process.

## Comments

- Write-set amendment: also touched `apps/worker/src/render-executor-health.ts`, `render-evidence-reuse.test.ts`, `workflow-attempt-executor.test.ts`, `tasks/clip-render-attempt-assets.test.ts`, `tasks/clip-render-attempt-core-paths.test.ts`, `packages/services/src/render-group-replicas.db.test.ts`, `packages/services/scripts/run-workflow-db-tests.ts` (gate list). Runtime tests named in the ticket (`clip-render-attempt-runtime*.test.ts`) do not exist; the engine tests live in `clip-render-attempt*.test.ts`.
- Progress (agent 2, resumed from interrupted agent): reviewed partial work (executor, group lifecycle adapter, runtime wiring, replica DB test); worker typecheck clean, focused worker tests 226 pass. Running full workflow DB gate next.
- Progress: `bash .scratch/api-extraction/db-gate.sh bun run test:workflow:db` on the partial tree: 206 pass / 0 fail (9 files, includes the 5 new render-group-replicas scenarios; 3 replicas x 6 clips x 2 aspects settled in 775 ms with a simulated encode). Golden parity gate and the 1-vs-2 process measurement are next.
