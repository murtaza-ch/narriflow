# Render pipeline hardening

Status: proposed implementation contract, 2026-10-29. All implementation tickets are unclaimed. This document incorporates the owner's final decisions; it does not request those decisions again.

## Purpose and boundaries

Deliver the requested clip, preserve completed outputs, retry recoverable failures, and bound the resources needed to do so. Improve throughput by removing repeated analysis and sharing work across replicas. A corrupt input or an unavailable required glyph can still fail permanently. Every requested variant must reach a truthful outcome without getting stranded or reporting an invalid artifact as ready.

The reviewed checkout is `dev` at `d4957e8ae96f0c5ab6cc844011d6488e31cbbd8f`. Read [AGENTS.md](../../AGENTS.md), [the audit brief](../api-extraction/render-audit-brief.md), [Sol's audit](../api-extraction/render-audit-sol.md), [Claude's audit](../api-extraction/render-audit-claude.md), and [the browser run](../api-extraction/browser-verification-youtube.md). These are evidence, not alternative specifications. The contract below resolves their disagreements.

Retain ranged source reads, multipart concurrency, upload/encode overlap, the shared composition plan, attempt-unique storage keys, and typed optional-media degradation. One replica runs one full-quality encode at a time. Scaling uses one parent Workflow Run with child render-group leases. A render group is a partition of the fixed Render Work Set containing one clip and one frozen export configuration, including its aspect variants. It is not a synonym for Render Work Set and is not another Workflow Run.

Keep `deriveCaptionCues` and `CAPTION_POSITION_Y_DEFAULTS` as the sole cue policy, and `drawtextLiteralText` as the literal drawtext serializer. Preserve `syncClipExportAggregates` after every ClipExportVariant mutation, inside its transaction. Do not repeat the existing DB connection timeout or poll-watchdog fixes. Do not add compatibility renderers, dual writers, or a second caption model.

## Accepted owner decisions

1. Correct demonstrated rotation/crop, SAR, short/late audio, VFR clock, HDR color, and clipping defects. Normal inputs retain identical output. Each defect has a narrow activation predicate and its own corrected reference; it does not license a global visual or audio retune.
2. Burn the composition plan's emoji into exports with the same cue timing and placement as Studio. Define a deterministic fallback chain. Missing glyphs must cause a visible notice and a typed failure when still unresolved, including when FFmpeg exits zero.
3. Retry transient failures with existing backoff through the attempt limit despite successful siblings. Amend ADR 0003. Completed and permanent-failure members stay settled; re-encode only unsettled members.
4. Retry transient layout/speaker analysis first. Use an explicitly flagged center crop only after that analysis retry budget is exhausted. Never store a transient infrastructure failure as durable analysis. Valid content outcomes such as no trustworthy faces may be stored.

No owner decision remains necessary for these four items. Changing the YouTube source format preference, baked export speed, delivery LUFS, CRF, scaler, GPU deployment, or a new codec/profile/GOP contract is outside this effort.

## Evidence and priority

The original reference run `6e49595d-33f7-464c-8242-a7ea17ee75ee` settled 3/10 success after three claims. The browser run recovered all ten only after manual retries. Duplicate local `bun --watch` workers and reloads caused the local process-start incident; the class includes synchronous/asynchronous `posix_spawn` failures, `EBADF`, `EMFILE`, `ENFILE`, and helper startup failures. The fix must also work for a sick Railway executor.

The audits' 21 completed / 6 failed surviving ClipRender rows describe mutable row state at a particular time, not an all-attempt failure rate. The original settlement, later rescue, and eventual browser recovery are different snapshots. Railway's sampled zero failures does not establish a zero production failure rate. Preserve those denominators in any comparison.

Sol measured completed-row wall time p50 27.020s / p95 92.648s, and eight logged successful encodes p50 16.196s with uploads p50 8.136s. Claude's separate ten-clip Railway run took 211s, including 8–12.5s of layout work per clip. Its estimated 30–45% opportunity from avoiding duplicated analysis is plausible, not an achieved gain. Cgroup peaks of 2.0–3.9 GiB include the worker, concurrent children and page cache. They are not per-FFmpeg RSS or proof of a leak. No fresh DB queries, renders or environment changes were made for this design.

## Golden parity contract

Ticket 01 blocks every output-touching ticket, including inspection changes, image changes, scheduling, evidence reuse, and child-group execution. It also establishes the environment fingerprint before comparisons. Capture the current deployed Linux toolchain, pin those artifacts, then capture the baseline. A dependency upgrade must not be smuggled into the initial pin. If the deployed artifact cannot be recovered, record that gap and compare a frozen current image before choosing a replacement.

The DB-free runner is `apps/worker/scripts/render-golden.ts`. Run it inside the pinned worker image, with frozen editor documents, source objects, layout evidence, font files, and optional assets. The manifest contains SHA-256 for every input and records image digest, Bun, FFmpeg/ffprobe build configuration, libass, fontconfig, OpenCV/numpy wheels and model hash. No live Pexels queries, expiring URLs in expected results, random detector inputs, or mutable object keys. Cached fixtures may be downloaded from a dedicated read-only R2 `golden/` prefix and checked by hash. Never use shared development clips as mutable fixtures.

