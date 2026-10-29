# 19 - Implement fenced group claiming and parent settlement

**What to build:** Allow independent replicas to claim groups safely while parent settlement remains truthful and transactional.

**Blocked by:** [18 - Define durable render groups and ownership contracts](18-render-group-model.md), [13 - Reuse compatible layout and immutable media facts](13-reuse-render-facts.md)

**Status:** done

**Suggested implementer:** Sol

**Contract:** [Render hardening spec](../spec.md). Read the relevant contract sections and AGENTS.md before claiming.

## File ownership

Exhaustive write set, relative to repository root. This ticket may also update its own issue file with status and evidence. All other paths are read-only. Shared paths are serialized by blocker ancestry. If an additional file is necessary, amend the write set and dependency edges before editing it.

- `packages/services/src/workflow-run-lifecycle.ts`
- `packages/services/src/workflow-run-lifecycle.test.ts`
- `packages/services/src/workflow-run-lifecycle.db.test.ts`
- `packages/services/src/render-group-lifecycle.ts`
- `packages/services/src/render-group-lifecycle.db.test.ts`
- `packages/services/src/layout-evidence.ts`
- `packages/services/src/layout-evidence.test.ts`
- `packages/services/src/index.ts`
- `packages/services/scripts/run-workflow-db-tests.ts`

## Implementation

1. Implement atomic group admission/claim/heartbeat/start/complete/fail/release/reap under 18 contracts. Use DB time and parent generation plus current group token for all child writes.
2. Charge only actual starts and ungraceful interrupted execution once. Retry only the unsettled group members through three attempts/backoff; pre-start spawn and graceful shutdown release without charging.
3. Keep coordinator lifecycle for parent membership/progress/outbox. Coordinator death does not steal live groups; parent settles only after no live or due-retry groups remain.
4. Preserve export aggregate helper from 11, late-variant follow-up admission, supersession and safe ambiguous completion. Background layout claims defer to live render group ownership. Remove parent-token-only child mutation authority as part of the integrated 18–20 change.

## Acceptance

- [x] Two simultaneous claims receive different groups; duplicate claim of the same group has one winner.
- [x] Expired group token and invalidated parent generation cannot mutate children; coordinator reclaim leaves current groups valid.
- [x] One poison/crashing group exhausts only its own budget while healthy siblings finish.
- [x] Mixed success/transient/permanent/superseded members produce correct aggregates and exactly one terminal event/notification.
- [x] Late variants get idempotent follow-up membership and no work remains stranded after reaper recovery.

## Verification

Run from repository root. The command interface below is delivered by ticket 01 where applicable. Run media checks inside the pinned image. Record output/evidence rather than merely listing commands.

```sh
bun test packages/services/src/workflow-run-lifecycle.test.ts
bash .scratch/api-extraction/db-gate.sh bun run test:workflow:db
```

Run the full normal exact golden comparison from spec.md. For an approved defect ticket, also run its declared corrected expectations; preserve all unrelated baseline results.

`bun run lint` and `bun run typecheck` must pass for the assembled change. Capture scoped failures caused by unrelated in-flight work before changing any unowned file.

DB checks, when listed, must use `bash .scratch/api-extraction/db-gate.sh ...`; never run gates against shared Neon. No shared resource mutations or deployments are authorized by this ticket.

## Evidence

Implemented by GPT-6.1-Sol on `dev`, HEAD `e40709a28922ec8223112a6976f46f3bb7737070`, 2026-10-30. Changes are uncommitted and confined to the declared write set. Concurrent ticket 14 files were not edited. No environment, dependency, shared-resource, deployment, or process-termination actions.

Implementation:
- Added `RenderGroupLifecycle` with complete-partition admission, independent atomic claims, DB-clock ownership checks after lock waits, heartbeat, immutable durable starts/fingerprints, guarded variant/evidence persistence, mixed-member settlement, graceful release and expired-execution reaping. Claims cost zero; starts charge once; started crashes retain that charge; shutdown refunds once and defers by the injected drain interval. Three charged starts schedule 30s/60s backoff and exhaust only that group.
- `WorkflowRunLifecycle.admitRenderGroups` freezes and admits membership transactionally under coordinator/project locks. Replays compare historical identities/membership, including after mutable rows disappear. Stable generation survives coordinator recovery. Coordinator claim/release/reaping cannot reset or charge child work. Generic parent completion and parent-token-only child/evidence writes reject a grouped work set.
- Coordinator settlement reconciles explicitly invalidated/deleted/reassigned membership, reports counts/progress, waits for live or expired-running leases and every future/due retry, then commits terminal lineage, export aggregates, one notification/outbox intent and idempotent late-work follow-up admission. Entirely superseded membership emits no notification.
- Every ClipExportVariant mutation uses `syncClipExportAggregates` in its transaction. Durable variant outcomes and `readVariantOutcome`/`readExecution` survive acknowledgement loss. Completion replay checks committed artifact identity without mutating stale ownership. Retry ledgers exclude already settled siblings.
- Added explicit member-invalidation and queued-parent cancellation protocols. Background automatic-layout admission locks relevant parents and defers while valid live group ownership exists; it does not charge its analysis counter during deferral.
- Re-exported ticket 18 contracts and the lifecycle from `index.ts`; added the new PostgreSQL suite to the standard workflow gate.

