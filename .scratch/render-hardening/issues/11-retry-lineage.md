# 11 - Retry transient siblings and repair manual export admission

**What to build:** Keep transient child failures nonterminal through backoff and make manual export retries claimable and idempotent.

**Blocked by:** [01 - Golden parity harness and pinned reference image](01-golden-parity-harness.md)

**Status:** done

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

- [x] Success plus retryable failure on claim one requeues only the failed child; no premature partial outcome or terminal notification.
- [x] After exhaustion, mixed outcomes settle partial once; all-failed, all-superseded and permanent failures remain truthful.
- [x] Actual manual retry of a terminal export detaches old run/attempt/disposition, is claimed and completes, with correct aggregates and preserved successful storage keys.
- [x] Simultaneous manual retries are idempotent and all ClipExportVariant mutations recompute aggregates.
- [x] Heartbeat blocked behind successful settlement does not emit attempt-lost; true pre-commit lease loss still aborts.

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

Implemented by GPT-6.1-Sol on `dev`, base HEAD `a4c8c003cab5ec6194ec3b23caf8e7fec6c5de60`, 2026-10-29. No commit, env edit, dependency update, shared-resource mutation, or deployment. All source edits stay within the declared write set.

Implementation:
- Removed the successful-sibling veto. Claims retain settled counts/progress; transient members alone requeue at 30s then 60s through the existing three-attempt budget. Completed storage keys and permanent failures remain unchanged. Terminal replay emits one durable notification.
- Extracted `clip-export-aggregates.ts` as the transactional aggregate authority for lifecycle writes, export creation, cancellation, and manual retry.
- Actual `ClipExportService.retryFailed` validates the frozen document/entitlements, then uses the lifecycle's project admission lock and a retry-count compare guard. Only settled failed children reset their lineage, disposition and result fields. Retry count, admission/reuse, aggregates and queued event commit together. Active children remain untouched; a frozen active run drains late retry work normally.
- Added local execution settlement tracking. A heartbeat rejected behind the handler's settlement waits for commit/rollback; only committed settlement suppresses ownership loss. Marker cleanup also covers handlers and pre-aborted shutdown. Amended ADR 0003 and the contradictory callback DB fixture.

Verification:
- `bun test packages/services/src/workflow-run-lifecycle.test.ts packages/services/src/clip-export.service.test.ts`: **27 pass**, 0 fail. Commit/rollback heartbeat race and true ownership loss covered.
- `bash .scratch/api-extraction/db-gate.sh bun run test:workflow:db`: **183 pass, 1 fail** across 184 tests. The only failure is the unowned `workspace-event-emission.db.test.ts:247` obsolete claim-one partial expectation. Log `/tmp/narriflow-ticket-11-workflow-db.log`.
- `WORKFLOW_TEST_NAME='WorkflowRunLifecycle PostgreSQL invariants|Workflow render rescue PostgreSQL invariants|Manual Clip Export retry PostgreSQL invariants' bash .scratch/api-extraction/db-gate.sh bun run test:workflow:db`: **109 pass**, 75 filtered, 0 fail. Log `/tmp/narriflow-ticket-11-owned-db.log`. Includes actual concurrent manual service retry, automatic success/exhaustion, all-failed permanent manual retry, active child preservation, frozen membership follow-up, admission rollback, real PostgreSQL heartbeat blocked on successful settlement, and true pre-commit lease loss.
- `bun run --cwd packages/services test`: **1391 pass**, 855 skipped DB tests, 0 fail. Log `/tmp/narriflow-ticket-11-services-test.log`.
- `bun run --cwd packages/services typecheck`: pass. Scoped `bunx biome check` on all nine owned TS verification paths: pass. Scoped `git diff --check`: pass.
- `bun run lint`: pass with 11 existing warnings and 1 info. Log `/tmp/narriflow-ticket-11-lint.log`.
- `bun run typecheck`: pass, 15/15 tasks. Initial log `/tmp/narriflow-ticket-11-typecheck.log`; final rerun after all source edits also passed 15/15 tasks, `/tmp/narriflow-ticket-11-typecheck-final.log`.
- `bun run test`: failed in concurrent ticket 02's `apps/worker/src/worker-process.test.ts`, test `real probes expose matrices, SAR, HDR, late audio and bounded timestamps`. FFmpeg rejects its generated `cover.mp3` with `Failed to find two consecutive MPEG audio frames`, `worker_command_input_invalid`. No worker files were edited here. Log `/tmp/narriflow-ticket-11-test.log`.
- Required golden command: `bun apps/worker/scripts/render-golden.ts verify --baseline /tmp/narriflow-golden/baseline --suite all --out /tmp/narriflow-golden/candidate-11`: **PASS, exit 0**. Normal 18/18 identical; 18/18 known-defect references unchanged. Report `/tmp/narriflow-golden/candidate-11/report.md`, log `/tmp/narriflow-golden/verify-11.log`. Same macOS host adaptation as ticket 01, fingerprint `90cf30a30583bbe50e3972558024cc2ce7b9bffe683b79411d839e93d0d05f7f`; no new image built. No `clip-render-attempt.ts` compiler-input derivation changed, so the no-mirrored-glue extraction prerequisite does not activate.

Closure is blocked on the out-of-write-set event-test fixture correction and the concurrent ticket 02 root-test failure. All five acceptance behaviors above pass owned tests. No behavior deviation from the spec. The write set omitted one DB expectation that must change with the explicitly approved retry policy.

## Comments

Owner request discovered during verification: `packages/services/src/workspace-event-emission.db.test.ts:236-247` is outside this ticket's write set and still expects a claim-one retryable sibling failure to settle partial. Before that test's `settleRenderWorkSet(attempt)`, set its run's `attemptCount` to 3, or change the failed format to permanent and adjust the comment. The new owner decision correctly leaves this test nonterminal without that fixture update. No unowned file was edited.

Additional owner request: ticket 02 should repair or regenerate its `cover.mp3` real-probe fixture, then rerun root tests. The failure is in its current work, not a ticket 11 render-output mismatch.