Use at least these normal references, combining cases where useful: solo auto layout; two-up/speaker; screen/PiP; explicit split; RTL/Arabic shaping; CJK and dense 100+ caption cues; logo plus b-roll/music/SFX/censor; cut timeline plus inserted image/video/text scenes; exact source-end clip; 720p watermark and 1080p treatments across 9:16/1:1/16:9; image background; audio-only audiogram, mono 44.1k and silent video; 24000/1001 and 30000/1001 clocks. Include the requested speed-change reference as a Studio playback-rate change that leaves the serialized document and export unchanged. There is no baked speed model to implement.

Separate defect references capture current broken behavior without blessing it: real display matrices at 90/180/270 degrees and mirror transforms; SAR 2:1 and odd dimensions; early/late/short/gapped audio with cuts, inserted scenes and music; actual VFR plus a 90000/1 base and 15/1 average probe; PQ and HLG with SDR overlays; hot music/SFX/scene audio; emoji including family, flags, skin tone and ZWJ sequences; missing required glyph; no-stream MP4 and interrupted HTTP read. Ticket-specific expected files activate corrected assertions without rewriting unrelated baselines. Initial known-defect recordings must be explicit expected failures, never silently skipped normal cases.

For every reference record the canonical composition plan, crop rectangles and tracked paths, cue text/times/positions/styles, layers, asset/evidence fingerprints, compiler argv and filtergraph bytes, decoded frame hashes and timestamps, decoded audio PCM hashes, ffprobe JSON, size, full decode result, loudness, true peak, and snapshots at cue midpoints and scene boundaries. Sources and media artifacts can live outside Git by content hash; commit the manifest and small expected results.

There are three comparison classes:

| Class | Required gate |
| --- | --- |
| Reliability, refactoring, caching, scheduling, storage, validation | Exact plan/crop/cue/layer equality, identical FFmpeg argv, identical decoded video frames/PTS and audio PCM. Canonicalize only attempt-local paths and refreshed access URLs by immutable asset identity. Preserve graph bytes. Changes to argv transport for an oversized graph may expand its script back to the exact original graph for comparison; ordinary graphs keep their actual argv unchanged. |
| Approved defect correction | The entire unaffected normal set passes the exact gate above. Only fixtures satisfying the named defect predicate may differ. Their corrected results must meet the specific semantic assertions below and retain unrelated plan/cue/layer fields. Record reviewed before/after snapshots and audio checks. Do not use SSIM to excuse an unintended framing change. |
| Separately authorized encoder experiment | Exact composition, crop/cue/layer decisions and timing, matching codec/profile/pixel format/resolution/SAR/color/audio contract, video duration within one frame, minimum per-frame SSIM >= 0.99, integrated loudness difference <= 0.5 LU. Silence uses PCM equality instead of an undefined LUFS value. Also inspect true peak, file size and decode. These thresholds are only for encoder changes. |

Do not compare container byte hashes as the only test. Mux metadata can vary. No ticket may refresh the normal baseline to make a failure pass. Produce a report naming mismatched plans, args, frames and audio. New source defects get their own narrow assertion rather than weakening the exact gate.

Planned CLI, provided by 01, from repository root:

```sh
docker build -f apps/worker/Dockerfile -t narriflow-render-golden .
docker run --rm -v "$PWD:/repo:ro" -v /tmp/narriflow-golden:/golden narriflow-render-golden bun /app/apps/worker/scripts/render-golden.ts capture --suite all --out /golden/baseline
docker run --rm -v "$PWD:/repo:ro" -v /tmp/narriflow-golden:/golden narriflow-render-golden bun /app/apps/worker/scripts/render-golden.ts verify --baseline /golden/baseline --suite all --out /golden/candidate
```

Build the candidate image after edits and retain the captured baseline outside the image. Fixture assets must be staged in `/tmp/narriflow-golden` by the runner's hash-checking setup. The mount `/repo` is reference material, never an override of candidate `/app` code.

## Media and caption corrections

### Inspection and displayed geometry: 02, 03

Worker Process Module remains the only ffprobe parser. Expose typed facts for coded and displayed dimensions, display matrix/rotation/reflection, sample aspect ratio, rational average/base rates, stream clocks and starts, audio span/rate/channels, codecs/profile/pixel format, color tags and frame counts. Add bounded packet/frame inspection when a header cannot prove a fact. Preserve all ordinary inspection behavior until a consumer explicitly adopts the corrected display facts. Persist only needed source facts through the existing validator contract; no second render-specific raw probe parser.

Planning, detector coordinates, Studio preview, preview proxies and export must share a display-oriented, square-pixel coordinate system. Apply rotation/reflection exactly once. Correctly transform both width/height and tracked face/PiP coordinates; swapping dimensions alone misses 180-degree and mirrored sources. Account for SAR before choosing the existing center/fit/crop policy, then emit SAR 1:1. Do not stretch anamorphic content to fit a coded rectangle. A square-pixel source with an identity matrix must retain the current crops and compiler args. Accept by testing all display transforms, fit/center/speaker layouts, odd dimensions, and matching preview/export subjects and pixels.

### Dialogue clock and clipping: 04, 05

Treat the edited video timeline as authoritative. Preserve source A/V offsets, leading silence and gaps through seeking, cut concatenation and scene insertion. Pad audio to the edited duration before trimming. Apply the correction only when inspected audio timing or actual decoded coverage demonstrates missing/offset samples; a full-length aligned ordinary track keeps its existing args and PCM. Test silent/no-audio sources, short mono audio, late-start audio, negative starts, cut gaps, scene audio, music and SFX. Dialogue onset should match the original video event within one output frame, and the video must retain its full planned frame count.

