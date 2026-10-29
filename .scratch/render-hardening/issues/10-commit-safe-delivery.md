# 10 - Preserve uploaded outputs across ambiguous completion

**What to build:** Keep completed or ambiguously committed artifacts safe when analytics or DB acknowledgements fail.

**Blocked by:** [09 - Validate rendered media before upload or success](09-output-validation.md)

**Status:** done

**Suggested implementer:** Sol

**Contract:** [Render hardening spec](../spec.md). Read the relevant contract sections and AGENTS.md before claiming.

## File ownership

Exhaustive write set, relative to repository root. This ticket may also update its own issue file with status and evidence. All other paths are read-only. Shared paths are serialized by blocker ancestry. If an additional file is necessary, amend the write set and dependency edges before editing it.

- `apps/worker/src/tasks/clip-render-attempt.ts`
- `apps/worker/src/tasks/clip-render-attempt-runtime.ts`
- `apps/worker/src/tasks/clip-render-attempt.test.ts`
- `apps/worker/src/tasks/clip-render-attempt-core-paths.test.ts`
- `apps/worker/src/tasks/clip-render-attempt-assets.test.ts`
- `apps/worker/src/render-object-reconciler.ts`
- `apps/worker/src/render-object-reconciler.test.ts`

## Implementation

1. Make the entire post-commit analytics operation best effort, including its lookup. A telemetry error must not reject a successful completion.
2. Distinguish proven stale rejection from uncertain commit. Delete attempt-unique provisional objects only with proven unreferenced/stale evidence; leave ambiguity to reference-aware reconciliation.
3. Preserve cancellation and original causal failure while bounded cleanup records orphan candidates. Keep current attempt fencing and object-key uniqueness.

## Acceptance

- [x] DB completion commits then analytics read fails: completion stays successful and delete is never called.
- [x] Lost DB commit acknowledgement preserves bytes; reconciliation rechecks references and retains committed objects.
- [x] Proven stale editor/reset or attempt rejection can delete only its own unreferenced key.
- [x] Cleanup failure does not undo a durable success or replace the original failure; normal parity passes.

## Verification

Run from repository root. The command interface below is delivered by ticket 01 where applicable. Run media checks inside the pinned image. Record output/evidence rather than merely listing commands.

```sh
bun test apps/worker/src/tasks/clip-render-attempt.test.ts apps/worker/src/render-object-reconciler.test.ts
```

Run the full normal exact golden comparison from spec.md. For an approved defect ticket, also run its declared corrected expectations; preserve all unrelated baseline results.

`bun run lint` and `bun run typecheck` must pass for the assembled change. Capture scoped failures caused by unrelated in-flight work before changing any unowned file.

DB checks, when listed, must use `bash .scratch/api-extraction/db-gate.sh ...`; never run gates against shared Neon. No shared resource mutations or deployments are authorized by this ticket.

## Evidence

Implemented on `dev`, base HEAD `c6728fe3ad`, 2026-10-29. No commit, env edit, dependency update, deployment, shared-resource mutation, or process termination. Ticket 15 files were left to their concurrent owner.

