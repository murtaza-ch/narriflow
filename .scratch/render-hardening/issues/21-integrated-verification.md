# 21 - Record durable attempt telemetry and verify integrated recovery

**What to build:** Produce reproducible parity, fault recovery and throughput evidence for the complete hardening change.

**Blocked by:** [20 - Execute one leased render group per replica](20-render-group-worker.md), [15 - Bound multipart abort and preview storage lifetimes](15-bounded-storage-cleanup.md)

**Status:** ready-for-agent

**Suggested implementer:** Sol

**Contract:** [Render hardening spec](../spec.md). Read the relevant contract sections and AGENTS.md before claiming.

## File ownership

Exhaustive write set, relative to repository root. This ticket may also update its own issue file with status and evidence. All other paths are read-only. Shared paths are serialized by blocker ancestry. If an additional file is necessary, amend the write set and dependency edges before editing it.

- `apps/worker/src/render-diagnostic-adapter.ts`
- `apps/worker/src/render-diagnostic-adapter.test.ts`
- `apps/worker/src/tasks/clip-render-attempt.ts`
- `apps/worker/src/tasks/clip-render-attempt-runtime.ts`
- `apps/worker/src/index.ts`
- `apps/worker/src/render-hardening.integration.test.ts`
- `packages/services/src/render-group-lifecycle.ts`
- `packages/services/src/render-group-lifecycle.db.test.ts`
- `.scratch/render-hardening/spec.md`

## Implementation

1. Fill remaining telemetry gaps using the spec field contract. Persist idempotent compact group/variant start/outcomes in the existing event/ledger model so mutable rows no longer define attempt denominators.
2. Run the full golden/fault matrix, including process-start, partial retries, true manual export retry, analysis retry/exhaustion, corrupt/truncated output, storage hang, disk pressure and ambiguous completion.
3. Compare frozen workloads with/without reusable evidence and with one/two replicas. Report samples, wall-time p50/p95, detector executions, repeated work, upload bytes/backlog and resource peaks with correct denominators.
4. Record reproducible command/image/commit hashes and failures in this ticket; close the spec only after every ticket and integrated gate passes. This ticket does not authorize deploying, mutating shared DB, killing user processes or pushing.

## Acceptance

- [ ] Structured telemetry includes safe IDs/fingerprints/phase/timing/retry/failure/errno/resources/output facts and redacts signed URLs/secrets/user caption text.
- [ ] Durable start/outcome history distinguishes media attempts, unstarted executor releases, crashes and supersession without duplicate terminal events.
- [ ] Full normal exact parity and all activated defect contracts pass; no normal baseline was refreshed to hide drift.
- [ ] Every injected failure reaches bounded retry/degradation/permanent success/failure correctly, with no ready invalid output or deleted referenced object.
- [ ] All repository and disposable DB gates below pass; performance results state sample sizes and limits, including whether the 30–45% opportunity was realized.

## Verification

Run from repository root. The command interface below is delivered by ticket 01 where applicable. Run media checks inside the pinned image. Record output/evidence rather than merely listing commands.

```sh
bun test apps/worker/src/render-hardening.integration.test.ts apps/worker/src/render-diagnostic-adapter.test.ts
bash .scratch/api-extraction/db-gate.sh bun run test:workflow:db
bash .scratch/api-extraction/db-gate.sh bun run test:clip-editor-persistence:db
bun run lint
bun run typecheck
bun run test
bun run --cwd apps/api test:inventory
bun run --cwd apps/api openapi:check
bun run check:web-split
```

Run the full normal exact golden comparison from spec.md. For an approved defect ticket, also run its declared corrected expectations; preserve all unrelated baseline results.

DB checks, when listed, must use `bash .scratch/api-extraction/db-gate.sh ...`; never run gates against shared Neon. No shared resource mutations or deployments are authorized by this ticket.

## Evidence

Pending. Record commit/image hashes, commands, fixture reports and any unresolved acceptance here.

## Comments