Preserve explicit volume controls and the existing loudness of non-clipping mixes. On music/SFX/scene mixes, measure the encoded candidate's decoded peak during validation. A peak above 0 dBFS triggers a bounded re-encode using the same frozen mix with `alimiter` at 0.95 and automatic level boost disabled. Compensate any limiter latency without moving dialogue. Permit only one corrective re-encode; validate the corrected decoded sample and true peak <= 0 dBFS, otherwise return a typed invalid-output failure. The normal non-clipping candidate remains byte-for-byte the same command and decoded audio. This deliberately pays extra work only for a demonstrated clipping output. No new LUFS target, mandatory stereo conversion, or global resampling policy.

### VFR and HDR: 06, 07

Use one measured rational clock rather than raw `r_frame_rate` for generated scenes/backgrounds. Detect VFR or inconsistent timestamps from bounded packet evidence, not merely a non-integer rate. For affected VFR exports choose the measured average rational in [1,60] fps, preserving exact standard fractions through `standardFrameRate`; use 30/1 when the measured rate is absent or outside that range. Normalize affected video branches to that CFR while preserving wall-clock timing and A/V sync. Ordinary CFR, including exact NTSC rates, keeps existing args and frames. Never let a 90000/1 base rate drive generated video. Record the clock decision and input facts.

For PQ/HLG, decode to linear light, tone-map with the pinned FFmpeg CPU filters, convert primaries/matrix/transfer/range to limited-range BT.709 SDR, then compose SDR captions/assets. Pin the selected tone-map curve and parameters in the corrected reference. Default design is the pinned FFmpeg `zscale` + `tonemap=hable` chain with source mastering peak when valid, otherwise a documented fixed peak assumption in the fixture contract. Verify linearization, highlight rolloff and neutral/color patches against trusted known-color references, not tags alone. Output yuv420p H.264 with BT.709 tags and remove stale HDR side data. Ordinary SDR takes the unchanged path. Dolby Vision must use a verified supported base layer; unsupported enhancement-only material fails explicitly rather than being relabeled SDR. Existing HDR optional video layers require the same conversion before overlay.

### Emoji and glyph coverage: 08

The composition plan already includes cue emoji, and Studio positions it above the active word at 0.8em. Export must consume that schedule, including active-word position, scale and cue animation. Avoid deriving emoji or cue grouping again in the worker. Use grapheme clusters for reveal and lookup, preserving family/flag/skin-tone/ZWJ sequences.

Use pinned Noto raster assets in a shared atlas for exported emoji and Studio. This removes OS emoji appearance from the product contract. Compare that approach against build-time rasterization of the installed NotoColorEmoji font before implementation; reuse the smaller reliable upstream route, record its license and hashes, and keep the same shared resolver and images on both sides. The fallback order is exact fully-qualified Noto sequence, its Unicode presentation-selector equivalent when semantically identical, then a pinned monochrome Noto glyph rendered to a shared image with a `glyph_fallback_used` notice. Never split a ZWJ cluster into unrelated pictures or discard variation/skin-tone semantics. An unsupported sequence produces `caption_glyph_unavailable` and no ready export. The Studio shows the same fallback or missing-glyph notice. Emoji editing is future work.

For ordinary text, fallback order is requested uploaded/built-in face, saved built-in fallback, pinned Noto face for the script, pinned Noto Sans Symbols 2, then the supported pinned monochrome emoji face for emoji in text. Check coverage and actual shaping, not just a successful fontconfig lookup. Surface libass missing-fallback/glyph and drawtext parsing errors even on exit zero. RTL/CJK, custom deleted font, typewriter clusters and caption bounds need image checks. Keep existing Latin cue geometry and fitting unchanged. Installing `fonts-noto-color-emoji` alone does not establish libass color glyph support.

## Output validation before success: 09

Validate every local full render and preview, at both output treatments, before upload or durable success. A reusable validator calls Worker Process Module; it does not parse a different ffprobe representation. Its input is the expected composition target and audio schedule, and its result includes measured facts and diagnostic codes.

Require a regular nonempty file, positive playable video frame count verified by decode when `nb_frames` is absent, expected canvas dimensions, yuv420p/H.264 and the existing selected profile contract, expected SAR and color contract, rational frame clock, monotonic timestamps and a decodable MP4. Require audio exactly when the schedule produces it, with planned channel/rate facts and no accidental audio stream otherwise. Do not reject a previously supported valid low-rate mono stream solely to introduce a new delivery standard.

Check decoded video start/end and duration against the plan within one output frame. Audio presentation span, after accounting for AAC priming/padding, may differ by at most one video frame plus one AAC packet at its measured sample rate. Do not add a blanket 50ms video tolerance. Check format duration separately against those stream bounds. Fully decode these short exports with error-on-decode-error and a bounded deadline. Record measured video duration in ClipRender and ClipExportVariant; size comes from the validated local stat. Do not trust exit zero, planned duration, file existence, or `nb_frames` alone. The one-frame rule catches both Claude's 20.38/30s truncated read and Sol's no-stream source-end MP4.

`render_output_invalid` is retryable when a transient read/truncation is plausible. A refreshed content-bound source probe and repeat local reproduction can identify an impossible range or corrupt immutable source as permanent `source_media_invalid` / `render_range_unavailable`. Invalid output is never uploaded or completed. Validation errors from missing executable/spawn propagate as executor health failures, not invalid-media failures. Clipping correction uses this same boundary. Store the validator facts in telemetry for accepted and rejected artifacts.

## Failure, retry and persistence protocol

### Taxonomy

