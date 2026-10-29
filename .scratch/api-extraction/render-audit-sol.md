# Independent render audit, Sol

2026-10-29. Independent read, without consulting the other review. Source inspected on `dev`, initially `59823484`, finally `d4957e8a`. The intervening commits changed the brief and web code, not the audited worker/services/composition source. Read AGENTS.md and the updated brief, including its output-parity constraint. No source edits, DB writes, job submissions, app restarts, or process kills. This report and experiments under `/tmp/render-audit-sol-*` are my only writes.

The pipeline is not ready to promise reliable delivery. I found reproducible output defects and recovery paths that can strand work or delete a successfully committed output. No P0 established. Correctness changes that affect pixels, timing, or audio need the owner's defect decision and the brief's golden parity gate before implementation.

## 1. Measured baseline

### Snapshot and denominators

Read-only `psql`, `DIRECT_URL` from `packages/db/.env`, with `default_transaction_read_only=on` and a 15-second statement timeout. Initial complete snapshot at **10:47:44 UTC**. Window: preceding seven days. Later live-test activity changed rows, so numbers below deliberately retain that snapshot.

| Population | Outcome at snapshot |
| --- | --- |
| Surviving ClipRender rows created in the window | 27 total, 21 completed, 6 failed: **22.22% failed**, all `EBADF`, all classified retryable |
| Reference project's current ten ClipRender rows | 4 completed, 6 failed: **60% failed**, all six `EBADF` |
| Reference project's original ten-variant run `6e49595d-33f7-464c-8242-a7ea17ee75ee` | Terminal partial after three claims, 3 succeeded / 7 failed: **70% failed at original settlement** |
| Separate Railway rescue/render `365bf25e-0a1b-4e82-81fb-8fb9956311cc` | One variant completed, explaining reference project's later 4/10 current success |
| ClipExportVariant rows created in the window | 7/7 completed, no failures |
| Clip-rendering WorkflowRuns created in the window | 12 terminal runs, 11 completed / 1 partial; aggregate requests 43, successes 36, failures 7, before accounting for the rescue re-requesting one earlier failure |

These are **row-state and run-outcome rates, not an attempt failure-rate estimate**. ClipRender is mutable; retries reset timestamps/errors, editor saves can delete rows, and a rescue counts the same intended output again. There is no durable per-variant attempt history from which to derive a defensible all-attempt rate. Partial WorkflowRuns have `errorCode=null`, despite failed children. Durable WorkflowEvents corroborate the original run's claims and terminal partial, but their stage events do not supply per-variant encode-start timings or every failed child code.

Evidence files: `/tmp/render-audit-sol-db.txt`, `/tmp/render-audit-sol-events.txt`, `/tmp/render-audit-sol-baseline.sql`, `/tmp/worker-dev.log`, `/tmp/render-audit-sol-railway.log`. Railway capture used `bunx --bun @railway/cli logs --service @narriflow/worker --lines 400 --json`; it returned 47 entries, including the one rescue render. No secrets copied here.

### Wall-clock

Percentiles use continuous linear interpolation. DB wall-clock is `completedAt - startedAt`, not request-to-ready latency; shared source resolution happens before these row starts. Failures' final-attempt durations do not include earlier retries or backoff.

| Measured population/phase | n | p50 seconds | p95 seconds |
| --- | ---: | ---: | ---: |
| All completed surviving ClipRender rows, DB wall-clock | 21 | 27.020 | 92.648 |
| Reference project completed rows, DB wall-clock | 4 | 24.482 | 31.375 |
| Failed rows' final-attempt DB wall-clock | 6 | 1.363 | 1.545 |
| Successful variants with local or Railway timing telemetry, encode | 8 | 16.196 | 23.292 |
| Same successful variants, upload | 8 | 8.136 | 21.705 |
| Reference project's successful variants, encode | 4 | 10.585 | 20.287 |
| Reference project's successful variants, upload | 4 | 6.529 | 10.308 |

