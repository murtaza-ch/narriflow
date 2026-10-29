# Render pipeline audit — Claude (independent), 2026-10-29

Scope and settled decisions as in `render-audit-brief.md`, including the **output-parity
hard constraint**. Anything that would change a rendered clip is marked **OWNER DECISION**.
Repro material lives in `/tmp/rendaudit` (scripts in `/tmp/rendaudit-scripts`).

## 1. Measured baseline

Sources: dev DB (read-only), `/tmp/worker-dev.log`, Railway logs for the current deployment
and deployments `12733606` and `c397dbe9`.

**Failure rate.** The DB has 27 `ClipRender` rows, all created 10-28 and 10-29: 21 completed
and 6 failed. All 6 failures are `EBADF`, marked `retryable`, and come from one local dev
worker. 7 of 7 `ClipExportVariant` rows completed. There are 12 `clip_rendering` runs: 11
completed and 1 `partial`. That run is `6e49595d`, project `53b0d959`: it rendered 3 of 10
clips in 3 attempts. A manual follow-up run (`365bf25e`, Railway) rendered 1 more, and **6
clips are still failed**. Railway's logs contain 20 of 20 variant completions with 0
failures. Excluding the local incident, the failure rate is 0/21. Including it, it is 22%.

**Why project `53b0d959` failed today.** Attempt 1 (10:32) and attempt 2 (10:36) were killed
by `bun --watch` restarts of the local worker. Three `bun --watch src/index.ts` processes
were running at once, and the log shows repeated EADDRINUSE errors. The reaper requeued each
attempt, and each one consumed an attempt. Attempt 3 (10:40) hit `EBADF: posix_spawn
ffprobe`. The ranged probe failed, which triggered a 21s full-source download. The local
probe then failed with EBADF too, and all 7 remaining variants were marked failed. Attempt
count reached the maximum of 3, so the run settled as terminal `partial`.

**Per-clip wall-clock on Railway.** These numbers come from the 10-clip run `aa7d7d0c` on
10-28 (clips 31–62s, 1080x1920, libx264 veryfast/CRF21, ranged source).
- Variant wall time (startedAt→completedAt): 11.9–32.7s, median 23.5s. The run took 211s
  for 494s of clip, about 0.43× clip duration.
- By phase, per clip:
  - Layout analysis before encode (segment extract ~4.9s plus detectors): 8–12.5s.
  - Encode: 5.5–16.5s.
  - Upload: 1.9–5.6s, overlapped with the next clip.
- Single-clip runs today took 14–19s end to end for a 26–31s clip.
- Peak cgroup memory per clip was 2.0–3.9 GiB. This figure includes page cache.

**Local (M-series, contended).** Encodes ran 10–23s for 24–38s clips. Uploads were very slow
on a residential uplink: 2.6 MB took 27.5s. A 4-variant export took 92–99s per variant.

**Output facts (real outputs).** H.264 High, level 4.0, yuv420p, bt709, 30000/1001 fps, AAC
LC 44.1 kHz stereo, faststart. Video and audio durations match the plan within 3 ms.

## 2. Findings

### P0

**P0-1 — No output validation; a truncated clip is marked `completed`.**
- Location: `apps/worker/src/tasks/clip-render-attempt.ts:1307-1349`. Only 720p outputs are
  probed, and only to log the size. `durationSec` is the *planned* value (`:1349`), not a
  measured one. Success depends entirely on ffmpeg's exit code.
- Repro (proven, using the production input flags): a range server that returns 503 partway
  through (`/tmp/rendaudit-scripts/flaky2.ts`). ffmpeg with `-reconnect* -rw_timeout -ss 10
  -t 30 … -t 30` **exits 0** and writes a **20.38s** file instead of 30s. Stderr only shows
  "Will reconnect… HTTP error 503 / Error splitting the input into NAL units". The same thing
  happens when the stalled R2 read is a real one. A 33.77s clip killed mid-encode also
  produced a valid, playable 14.78s MP4 (orphan `…-02fc1166…mp4`). Today that file is only
  rejected because the exit code was non-zero.
- Fix (parity-neutral): after encode, run `ffprobe` on the local file, which takes about
  50 ms. Assert:
  - The video stream matches the canvas size (or the 2/3 size for 720p) and has
    `nb_frames > 0`.
  - An audio stream exists if and only if one was planned.
  - The format and stream durations are within ±(1 frame + 50 ms) of `clipDurationSec`.

  On a mismatch, fail with retryable `render_output_invalid`. Persist the probed duration.
  Apply the same check in `clip-preview.ts` (which also has no output check).