| Cause | Disposition and action |
| --- | --- |
| Attempt/group ownership lost, superseded revision, explicit shutdown | Control signal. Cancel/reap children, settle only with current fencing. Graceful shutdown releases without charging a media attempt. Supersession is not a render failure. |
| Synchronous or asynchronous process-start failure, EBADF/EMFILE/ENFILE/EAGAIN, helper readiness timeout | Executor failure, retryable on a healthy executor. Stop starting work on this executor, retain errno and executable class, release the unstarted claim, run a readiness probe and recycle after repeated failure. Never download the source or remove assets to repair it. |
| Missing executable, permission denied, unsupported required FFmpeg filter/font/model hash | Deployment configuration failure. Worker is unhealthy and cannot claim media work. Alert once with context. Do not permanently poison every clip because its worker image is broken. |
| HTTP/storage connection reset, 408/429/5xx, expired presign | Retryable I/O; bounded backoff. Refresh a genuinely expired presign once, retaining object identity. Failed PUT/complete preserves the original failure and bounded cleanup. |
| Required object 404 after confirmed metadata lookup, authorization denied after one credential refresh, corrupt immutable source, invalid document/required asset, impossible range, unsupported glyph | Permanent for that frozen request, with the precise code. Credentials failing globally quarantine the executor instead. Optional assets use the current named degradation contract only. |
| Decode/encode/validation deadline, transient detector or extraction failure | Retryable through the existing limit. Bound retries by stage and record causal codes. Do not reinterpret timeout as proof an optional asset is bad. |
| Disk low, process-local pressure, machine OOM | Resource/executor failure, not proof of corrupt content. Backpressure before starting. An actually started group interrupted by an ungraceful crash consumes one group attempt; repeated budget exhaustion settles that group, preserving others. No arbitrary permanent-on-second-OOM rule. |
| DB commit rejected with proven stale token | Do not accept success; delete only an attempt-unique provisional key proven unreferenced. |
| DB timeout/lost commit acknowledgement, or post-commit analytics error | Ambiguous commit or diagnostic-only failure. Never synchronously delete the object on uncertainty. Reconcile by key/reference under fresh authority. Committed completion stays completed. |

Use stable low-cardinality failure codes and retain phase/errno separately. The existing limit is three charged execution attempts and `retryBackoffMs`, currently 30s then 60s; preserve that schedule for clip/group retries. The bounded analysis substep has its own explicit budget below. A process-start failure before media execution does not spend the media budget. Circuit health limits, a delayed release and process recycle prevent an infinite hot reclaim loop. Failed readiness twice closes media admission until recycle; one already admitted group may be released once by that executor, not immediately reclaimed by it. Before group leases arrive, release an unhealthy parent attempt while preserving its completed children; refund a claim only if it performed no media work.

### Parent retry and manual retry: 11

Remove the `succeeded === 0` precondition. One success plus one retryable failure on claim one remains nonterminal. Preserve completed bytes, retry only failed/interrupted members, back off, and emit one terminal notification/outcome after permanent failure or exhaustion. Public aggregates must represent current settled/retrying children; do not reset successful progress to zero. Update ADR 0003's mixed-outcome sentence and its DB test that currently expects early terminal partial.

Manual export `retryFailed` must reacquire the normal project/admission lock, conditionally reset failed children, detach their old run/attempt/failure disposition, retain frozen export entitlement/document, and admit work atomically. Repeated concurrent retry requests are idempotent. Recompute export aggregates after all variant writes through one authoritative helper, factoring it out if necessary. Test the actual service method through rescue and claim, not an imitation of its SQL.

### Safe completion: 10

Move the whole analytics lookup/enqueue behind best-effort diagnostics after durable completion. Distinguish `persisted`, proven stale rejection and uncertain commit. Reference-aware reconciliation owns uncertain objects. Test commit succeeds then analytics read rejects, lost commit acknowledgement, ownership loss before commit, editor reset, and cleanup failure. No completed row may reference a key this path deleted. Keep stale-attempt fences and attempt-unique keys.

### Analysis and evidence reuse: 12, 13

Preserve typed extraction/detector errors through runtime adapters; `null` must mean a genuine content outcome, not swallowed spawn/storage failure. Within each group execution, allow at most three analysis operations, with cancellable 1s then 2s delays between transient failures. This is an explicit substep budget, independent of how many earlier parent claims were spent on unrelated source/upload failures. Recreate failed segment/detector promises before retrying. On the third transient failure, supply center-crop availability for this render and record `framing_degraded` with the original cause and attempts. Successful analysis on the third attempt still wins. Process-start/configuration failure exits to executor recovery instead of sleeping/retrying on the same sick worker. Permanent invalid source never degrades into a successful render. Required fonts/media retain their own failure contracts. A later encode/upload retry can invoke this bounded substep again; the theoretical maximum is nine analysis operations over three charged group executions, explicitly recorded rather than hidden.

Do not persist `detection_unavailable` / `analysis_unavailable` due to infrastructure. Remove existing local/dev transient-failure entries with a targeted reset, not legacy parsers. A background failure may store retry scheduling/error metadata, never failed analysis as reusable evidence. Durable content outcomes are fingerprinted and typed.

Re-read only compatible durable layout facts just before each render group starts, not the editor/document/entitlement. Bind reuse to source content, clip window, deleted ranges, revision, preview identity, detector/model version and relevant analysis settings. Evidence becomes frozen once that group's plan starts. Background analysis should defer work already owned by a live group, and retry later without starving Studio. Source/proxy evidence may be substituted only when paired fixtures prove identical plans. If they diverge, reuse only evidence from the same canonical analysis path; do not change which crop wins as a performance shortcut. Verify no detector executes when compatible evidence arrives after parent snapshot but before group planning. Record analysis source and avoided work; measure the 30–45% claim on a controlled workload.

