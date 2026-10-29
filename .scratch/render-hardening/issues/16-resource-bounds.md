# 16 - Bound render backlog, scratch, cache and task deadlines

**What to build:** Keep slow storage and interrupted work from exhausting disk or holding leases indefinitely.

**Blocked by:** [14 - Narrow fallbacks and file-back oversized graphs](14-error-aware-fallback.md), [15 - Bound multipart abort and preview storage lifetimes](15-bounded-storage-cleanup.md)

**Status:** done

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
- `apps/worker/src/worker-process.test.ts` (amended: scratch ownership/sweep tests)
- `apps/worker/src/tasks/clip-render-attempt.test.ts` (amended: the upload-queue tracers supply a statfs stub, because output admission now reads disk facts)
- `apps/worker/src/tasks/clip-render-attempt-core-paths.test.ts` (amended: the disk-pressure expectation becomes a deferral; new backpressure/cleanup tests)
- `apps/worker/scripts/render-golden.ts` (amended only if the parity gate requires a derivation extraction; read-only otherwise)

## Implementation

1. Implement validated deadlines, download size/no-progress limits, waiting jobs/bytes, scratch/cache byte and free-space thresholds from the spec. Retain one full encode and existing encoder/thread args.
2. Apply queue backpressure before producing more outputs, unlink committed outputs promptly, reference-count group assets through upload drain and release blocked producers on cancellation.
3. Use Worker Process Module ownership metadata for scratch. Sweep only abandoned paths after DB/local ownership checks; bound b-roll cache by TTL and bytes and remove failed temp writes.
4. Expose resource/sweep operations to startup/maintenance integration in 17; do not edit index.ts here.

## Acceptance

- [x] Artificially slow uploads keep waiting jobs/bytes and scratch within configured reservations while preserving overlap.
- [x] Committed files are unlinked before whole-run completion; files still needed by active uploads remain.
- [x] Disk-low and oversized fallback source are rejected before download; no files from another live worker are swept.
- [x] Deadline math is finite at minimum/maximum durations and sizes; timeout cleans children/storage before releasing resources.
- [x] Normal golden commands/frames/PCM remain exact.

## Verification

Run from repository root. The command interface below is delivered by ticket 01 where applicable. Run media checks inside the pinned image. Record output/evidence rather than merely listing commands.

```sh
bun test apps/worker/src/render-resource-budget.test.ts apps/worker/src/render-config.test.ts apps/worker/src/tasks/broll-cache.test.ts apps/worker/src/worker-process.test.ts
```

Run the full normal exact golden comparison from spec.md. For an approved defect ticket, also run its declared corrected expectations; preserve all unrelated baseline results.

`bun run lint` and `bun run typecheck` must pass for the assembled change. Capture scoped failures caused by unrelated in-flight work before changing any unowned file.

DB checks, when listed, must use `bash .scratch/api-extraction/db-gate.sh ...`; never run gates against shared Neon. No shared resource mutations or deployments are authorized by this ticket.

## Evidence

Host: macOS arm64, Bun 1.4.2 / FFmpeg 8.0.1 (ticket-01 adaptation); uncommitted on `dev` at c8456dc6.