Reference successes, indexed by Clip.index: `0`: encode 11.101s / upload 10.841s / DB wall 31.673s; `1`: 21.908s / 5.769s / 29.686s; `2`: 10.068s / 7.288s / 19.277s; `7`, Railway: 9.970s / 1.347s / 11.543s. Upload overlaps subsequent work; do not add phase percentiles or subtract unrelated percentiles to infer composition time.

Source-resolution timings across captured runs: four successful ranged probes, 0.780–1.975s; presigning 0.045–0.516s. One **21.151s full-file fallback download** followed a 1ms ranged-probe `EBADF`, then local probing failed with the same `EBADF`. The fallback did not repair this process-level error.

Only the Railway rescue logged detailed composition resources: planning **2ms**, encode **9.970s**, upload **1.347s**, source presign **45ms**, probe **780ms**, run body **13.182s**, attempt **13.557s**, five scenes, 8,045 command bytes, one source decode, no detector execution. Peak cgroup memory **2,188,992,512 bytes, 2.04 GiB**. That includes worker and concurrent processes; it is not attributable solely to this encode. Local logs lack the full detailed resource record. Download/asset resolution/analysis/compose/queue/persistence cannot be separately percentile-split for all clips with this telemetry.

Local logs also contain repeated multi-loop `Connection terminated unexpectedly` bursts and `EBADF: bad file descriptor, posix_spawn '/opt/homebrew/bin/ffprobe'`. I did not establish the OS/Bun root cause. Local Bun reports **1.4.2**, while package/Docker pin **1.3.6**. The pool/watchdog fix is already present and should not be proposed again.

## 2. Findings

### P1-01. A post-commit analytics failure can delete a completed render

Locations: `apps/worker/src/tasks/clip-render-attempt-runtime.ts:158`, `:237`; `apps/worker/src/tasks/clip-render-attempt.ts:1233`, `:1340`.

The runtime commits `completeClipRenderVariant`, then awaits `recordRenderAnalytics`. Its initial `clipRender.findUnique` is outside the analytics error handler. If that read times out or loses its connection, `commitProvisionalRenderUpload` treats the whole completion as rejected and deletes the object. The completed ClipRender and ClipExportVariant still reference the deleted key. A subsequent failure write cannot undo completion because it requires status `rendering`.

Evidence is the control flow; connection failures are present in the real logs. Test sketch: make the lifecycle completion commit successfully, then reject the analytics lookup; assert storage deletion is never called and completion remains successful. Current flow fails that expectation. Also test a lost DB commit acknowledgement: rejection is not proof of rollback.

Fix: make the entire post-commit analytics operation best effort, including its lookup. Distinguish proven stale rejection from ambiguous persistence outcomes. Keep uncertain objects for reference-aware reconciliation rather than deleting them synchronously.

### P1-02. Manual export retry leaves work attached to a terminal run

Locations: `packages/services/src/clip-export.service.ts:954`; `packages/services/src/workflow-run-lifecycle.ts:581`, `:1181`.

`retryFailed` changes failed renders to pending but retains `workflowRunId`, `workflowAttemptId`, and failure disposition. Both rescue selection and work-set admission require `workflowRunId IS NULL`. After the original run terminates, the retried export can remain queued forever. It also hardcodes aggregate progress to zero even if other variants are completed, instead of deriving the aggregate as the brief requires.

Test sketch: fail an export-bound variant, terminally settle its run, invoke the actual `retryFailed`, then call rescue/begin-work-set. Expect the retried ID to be admitted and completed. Existing unit coverage mocks `retryFailed`; some DB tests manually imitate its writes instead of exercising admission end to end.

Fix: under the normal project/admission lock, reset failed render ownership and result state, and atomically arrange rescue/admission. Recompute the export through the authoritative aggregate helper after child writes. Conditional updates must prevent two simultaneous retries from incrementing retryCount or resetting active work twice.

### P1-03. A successful sibling suppresses retry of transient failures

Locations: `packages/services/src/workflow-run-lifecycle.ts:2305`, `:2383`, `:2718`.