Reuse source/asset facts only by immutable content hash or object key plus trusted version/ETag/size and toolchain version. `Project.sourceProbe` currently lacks several required facts; do not blindly use it in place of the render probe. Reuse validated complete facts, otherwise perform the bounded fresh probe. Refresh access URLs independently. Cache selected optional-asset validation windows and font downloads by content fingerprint without relaxing required scene validation.

### Error-aware fallback: 14

Download the full source only when a recoverable ranged HTTP/I/O limitation warrants it, after object size and free-space admission. Process-start, missing executable, invalid document, permission/config, and proven source corruption do not qualify. Preserve normal ranged-read commands.

An encode fallback may remove only a proven failing optional binding. Attribute failures by input identity and typed validation, retaining the requested source and unrelated logo/music/SFX/b-roll/background. An unattributed failure retries the same composition. Do not use arbitrary stderr substring guesses as proof. Validate selected asset windows with bounded decode, reuse immutable validation facts and keep typed missing-required-asset failures. Every degraded output reports the affected binding and reason; normal outputs retain all requested layers.

## Resource, temporary-file and deadline policy: 15–17

Separate task deadlines from lease health. A heartbeat can keep ownership alive but cannot extend an expired operation. Preserve process-group TERM then five-second KILL escalation and descendant reaping. No new timeout parser outside immutable RenderConfig.

Initial policy values are finite and validated: render encode deadline `min(configured ceiling, max(300s, 20 * edited duration))`, with the existing 1800s ceiling; probe 120s; validation full-decode budget `min(300s, max(30s, 2 * edited duration))`; remote optional fetch 45s. Full-source download has its own size-aware deadline `min(1800s, max(120s, 30s + bytes / 1MiBps))` plus a 30s no-progress bound. Source metadata lookup is itself bounded. Multipart abort/delete cleanup gets a fresh independent 5s budget even after the caller signal expires. Keep original causal errors when cleanup times out, record an orphan candidate, and allow settlement. Preview media/peaks PUT and cleanup DELETE receive shutdown and operation deadlines.

Bound upload backlog by jobs and bytes in addition to active concurrency. Initial limit is two waiting output files and 512MiB of waiting output bytes per replica; a single larger output uses an exclusive slot after disk admission. Wait before producing more outputs. Keep overlap with the next encode within that limit. Unlink committed local outputs immediately; retain shared assets until all dependent uploads finish. On cancellation, wake blocked producers and drain/reap before removing files.

Before fallback downloads and group work, require free disk above `max(1GiB, 10% of volume)` plus reserved input/output bytes. Bound worker-managed scratch to the smaller of 8GiB and 50% of its volume, and b-roll cache to 1GiB plus its existing TTL. Values are configurable; record effective values. Cache writes use atomic rename and remove failed temporary writes. Sweep only Worker Process Module-owned paths with ownership metadata, no active local process and no unexpired DB group/attempt claim, older than the maximum lease plus cleanup grace. Run at startup and periodically. Do not delete a different local worker's active scratch based on age alone.

Keep one full encode per replica. Defer starting preview, auto-layout and thumbnail CPU work during it; let already-running cancellable work finish within its bound. Reserve CPU/memory headroom using cgroup quotas and observed RSS; initially make full encoding exclusive against those background starts. Retain the current FFmpeg thread flags for parity. A new thread/filter-thread cap is an encoder-level experiment and must pass its stricter authorized comparison before adoption. Disk admission, scheduling and backpressure can be fixed without changing the encode args. Fairly service background queues between render groups and report their age.

Startup verifies executable starts, required filters, model and font fingerprints. Production and local consumers of shared queues must use the pinned image or pass the exact runtime fingerprint/glyph checks. An explicit local override may process isolated fixtures, never bypass checks while claiming shared render/preview work. Reserve the local worker health port before starting poll loops so duplicate workers exit before claiming. Use a single non-watch worker command for shared-queue verification; source reloads during in-flight work are not a supported verifier. Worker readiness includes process-start health and scratch headroom, not just timers. Use the existing watchdog rather than building another. Set Railway deployment draining to at least `WORKER_SHUTDOWN_DRAIN_MS` and verify release/reclaim on deploy.

Bound object reconciliation by project/prefix and age, rechecking DB references before delete. Schedule the existing reconciler through maintenance with dry-run evidence before enabling deletion. Verify a bucket abort-incomplete-multipart lifecycle policy or implement bounded inventory/abort for orphan multipart IDs. Never infer that a completed PUT is unreferenced because a DB call threw.

## Replica scaling protocol: 18–20

The settled clip-group design supersedes ADR 0001/0003 language rejecting every child lease. Update those records and GLOSSARY explicitly. The parent coordinator retains membership, public progress, terminal events and notification authority. It does not run all groups while holding the sole encode claim.

Create durable groups keyed by parent run, clip and frozen export identity, plus durable membership. Each group holds status, immutable attempt token, owner, DB-time lease, heartbeat, `nextAttemptAt`, charged attempt count and causal failure. Include durable per-group execution-start/outcome evidence for crash accounting. Exact rendering inputs remain frozen snapshots on existing rows; do not persist a second full render manifest. Source identity and analysis fingerprints identify reusable facts.

