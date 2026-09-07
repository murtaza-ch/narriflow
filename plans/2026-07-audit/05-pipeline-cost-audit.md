# Narriflow pipeline: speed + infra cost audit

Scope: `apps/worker/src/**`, `packages/services/src/{project,workflow,clip,dubbing}.service.ts`,
`packages/services/src/r2-storage.ts`, `packages/db/prisma/schema.prisma`.
Read-only. All ffmpeg numbers below are **measured on this machine** (see "Measurement rig");
everything else is either read off the source or computed from stated assumptions.

---

## Measurement rig

- ffmpeg 8.0.1 (Homebrew), 8 physical cores.
- Synthetic source: `testsrc2` 1920x1080@30 + sine audio, encoded x264, concatenated to a
  3600 s / 3.3 GB file for the deep-seek tests.
- ASS caption file generated to match `generateAssFromSlice` output shape
  (`render-clips.ts:430`): one `Dialogue:` line per word, `\an5\pos()`, per-word colour override.
- Filter chain copied verbatim from `buildCropAndScaleFilter` + `buildSubtitleFilter`
  (`render-clips.ts:800`, `render-clips.ts:697`): `crop=608:1080,scale=1080:1920,format=yuv420p,ass=...`

### Raw measurements (60 s clip, 1080p source → 1080x1920 output)

| Step | Wall clock |
|---|---:|
| decode only → null | 1.64 s |
| + crop + scale | 2.00 s |
| + ASS burn-in | 2.82 s |
| **+ libx264 `-preset medium -crf 23` (current code)** | **10.28 s** |
| + libx264 `-preset faster -crf 23` | 8.00 s |
| + libx264 `-preset veryfast -crf 23` | 5.63 s |
| + libx264 `-preset veryfast -crf 21` | 6.40 s |
| + `h264_videotoolbox -b:v 6M` | 9.45 s |

**Encoding is 73 % of clip-render wall clock** (10.28 − 2.82 = 7.46 s of 10.28 s).
Decode, crop/scale and caption burn-in together are only 27 %.

### Concurrency measurements (4 x 60 s clips, same box)

| Config | Wall clock |
|---|---:|
| sequential, `medium` (**current code**) | 39.50 s |
| 4-way parallel processes, `medium` | 40.49 s |
| 4-way parallel processes, `medium -threads 2` | 39.27 s |
| 4-way parallel processes, `veryfast` | 23.28 s |
| sequential, `veryfast` | 22.36 s |

3 aspect-ratio variants of one clip: sequential processes 32.12 s, parallel processes 30.68 s,
single process with `split=3` (the `buildMultiVideoArgs` path, `render-clips.ts:1143`) 25.35 s.

> **Counter-intuitive but measured: intra-machine parallelism buys ~0.**
> libx264 frame-threading already saturates all cores (default = 1.5 x cores). Running N encodes
> concurrently just time-slices the same CPU. The brief's hypothesis (h) "segment-parallel
> encoding" and the general "render clips in parallel" instinct are **not** speed wins on a
> single box. The only per-machine encode lever is the preset. Parallelism is worth adding for a
> different reason — to stop I/O-bound stages blocking CPU-bound ones (finding C-1).

### Seek + audio measurements

| Step | Wall clock |
|---|---:|
| `-ss 3000` **before** `-i` on a 60-min source (current code) | 6.91 s |
| `-ss 3000` **after** `-i` (naive) | 94.29 s |
| STT audio extract, whole 60-min source (`transcribe.ts:432`) | 5.71 s |
| detector-equivalent: decode every frame → bgr24, 60 s | 2.51 s |
| optimal: `fps=4,scale=640:-2` → bgr24, 60 s | 1.52 s |

---

## 1. End-to-end latency budget — 60-minute source

**Assumptions** (stated so you can re-run the arithmetic):
- Source 60 min, 1080p30 H.264 @ ~5.5 Mbps ⇒ **2.5 GB**.
- Worker ↔ R2 single-stream throughput **25 MB/s** (200 Mbit/s). Realistic band 12–50 MB/s.
- 10 clips (`resolveDefaultClipCountTarget`, `detect-clips.ts:346` returns 10 for ≥45 min),
  1 aspect ratio (`autoQueueDefaultRenders` default `9:16`, `clip.service.ts:990`), avg 45 s each.
- AssemblyAI provider-side turnaround **120 s** — *provider-side, not measurable here; flagged*.
- OpenAI `gpt-5.4-mini` at `reasoning.effort=medium` on ~22 k input tokens **90 s** —
  *estimate, not measurable here; flagged*.
- Auto-reframe ON (default: `WORKER_AUTO_REFRAME !== "0"`, `render-clips.ts:1743`), paid tier.

