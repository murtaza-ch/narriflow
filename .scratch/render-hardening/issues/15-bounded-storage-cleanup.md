# 15 - Bound multipart abort and preview storage lifetimes

**What to build:** Let failed storage operations and preview shutdown settle within finite cleanup deadlines.

**Blocked by:** [09 - Validate rendered media before upload or success](09-output-validation.md)

**Status:** ready-for-agent

**Suggested implementer:** Claude

**Contract:** [Render hardening spec](../spec.md). Read the relevant contract sections and AGENTS.md before claiming.

## File ownership

Exhaustive write set, relative to repository root. This ticket may also update its own issue file with status and evidence. All other paths are read-only. Shared paths are serialized by blocker ancestry. If an additional file is necessary, amend the write set and dependency edges before editing it.

- `packages/services/src/r2-storage.ts`
- `packages/services/src/r2-storage.test.ts`
- `apps/worker/src/tasks/clip-preview.ts`
- `apps/worker/src/tasks/clip-preview.test.ts`

## Implementation

1. Give AbortMultipartUpload an independent five-second cleanup deadline after caller cancellation. Preserve the original part/complete failure and report orphan candidates when abort stalls.
2. Pass worker shutdown and operation deadlines through preview media PUT, peaks PUT and DELETE. Watchdog abandonment must actually cancel outstanding storage work.
3. Preserve ordered multipart completion, bounded part buffers and current overlap. Do not change storage thresholds as incidental tuning.

## Acceptance

- [ ] A rejected part followed by a never-settling abort returns within cleanup grace with the original failure.
- [ ] Shutdown during preview media/peaks upload stops the operation and cannot publish a ready preview afterward.
- [ ] Delete timeout emits a cleanup notice without masking committed state.
- [ ] Upload concurrency and multipart tests pass; normal golden output remains exact.

## Verification

Run from repository root. The command interface below is delivered by ticket 01 where applicable. Run media checks inside the pinned image. Record output/evidence rather than merely listing commands.

```sh
bun test packages/services/src/r2-storage.test.ts apps/worker/src/tasks/clip-preview.test.ts
```

Run the full normal exact golden comparison from spec.md. For an approved defect ticket, also run its declared corrected expectations; preserve all unrelated baseline results.

`bun run lint` and `bun run typecheck` must pass for the assembled change. Capture scoped failures caused by unrelated in-flight work before changing any unowned file.

DB checks, when listed, must use `bash .scratch/api-extraction/db-gate.sh ...`; never run gates against shared Neon. No shared resource mutations or deployments are authorized by this ticket.

## Evidence

Pending. Record commit/image hashes, commands, fixture reports and any unresolved acceptance here.

## Comments