Group writes require both an open parent with valid membership and the current unexpired group token. Coordinator reclaim must not invalidate healthy groups; a stable work-set generation identifies that membership until explicit cancellation/supersession. The coordinator's Workflow Attempt fences parent mutation; the group token fences its child variants. Reaping an expired group retries only that group's unsettled members. Group success/permanent members survive retries. An ungraceful crash after durable execution start charges that group once. A spawn rejection before execution or graceful shutdown releases without charging it. Budget exhaustion affects the group, not healthy siblings. Use three attempts and the same backoff; do not add per-clip Workflow Runs or a second parallel retry authority.

Parent terminal settlement waits for all groups to be settled or superseded, with no live lease or future retry. Preserve late-variant admission to a separate idempotent follow-up run. Parent reaper coordinates or resumes settlement while healthy child leases continue. Aggregate changes and terminal outbox/notification intent remain transactional and idempotent. Persisted completion must be safe under ambiguous commits as above.

Split implementation into schema/contracts, service protocol, then worker execution. Each is one ticket and owns separate files. Integrate them before running/deploying the new runtime, remove the parent-only execution path in 20, and apply the migration once before code deployment. There is no dual-run mode or rolling-compatibility bridge. Multi-replica tests need simultaneous claims, expired child token, coordinator death, child death, mixed success/retry/permanent outcomes, editor supersession, duplicate completion, and notification uniqueness. Prove faster batch completion using two replicas and at least four groups, with one encode per replica and exact output parity.

## Reproducible worker environment

Ticket 01 pins the worker base and token-provider images by digest, FFmpeg/ffprobe and libass/fontconfig artifacts through a dated package snapshot or checksummed build, Python dependencies by version plus wheel hashes, OpenCV/numpy hashes, and the YuNet ONNX download by immutable upstream commit and SHA-256. Include architecture-specific lock entries rather than claiming macOS and Linux encodes are identical. Verify hashes at build and emit a runtime fingerprint. Pin existing deployed artifacts before experimenting with versions. Ensure required HDR filters exist in that pinned build.

Keep caption display faces already vendored in `packages/caption-fonts`. Pin script/symbol/emoji fallback artifacts and fontconfig configuration as well. A startup glyph check must render the RTL/CJK/emoji reference strings and reject a shared-queue consumer whose resolved faces differ. A matching filename is insufficient; compare file hashes and expected glyph output. Local development can use the worker image while web/API stay native. Machine-dependent system fonts must not decide exported glyphs or Studio emoji appearance.