| Stage | Step | file:line | Time | Serial? |
|---|---|---|---:|---|
| ingest | poll pickup | `index.ts:229` | 0–2.5 s | — |
| ingest | `headObject` + presign + ffprobe over HTTP range | `ingest.ts:161-173` | ~2 s | ok |
| ingest | `completeIngestJob` → enqueue `stt` | `project.service.ts:2209` | 0.2 s | — |
| **stt** | poll pickup | `index.ts:122` | 0–2.5 s | — |
| **stt** | **R2 GET full 2.5 GB source → local disk** | `transcribe.ts:467` | **100 s** | **avoidable** |
| **stt** | ffmpeg audio extract (measured 5.71 s) | `transcribe.ts:432` | 6 s | avoidable |
| **stt** | `readFileSync` 28 MB + upload to AssemblyAI | `transcribe.ts:211` | 3 s | avoidable |
| **stt** | AssemblyAI queue + transcribe (`speaker_labels: true`) | `transcribe.ts:277` | **120 s** | provider |
| **stt** | poll granularity overshoot (5 s jittered) | `transcribe.ts:419` | +2.5 s | fixable |
| **stt** | `putJson` raw payload + DB writes | `transcribe.ts:494` | 2 s | ok |
| | **stt subtotal** | | **~234 s** | |
| **md** | poll pickup | `index.ts:130` | 0–2.5 s | — |
| **md** | transcript fetch (~10 MB `utterancesJson`) | `detect-clips.ts:849` | 1 s | ok |
| **md** | **OpenAI call, reasoning effort=medium** | `detect-clips.ts:791` | **90 s** | **tunable** |
| **md** | persist clips + queue render run | `detect-clips.ts:1182` | 1 s | ok |
| | **md subtotal** | | **~95 s** | |
| **render** | poll pickup | `index.ts:138` | 0–2.5 s | — |
| **render** | **R2 GET the SAME 2.5 GB source AGAIN** | `render-clips.ts:1547` | **100 s** | **duplicate** |
| **render** | `ffprobe` + brand snapshot + logo GET | `render-clips.ts:1558-1580` | 1 s | ok |
| **render** | 10 x YuNet face detection (est. 25 s/clip) | `render-clips.ts:1757` | **~250 s** | **avoidable** |
| **render** | 10 x ffmpeg encode @ `medium` (measured 10.28 s) | `render-clips.ts:2053` | 103 s | tunable |
| **render** | 10 x R2 PUT ~14 MB | `render-clips.ts:1485` | 6 s | ok |
| **render** | 10 x DB write + progress publish | `render-clips.ts:2113` | 3 s | ok |
| **render** | *(free tier only)* 10 x second full encode + ffprobe | `render-clips.ts:1443-1481` | +66 s | **waste** |
| | **render subtotal (paid)** | | **~464 s** | |

**End-to-end ≈ 798 s ≈ 13 min 20 s** (free tier ≈ 14 min 26 s).
With `WORKER_AUTO_REFRAME=0`: ≈ 548 s ≈ 9 min 10 s.

### Time-to-first-clip = time-to-LAST-clip

`apps/web/app/(app)/projects/[projectId]/project-events.tsx:65-74` calls `router.refresh()`
**only when `parsed.status === "completed" || "failed"`**. Intermediate `running` progress events
move a progress bar and nothing else. `completeClipRenderVariant` (`clip.service.ts:729`) writes
the row and records an analytics event but publishes **no** workflow event.

⇒ Clip #1 finishes rendering at ~t+7 min but is not visible until the whole run completes at
**t+13 min 20 s**. On the exact metric competitors market, Narriflow is showing its worst number.

### What is serialized that could be parallel

1. **The whole worker.** `index.ts:26` `let polling = false` + the guard at `index.ts:103-105`
   means one worker processes exactly **one job at a time**, and the flag is held for the entire
   job (`finally` at `index.ts:188`). While the STT stage sleeps in its AssemblyAI poll loop
   (`transcribe.ts:391-420`, up to 2 h) the machine does nothing else. ~210 s of the 798 s budget
   is pure blocking wait on an external API with a fully idle CPU.
2. **Stage claims are ordered and greedy.** `index.ts:112-153` tries ingest → stt →
   moment_detection → clip_rendering → dubbing and `return`s on the first hit. A steady stream of
   ingest jobs starves rendering indefinitely.
3. **Clip render loop is sequential** (`render-clips.ts:1641`). Parallelising it does not help
   (measured above) — but interleaving it with I/O stages does.
4. **Detection chunk loop is sequential** (`detect-clips.ts:1031`). No effect at 60 min (one
   chunk — `MAX_CHARS_PER_CHUNK` = 320 000, a 60-min transcript is ~82 000 chars), but a 3-hour
   podcast produces 6 chunks x 90 s = 9 min serialized that could be one `Promise.all`.
5. **Multipart upload parts are sequential** (`r2-storage.ts:255-284`), 64 MB at a time.
6. **STT audio extraction is serialized behind a full download** rather than streamed.

---

## 2. Concurrency model

| Question | Answer | Evidence |
|---|---|---|
| Workflow runs claimed at once | **1 per worker process, globally serialized** | `index.ts:26`, `index.ts:103-105`, `index.ts:188` |
| Clips rendered in parallel | **0 — strictly sequential** | `render-clips.ts:1641` |
| Aspect-ratio variants in parallel | 1 ffmpeg process with `split=N` (only when no b-roll/studio edits) | `render-clips.ts:1143`, `render-clips.ts:2042` |
| ffmpeg `-threads` | **never set anywhere** (grep confirms zero occurrences) | — |
| ffmpeg preset | `medium` in all five encode paths | `render-clips.ts:969, 1110, 1230, 1355, 1420` |
| Per-machine cap tied to CPU count | **none** | — |
| Head-of-line blocking | **yes, total** | `index.ts:112-153` |
| Fairness between users/projects | **none** — strict FIFO on `createdAt` | `project.service.ts:1724` |
| Priority queue for paid tiers | **none** — tier is read only to decide watermarking | `render-clips.ts:1529` |

