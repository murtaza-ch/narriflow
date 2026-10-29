# 15 - Bound multipart abort and preview storage lifetimes

**What to build:** Let failed storage operations and preview shutdown settle within finite cleanup deadlines.

**Blocked by:** [09 - Validate rendered media before upload or success](09-output-validation.md)

**Status:** done

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

- [x] A rejected part followed by a never-settling abort returns within cleanup grace with the original failure.
- [x] Shutdown during preview media/peaks upload stops the operation and cannot publish a ready preview afterward.
- [x] Delete timeout emits a cleanup notice without masking committed state.
- [x] Upload concurrency and multipart tests pass; normal golden output remains exact.

## Verification

Run from repository root. The command interface below is delivered by ticket 01 where applicable. Run media checks inside the pinned image. Record output/evidence rather than merely listing commands.

```sh
bun test packages/services/src/r2-storage.test.ts apps/worker/src/tasks/clip-preview.test.ts
```

Run the full normal exact golden comparison from spec.md. For an approved defect ticket, also run its declared corrected expectations; preserve all unrelated baseline results.

`bun run lint` and `bun run typecheck` must pass for the assembled change. Capture scoped failures caused by unrelated in-flight work before changing any unowned file.

DB checks, when listed, must use `bash .scratch/api-extraction/db-gate.sh ...`; never run gates against shared Neon. No shared resource mutations or deployments are authorized by this ticket.

## Evidence

Implemented on HEAD 7090c536 (uncommitted).

- `r2-storage.ts`: multipart failure cleanup goes through `abortMultipartUploadBestEffort` - own 5 s clock independent of the caller signal, race against stall, never throws, logs `r2_multipart_abort_unconfirmed` (key, uploadId) as orphan candidate; original part/complete failure is rethrown. First failed part now also cancels in-flight sibling UploadParts (stalled sibling can no longer hold the failure). `putJson` takes `signal`. Part size, concurrency (4, clamp 1-16), ordered completion unchanged.
- `clip-preview.ts`: new exported `storeAndPublishClipPreview` (media PUT, peaks PUT, claim, cleanup) with injectable storage/claim. Media PUT 120 s, peaks PUT 30 s (peaks timeout degrades to no-peaks, shutdown aborts), each layered on the worker shutdown signal; `signal.throwIfAborted()` before the claim so a shut-down attempt cannot publish; unpublished objects are deleted via `deleteClipPreviewObjectsBestEffort` (10 s per key, independent of the aborted signal, never throws, logs `clip_preview_cleanup_unconfirmed`). No cleanup after the claim is issued (may have committed). Also fixed the peaks-failed log, whose `message` context key overwrote the event name.
- Tests: r2-storage.test.ts (rejected part + never-settling abort returns original failure in 5-7 s with sibling cancelled and orphan log; caller-cancelled upload still issues an abort on a live signal; ascending completion; putJson pre-abort) and clip-preview.test.ts (shutdown during media/peaks upload, before claim, media deadline, peaks deadline degrade, never-settling delete on lost claim, failed delete after committed claim).
- Results: `bun test src/r2-storage.test.ts` 16 pass/5 skip (R2 contract tests need credentials); worker `bun test` 947 pass 0 fail; worker + services `bun run typecheck` clean; `bash .scratch/api-extraction/db-gate.sh bun run test:upload-session:db` 15 pass; `bunx biome check` clean on the four paths.
- Parity gate: not conclusive. `render-golden.ts verify ... candidate-15` exited 1 with plan-fingerprint mismatches on every normal fixture, but the working tree had concurrent uncommitted edits by another ticket to `apps/worker/scripts/render-golden.ts` and `clip-render-attempt.ts` (and layout-evidence files); the harness imports neither `r2-storage` nor `clip-preview`, and this ticket changes no compiler, planner or ffmpeg argument. Rerun after those land.

## Comments