- Test sketch: a fake `workerProcess.execute` resolves exit 0 for a 20s file when 30s was
  planned. Expect the variant to be failed/retryable, with no `completeClipRenderVariant`
  call.

**P0-2 — Rotation metadata is ignored, so portrait phone uploads are framed wrong.**
- Location: `apps/worker/src/worker-process.ts:776` uses the raw `width`/`height` and never
  reads `side_data_list.rotation` or `tags.rotate`.
- Repro (proven): `ffmpeg -display_rotation 90 …` produces a file that probes as
  **1920x1080 with rotation 90**. ffmpeg autorotates it, so the decoded frames are
  **1080x1920**. The plan computes crops in landscape space. `crop=608:1080:656:0` on the
  rotated frames **succeeds silently**, because ffmpeg clamps x, and outputs a wrong
  zoomed-in slice. This affects most iPhone portrait recordings.
- Fix: swap width and height for ±90/270 in `inspectMedia`, so ingest's `sourceProbe` and
  the render agree. This changes output **only for rotated sources, which are wrong today**
  (a demonstrated defect). **OWNER DECISION**, recommended.

### P1

**P1-1 — Optional-asset fallback fires on *any* primary failure.**
- Location: `clip-render-attempt.ts:817`.
- A source read failure, a 30-min timeout, or an OOM-kill all trigger a second full encode
  *without logo, music or SFX*. If the source recovers, the clip ships **silently missing
  its logo or music** and is recorded as success. A hung source costs 2×30 min.
- Fix: fall back only when the failure is attributable to an optional input. Two ways to
  detect that: probe the optional assets before encoding, or match stderr for that input
  index. Otherwise rethrow.
- Test sketch: primary rejects with `worker_command_failed`, diagnostic "Error opening input
  file https://…source…", and a logo is present. Expect a throw, not `"fallback"`.

**P1-2 — Infrastructure failures in layout analysis silently change framing, and some of
them stick.**
- Location: `apps/worker/src/layout-evidence.ts:242,272,291` and
  `clip-render-attempt-runtime.ts:470`.
- A transient R2 blip or detector crash during segment extraction (including a spawn
  failure) has two effects:
  - Automatic mode falls back to center crop for that render, marked success.
  - Screen and split modes **persist a durable typed failure** (`detection_unavailable` /
    `analysis_unavailable`) bound to the input fingerprint. Every later render reuses it, so
    the speaker-band or no-split framing becomes permanent.
- Not observed in the logs: dev has no screen or split evidence rows yet.
- Fix: treat extraction and detector *infrastructure* errors as retryable variant failures,
  and persist only content outcomes such as "no trustworthy faces".

**P1-3 — Partial runs never retry retryable variants.**
- Location: `packages/services/src/workflow-run-lifecycle.ts:2305-2308`
  (`shouldRequeue = succeeded === 0 && …`), per ADR-0003.
- A single R2 timeout in a 10-clip run leaves that clip `failed/retryable` forever, unless
  the user retries it. Today, 6 clips sit in exactly that state. This contradicts the brief's
  "retryable render failures stay nonterminal" and the owner's goal that no render should
  fail.
- Fix: drop `succeeded === 0`. Settlement already resets only the retryable rows.
  **OWNER DECISION** (ADR change). Parity-neutral.

**P1-4 — Spawn failures are mishandled, and restarts burn the attempt budget.**
- Location: `worker-process.ts:388`. `spawn()` is called inside the Promise executor, so a
  synchronous throw (EBADF) escapes as a raw `EBADF` code. It bypasses
  `worker_command_spawn_failed` and its diagnose call.
- That error is then treated in three wrong ways:
  - A ranged-probe spawn error triggers the full-source download (`:1017` catch → 21s).
  - It is treated as a per-clip failure, when it is really a sick worker.
  - It shares the 3-attempt run budget with crash and restart losses (today: 2 restarts
    plus 1 EBADF meant terminal).
- Fixes:
  1. Wrap `spawn` in try/catch.
  2. Classify spawn failures as worker-health failures: release the attempt without
     charging it, and mark the loop unhealthy.
  3. Fall back to download only on HTTP/IO probe errors.
  4. Verify that Railway's draining time (`RAILWAY_DEPLOYMENT_DRAINING_SECONDS`) is at least
     `WORKER_SHUTDOWN_DRAIN_MS` (30s). It is not set on the worker, so graceful release on
     deploy is unverified.