Verification:
- `bash .scratch/api-extraction/db-gate.sh bun run test:workflow:db`: **199 pass, 0 fail**, 1105 assertions, eight files. Includes 15 new group DB scenarios. Final log `/tmp/ticket19-workflow-db-final.log`. Tests cover concurrent distinct/same-group claims, immutable admission, coordinator reclaim beyond three attempts, stale token/generation/member rejection, poison-group crash isolation, 30s/60s backoff, shutdown/refund replay, mixed export aggregation, actual commit-acknowledgement loss, completion replay after parent terminal state, late follow-up admission, layout deferral, cancellation, lock-wait expiry, and deleted members. All migrations ran only in disposable local schemas, which the gate dropped.
- `bun run --cwd packages/services test`: **1426 pass, 873 skipped opt-in tests, 0 fail**, 151 files; `/tmp/ticket19-services-tests-final.log`.
- `bun test packages/services/src/workflow-run-lifecycle.test.ts packages/services/src/render-group-contract.test.ts packages/services/src/layout-evidence.test.ts`: **43 pass, one opt-in reset DB test skipped, 0 fail**; `/tmp/ticket19-unit.log`. New layout/group behavior is exercised by the full PostgreSQL gate.
- `bun run --cwd packages/services typecheck`: **exit 0** after final behavioral edits; `/tmp/ticket19-typecheck-final.log`.
- `bash .scratch/api-extraction/db-gate.sh bun run typecheck`: **15/15 successful**, exit 0; `/tmp/ticket19-root-typecheck.log`.
- Scoped `bunx biome check` on all six owned source/script paths: **clean**; `/tmp/ticket19-biome-final.log`. Scoped `git diff --check`: clean.
- `bun run lint`: final **exit 0**, 11 existing warnings and one info; `/tmp/ticket19-root-lint-final.log`. Earlier root lint observed ticket 14's in-flight unused `brollPlacements` in its golden-runner edit; that owner resolved it, with no edit from this implementer. Initial DB test fixture errors and outbox fixture cleanup were corrected; the final full gate is green.
- `bun apps/worker/scripts/render-golden.ts verify --baseline /tmp/narriflow-golden/baseline --suite all --out /tmp/narriflow-golden/candidate-19`: **PASS, exit 0**, all **18/18 normal references identical**, **16 corrected references passing**, two existing guards unchanged. Exact plans/crops/cues/layers/argv/graphs/frames/PTS/PCM retain the baseline. Reports `/tmp/narriflow-golden/candidate-19/report.md` and `report.json`; log `/tmp/ticket19-golden.log`. No baseline or expected results changed. The golden run also sees concurrent ticket 14 worker edits.

Migration/environment:
- No migration added. Uses ticket 18's additive `20261029160000_render_group_leases`; its previously documented migration safety is unchanged. Shared Neon remains untouched.
- Inherited ticket 01 host adaptation: macOS arm64, Bun 1.4.2 / FFmpeg 8.0.1, fingerprint `90cf30a30583bbe5`, baseline commit `5680477046`. No Docker/Podman image verification is claimed. Pinned Linux verification remains ticket 21's gate.

Close-out: ticket 19 acceptance and scoped verification pass. Integration/deployment still requires ticket 20; this service-only change does not enable a worker execution mode.

## Comments


Ticket 20 handoff:
- Before child execution, call `WorkflowRunLifecycle.admitRenderGroups(coordinatorAttempt, [{ configuration: { clipId, exportId, editorRevision, resolution, watermark }, variantIds }])` for the complete frozen work set. Callers provide frozen output entitlements; the service validates existing variant/export identity and stores no second render manifest. Reclaim can reuse historical membership, without rereading mutable rendering inputs.
- Use `RenderGroupLifecycle.claim` globally or filtered by parent/group. Render only returned `memberIds`. Use the group ref/token/owner for every render/evidence mutation. `start` follows successful process startup and precedes accepting completion; fingerprints must remain identical on replay. Persist per-member outcomes, then `finish`. Use `release` for pre-start executor rejection or shutdown; inject `releaseGraceMs` from the worker's configured shutdown drain. `readExecution` supports heartbeat-versus-settlement reconciliation, and `readVariantOutcome` supports ambiguous upload completion. An absent outcome is not proof of an unreferenced object.
- Schedule **both** `RenderGroupLifecycle.reapExpired()` and the existing coordinator reaper. Coordinate admission/progress/`settleRenderWorkSet` separately; `status: "pending"` means a group lease or retry still prevents parent settlement. Keep the coordinator heartbeat alive during this wait, or release/reclaim coordination independently. Preserve the settlement-promise barrier before suppressing a late heartbeat loss.
- Remove the old sequential parent encoder and its old parent-only persistence methods/branches in the integrated 18-20 tree. They remain only for the current, pre-20 worker call sites; once group membership is admitted, those methods reject rather than allowing a second writer. This is the required service/worker integration boundary, not a deployment selector or dual-run mode. Drain old workers before deployment.
- Editor supersession can call `invalidateRenderGroupMembersWithinTransaction` before resetting/deleting affected variants in the **same** transaction, in parent/group/member/variant lock order. Existing deletion/reassignment is also detected transactionally during group operations. Preserve unrelated frozen export members. The helper is exported from services; no unowned editor file was changed here.
