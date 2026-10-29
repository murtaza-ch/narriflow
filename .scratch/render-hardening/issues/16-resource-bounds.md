# 16 - Bound render backlog, scratch, cache and task deadlines

**What to build:** Keep slow storage and interrupted work from exhausting disk or holding leases indefinitely.

**Blocked by:** [14 - Narrow fallbacks and file-back oversized graphs](14-error-aware-fallback.md), [15 - Bound multipart abort and preview storage lifetimes](15-bounded-storage-cleanup.md)

**Status:** ready-for-agent

**Suggested implementer:** Claude

**Contract:** [Render hardening spec](../spec.md). Read the relevant contract sections and AGENTS.md before claiming.

## File ownership

Exhaustive write set, relative to repository root. This ticket may also update its own issue file with status and evidence. All other paths are read-only. Shared paths are serialized by blocker ancestry. If an additional file is necessary, amend the write set and dependency edges before editing it.

- `apps/worker/src/tasks/clip-render-attempt.ts`
- `apps/worker/src/render-config.ts`
- `apps/worker/src/render-config.test.ts`
- `apps/worker/src/worker-process.ts`
- `apps/worker/src/tasks/broll.ts`
- `apps/worker/src/render-resource-budget.ts`
- `apps/worker/src/render-resource-budget.test.ts`
- `apps/worker/src/tasks/broll-cache.test.ts`

## Implementation

1. Implement validated deadlines, download size/no-progress limits, waiting jobs/bytes, scratch/cache byte and free-space thresholds from the spec. Retain one full encode and existing encoder/thread args.
2. Apply queue backpressure before producing more outputs, unlink committed outputs promptly, reference-count group assets through upload drain and release blocked producers on cancellation.
3. Use Worker Process Module ownership metadata for scratch. Sweep only abandoned paths after DB/local ownership checks; bound b-roll cache by TTL and bytes and remove failed temp writes.
4. Expose resource/sweep operations to startup/maintenance integration in 17; do not edit index.ts here.

## Acceptance

- [ ] Artificially slow uploads keep waiting jobs/bytes and scratch within configured reservations while preserving overlap.
- [ ] Committed files are unlinked before whole-run completion; files still needed by active uploads remain.
- [ ] Disk-low and oversized fallback source are rejected before download; no files from another live worker are swept.
- [ ] Deadline math is finite at minimum/maximum durations and sizes; timeout cleans children/storage before releasing resources.
- [ ] Normal golden commands/frames/PCM remain exact.

## Verification

Run from repository root. The command interface below is delivered by ticket 01 where applicable. Run media checks inside the pinned image. Record output/evidence rather than merely listing commands.

```sh
bun test apps/worker/src/render-resource-budget.test.ts apps/worker/src/render-config.test.ts apps/worker/src/tasks/broll-cache.test.ts apps/worker/src/worker-process.test.ts
```

Run the full normal exact golden comparison from spec.md. For an approved defect ticket, also run its declared corrected expectations; preserve all unrelated baseline results.

`bun run lint` and `bun run typecheck` must pass for the assembled change. Capture scoped failures caused by unrelated in-flight work before changing any unowned file.

DB checks, when listed, must use `bash .scratch/api-extraction/db-gate.sh ...`; never run gates against shared Neon. No shared resource mutations or deployments are authorized by this ticket.

## Evidence

Pending. Record commit/image hashes, commands, fixture reports and any unresolved acceptance here.

## Comments
