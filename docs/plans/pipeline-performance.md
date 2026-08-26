# Pipeline performance: diagnosis + prioritized plan

Investigated 2026-07-29 on branch `murtaza/assembly-ai`. Reviewed adversarially by
Opus (deep code verification, all file:line claims checked) and Codex gpt-5.6-sol
(independent read-only review). Both reviews converged on the ordering below.

## Implementation status (2026-07-29)

Implemented on this branch: Gate 0 (per-stage timing telemetry), Tier 1 (both
correctness fixes + `20260729000000_one_live_clip_rendering_run` migration —
apply before deploy), Tier 2 items 3-6 (`--concurrent-fragments`, parallel
multipart parts, ranged source reads via `WORKER_RENDER_SOURCE_MODE`,
detection `max_output_tokens` + heartbeat), Tier 3 items 7-8 (STT
submit-and-release with a dedicated result-poll loop + lease; per-stage poll
loops in `apps/worker/src/index.ts`). New envs documented in
`apps/worker/.env.example`. Not implemented: Tier 3 item 9 (clip-group render
claiming for replicas), Tier 4 experiments.

Post-implementation Opus + Codex reviews found and led to these fixes (all
applied): all-failed render attempts now reset variants only on actual requeue
(service-side, so the terminal attempt leaves accurate `failed` states);
ffmpeg/ffprobe children have wall-clock timeouts + SIGKILL escalation (a quiet
HTTP stall can no longer wedge the render loop forever); presigned-URL query
strings are redacted from error messages/logs; the STT overall timeout is
checked before the provider GET (persistent poll failures are bounded);
transcript finalization is fenced by expected provider job id, creates the
detection run before completing the stt run (crash-safe), and completes
conditionally on still-running; clip-render completion is conditional the same
way; the reaper runs on its own maintenance loop (a multi-hour ingest no
longer starves it); a requeue that hits the one-live-run index settles as
`superseded_duplicate_run` instead of wedging the reaper; variants queued
while a run was mid-render get a follow-up run at completion; partial variant
failure records `partial_render_failure` on the completed run.

Accepted risks (explicitly deferred, revisit with Tier 3 item 9):
- A reaped-but-still-alive worker holds no fencing token; stale completions
  are blocked, but duplicate encode work (and racing PUTs to the same render
  keys) remains possible when a heartbeat gap exceeds the 30-min stall
  timeout. True fix = per-clip-group leases.
- Two live stt runs (force-regenerate race) can still double-submit to
  AssemblyAI; the finalize fence prevents data corruption but the orphaned
  provider job is paid for. Full fix = stt partial unique index or run-scoped
  provider job ids.
- No global CPU/memory ceiling across the now-9 independent loops (up to ~5
  concurrent media processes + R2_MULTIPART_CONCURRENCY×16MB per upload) —
  size worker machines accordingly, or lower the concurrency envs.
- DB-race paths (claims, leases, finalize fencing) have no direct test
  coverage; builder arg-ordering for https sources now does.

Deploy notes: apply the migration with workers stopped/drained (see the
migration header comment); `prisma migrate deploy` must run before this
worker/service code ships.

## Where the time goes

For a locally-tested 10-min 1080p YouTube import (~6 clips × up to 3 ratios):

| Stage | Cost | Bound by |
|---|---|---|
| yt-dlp download (1080p-capped) | 1–5 min | network (no `--concurrent-fragments`) |
| Upload full source to R2 | 1–10 min locally | residential uplink; sequential 16 MB multipart parts |
| AssemblyAI STT (presigned R2 URL, 5s poll) | ~1–3 min | provider (already near-optimal) |
| Moment detection (1 OpenAI call, medium reasoning) | ~15–20s | provider |
| Render: re-download full source from R2 | 1–5 min locally | downlink (ingest deleted the local copy) |
| Render: serial software x264 encodes | 2–8 min | CPU (x264 already saturates all cores) |
| Orchestration dead time (2.5s polls) | ~4–8s | negligible |

Locally the dominant cost is the **source's triple network trip**
(YouTube → local, local → R2, R2 → local again for render) plus **serial encodes**.
For a 2h podcast this scales to plausibly 1.5–3h wall clock; additionally one
worker's IO loop holds its mutex through the entire AssemblyAI poll
(`apps/worker/src/tasks/transcribe.ts:578-606`), so a podcast's STT blocks every
other project's ingest/detection/dubbing on that worker for 10–40 min.

Key verified facts:

- Clip render loop is fully sequential. Every aspect-ratio target is compiled
  from its Clip Composition Plan into an independent full decode+encode, whether
  or not it contains B-roll. Multi-target renders no longer share a source decode.
- Measured in-repo benchmark (`apps/worker/src/index.ts:21-30`): 4 parallel clip
  encodes ≈ sequential (40.49s vs 39.50s) — x264 saturates cores, so naive
  `Promise.all` around ffmpeg buys nothing *for the encode phase*. It does not
  cover the I/O phases (uploads, B-roll fetch), which do benefit from overlap.
- No hardware acceleration anywhere; `WORKER_X264_PRESET`/`WORKER_X264_CRF` are
  already env-tunable with a documented quality baseline (veryfast/21).
- R2 multipart parts upload sequentially (`packages/services/src/r2-storage.ts:335-364`)
  — a 2 GB source is 128 serial 16 MB round trips; this throttles ingest too.
- detect-clips chunker splits only above ~320k chars (`detect-clips.ts:291-293`);
  a 2–3h podcast is still **one chunk** (~255k chars worst case), so parallelizing
  chunks is dead weight for that target; the real risk is one giant call with no
  `max_output_tokens` (truncation → `clip_detection_parse_error` fails the run)
  and no heartbeat between the 20% and 80% progress marks.