- Regression before fix: `bun test apps/worker/src/tasks/clip-render-attempt.test.ts --test-name-pattern 'analytics|acknowledgement|completion is uncertain|completion loses ownership'`: **1 pass, 5 fail**, reproducing deletion of committed/referenced bytes after analytics lookup, synchronous enqueue, or lost DB acknowledgement, and deletion on uncertain/lost-ownership completion. Log `/tmp/ticket10-red.log`.
- Final focused gate: `bun test apps/worker/src/tasks/clip-render-attempt.test.ts apps/worker/src/render-object-reconciler.test.ts`: **72 pass, 0 fail**. Log `/tmp/ticket10-focused-final.log`. Exercises the real production completion/analytics adapter through `execute()` with injected DB/service failures, not a mirrored completion function. Added cancellation and ownership loss during a committed call, same-token referenced stale output, rejected/stalled reference reads, a late reference response after cleanup timeout, and a DELETE that ignores abort across the exact 4999/5000ms boundary. The actual lost-ACK attempt flows through aged reconciliation; its fresh reference refresh retains the committed key. Fresh reconciliation-read failure also prevents deletion.
- `cd apps/worker && bun test`: **939 pass, 0 fail**, 51 files, 5225 assertions. Log `/tmp/ticket10-worker.log`.
- `bun run --cwd apps/worker typecheck`: **exit 0** after final source edits. Log `/tmp/ticket10-typecheck-final.log`.
- `bash .scratch/api-extraction/db-gate.sh bun run test:workflow:db`: **184 pass, 0 fail**, seven files. Log `/tmp/ticket10-workflow-db.log`.
- `bash .scratch/api-extraction/db-gate.sh bun run test:clip-editor-persistence:db`: **38 pass, 0 fail** across its three suites, 28 + 7 + 3. Log `/tmp/ticket10-editor-db.log`. Both DB commands used disposable local PostgreSQL only.
- Required parity: `bun apps/worker/scripts/render-golden.ts verify --baseline /tmp/narriflow-golden/baseline --suite all --out /tmp/narriflow-golden/candidate-10`: **exit 0**, 18/18 normal references identical, 16 corrected defect references pass, two existing guards unchanged, zero mismatches/xpass. Report `/tmp/narriflow-golden/candidate-10/report.md` and `report.json`; log `/tmp/narriflow-golden/verify-10.log`. Baseline commit `5680477046`, unchanged host fingerprint `90cf30a30583bbe5`, Bun 1.4.2 / FFmpeg 8.0.1 / macOS arm64. Ticket 01's approved host adaptation still applies; no container runtime/image build was added. Pinned Linux verification remains ticket 21's existing gate.
- `bun run lint`: **exit 0**, 11 existing warnings and 1 info. Log `/tmp/ticket10-root-lint.log`. `bun run typecheck`: **exit 0**, 15/15 tasks. Log `/tmp/ticket10-root-typecheck.log`.
- `bunx biome check` on the six changed TypeScript paths: **clean**, `/tmp/ticket10-biome.log`. `git diff --check`: **clean**.

## Comments

Write-set amendment, 2026-10-29: the two named runtime test files do not exist at c6728fe3. Their construction/runtime flows are in `clip-render-attempt.test.ts`; own that existing test instead. Tickets 09 and 11 are done; later attempt-lane tickets remain blocked by 10. No compiler input derivation changes are planned, so the no-mirrored-glue prerequisite does not activate.

Write-set amendment: add the two existing attempt test fixtures above to supply the required project-reference reader at the persistence seam. Before synchronous stale/pre-call-cancellation cleanup, a fresh reference read protects both ClipRender and ClipExportVariant references, including same-token replay. The five-second cleanup budget covers this read and DELETE together. No other ownership/dependency changes.


Implementation and close-out
- All analytics work, including client acquisition, lookup, synchronous invocation, async enqueue and error diagnostics, is best effort after fenced durable completion. Diagnostic sink failure cannot change the result; raw analytics exception messages are not logged.
- Completion throws are uncertain and retain bytes, including cancellation/ownership loss during the call. `RenderPersistenceFailure.cause` retains the causal error. The existing guarded failure writer cannot undo a completed row. Orphan diagnostics record the exact attempt key for the existing storage scanner; no new queue or schema is needed.
- Only an acknowledged false completion or cancellation before completion was invoked can attempt synchronous cleanup. Cleanup validates project-scoped attempt-key syntax and refreshes both render/export references through the existing service before DELETE. Reference errors, referenced keys and ambiguity all retain bytes. The fresh five-second budget bounds the reference lookup plus deletion, aborts storage independently of attempt cancellation, and rejects even if the adapter ignores abort. A late reference read checks that budget before it can delete. Cleanup failures cannot replace the original cancellation or reverse supersession.
- The reconciler already refreshes authoritative references before every aged deletion. Kept that implementation and added failure/recovery coverage instead of adding a second reconciliation protocol. Scheduling reconciliation remains with the later resource/maintenance tickets.
- Deviations: only the test-path/write-set correction above. No compiler-input derivation, planner, codec, graph, frame or PCM policy changed. No new baseline exceptions. No requests for other owners and no unresolved ticket-10 acceptance.