`shouldRequeue` requires `succeeded === 0`. With one completed sibling and one retryable failure on claim one, the run becomes terminal partial and the export variant becomes failed immediately, even though two claims remain. Follow-up admission only finds unassigned pending variants, so it does not recover these rows.

Test sketch: one success plus one `storage_temporarily_unavailable` on first claim must preserve the success and requeue only the failed sibling. Current DB test at `workflow-run-lifecycle.db.test.ts:2735` explicitly expects terminal partial for this case. This is a conflict with the brief's settled nonterminal-retry rule, not an invitation to redesign retry policy. The measured 3/10 partial exhausted three claims, so this specific guard is not proven to have caused that incident.

Fix: requeue retryable members while budget remains regardless of successful members; retain completed outputs and recompute public aggregates only from settled/current retry state.

### P1-04. Success does not establish that the output contains the requested clip

Locations: `apps/worker/src/tasks/clip-render-attempt.ts:1307`, `:1320`, `:1349`; `apps/worker/src/worker-process.ts:581`.

1080p output is never probed. 720p is probed for logging but dimensions, actual duration, audio, pixel format and decodability are not asserted. DB duration is the planned duration. FFmpeg exit zero is insufficient.

Real reproduction through the production compiler: seek the generated three-second 24fps source from 2.96s for a one-second planned range. FFmpeg exits **0**, warns that no frames were encoded, and produces an MP4 with **no streams**. A full decode subsequently fails. The request intentionally stresses missing media near/beyond the true last frame; normal editor bounds reject an end beyond a trustworthy stored edge, but stale source metadata, sparse frames, or truncation still need this output boundary. The short-audio reproduction below is a fully in-range example of wrong duration passing success.

Fix: validate every output before upload/commit. Require expected video/audio, positive frame count, exact treated canvas/SAR, duration within a frame-aware tolerance, and codec/pixel-format contract. Store measured duration. Run a bounded decode check, with full decode appropriate to these short exports, and classify truncated input distinctly. Reject empty output with a specific code instead of reporting ready. Tests must inspect streams and decode, not only exit status or file existence.

### P1-05. Short or delayed source audio truncates video and shifts dialogue

Locations: `apps/worker/src/composition-ffmpeg-adapter.ts:2294`, `:2361`, `:2592`, `:2866`.

The dialogue branch is first in `amix:duration=first` and is not padded. Mixed-audio commands use `-shortest`. A three-second video with 0.5s of mono 11,025Hz audio plus a full music bed produces **0.558s** total output, 13 frames, with exit zero. Video and music disappear with the short dialogue stream.

Second real fixture: video starts at zero, source audio starts at **0.976s** and lasts about two seconds. `asetpts=PTS-STARTPTS` moves dialogue to time zero; output starts audio at zero and truncates video to **2.000s**. This is a demonstrated sync defect, not a proposed new loudness policy.

Fix, subject to the defect/parity decision: align source audio to the shared clip/video clock, preserve leading silence, resample/fill timestamp gaps where needed, pad to edited duration and trim explicitly. Make the planned video duration authoritative. Cover no audio, late audio, early-ending audio, cuts, inserted scenes, music and SFX together. Do not apply an independent timestamp reset that erases A/V offsets.

### P1-06. Rotation metadata invalidates the planner's crop coordinates

Locations: `apps/worker/src/worker-process.ts:113`, `:756`, `:776`; `apps/worker/src/tasks/clip-render-attempt.ts:2940`; `apps/worker/src/composition-ffmpeg-adapter.ts:1793`.

Inspection returns encoded width/height and discards the display matrix. FFmpeg autorotates before applying the planned crop. With a 320x180 source carrying a 90-degree display matrix, the production 16:9 center command asks to crop width 320 from decoded width 180 and exits **234**, `Invalid too big or non positive size`. Other ratios can crop the wrong region instead.

Reproduction: `ffmpeg -display_rotation 90 -i base.mp4 -c copy rotated-real.mp4`, then reuse `rotation-args.json` with that input. Verified display matrix via ffprobe. The old `-metadata rotate=90` fixture did not create rotation metadata on FFmpeg 8; only the verified matrix fixture is evidence.