**Consequences.**
- One Pro user uploading a 3-hour source (allowed: `MAX_UPLOAD_LENGTH_SECONDS.pro`,
  `pricing.ts:29`) occupies the worker for ~40 min. Every free-tier 5-minute upload behind it
  waits the full 40 min. There is no interleaving, no fairness, no preemption.
- Adding worker replicas *does* work — `claimNextWorkflowRun` uses a conditional
  `updateMany(where status='queued')` with a 5-attempt bounded retry (`project.service.ts:1746-1758`),
  which is a correct optimistic claim. But each replica is still 1-job-at-a-time, so scaling is
  purely horizontal and coarse.
- `-threads` unset is *fine today* (one ffmpeg at a time, auto-threading is optimal). It becomes a
  problem the moment you add intra-machine parallelism — and the measurement above says don't.

### Recommended concurrency shape (measurement-driven)

Do **not** parallelise encodes on one box. Instead split the poller's single mutex into
**per-class slots**:

```
io slots   = 8   (stt polling, moment_detection, ingest download, dubbing TTS)  — network-bound
cpu slots  = 1   (clip_rendering)                                               — CPU-saturating
```

That removes head-of-line blocking without any extra hardware, because the ~210 s of STT/LLM
wait per project stops occupying the box. Then add per-user fairness by ordering the claim query
by `(tier_rank, createdAt)` or by round-robin over `userId`.

---

## 3. Biggest speed wins, ranked

Times are for the modelled 60-min / 10-clip job.

| # | Win | Saves | Sev | Where |
|---|---|---:|---|---|
| 1 | **Fix the face detector** (see F-1) | **~220 s** | High | `scripts/reframe_detect.py`, `render-clips.ts:1757` |
| 2 | **Publish a per-clip event + refresh on `running`** → time-to-first-clip drops from 800 s to ~215 s | **~585 s of *perceived* latency** | High | `clip.service.ts:729`, `project-events.tsx:65` |
| 3 | **Hand AssemblyAI a presigned R2 URL** instead of download→transcode→upload | **~109 s** + 2.5 GB disk | High | `transcribe.ts:467-486` |
| 4 | **Eliminate the second full source download** in render (reuse via a cached/shared local copy, or a 720p proxy produced once) | **~100 s** | High | `render-clips.ts:1547` |
| 5 | **`-preset veryfast -crf 21`** (quality-neutral) or `veryfast -crf 23` | **34–47 s** | High | `render-clips.ts:969` +4 sites |
| 6 | **Split the poller mutex into io/cpu slots** — removes head-of-line blocking; no change to a single job's latency but ~4x throughput at fixed hardware | queue-wait, not job-time | High | `index.ts:103-153` |
| 7 | **Fold the free-tier watermark into the main filtergraph** (no second encode, no third ffprobe) | **66 s** on free tier | Med | `render-clips.ts:1443-1481` |
| 8 | **`reasoning.effort=low`** for clip detection + `prompt_cache_key` for the static system prompt | **~40 s**, ~35 % of LLM cost | Med | `detect-clips.ts:791` |
| 9 | **Caption-only re-render fast path** — re-burn from the finished 1080p render instead of re-downloading the 2.5 GB source and re-encoding from scratch | **~105 s per caption tweak** | Med | `clip.service.ts:187-197`, `:622-627` |
| 10 | **Cap yt-dlp format** to `bv*[height<=1080]+ba/b[height<=1080]` — today it fetches the best available, up to 4K/8K, for a pipeline whose max output is 1080p | 30–70 % of link-import time and bytes | Med | `ingest.ts:312-330` |

Explicitly evaluated and **rejected** (measured):

- **(h) segment-parallel encoding / parallel clip renders** — 4-way parallel `medium` measured
  40.49 s vs 39.50 s sequential. Zero gain; libx264 already saturates the cores.
- **(f) hardware accel** — `h264_videotoolbox` measured 9.45 s vs libx264 `veryfast` 5.63 s, and
  produced 43.9 MB vs 17.7 MB for the same clip. On this box HW accel is both slower and much
  worse per byte, because the chain is `crop→scale→ass` on the CPU and every frame has to be
  uploaded to the encoder. NVENC on a Linux GPU box was not testable here and may differ, but
  it is not the cheap win it looks like — take the preset change first.
- **(e) `-ss` before `-i`** — **already correct** (`render-clips.ts:938`). Measured 6.91 s vs
  94.29 s for the naive ordering on a deep seek. This is worth **87 s per clip**; guard it with a
  test so nobody "fixes" it into the slow form.
- **(a) streaming STT / partial-transcript detection** — real but low ROI here: at 60 min the
  transcript is a single LLM chunk (82 k chars < the 320 k `MAX_CHARS_PER_CHUNK` threshold,
  `detect-clips.ts:255`), so there is nothing to overlap. Revisit for 3-hour sources, where
  `Promise.all` over the 6 chunks (`detect-clips.ts:1031`) saves ~7 min.
