# 10 - Preserve uploaded outputs across ambiguous completion

**What to build:** Keep completed or ambiguously committed artifacts safe when analytics or DB acknowledgements fail.

**Blocked by:** [09 - Validate rendered media before upload or success](09-output-validation.md)

**Status:** ready-for-agent

**Suggested implementer:** Sol

**Contract:** [Render hardening spec](../spec.md). Read the relevant contract sections and AGENTS.md before claiming.

## File ownership

Exhaustive write set, relative to repository root. This ticket may also update its own issue file with status and evidence. All other paths are read-only. Shared paths are serialized by blocker ancestry. If an additional file is necessary, amend the write set and dependency edges before editing it.

- `apps/worker/src/tasks/clip-render-attempt.ts`
- `apps/worker/src/tasks/clip-render-attempt-runtime.ts`
- `apps/worker/src/tasks/clip-render-attempt-runtime.test.ts`
- `apps/worker/src/tasks/clip-render-attempt-runtime-flows.test.ts`
- `apps/worker/src/render-object-reconciler.ts`
- `apps/worker/src/render-object-reconciler.test.ts`

## Implementation

1. Make the entire post-commit analytics operation best effort, including its lookup. A telemetry error must not reject a successful completion.
2. Distinguish proven stale rejection from uncertain commit. Delete attempt-unique provisional objects only with proven unreferenced/stale evidence; leave ambiguity to reference-aware reconciliation.
3. Preserve cancellation and original causal failure while bounded cleanup records orphan candidates. Keep current attempt fencing and object-key uniqueness.

## Acceptance

- [ ] DB completion commits then analytics read fails: completion stays successful and delete is never called.
- [ ] Lost DB commit acknowledgement preserves bytes; reconciliation rechecks references and retains committed objects.
- [ ] Proven stale editor/reset or attempt rejection can delete only its own unreferenced key.
- [ ] Cleanup failure does not undo a durable success or replace the original failure; normal parity passes.

## Verification

Run from repository root. The command interface below is delivered by ticket 01 where applicable. Run media checks inside the pinned image. Record output/evidence rather than merely listing commands.

```sh
bun test apps/worker/src/tasks/clip-render-attempt-runtime.test.ts apps/worker/src/tasks/clip-render-attempt-runtime-flows.test.ts apps/worker/src/render-object-reconciler.test.ts
```

Run the full normal exact golden comparison from spec.md. For an approved defect ticket, also run its declared corrected expectations; preserve all unrelated baseline results.

`bun run lint` and `bun run typecheck` must pass for the assembled change. Capture scoped failures caused by unrelated in-flight work before changing any unowned file.

DB checks, when listed, must use `bash .scratch/api-extraction/db-gate.sh ...`; never run gates against shared Neon. No shared resource mutations or deployments are authorized by this ticket.

## Evidence

Pending. Record commit/image hashes, commands, fixture reports and any unresolved acceptance here.

## Comments