**P1-5 — Output depends on which machine claims the run.**
- Local dev workers claim renders from the shared queue. They run Bun **1.4.2**, Homebrew
  ffmpeg **8.0.1**/libass 0.17.4 and macOS fonts. Railway runs `oven/bun:1.3.6` with Debian
  apt ffmpeg and Noto fonts.
- Proven locally: the same ASS cue renders **CJK and emoji as tofu boxes**. Docker has
  `fonts-noto-cjk`. Today's renders of project `53b0d959` were split between the two
  machines.
- Fix: local workers must not claim `clip_rendering` and preview stages unless explicitly
  opted in (env flag), or run the Docker image. Also stop the 3 duplicate local workers
  (owner action; I did not touch them).

**P1-6 — Emoji captions appear in the Studio but never in the export.**
- The Studio preview draws `item.emoji`
  (`apps/web/…/studio/_components/caption-style-engine.tsx:398`). `apps/worker/src` has
  **zero** emoji references, and `caption-ass.ts` never serializes `emoji`. The comment at
  `packages/validators/src/caption-preset.ts:44` promises they match.
- libass cannot draw color emoji in any case, so a fix needs PNG overlays.
- Demonstrated defect. **OWNER DECISION**, because the fix changes output.

**P1-7 — HDR/10-bit sources produce 8-bit output tagged as PQ/BT.2020.**
- Proven: a PQ yuv420p10le source rendered through the production chain comes out as High
  yuv420p, `bt2020nc/smpte2084/bt2020`.
- On HDR displays, SDR captions and logo are interpreted as PQ, which washes out or blows
  out the picture. Platforms handle 8-bit PQ inconsistently. There is no HDR handling in
  ingest or render.
- Fix: tonemap to bt709 for HDR sources only. **OWNER DECISION**.

**P1-8 — The build is not reproducible, which threatens framing parity.**
- Location: `apps/worker/Dockerfile:17,32,35`.
- `opencv-python-headless` and `numpy` are unpinned. The YuNet model comes from opencv_zoo
  **`main`** with no checksum. apt `ffmpeg` is unpinned.
- Any rebuild can silently change face detection, and therefore crops, or change the
  encoder output.
- Fix: pin pip versions, pin the model by commit SHA plus sha256, and pin the base image
  digest. Parity-neutral, and it is a prerequisite for the parity gate.

### P2

1. **Spurious "attempt lost" after a successful settlement.**
   `workflow-run-lifecycle.ts:1861-1904`: if a heartbeat is in flight during settlement, it
   blocks on the row lock and then sees `status != running`, so it throws Lost. Observed:
   `workflow_attempt_lost` 3 ms after `clip_render_attempt_settled completed` (10:26:46).
   Fix: stop heartbeats before settlement, or ignore Lost once the handler has resolved.
2. **Scratch directories leak on crash.** There are 3 orphaned `narriflow-render-*`
   directories in `$TMPDIR`, including partial outputs. In download mode they would hold the
   whole source. Fix: on startup, sweep `narriflow-render-*`/`clip-preview*` directories
   older than the lease.
3. **Poison clip.** The run-level attempt budget is shared by every clip. A clip that
   OOM-kills the container takes the remaining clips down with it after 3 crashes, and
   there is no per-ffmpeg memory bound (peak 3.9 GiB). Fix: count crash-interrupted starts
   per variant and fail only that variant as permanent after 2.
4. **Timeouts are not sized to the work.**
   - ffmpeg gets a fixed 30 min regardless of clip length (max clip 180s). Use e.g.
     `max(5 min, 20×duration)`.
   - The source download fallback uses the 2-min storage timeout, which is too short for
     multi-GB sources.
5. **Frame rate and SAR come from the wrong fields.**
   - `probe.fps` uses raw `r_frame_rate` (`worker-process.ts:781`) and feeds `fps=` in the
     background-image paths. `sourceProbe` already uses `measuredFrameRate`. Use the same
     one; output is identical for standard-rate sources.
   - SAR is ignored, so anamorphic sources come out squeezed. That is an **OWNER DECISION**.
6. **The yt-dlp selector contradicts its comment.** `ingest.ts:68` says it prefers H.264
   but selects **AV1** (`399+140` for 2reQut8WNGc). AV1 decode-only takes 1.40s vs 0.58s
   for H.264 per 40s. Switching changes source pixels (rough SSIM 0.985, below the gate), so
   it is an **OWNER DECISION** and only affects new imports.

## 3. Performance levers

All of these are parity-gated.