- **(b) render clips as detected** — subsumed by #2. The rendering already emits per-clip; the
  gap is purely that the UI ignores non-terminal events.

---

## 4. FFmpeg / ffprobe command audit

Every invocation in the repo (grep-verified: 4 ffmpeg call sites, 3 ffprobe call sites).

### 4.1 `transcribe.ts:432` — STT audio extraction
```
ffmpeg -y -i <source> -vn -ac 1 -ar 16000 -b:a 64k out.mp3
```
- ✅ `-vn` means video is never decoded. Measured 5.71 s for a full 60-min source — cheap.
- ⚠️ **64 kbps MP3 at 16 kHz mono is ~4x more bits than an ASR model can use.** 28.8 MB where
  ~10 MB (`-c:a libopus -b:a 24k`) or ~14 MB (`-b:a 32k` mp3) is transparent for speech.
  Cuts the upload leg by ~2/3.
- ⚠️ No `-threads`, no `-map 0:a:0` — a source with multiple audio streams gets ffmpeg's default
  stream selection (loudest/first), which is usually right but is unpinned.
- 🔴 **The whole step is avoidable**: AssemblyAI accepts `audio_url`. Pass
  `presignDownloadUrl({key: sourceStorageKey})` and skip the download + transcode + upload
  entirely (R2 egress is $0, so their pull costs nothing).

### 4.2 `ingest.ts:185` — duration probe
```
ffprobe -v quiet -print_format json -show_format <url|path>
```
- ✅ **Best-in-repo.** Run against a presigned URL (`ingest.ts:168`) so it reads the moov atom
  over range requests instead of downloading the file. Keep this pattern; it is the template for
  the other stages.
- ⚠️ No `-analyzeduration` / `-probesize` cap — a malformed file can make ffprobe read far more
  than the header. `METADATA_PROBE_TIMEOUT_MS` bounds it, so low severity.

### 4.3 `render-clips.ts:262` — source probe
```
ffprobe -v quiet -print_format json -show_streams <local path>
```
- ✅ Correct, once per run.
- 🔴 Called a **second time per free-tier variant** at `render-clips.ts:1474` purely to populate a
  log line (`free_tier_export_treatment` width/height). 10 extra process spawns per free-tier run
  for a value that is already known statically (2/3 of the aspect config). Delete it.

### 4.4 `render-clips.ts:876` `buildSingleVideoArgs` — the main render
```
ffmpeg -y -ss <start> -t <dur> -i <source> [-i logo] [-stream_loop -1 -i music]
  -filter_complex "[0:v]crop=W:H,scale=1080:1920,format=yuv420p,ass='...'[outv]"
  -map [outv] -c:v libx264 -preset medium -crf 23
  -map 0:a:0? -c:a aac -b:a 128k
  -movflags +faststart -max_muxing_queue_size 1024 out.mp4
```
- ✅ `-ss` **before** `-i` — correct fast seek. Measured 6.91 s vs 94.29 s. Do not regress.
- ✅ `-t` before `-i` correctly bounds input reading.
- ✅ `format=yuv420p` present — required for social platform compatibility.
- ✅ `+faststart` present on every output.
- ✅ `crop` before `scale` — cheaper order (scales fewer pixels).
- 🔴 **`-preset medium`.** Measured 73 % of wall clock. `veryfast -crf 23` is 45 % faster with a
  4 % *smaller* file; `veryfast -crf 21` is 33 % faster at +17 % bytes and visually equivalent.
- ⚠️ **No `-threads`.** Fine today (serial renders). Must be set to `ceil(cores/slots)` the moment
  you add cpu slots > 1, or the encoders will thrash.
- ⚠️ **No `-g` / `-keyint_min`.** Default GOP 250 (~8 s). TikTok/Reels re-encode anyway, so low
  impact, but `-g 60` makes the delivered files seekable and is free.
- ⚠️ Audio is **re-encoded to AAC 128k for every variant** even though all variants of a clip
  share identical audio. ~0.4 s x 30 variants. Encode once, `-c:a copy` into the siblings.
- ⚠️ `-max_muxing_queue_size 1024` is a legacy ffmpeg-3-era workaround; harmless on ffmpeg 8.

### 4.5 `render-clips.ts:1000` `buildBrollVideoArgs`
Same encoder flags → same preset finding.
- ⚠️ The b-roll input is **not** `-ss`-trimmed; the whole Pexels file is decoded and delayed with
  `setpts=PTS-STARTPTS+start/TB` (`render-clips.ts:1042`) for a ≤3.5 s cutaway
  (`planBrollWindow`, `broll.ts:76`). Add `-ss 0 -t <window>` on input 1.
- ⚠️ Taking this branch **disables the `split=N` single-decode multi-output path** — with b-roll
  or any studio edit, N variants each re-decode the source (`render-clips.ts:1962-2025`).
- ⚠️ `overlay` runs at full 1080x1920 with `enable='between(...)'`; the filter is evaluated for
  every frame even outside the window. Minor.

