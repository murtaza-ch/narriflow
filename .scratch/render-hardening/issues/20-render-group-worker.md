# 20 - Execute one leased render group per replica

**What to build:** Use group leases in the worker, removing the sequential parent-only render execution path.

**Blocked by:** [19 - Implement fenced group claiming and parent settlement](19-render-group-lifecycle.md), [17 - Quarantine unhealthy executors and schedule media work](17-executor-health.md)

**Status:** ready-for-agent

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

- [ ] Two replicas process at least four groups with distinct leases, one encode each and exact output parity against sequential golden results.
- [ ] Killing one replica after durable group start requeues only its unfinished group; the other replica continues.
- [ ] Coordinator death, shutdown during upload, editor supersession and source-fact changes preserve fencing and truthful parent settlement.
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

Pending. Record commit/image hashes, commands, fixture reports and any unresolved acceptance here.

## Comments