The upstream comparison favors existing components: [libass's color-emoji issue](https://github.com/libass/libass/issues/381) and [its alpha-mask image interface](https://github.com/libass/libass/blob/master/libass/ass.h) explain why installed color fonts alone are inadequate. [Noto Emoji](https://github.com/googlefonts/noto-emoji) and [Twemoji](https://github.com/jdecked/twemoji) provide reusable artwork; prefer Noto to match the installed font family and avoid mixing two visual sets. Twemoji is an alternative with its own artwork attribution requirement, not a second runtime fallback. [FFmpeg's file option syntax](https://www.ffmpeg.org/ffmpeg-all.html) and [filter implementation/documentation](https://ffmpeg.org/ffmpeg-filters.html) support file-backed graphs and explicit tone mapping. Use the syntax supported by the pinned binary, `-/filter_complex` on supported versions or its `-filter_complex_script` predecessor. No new caption renderer or custom tone mapper is needed.

## Observability and operational acceptance: 21

Emit structured JSON with `level`, `message`, project/clip/variant/export IDs, Workflow Run/Attempt IDs, group ID/token/owner after scaling, editor revision, frozen source/evidence/toolchain fingerprints, phase/operation, start/end/elapsed time, failure code/disposition, errno/exit/signal, retry count/limit/next-attempt time, degraded binding/reason and cleanup result. Redact URLs, query strings, tokens and raw user text. Executable is a safe class such as ffprobe, not an arbitrary path containing private data.

Record request-to-ready and queue age separately from per-attempt wall time. Break out presign/probe/download/asset-validation/evidence-read/analysis/planning/spawn/encode/validation/upload/drain/persistence/cleanup. Record actual versus avoided detector executions, graph bytes/max-arg bytes, decoder count, upload active/waiting bytes and disk/free/reserved/cache bytes. Record process RSS separately from cgroup current/peak/page-cache facts, CPU quota and active child count. Output facts include planned/measured duration, canvas/SAR/fps/color/audio/size, decode checks, peak and optional loudness.

Keep durable compact execution-start/outcome records in Workflow Event or the group execution ledger, keyed idempotently by token and variant, so attempt failure-rate denominators survive mutable ClipRender retries. Use existing outbox ownership for public events. Do not insert raw command text or secrets into DB events. Mark terminal settlement explicitly so a late in-flight heartbeat cannot emit `workflow_attempt_lost` after successful settlement, while genuine loss before commit still aborts.

Final evidence includes the full golden report and fault-injection report: mid-read HTTP 503 with exit zero, sync/async ffprobe start failure, failed readiness, slow upload/backpressure, stalled multipart abort, shutdown during preview PUT, commit acknowledgement loss, analytics read failure, transient layout then success, exhausted layout center fallback, mixed sibling retries, actual manual export retry, disk pressure, process kill and two-replica group recovery. No shared development DB mutation for tests. Run database gates with [.scratch/api-extraction/db-gate.sh](../api-extraction/db-gate.sh), which points both URLs at disposable local Postgres:

```sh
bash .scratch/api-extraction/db-gate.sh bun run test:workflow:db
bash .scratch/api-extraction/db-gate.sh bun run test:clip-editor-persistence:db
bun run lint
bun run typecheck
bun run test
bun run --cwd apps/api test:inventory
bun run --cwd apps/api openapi:check
bun run check:web-split
```

The final ticket records commands, commit/image hashes, sample sizes and p50/p95 for a controlled frozen workload. It may report a missed performance target; it may not report output or recovery success without evidence. Operational deployment checks use a drained worker and read-only configuration inspection before a separately authorized verification run. Do not kill duplicate workers, alter Railway settings, migrate the shared DB, submit real work or push/deploy merely to close a planning ticket.

## Audit reconciliation

Code was checked directly at the reviewed checkout. The table covers every numbered finding and the conflicting positive assertions. S means Sol's numbered finding, C means Claude's finding.

| Audit point | Code evidence and decision | Ticket |
| --- | --- | --- |
| S01 vs C solid fencing/cleanup | Runtime completion awaits analytics whose initial `findUnique` is outside the catch; `commitProvisionalRenderUpload` deletes on any completion rejection. Sol is correct. Attempt-unique keys do not make deletion safe after an ambiguous commit. | 10 |
| S02 vs C every variant write syncs aggregates | `clip-export.service.ts:retryFailed` retains run/attempt/disposition and hard-resets parent progress. Rescue requires unassigned rows. Sol is correct; worker lifecycle writes are sound, manual retry is the exception. | 11 |
| S03 / C P1-3 | `settleClipRenderingAttempt` requires `succeeded === 0`; ADR 0003 says mixed outcomes are terminal. Both found the defect; owner now changes that policy. The real 3/10 run had exhausted its budget, so do not attribute it solely to this guard. | 11 |
| S04 / C P0-1 | Only 720p is probed, for logging, and persistence uses planned duration. Both reproductions show exit zero can lie. Accept both. Treat as release-blocking correctness without claiming proven universal P0 impact. Use tighter video duration and explicit AAC allowance rather than blanket 50ms slack or retrying permanent corruption forever. | 09 |
| S05 vs C audio padding solid | `buildAudioMixFilter` pads SFX, not dialogue; dialogue gets `atrim,asetpts` and mixed outputs use `-shortest`. Sol's short/late fixtures disprove the general assertion. | 04 |
| S06 / C P0-2 | `inspectMedia` returns coded dimensions, discards matrix, compiler relies on FFmpeg autorotation. Both are right. Claude's swap-only fix is incomplete for 180/reflection/SAR/detector coordinates. Use the full display transform. | 02,03 |
| S07 / C P2-5 | Common center/fit filters omit `setsar=1`; scene branch includes it. Accept both, with geometry correction before output normalization. | 03 |
| S08 / C P2-5 | `buildSourceProbe` uses measured rate, render-facing `fps` uses raw base. Accept both. A real VFR fixture succeeded, so the bug is bad clock policy, not all VFR decoding. Owner authorizes affected VFR CFR conversion. | 02,06 |
| S09 only | Budget sums argv to 512KiB; a single valid graph can be 189KiB, beyond typical Linux single-argument limits. File transport preserves graph semantics; retain complexity admission. | 14 |
| S10 vs C multipart/process lifetimes solid | R2 abort lacks a signal; preview PUT/peaks/DELETE lack deadlines. A live heartbeat cannot bound these waits. Sol is correct about the remaining gap. | 15 |
| S11 / C scratch, memory/contention | Queue active uploads are bounded but waiting list/files/cache are not. Crash bypasses scratch `finally`. Both correct. Memory observations are combined cgroup peaks, not measured child leaks. | 16,17 |
| S12 / C P1-4 and browser run | `spawn` throws before event classifier; source resolver catches broadly and downloads. Accept both plus browser's duplicate-watch cause. Use unhealthy-executor release/quarantine; neither blind download nor a runtime upgrade alone fixes this class. Graceful release already exists, ungraceful crash accounting remains. | 02,14,17 |
| S13 / C lever 2 and poison clip | Parent-only claim and sequential group loop prevent single-project multi-replica throughput. Implement settled group leases. Reject C's arbitrary permanent-after-two-crashes rule: count actual group starts through the normal limit and preserve siblings. | 18–20 |
| S14 / C P1-7 | Adapter forces 8-bit without a tone mapper while tags propagate. Both correct; owner chooses SDR, including conversion before SDR overlays. | 07 |
| S15 / C P1-5 | Missing-glyph errors disappear on successful exit; macOS lacks equivalent fallback. Both correct locally, neither proves the Linux image lacks its installed Noto fonts. Verify hashes and glyph output on both, use image for shared queue. | 01,02,08,17 |
| C P1-6 vs S glyph scope | Plan has emoji and Studio paints active emoji; caption ASS does not serialize those glyphs. Claude found a separate export omission. Accept it; rasterize shared emoji, do not assume libass color support. | 08 |
| S16 only | `normalize=0` and limiter only for censor beeps permits >0 dBFS output. Correct hot mixes only, preserve ordinary PCM and volume intent. | 05 |
| S17 / C P1-1 | Any primary exception strips all optional assets; runtime validates each whole asset by decode. Both right about fallback. Sol also identifies wasted validation; use immutable selected-window caching. | 13,14 |
| C P1-2 only | LayoutEvidence converts detector/extraction nulls to fallback and writes screen/split infrastructure failures. Accept. Retry before final center crop and never cache infrastructure failure. | 12 |
| C P1-8 only | Docker uses unpinned apt/pip and YuNet `main`; base tag alone is mutable. Accept. Initial pin captures deployed versions rather than upgrading. | 01 |
| C P2 heartbeat only | Timer remains active through handler settlement and can report lost after row becomes terminal. Accept; synchronize successful settlement with heartbeat teardown. | 11 |
| C P2 deadlines | Fixed 30-minute encode and two-minute fallback download lack work/size policy. Accept the problem; use the explicit finite policy above, rather than `20*duration` exceeding the existing ceiling. | 16 |
| C P2 yt-dlp AV1 selector | Selector can choose AV1 despite H.264 comment. Switching source changes pixels, measured rough SSIM 0.985. Leave preference unchanged; this is outside owner-approved defect corrections. | Deferred |

## Performance lever disposition

Both lever lists remain accounted for. Existing features are not claimed as new gains.

| Lever | Decision and measurement |
| --- | --- |
| S repair retry/finalization before speed | 10,11 prevent manual cycles and lost outputs. Measure request-to-ready and repeated encode/upload counts, not only successful encode time. |
| C persisted layout evidence, estimated 30–45% | 13 re-reads compatible facts at group planning; 17 avoids competing analysis. Paired source/proxy plan equality is mandatory. Report detector count and analysis wall time before claiming gain. |
| S/C fingerprint-bound source/asset/font reuse | 13 uses immutable complete facts; `Project.sourceProbe` alone is incomplete. Measure probe/validation calls and hit rate. Preserve changed-source detection. |
| S/C ranged reads and error-aware fallback | Keep ranged reads; 14 avoids the observed wasted 21s download after EBADF. Measure fallback cause/bytes/time. |
| S/C upload overlap, multipart and storage RTT | Already implemented. 15,16 bound failure/queue growth without removing overlap. Benchmark part concurrency only where output exceeds 16MiB; the sampled small outputs used single PUT. Do not present residential-vs-Railway timing as controlled improvement. |
| S/C CPU scheduling, scratch and cache bounds | 16,17 prioritize one encode and fair background work. Thread changes need a separate encoder gate. Measure RSS/cgroup/cache separately and queue age. |
| S/C child clip-group leases | 18–20 provide independent groups across replicas, preserving one parent run. Speedup is bounded by ready groups, replicas and shared I/O capacity; verify two-replica throughput. |
| C one decode / N aspect outputs | Video aspects compile independently in the output loop in `clip-render-attempt.ts`. Defer a new video fan-out encoder until reliability/reuse results establish value. It changes encoder threading and needs the encoder-only gate, not a framing rewrite. |
| S encoder/HW experiments; C do not tune x264 | Keep veryfast/CRF21. Claude's superfast sample saved ~27% encode-only, cost 79% size and SSIM 0.997; it does not establish end-to-end value. No GPU on the declared Railway CPU design. Defer preset/HW work, scaler/CRF changes, and new level/GOP/VBV rules. |
| Brief concurrent fragments, STT submit-and-release | Preserve existing import/transcription behavior. They are outside clip-render hardening; no new fragment or STT project is hidden in these tickets. |

## Execution and file ownership

Use the linked [tickets](issues/01-golden-parity-harness.md). Claim and close them according to [the local tracker](../../docs/agents/issue-tracker.md). Suggested implementers balance Claude's mechanical/media work with Sol's lifecycle/protocol work; assignments are suggestions, not claims. Each ticket lists an exhaustive write set. Other files are read-only. A newly discovered necessary file requires updating this plan and adding dependencies before editing it. Each ticket may edit its own issue file to record evidence; the final ticket alone closes this spec.

Files shared across tickets are serialized by blocker ancestry, including test files and docs. The attempt lane is 03 -> 04 -> 05 -> 08 -> 09 -> 10 -> 12 -> 13 -> 14 -> 16 -> 17 -> 20 -> 21. The compiler lane is 03 -> 04 -> 05 -> 06 -> 07 -> 08. These lanes can run beside the service retry lane 11 -> 18 -> 19, and storage 15. Group worker integration 20 waits for all prerequisites. No two unblocked tickets own the same path. New production helpers should represent a needed lifecycle or validation responsibility, not split a file solely to create parallel edits.

Complete only when all tickets meet acceptance, the integrated tree passes verification, no obsolete execution path remains, and the parity/fault reports show truthful completion with bounded recovery. A deploy, PR or real shared-environment retry is not implied by writing or implementing these tickets.

## Parity gate rule: no mirrored glue (orchestrator, 2026-10-29)

Ticket 01's harness calls the real planner (`planClipComposition`) and compilers
(`compileClipCompositionCommand`, caption/audio compilers, media inspection), but
mirrors the orchestration in `clip-render-attempt.ts` that assembles their inputs.
Any ticket that changes how `clip-render-attempt.ts` derives compiler inputs
(source facts, layout evidence selection, overlays, timing, fallbacks) must FIRST
extract that derivation into an exported function, switch
`apps/worker/scripts/render-golden.ts` to call it, re-verify the unchanged
baseline (exit 0), and only then change behavior. Parity gate command:
`bun apps/worker/scripts/render-golden.ts verify --baseline /tmp/narriflow-golden/baseline --suite all --out /tmp/narriflow-golden/candidate-NN`
(durable baseline copy: `~/.cache/narriflow-render-golden/baseline-5680477046-90cf30a3`).