What shipped
- `render-config.ts`: validated, frozen limits (effective values logged in `clip_rendering_run_started.resourcePolicy`): encode floor 300s / factor 20 / ceiling = existing 1800s; transfer floor 120s, ceiling 1800s, 1 MiB/s, 30s no-progress; upload backlog 2 jobs / 512 MiB; free-disk floor max(1 GiB, 10%); scratch bound min(8 GiB, 50%); admission wait 5 min; b-roll cache 1 GiB; sweep grace/interval.
- `render-resource-budget.ts` (new): `renderEncodeDeadlineMs` (factor x edited duration x resolution weight 1..4 x HDR weight 3, clamped; non-finite -> ceiling), `transferDeadlineMs`, `RenderResourceBudget` (process-wide per frozen config: waits for backlog room, then free disk with 1s..15s backoff, defers with typed `RenderResourceDeferral` after the wait, rejects a request that can never fit, wakes blocked producers on cancel, `trackEncode`, `snapshot`), `ScratchFileRefs`, `startTransferWatchdog`.
- `clip-render-attempt.ts`: per-output encode deadline from the plan duration, source resolution and HDR (also applied to caption retry and limiter re-encode); full-source fallback reserves its bytes (replaces ticket 14's inline statfs) and downloads under the size deadline plus no-progress watchdog; every output reserves before encoding and is released/unlinked when its upload settles (file and reservation) or when its encode fails; uploads use a size-derived deadline instead of the flat 2 min; downloaded B-roll files are referenced and removed after the group's encodes; run-level `finally` returns all reservations; `RenderResourceDeferral` escapes like executor-scope failures (no variant is failed, the attempt is released) .
- `worker-process.ts`: scratch directories get an owner marker (host, instance, pid, `{workflowRunId, attemptId}`), refreshed every 30s; `process.on("exit")` removes any still-live directory; `sweepAbandonedScratch` removes only marked, same-host, non-active, stale (max lease + grace) directories with no unexpired DB claim (`isOwnerActive` injected), and never this process's live dirs.
- `broll.ts`: `pruneBrollAssetCache` (TTL, byte bound oldest-first, dead-writer temp files), save skips assets over the bound, failed writes remove their temp file; `brollAssetCachePath`.

Verification
- `bun test` in `apps/worker`: 1091 pass, 0 fail (`/tmp/ticket16-worker-tests2.log`); new: 41 in render-resource-budget/config, 8 broll-cache, 5 worker-process sweep tests, 4 attempt-level resource tests (slow uploads stop the next encode at the waiting limit and resume; committed file unlinked while another upload holds its own; cancel wakes the blocked producer and returns reservations; timeout returns its reservation) plus disk deferral and oversized-source rejection.
- `bun run typecheck` (root): 15/15. `bunx biome check` on all owned paths: clean.
- Parity gate `bun apps/worker/scripts/render-golden.ts verify --baseline /tmp/narriflow-golden/baseline --suite all --out /tmp/narriflow-golden/candidate-16`: exit 0 (`/tmp/narriflow-golden/verify-16.log`). No compiler input or argv changed, so no derivation extraction was needed.
- No DB gate (no service/DB change). No shared resources touched.

## Comments

- Deferral semantics: after the admission wait the attempt throws `RenderResourceDeferral` (retryable `render_scratch_disk_low` / `render_scratch_limit_reached`) before any media work; no clip is failed. Today the workflow charges that claim; refunding an unstarted claim is ticket 17/20 (group `release`).
- For ticket 17: wire `sweepAbandonedScratch({graceMs: config.scratchSweepGraceMs, isOwnerActive})` at startup and every `scratchSweepIntervalMs`, `pruneBrollAssetCache({maxBytes: config.brollCacheMaxBytes, ttlMs: config.brollAssetCacheTtlMs})` alongside, and read `renderResourceBudgetFor(config).snapshot()` (`encoding`, free-reservation, waiting/active uploads) for readiness and for deferring preview/auto-layout/thumbnail starts during the one full encode. No `index.ts` edit here.
- Group assets: in the current sequential parent the only group-owned downloads are B-roll files; they are reference-counted and removed after the group's encodes. True per-group scratch arrives with ticket 20.
- Not done here (not in write set): `downloadUrlToFile` size/no-progress limits for optional assets (already has `maxBytes`), CPU/cgroup headroom reservation, and the Linux image run (ticket 21).
- Write set amended: worker-process.test.ts, clip-render-attempt-core-paths.test.ts, clip-render-attempt.test.ts (stubs statfs in two upload-queue tracers; admission now reads disk facts).