### 4.6 `render-clips.ts:1143` `buildMultiVideoArgs` — split multi-output
```
ffmpeg -y -ss .. -t .. -i src [-i logo]
  -filter_complex "[0:v]split=3[v0][v1][v2];[v0]crop..,ass=..[outv0];..."
  -map [outv0] -map 0:a:0? -c:a aac -b:a 128k -c:v libx264 -preset medium -crf 23 ... out0.mp4
  -map [outv1] ... out1.mp4
```
- ✅ Single decode feeding N encoders — correct idea, and the per-output option ordering is right.
- ⚠️ Measured 25.35 s vs 32.12 s for 3 separate processes: only **21 %** better, because the 3
  in-process encoders share one thread pool. Real but smaller than it looks.
- 🔴 Only reachable when there is **no** b-roll, **no** studio edits, **no** music
  (`render-clips.ts:2026`). The common "brand template + music" case falls into the slow path.
- ⚠️ Does not pass `studioEdits` at all (`render-clips.ts:1161-1167` omits it) — which is why the
  caller has to route around it; that coupling is the root cause of the previous point.

### 4.7 `render-clips.ts:1253` `buildAudiogramArgs`
- ✅ Correct for audio-only sources; `showwaves rate=25` is cheap.
- ⚠️ `-preset medium` again on a synthetic, trivially-compressible waveform where `veryfast`
  costs nothing in quality.

### 4.8 `render-clips.ts:1389` `buildFreeTierPostProcessArgs` — **double encode**
```
ffmpeg -y -i <just-rendered.mp4>
  -vf "scale=trunc(iw*2/3/2)*2:trunc(ih*2/3/2)*2,drawtext=..."
  -c:v libx264 -preset medium -crf 23 -c:a copy -movflags +faststart out.wm.mp4
```
- ✅ `-c:a copy` — audio is not re-encoded. Good.
- 🔴 **This is a full second decode + full second H.264 encode of every free-tier clip**, ~6 s per
  clip on top of the 10.3 s primary encode. For a 10-clip free job that is +66 s and +60 % CPU
  cost, on the tier with the worst unit economics.
- 🔴 The 1080p intermediate is encoded at `crf 23` and then thrown away — the free tier pays for
  1080p quality it never ships.
- **Fix**: append `scale=...,drawtext=...` to the primary filtergraph and emit 720p directly.
  Removes the entire pass and the `probeSource` at `:1474`. Saves ~6.6 s/clip.
- ⚠️ No `format=yuv420p` after `scale` in this pass. Safe today (input is already yuv420p) but
  brittle.

