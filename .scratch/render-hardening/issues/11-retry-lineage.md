# 11 - Retry transient siblings and repair manual export admission

**What to build:** Keep transient child failures nonterminal through backoff and make manual export retries claimable and idempotent.

**Blocked by:** [01 - Golden parity harness and pinned reference image](01-golden-parity-harness.md)

**Status:** ready-for-agent

**Suggested implementer:** Sol

**Contract:** [Render hardening spec](../spec.md). Read the relevant contract sections and AGENTS.md before claiming.

## File ownership

Exhaustive write set, relative to repository root. This ticket may also update its own issue file with status and evidence. All other paths are read-only. Shared paths are serialized by blocker ancestry. If an additional file is necessary, amend the write set and dependency edges before editing it.

- `packages/services/src/workflow-run-lifecycle.ts`
- `packages/services/src/workflow-run-lifecycle.test.ts`
- `packages/services/src/workflow-run-lifecycle.db.test.ts`
- `packages/services/src/workflow-render-rescue.db.test.ts`
- `packages/services/src/clip-export.service.ts`
- `packages/services/src/clip-export.service.test.ts`
- `packages/services/src/clip-export-aggregates.ts`
- `packages/services/src/clip-export-retry.db.test.ts`
- `packages/services/scripts/run-workflow-db-tests.ts`
- `packages/services/src/index.ts`
- `docs/adr/0003-clip-render-attempt.md`

## Implementation

1. Remove the successful-sibling retry veto; preserve success/permanent members and requeue only transient/interrupted members using the existing three-attempt/backoff policy.
2. Expose one authoritative aggregate recomputation helper for lifecycle and manual retry. Under project/admission lock, conditionally reset failed lineage/result fields and atomically admit/reuse work. Frozen export inputs remain unchanged.
3. Exercise the actual retryFailed service through rescue/admission. Concurrent retries increment retryCount once and cannot reset already-active children.
4. Fix in-flight heartbeat/settlement synchronization so completed handlers do not emit lost ownership. Preserve genuine ownership loss before settlement. Amend ADR 0003 to final owner decision and update the contradictory DB expectation.

## Acceptance

- [ ] Success plus retryable failure on claim one requeues only the failed child; no premature partial outcome or terminal notification.
- [ ] After exhaustion, mixed outcomes settle partial once; all-failed, all-superseded and permanent failures remain truthful.
- [ ] Actual manual retry of a terminal export detaches old run/attempt/disposition, is claimed and completes, with correct aggregates and preserved successful storage keys.
- [ ] Simultaneous manual retries are idempotent and all ClipExportVariant mutations recompute aggregates.
- [ ] Heartbeat blocked behind successful settlement does not emit attempt-lost; true pre-commit lease loss still aborts.

## Verification

Run from repository root. The command interface below is delivered by ticket 01 where applicable. Run media checks inside the pinned image. Record output/evidence rather than merely listing commands.

```sh
bun test packages/services/src/workflow-run-lifecycle.test.ts packages/services/src/clip-export.service.test.ts
bash .scratch/api-extraction/db-gate.sh bun run test:workflow:db
```

Run the full normal exact golden comparison from spec.md. For an approved defect ticket, also run its declared corrected expectations; preserve all unrelated baseline results.

`bun run lint` and `bun run typecheck` must pass for the assembled change. Capture scoped failures caused by unrelated in-flight work before changing any unowned file.

DB checks, when listed, must use `bash .scratch/api-extraction/db-gate.sh ...`; never run gates against shared Neon. No shared resource mutations or deployments are authorized by this ticket.

## Evidence

Pending. Record commit/image hashes, commands, fixture reports and any unresolved acceptance here.

## Comments