1. **Use layout evidence that arrives mid-run** (biggest win, about −30–45% wall time per
   clip on first renders).
   - Today the render snapshots `clip.autoLayoutAnalysis` at attempt start. Meanwhile the
     background loop analyses the same clips. In the 10-28 run, all 10 clips re-ran
     detectors (`detectorExecutionCount=2`, `extractedSegmentCount=1`), at 8–12s each. One
     of them, `993e50f6`, had durable evidence 2 minutes before its render.
   - Fix: re-read durable evidence per clip group, and/or have the background loop skip
     clips in a live work set. This also removes CPU contention.
   - Parity caveat: confirm that proxy-based and source-based evidence produce identical
     plans. Today, framing already depends on which analysis path won the race.
2. **Clip-group leases across replicas** (settled direction, not implemented). Within a
   project, throughput scales roughly linearly with replica count. Bit-identical output.
3. **Deprioritise the preview, auto-layout and thumbnail loops while a render is
   encoding.** Same-box contention roughly doubled local encode times. Bit-identical output.
4. **Reuse `Project.sourceProbe`** instead of the per-run ranged ffprobe (−1.2–2s per run),
   and stop downloading the full source on spawn errors.
5. **Don't tune x264.** For a real 38s 1080x1920 clip, encode-only at veryfast takes 3.2s,
   while the in-pipeline render took about 22s. superfast is only 27% faster encode-only,
   produces files 79% larger, and has SSIM 0.997. The filter graph and analysis dominate.
   Railway has no GPU, so hardware encode is not an option.
6. **One decode, N outputs for multi-aspect exports.** Today 4 variants mean 4 decodes and
   4 ranged reads. The gain is modest and the x264 thread layout changes slightly, so it
   needs the SSIM gate.

## 4. Parity harness design

The harness should run **inside the pinned production image**.

- **Reference set** (about 12 clips): frozen editor documents plus **frozen layout
  evidence** JSON. Store the sources under an R2 `golden/` prefix, and cache b-roll and
  music files instead of fetching Pexels live. Cases:
  - Layouts: solo auto, two-up speaker, screen/PiP, split.
  - Captions: RTL, CJK and emoji, plus 100+ cues.
  - Overlays: logo, b-roll, music, SFX and censor beep.
  - Timing and treatment: a clip at source end, 720p with watermark, and an image
    background.
  - Source variety: a rotated phone portrait, 10-bit HDR, VFR, mono 44.1k, and no audio.
- **Script.** `apps/worker/scripts/render-golden.ts` plans and compiles straight from the
  documents, with no DB. It records:
  1. The plan JSON: per-scene crop rects and tracks, the cue list (text, times, position)
     and the layer list. These must match **exactly**.
  2. The argv hash.
  3. ffprobe metadata: codec, profile, level, pix_fmt, color tags, size, SAR, r/avg fps,
     `nb_frames`, duration ±1 frame, and audio codec/rate/channels.
  4. Per-frame `ssim=stats_file`, requiring min ≥ 0.99.
  5. `ebur128` integrated loudness within ±0.5 LU, and true peak.
  6. PNG snapshots at cue midpoints for human review.
- **Gate.**
  - For hardening-only changes (validation, retries), require **identical argv and
    identical `framemd5`**. That is a stronger check than SSIM.
  - Use the SSIM and LU thresholds only for encoder-level changes.
  - Regenerate the baseline only on an owner-approved output change.

## 5. What's solid

- **Fencing and ownership.** Attempt-fenced child writes. Storage keys are unique per
  attempt, and provisional objects are deleted when persistence is rejected. Multipart
  uploads abort on error, and there is an orphan reconciler. Every
  `ClipExportVariant` write ends in `syncClipExportAggregates`.
- **Process management.** Process-group kill with a SIGKILL grace period. Bounded stderr
  diagnostics with URLs redacted. Graceful shutdown releases the attempt without charging
  it.
- **Throughput already in place.** Ranged source reads with reconnect and `rw_timeout`. The
  upload queue overlaps the next encode.
- **Output and media handling.**
  - Explicit output `-t` bound and faststart.
  - `drawtextLiteralText` is used for the watermark.
  - Typed degradation for logo, music and b-roll downloads.
  - One shared composition plan. Audio branches use `apad` before `atrim` so they always
    reach the planned length.
- **Telemetry.** Per-phase timings (presign, probe, spawn, encode, upload, drain, RSS) were
  enough to reconstruct every incident above.
- **Tests.** 155 core tests pass: the adapter, render-attempt, worker-process and
  render-config suites.