- clip-preview already proves the ranged-read pattern: presigned URL + `-ss`
  before `-i` range-requests only the needed window
  (`apps/worker/src/tasks/clip-preview.ts:1055-1070`, "11.72s wall for a 38s cut
  off a 531 MB 4K source"). render-clips downloads the whole object instead.

## Correctness bugs found in passing (exist today, worse under any scaling)

1. **Orphaned `rendering` variants are never retried.**
   `markClipRenderVariantRendering` flips status before the encode and nothing
   ever resets it; retries select only `pending` variants
   (`packages/services/src/clip.service.ts:715-744`, `render-clips.ts:2298`).
   A mid-render crash leaves variants stuck in `rendering` forever, the UI shows
   render active forever (`apps/web/lib/project-state.ts:370-382`), and a
   requeued run can die with `no_renderable_clips`. `ClipRender` has no
   lease/attempt fields (`schema.prisma:660-678`).
2. **Duplicate concurrent render runs are possible.**
   `getPendingClipRendersForProject` is project-scoped, not run-scoped; the two
   queueing paths use non-transactional find-then-create with *different*
   idempotency keys (`clip.service.ts:663-671`, `:1353-1362`), so two live
   `clip_rendering` runs + two workers would double-render and race PUTs to the
   same deterministic R2 keys. Masked today by the single render slot per process.

## Plan (converged priority order)

### Gate 0 — measure first (~1 day)
Structured per-stage/substage timings (durations, bytes, throughput, encoder,
clip/variant counts, B-roll cache hits) + fixed 10-min and 2h benchmark fixtures.
`.env.example` already claims "encoding is ~73% of render wall-clock", which
contradicts the local-network mental model — telemetry decides what's real in
prod vs. a dev-environment artifact, and gates everything below.

### Tier 1 — correctness before parallelism
1. `ClipRender` lease (`leaseExpiresAt`/`attemptCount`) + reaper; reset orphaned
   `rendering` variants on run requeue. Aggregate run completion must reflect
   variant failures.
2. Run-scope pending-render selection + partial unique index preventing two live
   `clip_rendering` runs per project.

### Tier 2 — high-value, low-risk latency
3. `yt-dlp --concurrent-fragments N` (cheapest single change; 2–4× the download leg).
4. Parallel multipart part uploads inside `putFileFromPath` (bounded; helps both
   ingest upload and render output upload; keep part ordering + memory bound).
5. Ranged source reads for render: presigned URL + `-ss` before `-i`, reusing the
   clip-preview pattern (incl. `-reconnect*` flags). For a 2h source, 6–10 clips
   read ~5–8% of the bytes instead of 100%. Beats a local source cache in every
   deployment; keep an opt-in `WORKER_SOURCE_CACHE_DIR` (size-capped, default off)
   only for dev ergonomics. `detectFacePath` needs a small local segment per clip.
6. Detection hardening: `max_output_tokens` on the OpenAI call + in-flight
   heartbeat during the (up to 5-min) request.

### Tier 3 — throughput / scalability
7. **STT submit-and-release**: AssemblyAI `webhook_url` (or a cheap dedicated
   poll loop over submitted transcripts; `Transcript.providerJobId` already
   exists). Removes 10–40 min of IO-mutex occupancy per podcast — the single
   biggest multi-project throughput win.
8. Split the IO loop per stage (own mutex/interval each, as render/preview
   already are) — meaningful only after 7.
9. Variant-level render claiming for replicas: claim at **clip-group granularity**
   (one clip + all its ratios, preserving shared decode/B-roll/face-tracking),
   keep exactly ONE parent `clip_rendering` WorkflowRun as aggregate
   heartbeat/progress/notification owner; last finisher completes it. Per-clip
   WorkflowRuns are ruled out — they break `activeRun` aggregation
   (`project.service.ts:1512`), the processing-panel exit condition, the
   notification ledger uniqueness, and `triggerGeneration`'s single-run
   assumption. Requires Tier 1 shipped first.
10. Replica deployment guidance + per-stage concurrency envs (document
    `RENDER_POLL_INTERVAL_MS`/`PREVIEW_POLL_INTERVAL_MS` in `.env.example` too).

### Tier 4 — bounded experiments
11. `WORKER_X264_PRESET=superfast` A/B against the documented veryfast/21
    baseline before any hardware-encoder work.
12. Hardware encode as tested per-encoder *profiles* (VideoToolbox is macOS-only —
    dev machines, not the Debian worker container; `-crf` doesn't transfer; the
    free-tier watermark path is probe-verified so pix_fmt drift fails hard).
    Opt-in everywhere; capability probe + software fallback.
13. B-roll slot parallelism within a clip (concurrency 2–3, per-query dedup,
    Pexels 200/hr budget respected).
14. Overlapping output uploads with subsequent encodes — last: `putFileFromPath`
    opens files lazily, so uploads MUST be joined before run completion *and*
    before the `finally` tempDir rm on both success and failure paths; largely
    superseded by item 4.

### Dropped / deferred (with reasons)
- Parallel detect-clips chunk calls: chunker almost never yields >1 chunk for
  1–3h sources. Revisit only if chunking switches to duration-based.
- Event-driven stage handoff: saves ~4–8s total; the naive "call the poll fn on
  completion" doesn't even work (the IO mutex is still held at completion time).
- Ingest/STT pipelining as originally sketched: bypasses the quota/upload-length
  gate (provider spend before `assertProjectGenerationAllowed`), risks
  wrong-language transcripts (language set after ingest in link-first flow), and
  disables `triggerGenerationIfPending`. Safe variant if telemetry justifies it:
  extract the mono audio while the file is local, upload that small object first,
  and submit STT against it after the existing gate.
- Persistent python reframe daemon: decode, not interpreter startup, likely
  dominates — measure first.