### 4.9 `dubbing.ts:335` — dubbed mux
```
ffmpeg -y -i video -i audio -map 0:v:0 -map 1:a:0 -c:v copy -c:a aac -b:a 160k
  -shortest -movflags +faststart out.mp4
```
- ✅ **Exemplary**: `-c:v copy`, no video re-encode, faststart set. This is exactly the pattern
  the caption-only re-render path should copy (finding #9).
- ⚠️ `-b:a 160k` for TTS-generated mono speech is ~2x what is needed; `96k` is transparent.

### 4.10 `dubbing.ts:317` — duration probe
```
ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 <path>
```
✅ Minimal and correct.

---

## 5. Cost per source-hour

### 5.1 Stated assumptions

| Input | Value | Basis |
|---|---|---|
| Source size | 2.5 GB / hour | 1080p30 H.264 @ 5.5 Mbps |
| Extracted audio | 28.8 MB | `-b:a 64k` x 3600 s, `transcribe.ts:441` |
| Renders | 10 clips x ~14 MB = 140 MB | 45 s @ crf 23, measured 18.4 MB for 60 s |
| Raw transcript JSON | ~6 MB | `putJson` of the full AssemblyAI payload, `transcribe.ts:494` |
| LLM input tokens | ~22 000 | derived from `formatTranscriptForLlm` line shape x ~450 utterances |
| LLM output + reasoning | ~13 000 | 36 candidates (`resolveCandidateCountTarget(10, 3600)`) x ~140 tok, plus reasoning at `effort=medium` |
| R2 | $0.015/GB-mo, $4.50/M class A, $0.36/M class B, **$0 egress** | Cloudflare published |
| Compute | $0.06 / machine-hour | 4 vCPU cloud instance; substitute yours |
| AssemblyAI | **$0.27 / audio-hour** | ⚠️ **UNVERIFIED** — post-cutoff SKU (`universal-3-5-pro`, `language.ts:117`). Treat as a parameter. |
| OpenAI `gpt-5.4-mini` | **$0.25/M in, $2.00/M out** | ⚠️ **UNVERIFIED placeholder** — post-cutoff model. Treat as a parameter. |

### 5.2 R2 operations (counted from source)

Class A (writes, `$4.50/M`): browser multipart ≈ 52 (create + ~50 parts + complete) + 1 `putJson`
(`transcribe.ts:494`) + 10 `putFileFromPath` (`render-clips.ts:1485`; each render <100 MB so
single `PutObject`, `r2-storage.ts:219`) = **63 ops = $0.00028**.
Class B (reads, `$0.36/M`): 1 `headObject` + ~6 ffprobe range GETs + 1 STT GET + 1 render GET +
1 logo GET = **~10 ops = $0.0000036**.
Presigning is client-side and free. **Operations are noise — do not optimise them.**

### 5.3 Compute seconds (from the §1 budget)

Current worker occupancy per source-hour = 789 s = 0.219 machine-hours → **$0.0131**.
Note this *includes ~210 s of fully-idle blocking on AssemblyAI/OpenAI* — you are paying for a
machine to sleep.
After optimisation (detector fixed, veryfast, one download, io/cpu slots so waits don't occupy the
box): ~203 s = 0.056 machine-hours → **$0.0034**.

### 5.4 Itemised, before and after

| Line item | Now | Optimised | Note |
|---|---:|---:|---|
| AssemblyAI STT | $0.2700 ⚠️ | $0.2700 ⚠️ | dominant; see levers below |
| OpenAI moment detection | $0.0315 ⚠️ | $0.0120 ⚠️ | `effort=low` + prompt cache |
| Compute | $0.0131 | $0.0034 | §5.3 |
| R2 operations | $0.0003 | $0.0003 | negligible |
| R2 storage — **month 1** | $0.0397 | $0.0397 | 2.65 GB x $0.015 |
| **Total, month 1** | **$0.355** | **$0.286** | |
| R2 storage — **cumulative at month 12** | **$0.477** | **$0.0397** | ← the real story |
| **Total, steady state @ 12 mo** | **$0.792** | **$0.301** | |

⚠️ = external list price I could not verify from the codebase or my knowledge; substitute your
contract rate. The *structure* of the model holds regardless.

### 5.5 🔴 The finding that matters: storage is unbounded and eats the margin

`sourceStorageKey` is **never** passed to `deleteObject`. Grep confirms `deleteObject`
(`r2-storage.ts:397`) has exactly one caller — `deleteRenderAssets` (`clip.service.ts:199`),
which only ever removes *render* outputs. There is no `deleteProject`, no lifecycle rule, no TTL.
`WorkflowEvent` is likewise never purged (only `WebhookDeliveryLog` is, `index.ts:77`).

Every source-hour ever processed adds **2.65 GB permanently**.

Against your own pricing (`pricing.ts:17-22`, `:71-78`):

| Tier | Revenue / source-hour | Cost @ mo 1 | Cost @ mo 12 | Cost @ mo 24 |
|---|---:|---:|---:|---:|
| Starter $7 / 300 min | $1.40 | $0.36 | $0.79 | $1.27 |
| Creator $12 / 600 min | $1.20 | $0.36 | $0.79 | $1.27 |
| **Pro $24 / 1800 min** | **$0.80** | $0.36 | **$0.79** | **$1.27** |

**A fully-utilised Pro seat goes gross-margin-negative between month 12 and month 24, purely from
never deleting source video.** Fixes, cheapest first:

1. **30-day lifecycle rule** on `projects/*/link/*`, `projects/*/rss/*`, `projects/*/uploads/*`.
   Turns unbounded growth into a flat $0.0397/source-hour. One R2 console setting, zero code.
2. After `clip_rendering` completes, replace the source with a 720p @ 2 Mbps proxy (~0.9 GB) —
   enough for re-renders, 64 % smaller. Costs one transcode.
3. Delete the raw AssemblyAI JSON (`transcribe.ts:490`) once `utterancesJson` is persisted; the
   normalised form is already in Postgres.

### 5.6 STT cost levers (76 % of variable cost)

- `speaker_labels: true` is **unconditional** (`transcribe.ts:277`). Diarization is a priced
  add-on and adds provider-side latency. Only request it when the content pack actually needs
  speaker attribution.
- `ASSEMBLYAI_SPEECH_MODEL_CHAIN` puts `universal-3-5-pro` first for **every** tier
  (`language.ts:117`). Route free/starter to `universal-2`.
- Both are one-line changes with the largest $ leverage in the whole system.

---

## 6. Redundant / duplicated work

| # | Finding | file:line | Sev | Impact | Fix |
|---|---|---|---|---|---|
| R-1 | **The 2.5 GB source is downloaded from R2 twice** — once for STT, once for render | `transcribe.ts:467`, `render-clips.ts:1547` | 🔴 High | ~100 s + 2.5 GB disk | Give AssemblyAI a presigned URL; render keeps the single download |
| R-2 | **Every caption/style edit triggers a full re-render from source** — `getClipRenderResetData()` clears `storageKey` and re-queues `pending`, so the run re-downloads 2.5 GB and re-encodes from scratch | `clip.service.ts:187-197`, `:615-627` | 🔴 High | ~105 s + full encode per tweak | Keep the rendered 1080p as an intermediate; re-burn captions with `-c:v libx264` on a 45 s file only, or better, keep captions as a sidecar track. `dubbing.ts:335` already shows the `-c:v copy` pattern |
| R-3 | **ffprobe run a second time per free-tier variant solely to write a log line** | `render-clips.ts:1474` | Med | 10 spawns/run | Delete; dimensions are static |
| R-4 | **Free-tier double encode** | `render-clips.ts:1443-1481` | 🔴 High | +66 s, +60 % CPU | Fold into the primary filtergraph |
| R-5 | **`WorkflowRun` has no index for the claim query.** `findFirst({where:{stage,status},orderBy:{createdAt}})` against a model whose only index is `@@unique([projectId, idempotencyKey])` | `project.service.ts:1719-1740`, `schema.prisma:258-272` | 🔴 High | **4 seq-scans + sorts per 2.5 s tick per worker = 1.6/s**, growing linearly with lifetime project count | `@@index([stage, status, createdAt])` |
| R-6 | **Reaper scan is unindexed** — `{status:"running", updatedAt:{lt:cutoff}}` | `project.service.ts:2561-2564` | Med | full scan every 5 min | `@@index([status, updatedAt])` |
| R-7 | **`ClipRender` has no index on `status`** — `findMany({where:{status:"pending", clip:{projectId}}})` scans + joins | `clip.service.ts:687-695`, `schema.prisma:590-608` | Med | grows with total renders | `@@index([status, clipId])` |
| R-8 | **Every progress event does `aggregate max(seq)` inside a serializable transaction, then an insert** — during STT this fires every 5 s for the whole transcription | `workflow.service.ts:115-136`, `transcribe.ts:410` | Med | ~50 write-transactions per project on the hot path; a contention point at scale | Postgres sequence or `INSERT ... SELECT coalesce(max(seq),0)+1`; and only publish when the integer progress actually changes |
| R-9 | **Reaper is N+1** — `findMany` then one `updateMany` + one event publish per stalled row | `project.service.ts:2567-2588`, `:2616-2643` | Low | only on failure paths | Batch the `updateMany` |
| R-10 | **`WorkflowEvent` is never purged** while `WebhookDeliveryLog` is | `index.ts:77`, no counterpart | Med | unbounded table; every SSE reconnect replays from it | Add to the same purge job |
| R-11 | **Sequential 64 MB multipart part uploads** | `r2-storage.ts:255-284` | Med | ~4x slower than 4-way parallel on link/RSS imports | `Promise.all` with a concurrency of 4 |
| R-12 | **Single-stream R2 download** — no ranged parallel GET | `r2-storage.ts:314-355` | Med | 2.5 GB at single-stream throughput | 4–8 parallel range GETs typically 2–3x |
| R-13 | **yt-dlp downloads the best available format** with no height cap, for a pipeline that outputs at most 1080p | `ingest.ts:312-330` | 🔴 High | a 4K 60-min YouTube source is 3–8 GB vs ~2.5 GB at 1080p — download time, R2 storage and every later download all scale with it | `-f "bv*[height<=1080]+ba/b[height<=1080]"` |
| R-14 | **Whole STT audio file read into memory** with `readFileSync` before upload | `transcribe.ts:211` | Low | 28.8 MB RSS spike; scales with `-b:a` | `createReadStream` — or moot after R-1 |
| R-15 | **Face detection re-decodes the source per clip** (see F-1) | `render-clips.ts:1757` | 🔴 High | ~250 s | see §7 F-1 |
| R-16 | Re-transcription | — | ✅ none | `claimNextWorkflowRun` upserts the transcript to `processing`; transcripts are not recomputed | no action |

---

## 7. Reliability

### F-1 🔴 The face detector is the single largest latency item and it is misconfigured

`apps/worker/scripts/reframe_detect.py`:
```python
detector.setInputSize((width, height))     # line 55 and again at line 77
...
while True:
    ok, frame = cap.read()                 # decodes EVERY frame at full 1080p
    ...
    if idx % frame_interval == 0:          # ...but only detects on every Nth
        _, faces = detector.detect(frame)
```
Two compounding problems:
1. **YuNet is run at the source's native resolution.** Its designed input is 320x320. At
   1920x1080 the input tensor is ~20x larger and inference cost scales roughly with input pixels.
2. **Every frame is decoded** even though only 1-in-7 is used (`fps=4` vs source 30).
   Measured: decoding all frames costs 2.51 s per 60 s clip vs 1.52 s for `fps=4,scale=640:-2` —
   so the decode waste is ~1 s/clip. **The dominant term is the full-resolution inference**
   (~240 detections/clip), which I could not measure directly (no OpenCV on this box) but which
   plausibly runs 20–35 s/clip on a CPU-only container. Called once per clip at
   `render-clips.ts:1757`, this is ~250 s of the 798 s budget.

**Fix**: feed the detector a pre-decimated, pre-scaled stream —
`ffmpeg -ss X -t D -i src -vf "fps=4,scale=640:-2" -f rawvideo -pix_fmt bgr24 -` piped to the
Python process — and call `setInputSize((640, 360))`. Expect ~250 s → ~30 s.
**Verify with a real measurement on the worker image before shipping**, since the inference
number is the one figure in this report I could not measure.

### F-2 🔴 No retry anywhere. Every failure is terminal on the first error.

`IngestJob.attemptCount` is incremented on claim (`project.service.ts:1826`) and surfaced on the
claimed job (`:1849`) — but **it is never read to make a retry decision**. Grep for
`maxAttempts` / `backoff` / `requeue` across `apps/worker` and `packages/services` returns only
Redis-connection helpers. `failTranscriptWorkflowRun`, `failClipDetectionWorkflowRun`,
`failClipRenderingWorkflowRun` and `failIngestJob` all set `status: "failed"` and stop.

Consequences:
- One AssemblyAI 503, one OpenAI 500, one R2 blip ⇒ the user's 60-minute upload is dead and they
  must re-run the whole thing (and it re-bills the STT).
- `callOpenAI` (`detect-clips.ts:777`) has **no `AbortSignal.timeout`** — unlike the AssemblyAI
  calls, which all set one (`transcribe.ts:213, 281, 326`). A hung OpenAI socket blocks the
  *entire single-threaded worker* until the reaper's 30-minute stall timeout, and even then the
  worker process itself is still stuck in `fetch`.

**Fix**: `attemptCount < 3` ⇒ requeue with exponential backoff on transient codes
(`assemblyai_transcription_poll_failed`, `openai_request_failed`, `source_download_failed`,
`remote_fetch_timeout`); terminal on validation codes (`no_clips_detected`,
`unsupported_aspect_ratio`, `link_unsupported_source`). Add `AbortSignal.timeout` to `callOpenAI`.

### F-3 Poison jobs

There is no dead-letter path and no attempt ceiling — but because nothing retries, nothing loops
forever either. The failure mode is the opposite: a job that *would* succeed on retry is
permanently lost. Add the DLQ **at the same time** as retries, not before.

### F-4 Worker crash mid-render

- `reapStuckWorkflowRuns` (`project.service.ts:2554`) correctly fails runs whose heartbeat
  (`updatedAt`, bumped by `publishWorkflowProgress` at `:2526`) is older than 30 min. ✅
- 🔴 But `ClipRender` rows left in `status: "rendering"` (`clip.service.ts:716`) are **never
  reaped**. `getPendingClipRendersForProject` only selects `status: "pending"`
  (`clip.service.ts:689`), and `autoQueueDefaultRenders` skips clips with an existing
  `pending`-or-`rendering` variant (`clip.service.ts:1010`). A crash mid-render therefore leaves
  those variants permanently invisible to every future run — they can never be re-queued.
  **Fix**: extend the reaper to reset `ClipRender` rows stuck in `rendering` past the timeout.
- 🔴 The render heartbeat only fires **once per clip group** (`render-clips.ts:2113`). A single
  clip whose ffmpeg hangs (no `timeoutMs` on the render `execCommand`, `render-clips.ts:169` —
  unlike `ingest.ts:79` which does support one) produces no heartbeat and is only caught 30 min
  later, with the worker fully blocked the whole time.

### F-5 Temp files and disk

- ✅ All four temp roots use `mkdtemp` + `rm(..., {recursive:true, force:true})` in `finally`
  (`transcribe.ts:460/537`, `render-clips.ts:1540/2148`, `ingest.ts:285/386`, `:396/444`,
  `dubbing.ts:368`).
- 🔴 **`finally` does not run on SIGKILL/OOM.** There is **no boot-time sweep** of
  `os.tmpdir()/narriflow-*` (grep confirms). Each leaked render dir holds the 2.5 GB source plus
  partial outputs. Two OOM kills fill a typical 10 GB container disk, after which every
  subsequent job fails at `downloadObjectToFile` with a confusing ENOSPC.
  **Fix**: on startup, `readdir(tmpdir())` and `rm` anything matching `narriflow-*` older than
  1 hour. ~10 lines in `index.ts`.
- 🔴 **No free-space preflight.** `render-clips.ts:1547` downloads the source with no check that
  `sourceSizeBytes` (already known on the project row) fits. Add a `statfs` guard that fails the
  run with a clear code instead of a truncated download.
- ⚠️ Peak render disk = source (2.5 GB) + N variant outputs + the `.wm.mp4` free-tier temp. For a
  3-hour Pro source that is 7.5 GB + outputs from one job.

### F-6 Poller crash-loop guard

`index.ts:176-186` exits the process after 20 consecutive poll failures. ✅ Correct — lets the
orchestrator restart on a wedged DB connection. But `consecutivePollFailures` is reset at
`index.ts:114` **after** `claimNextIngestJob` and **before** the workflow-stage claims, so a
failure that only ever occurs in the later claims still resets the counter on the next tick and
the guard never trips. Move the reset to the end of the `try`.

### F-7 Redis is correctly optional

`workflow.service.ts:144-163` — a Redis outage degrades to DB-persisted events with no real-time
push, logs once, and applies a recovery cooldown. ✅ Good design; no change needed.

---

## Appendix: one-line diffs with the best effort-to-payoff ratio

```
schema.prisma:272   + @@index([stage, status, createdAt])
                    + @@index([status, updatedAt])
schema.prisma:608   + @@index([status, clipId])
render-clips.ts:971 - "medium"  →  "veryfast"      (and :1112, :1232, :1357, :1422)
render-clips.ts:973 - "23"      →  "21"            (quality-neutral pair with veryfast)
transcribe.ts:277   - speaker_labels: true  →  conditional on the content pack
detect-clips.ts:792 - "medium"  →  "low"
detect-clips.ts:779 + signal: AbortSignal.timeout(10 * 60 * 1000)
ingest.ts:314       + "-f", "bv*[height<=1080]+ba/b[height<=1080]"
project-events.tsx:65 + refresh on clip_rendering `running` events too
R2 console          + 30-day lifecycle rule on projects/*/{link,rss,uploads}/*
```