Fix, owner defect decision first: define one display-oriented source coordinate system, carry rotation/display size into planning and analysis, and perform the matching transform exactly once. Cover 90/180/270 degrees and mirrored transforms; compare crops and reference pixels across preview/export.

### P1-07. Center/fit output retains source SAR and can violate target aspect ratio

Locations: `apps/worker/src/composition-ffmpeg-adapter.ts:1742`, `:1764`, `:1793`; compare the scene path's `setsar=1` at `:1549`.

The common center/fit branches omit `setsar=1`, and the planner uses coded dimensions without SAR. A 320x180 source with SAR 2:1, rendered to a 320x180 16:9 target, retains **SAR 2:1**, hence displays as **32:9**. Odd 321x181 input rendered to 320x180 retained SAR **2889:2896**, proving this also occurs without deliberately anamorphic input. Different framing branches handle the same input inconsistently.

Fix, owner defect decision first: make display aspect an explicit input to the existing framing policy and normalize output SAR after geometry. Merely adding `setsar=1` can squeeze an anamorphic source without fixing its crop, so test both displayed geometry and metadata. Keep normal square-pixel crops identical.

### P1-08. VFR's raw base rate can create extreme synthetic frame rates

Locations: `apps/worker/src/worker-process.ts:286`, `:781`; `apps/worker/src/composition-ffmpeg-adapter.ts:1129`, `:1160`, `:1749`.

The persisted sourceProbe uses `measuredFrameRate`, but the render-facing `fps` independently uses raw `r_frame_rate`. Executed a fake-probe fixture containing base `90000/1`, average `15/1`: sourceProbe says 15fps, render fps says **90,000**. That value feeds scene color/text generators and image background fps filters. One inserted second can schedule 90,000 generated frames and make concat/filter work consume the timeout or memory budget.

Fix: share the measured rational clock, with explicit product-supported generation limits and timestamp policy. Preserve ordinary CFR and existing intended VFR behavior. A real VFR fixture with a 2fps section followed by 30fps decoded successfully; there is no evidence that every VFR source fails. Add the extreme-base-rate fixture to the actual render-facing inspection assertions, not just sourceProbe tests.

### P1-09. An admitted composition can exceed Linux's per-argument limit

Locations: `apps/worker/src/render-config.ts:143`; `apps/worker/src/tasks/clip-render-attempt.ts:682`; `apps/worker/src/composition-ffmpeg-adapter.ts:2578`.

