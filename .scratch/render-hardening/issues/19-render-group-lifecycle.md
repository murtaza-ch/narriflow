# 19 - Implement fenced group claiming and parent settlement

**What to build:** Allow independent replicas to claim groups safely while parent settlement remains truthful and transactional.

**Blocked by:** [18 - Define durable render groups and ownership contracts](18-render-group-model.md), [13 - Reuse compatible layout and immutable media facts](13-reuse-render-facts.md)

**Status:** ready-for-agent

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

- [ ] Two simultaneous claims receive different groups; duplicate claim of the same group has one winner.
- [ ] Expired group token and invalidated parent generation cannot mutate children; coordinator reclaim leaves current groups valid.
- [ ] One poison/crashing group exhausts only its own budget while healthy siblings finish.
- [ ] Mixed success/transient/permanent/superseded members produce correct aggregates and exactly one terminal event/notification.
- [ ] Late variants get idempotent follow-up membership and no work remains stranded after reaper recovery.

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

Pending. Record commit/image hashes, commands, fixture reports and any unresolved acceptance here.

## Comments