The 512KiB budget sums arguments but does not bound the single filtergraph argument. A schema-valid document with 64 one-second text scenes, each 500 escapable characters, produces a **189,193-byte filtergraph**, total argv **189,445 bytes**, from a **58,531-byte document**. It passes the app budget. On Linux with 4KiB pages, exec rejects a single argument at 128KiB with E2BIG. The [kernel limit](https://github.com/torvalds/linux/blob/master/include/uapi/linux/binfmts.h) is `PAGE_SIZE * 32`. Local macOS ARG_MAX is 1MiB, so normal local tests do not establish deployment safety. I generated the real production arguments but did not execute this fixture on Railway.

Fix: put large filtergraphs in attempt-local files and pass the deployed FFmpeg version's supported file-based filtergraph option. Retain graph-complexity admission bounds separately. Add a deployed-Linux integration fixture above 128KiB; raising the existing byte budget does not fix exec limits.

### P1-10. Storage error cleanup can hang beyond the render deadline

Locations: `packages/services/src/r2-storage.ts:737`; `apps/worker/src/tasks/clip-preview.ts:874`, `:912`, `:947`; `apps/worker/src/poll-loop.ts:96`.

The render correctly passes bounded cancellation signals to normal storage operations. But multipart failure awaits `AbortMultipartUpload` without a signal/deadline. A stalled abort can outlive the expired upload deadline indefinitely. The parent continues heartbeating and `holdingLease` disables the poll watchdog, so this can stop rendering on that replica forever. Preview PUT, peaks PUT and cleanup DELETE likewise omit the available shutdown signal and an operation deadline. A preview watchdog abandonment does not cancel its old upload.

Test sketch: reject one upload part, return a never-settling abort request, expire the caller signal, and assert the attempt settles within cleanup grace. Current catch remains pending. Repeat with a preview PUT stalled across shutdown.

Fix: independent bounded cleanup deadlines, preserve the original failure, and record cleanup candidates if abort cannot finish. Pass cancellation plus deadlines through all preview/storage operations. A healthy lease is not a task-progress timeout.

### P1-11. Disk and process-wide resource use lack an admission bound

Locations: `apps/worker/src/tasks/clip-render-attempt.ts:1145`, `:1550`, `:3740`; `apps/worker/src/tasks/broll.ts:85`, `:105`; `apps/worker/src/index.ts:638`, `:645`.

The queue bounds active uploads but its waiting list is unbounded. Completed MP4s and per-clip assets stay in the run scratch directory until the whole attempt ends, even after successful upload. A slow uplink lets disk accumulate behind encoding; download fallback adds the full source. B-roll cache TTL makes old files miss but never deletes them, and failed cache writes can leave temporary files. SIGKILL/process crash bypasses scratch `finally`. No free-space threshold, total scratch/cache byte limit, or stale-scratch sweep was found.

Full export has no thread/filter-thread budget and runs beside preview, detector and thumbnail work. The observed worker cgroup reached 2.04GiB on a 31.177s rescue clip, despite one full export command. This measures combined memory, not a proven leak or graph-specific peak.

Fix: backpressure by queued bytes/jobs; unlink committed output files promptly; retain group assets only until its uploads settle; bound/sweep cache and abandoned scratch by ownership/age. Check disk headroom before full fallback. Establish replica CPU/RAM budgets across background media work and cap FFmpeg/filter workers accordingly. Test bounded growth with an artificially slow uploader and stale-scratch recovery. Preserve one full-quality encode per replica.

### P1-12. Process-level failures consume render attempts without isolating an unhealthy executor

Locations: `apps/worker/src/worker-process.ts:387`, `:487`; `apps/worker/src/tasks/clip-render-attempt.ts:1025`, `:3483`; `apps/worker/src/index.ts:708`.

Real evidence is six currently failed rows with `EBADF` and earlier preview spawn failures. A synchronous `spawn` throw rejects before the asynchronous `error` classifier/diagnostic; raw `EBADF` therefore appears instead of the normalized spawn event. Render catches can persist failures and settle normally, so these do not necessarily increment poll-loop failure counters. Health checks measure loop activity/stalls, not inability to spawn ffmpeg/ffprobe. An alive loop can exhaust a batch on a broken local executor.

Fix: classify synchronous and asynchronous spawn failures consistently, include safe errno/executable/FD/child-count context, and probe executable readiness. Repeated environment-level spawn failures should quarantine/recycle that executor or release work for a healthy replica, rather than retrying every clip on it. Do not full-download a source when the ranged probe could not spawn. Root-cause the Bun/macOS descriptor failure separately; this audit does not establish a leak or an appropriate runtime upgrade.

### P2-13. One project's render work cannot use multiple replicas

Locations: `apps/worker/src/index.ts:620`; `apps/worker/src/tasks/clip-render-attempt.ts:3798`; `packages/services/src/workflow-run-lifecycle.ts:1169`.

The only claim is the exclusive parent WorkflowRun, and it sequentially loops all clip groups. The schema has no child clip-group claim/lease. Extra replicas can handle different projects but cannot accelerate a single large project or isolate one group's crash/retry cost. This is the already-settled clip-group design left unimplemented, not a proposal for per-clip WorkflowRuns or same-host parallel encoding.

Fix: keep the parent fixed work set, add independently fenced child clip-group leases and group-level completion; each replica claims one group at a time. Parent settlement must wait for live/retryable groups, preserve success, and account for supersession. Add simultaneous-claim and parent-crash tests before rollout.

### P2-14. HDR is reduced to 8-bit without an SDR/HDR color policy

Locations: `apps/worker/src/worker-process.ts:113`; `apps/worker/src/composition-ffmpeg-adapter.ts:1793`.

A real 10-bit BT.2020/PQ fixture is exported as **8-bit yuv420p H.264 with smpte2084 transfer still set**. There is no tone mapping or inspection of transfer/primaries/range/mastering metadata. It decodes, but is not a demonstrated correct SDR conversion or consistent HDR presentation with SDR captions/assets.

Decision required: establish whether this product's exported composition is SDR or HDR. Then implement the matching tagged conversion before SDR overlays and verify representative PQ/HLG/Dolby Vision material. A BT.709 relabel alone is not tone mapping. [FFmpeg's filter documentation](https://www.ffmpeg.org/ffmpeg-filters.html#tonemap) describes the separate conversion operation. Do not silently change normal SDR pixels or apply a new color policy as a performance optimization.

### P2-15. Missing glyphs can silently produce incomplete caption output

Locations: `apps/worker/src/worker-process.ts:482`, `:581`; `apps/worker/src/caption-ass.ts:303`, `:308`, `:449`; `apps/worker/Dockerfile:14`.

Production-compiled Arabic fixture encoded without diagnostics locally. CJK and family/flag/skin-tone emoji fixtures exited zero while libass logged **42** and **240** missing-fallback-glyph messages respectively. macOS font lookup failed on PingFangUI and emoji fallback. This is proven for the local runtime, not proof the Linux image lacks its installed Noto fonts. Successful command execution discards stderr diagnostics, so callers cannot see this degradation. When metrics are unavailable, captions also skip measured fitting/decorations; typewriter iterates code points instead of grapheme clusters.

Fix: test these exact script/emoji fixtures in the deployed image and require usable bundled fallback faces. Recognize font-select/missing-glyph diagnostics even on exit zero, with explicit degraded outcome. Verify glyph content and bounds, not only MP4 existence. Grapheme-aware animation and fit changes require the owner's defect decision and parity references; adding system font packages alone does not establish complex-script layout parity.

### P2-16. Ordinary music/SFX mixes can exceed digital full scale

Location: `apps/worker/src/composition-ffmpeg-adapter.ts:2351`.

`amix normalize=0` correctly preserves dialogue gain, but a limiter is added only when censor beeps exist. Two legal hot source/music tracks at allowed gains produced a decoded AAC peak of **+1.602594dBFS** in a real production-command fixture. Standard integer playback can clip. No general resample/channel/loudness delivery policy is enforced; a multi-audio fixture selected the first mono 11,025Hz stream and exported AAC LC at that same sample rate, with FFmpeg bitrate-clamping warnings.

Fix only after the owner accepts the demonstrated clipping defect: establish headroom or use a limiter on the summed mix, tested with hot music/SFX/scene audio and explicit user volume controls. Do not introduce a new LUFS target, automatic stereo conversion, or sample-rate policy as incidental hardening. Capture sample rate/channels/true peak in validation so delivery limits can be applied explicitly.

### P2-17. Optional fallback is too broad, and asset validation re-decodes too much

Locations: `apps/worker/src/tasks/clip-render-attempt.ts:815`, `:3223`; `apps/worker/src/tasks/clip-render-attempt-runtime.ts:399`; `apps/worker/src/composition-ffmpeg-adapter.ts:36`.

Any primary encode failure with optional media retries once after removing **all** optional b-roll/logo/music/SFX/background assets. A CPU timeout or decoder failure can therefore repeat almost the whole encode and, if it succeeds for an unrelated transient reason, deliver altered output without the requested assets. This is wider than the product's typed optional-media degradation contract. Separately, `validateOptionalMedia` decodes an entire downloaded asset to null, then the final encode decodes it again, even when only a small selected scene/window is used. Timeout returns false and can misclassify a valid slow asset as invalid.

Fix: distinguish source/executor/resource errors from asset-specific errors, retain named fallback reasons, and only remove the proven failed optional binding. Reuse validation by immutable fingerprint and validate selected ranges with a bounded decode where that matches the asset contract. Missing required scene visuals/fonts should continue returning typed errors, not silently disappear. Compare fallback plan/cue/crop fingerprints against intended changes.

## 3. Highest-value performance levers

All estimates below are bounds or targets, not measurements of an implementation. Preserve the brief's exact golden checks: SSIM at least 0.99, identical crop rectangles and caption cues, frame-rate/resolution/metadata agreement, duration within one frame, audio loudness within 0.5 LU. Defect corrections need the owner's decision before changing the golden expectation.

| Lever | Expected gain and evidence | Risk / condition |
| --- | --- | --- |
| Stop replaying successful work and repair retry/finalization first | Avoids whole failed/manual cycles and repeated uploads; reference run took 8m53s from run creation to terminal partial | Must preserve completed rows and attempt fencing; this improves reliability before encoder speed |
| Child clip-group leases across replicas | Up to `min(replicas, ready groups)` speedup of a long project's parallelizable portion; no same-host encode fan-out | Parent/group fencing and settlement need concurrency tests; I/O/provider capacity can become the limit |
| Keep ranged source reads; make fallback error-aware | Captured ranged probes took 0.780–1.975s; avoid the observed wasted 21.151s full download after spawn failure | Preserve normal source-corruption fallback; refresh presigns after true expiry, not blind retries of 403/404 |
| Preserve overlap; reduce storage RTT and per-output DB work | Captured upload median 8.136s, p95 21.705s. Railway reference upload was 1.347s versus local reference median 7.288s for local-only samples | Different clips/network conditions, not a controlled speedup. Multipart concurrency and overlap already exist; do not claim them as new work. All captured outputs were below the 16MiB single-PUT threshold |
| Reuse fingerprint-bound source/asset inspection and layout evidence | Rescue used 0 detector executions, 2ms planning. Preserve that fast path; full optional-asset decode and repeated font downloads are avoidable | Cache immutable content/facts, never editor-dependent crops under a loose key. Existing source-probe reuse must preserve changed-source detection |
| Bound background CPU/threads and disk; release files after commit | Prevents throughput collapse/OOM/disk-full rather than a guaranteed lower idle-case latency; measured combined peak 2.04GiB | Tune against deployed CPU quota and golden outputs. Do not infer full-render thread budget from preview's encoder-only two-thread cap |
| Encoder/HW experiments only after the above | The 13.182s Railway rescue spent 9.970s encoding. Halving encode time would bound that example near 8.197s, about 38% less body time, if the other work stayed fixed | Current default already veryfast/CRF21. No new preset/HW gain measured. HW encoders are absent from the declared CPU Railway design, and CPU filters/decode/transfers can dominate. Require same geometry, SSIM and audio checks; do not change CRF/scaler or force CFR for speed |

Do not introduce naive parallel clip encodes on one machine, per-clip WorkflowRuns, a second caption cue model, compatibility renderers, or a new loudness target. Source download mode remains a bounded recovery path, not a proposed replacement for ranged access.

## 4. Checks that were solid, and remaining coverage limits

**530 selected tests passed, zero failed.** These are existing suites; I did not alter tests or run DB-mutating suites against the shared environment.

- 140 tests / 6 files / 25.82s: composition adapter, crop tracking, scene audio, text weight, captioned video, composition commands. These include real FFmpeg execution and drawtext stderr assertions.
- 274 tests / 8 files / 21.48s: render-attempt core paths/assets/runtime flows, worker-process ownership/cancellation, preview, object reconciliation, render config and poll loop.
- 116 tests / 8 files / 1.14s: composition-plan and subtitles, caption ASS, brand-font resolution, export service and workflow lifecycle pure contracts.
- Logs: `/tmp/render-audit-sol-tests.log`, `/tmp/render-audit-sol-lifecycle-tests.log`, `/tmp/render-audit-sol-contract-tests.log`.

Normal silent video, audio-only/audiogram, speech and supplied captions at supported aspect ratios have real-media test coverage. My additional 24fps square-pixel, 23.976fps odd-dimension, VFR and multiple-audio fixtures encoded and fully decoded. Mono 11,025Hz audio encoded, with the bitrate warning described above. Source-end empty MP4s failed the independent full-decode check. Ordinary outputs use H.264 yuv420p, libx264's selected High profile in the fixture, AAC LC where present, and `+faststart`. Input `-ss` enables accurate decode-seek rather than stream-copy GOP snapping. Explicit output `-t` and bounded b-roll input windows defend against overrun. No universal forced profile/level/GOP is inherently a demonstrated bug: actual fixture level varies with resolution/rate, and no deployment channel failure from the existing keyframe policy was established. Delivery-specific level/GOP/VBV requirements still need an explicit contract.

Attempt-unique object keys prevent stale attempts overwriting current bytes. Durable child writes lock/check run ID, attempt ID, lease owner, status and unexpired DB lease. Existing retries preserve completed members during interruption. Parent admission serializes one live rendering run per project. Export snapshots carry immutable editor state and output entitlement, avoiding live-editor drift. Export aggregate recomputation after worker lifecycle writes locks the parent, preventing sibling completion races. The manual retry path is the exception described above.

Process execution drains bounded stderr/stdout, applies deadlines, sends TERM/KILL to its own process groups, and cleans scratch in `finally`. Heartbeat failure aborts an expired attempt even with a query in flight. Shutdown aborts media work, releases owned attempts after grace and refunds the interrupted claim's retry. Full-render upload drain precedes scratch removal. These are substantial protections; the missing bounded cleanup/resource paths are specific gaps.

R2 multipart uploads buffer bounded 16MiB parts, sort completion records, wait for active parts and attempt abort on failure. Small uploads are bounded at 16MiB each. Download streaming honors cancellation. Metadata sanitization protects headers and bounds values. Provisional stale uploads are deleted when staleness is proven; the reconciler uses a 24-hour age threshold and rechecks references before deletion. The render-object reconciliation command exists, but is not scheduled by index.ts and does not inventory incomplete multipart uploads. Bucket abort-incomplete-upload lifecycle configuration was not verified. Crash-left objects/parts therefore need an operational cleanup gate.

Missing optional logo/b-roll/background/music have typed degradation tests; required inserted scene assets check identity, fingerprint, type, duration and decodability. Uploaded caption/text font deletion falls back to the saved built-in font; inserted scene fonts intentionally require their saved asset. I did not delete/expire real R2 assets. Font and unavailable-asset assertions were exercised through existing injected tests and local media only.

Zero-duration caption words were safely omitted in a production-plan fixture. A 15,000-word document was rejected by the 512KiB editor-document bound before planning. An admitted 5,000-word dense document planned/serialized in about 59ms and used about 180MiB process RSS; many sub-centisecond word events rounded to zero-length ASS intervals. That fixture is not representative speech and is not evidence of an unbounded-caption hang. Test realistic dense CJK/timestamp collisions and enforce a clear minimum visible-event policy before promising parity for malformed timing.

Speed changes currently belong to Studio playback controls; no serialized speed/atempo model was found in validators/composition/export. Do not implement export retiming under this audit. The brief's speed-change golden should establish that changing preview playback rate leaves persisted export timing unchanged. If actual baked export speed changes are intended, that is a missing product contract, not a render optimization.

Fixtures and scripts remain in `/tmp/render-audit-sol-media`, `/tmp/render-audit-sol-repro.ts`, `/tmp/render-audit-sol-maxgraph.ts`, `/tmp/render-audit-sol-text.ts`. JSON argument files reproduce the production commands. `rotated-real.mp4`, `short-audio-out.mp4`, `delayed-audio-out.mp4`, `sar-out.mp4`, `hdr-out.mp4`, and `hot-mix-out.mp4` are the demonstrated edge cases. `/tmp/render-audit-sol-decode.json` records independent decoding. Linux command-size behavior is supported by the kernel limit plus generated arguments; no Linux/Docker or hardware parity run was performed. No throughput/load/soak claim is made from these small tests.
