# 09 - Behind the speaker

**What to build:** A hero can sit behind the person, with the Depth style and a toggle (spec 5.12, gate G3).

**Blocked by:** 06

**Status:** ready-for-agent

Spec: [../spec.md](../spec.md). Follow the spec; where a ticket and the spec disagree, the spec wins.

## Acceptance

- [ ] Model vendored in both places with a hash test; `person_matte.py`; plan `mattes`; matte mode of the visual stack; split caption track and graph.
- [ ] Typed degradation `caption_matte_unavailable` in worker and Studio.
- [ ] G3 on 5 real clips recorded before the Studio half starts.
- [ ] Studio segmenter worker, person canvas, layer order; Depth style; toggle; Sol visual review recorded.
- [ ] `bun run lint`, `bun run typecheck`, `bun run test` pass (Bun 1.4.4). No PostgreSQL or heavy suites.

## Comments

### 2026-11-19 — G3 spike (research agent)

**Verdict: go with changes.** A free CPU matte gives usable edges on real talking heads. The browser preview holds frame rate. As specified in 5.12, the render fails the 1.5x budget. Five changes (end of this comment) bring it to 1.40–1.48x CPU. Edge acceptance is still for the owner and Sol to judge. Review files, all in `/private/tmp/claude-501/-Users-murtaza-Documents-dev-narriflow/49bb75c5-29c7-4a2e-aa64-a5b996ebf64f/scratchpad/09a/`:
`contact_sheet.jpg` (5 clips x 4 moments, plus 3 chest-level rows), `edge_zoom.jpg` (1:1 crops at 1080x1920), `reel_all_clips.mp4` (5 clips side by side), `out/<clip>.mp4` (15 s each, plus `_baseline` without the behind layer and `_chest`), and `out/{mkbhd30,altman30}.mp4` (30 s). Code: `apps/media/python/narriflow_media/person_matte.py` and `apps/media/python/tests/test_person_matte.py` (14 tests; numpy, OpenCV and ffmpeg cases skip when those are missing). Nothing is committed.

**Model.** MediaPipe Selfie Segmenter, square, float16, v1. URL: `https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/1/selfie_segmenter.tflite` (`latest` serves the same bytes today; pin `/1/`). SHA-256 `191ac9529ae506ee0beefa6b2c945a172dab9d07d1e802a290a4e4038226658b`, 249,537 bytes, Apache-2.0. I chose square over landscape (256x144, `490e9ea7…`, 250,177 bytes). Our sources are 16:9. Run once over the whole frame, the landscape model gives the speaker about 80 model px across the 9:16 crop and leaves a 20–30 px smudge of background over the word around the head (Altman, Gereon; `exp/layouts_zoom.jpg`). The square model run on the visible 9:16 rectangle, stretched to 256x256, gives the cleanest edges. MediaPipe itself stretches rather than letterboxes. OpenCV and LiteRT output matched MediaPipe's own ImageSegmenter within 0.4–1.3% mean absolute difference, with RGB input in [0, 1].

**How the model reaches the image (real ticket).** `apps/media/models/` is gitignored (`.gitignore:40`). The local copy I placed there is for development only. yunet reaches the image through a `curl` of an immutable URL plus `sha256sum -c` in `images/Dockerfile` (render profile), and through the `platforms.linux-x64.model` entry in `runtime-lock.json`, which `check-render-environment.ts` enforces. Do the same:
- Add a Dockerfile step for the `/float16/1/` URL, writing `/usr/local/share/narriflow/selfie_segmenter.tflite`, and set `PERSON_MATTE_MODEL_PATH`.
- The lock has a single `model` key, so it needs a second entry or a list.
- The web copy in `apps/web/public/models/` is committed while the media copy is not. The spec's "both copies same hash" test should therefore compare the web file with the lock's SHA-256.

**Library.** Use `ai-edge-litert==2.3.0` (LiteRT, XNNPACK).
- LiteRT: 2.8 ms per 256x256 inference on one M1 Pro core, 1.8 ms on two. The linux x86_64 cp313 wheel is 21.8 MB (37 MB installed). New dependencies: `ml_dtypes` (0.5 MB), `protobuf` (0.3 MB), `flatbuffers`, `tqdm`, `typing-extensions`, `backports.strenum`. All need hash pins in the lock for the render profile only, like numpy and OpenCV (`check-render-environment.ts:544`). Import takes 45 ms and model load 2 ms, so cold start is unaffected apart from the larger image.
- OpenCV DNN (`cv2.dnn.readNetFromTFLite`, already in the image via `opencv-python-headless` 5.0.0.93): works with no new wheel, but takes 14 ms per inference. That is 5x slower, and the budget below does not survive it.
- Rejected `mediapipe` 1.2.3: a 43 MB wheel that pulls `opencv-contrib-python` (which clashes with the pinned headless OpenCV over `cv2`), `matplotlib` and `sounddevice`/PortAudio.

The spike module keeps a `--runtime opencv` switch for comparison. Drop it in the engine.

**Pipeline that passed review** (`person_matte.py`): ffmpeg decodes each range at 15 fps (`-skip_loop_filter all`, scaled by ffmpeg to the matte size). Then, per sample:
1. Segment: one stretched pass over the visible region, or 3 overlapping square tiles max-merged when no region is given.
2. Smooth over time (EMA, α 0.6, reset per range).
3. Fast guided filter against the frame (coefficients at about 270 px, applied at matte size).
4. Edge contrast, smoothstep 0.4→0.8. This was the cheap fix that worked. It turns the soft grey halo around dark or grey hair into a tight edge (`exp/remap.jpg`).
5. Feather with a 1.5 px Gaussian.
6. Write gray x264 (ultrafast, crf 16) at 15 fps. `alphamerge` holds frames between samples.

The output starts at the first range, black between ranges, and a JSON summary is printed. It raises `PersonMatteUnavailable`, which maps to `caption_matte_unavailable`.

**Numbers.** M1 Pro, CPU only. The laptop was shared with another agent's jobs (load average 5–50), so each figure is the minimum of 3 runs. The baseline is the same 9:16 render without the behind layer: crop, scale, drawtext, x264 veryfast crf 21, the render thread policy.

| 30 s clip, every frame behind | baseline CPU-s / wall | matte CPU-s / wall | behind render CPU-s / wall | total CPU ratio | laptop wall, sequential |
| --- | --- | --- | --- | --- | --- |
| MKBHD, region mode | 35.9 / 7.0 | 9.8 / 5.2 | 40.3 / 7.8 | **1.40** | 1.86 |
| Altman, region mode | 25.7 / 4.8 | 8.4 / 4.8 | 29.6 / 5.7 | **1.48** | 2.20 |
| Altman, tiles mode (no region) | 24.8 / 4.4 | 12.1 / 7.4 | 28.5 / 5.3 | 1.64 | 2.88 |
| First cut: OpenCV, 1080p matte, full-frame overlay | — | 25 / 15 | — | 1.9–2.3 | 2.7–4.2 |

- Matte cost: region mode 0.28–0.33 CPU-s per second of video; tiles mode 0.40; first cut 1.3 s wall per second.
- The behind render alone, with the person redrawn only inside the word's band, is 1.11–1.20x the baseline wall. With a full-frame `alphamerge`+`overlay` it was 1.37–1.52x.
- Modal estimate (4-core render container, CPU-bound): about 1.6–1.8x if the matte runs before the render. About 1.40–1.48x if the matte runs alongside it, since total CPU sets the time. The real baseline also paints ASS and mixes audio, which lowers the ratio a little. Re-measure on the worker image, as 03b does for captions.
- Cost: the repo has no Modal price. Using the project's unit-cost note (4 cores / 8 GiB ≈ $0.25/h), the extra 4–7 s per 30 s clip costs $0.0003–0.0005, and the worst run seen (tiles, sequential, 9 s) about $0.0006.

**Browser** (`@mediapipe/tasks-vision` 1.2.3, Apache-2.0; 1.2.2 of 2026-11-03 is the newest release at least two weeks old today). ImageSegmenter runs the same model file in a module Web Worker. It needs `FilesetResolver.forVisionTasks(base, true)`, the module WASM loader. The default loader calls `importScripts`, which module workers lack, and throws "ModuleFactory not set".
- Setup: Chrome 157, 720p 23.976 fps source, 9:16 crop → `createImageBitmap(..., {resizeWidth: 256, resizeHeight: 256})` → worker, CPU delegate.
- Speed: 14–20 ms per result including the worker round trip (p95 27–29 ms).
- Capped at 15 fps: 11.4–12.1 results/s (a 24 fps source quantises the cap to every other frame). Video stayed at 22.9–24.0 fps with 0 long tasks. Painting the person canvas took 0.3 ms per frame.
- Uncapped: segmentation kept up with every frame (24/s), video at 24.1 fps.
- GPU delegate in the worker was worse: 10.3 results/s and video dropped to 16.7 fps. Use CPU, as the spec says.
- Bundle: `vision_bundle.mjs` 156 KB (45 KB gzip), WASM loader 337 KB (81 KB gzip), WASM 14.7 MB (4.1 MB gzip, 2.8 MB brotli), model 250 KB. Load it lazily, only when a behind hero exists.
- Repaint the person canvas on every presented frame with the latest mask. Repainting only per result makes the person stutter at 12–15 fps over 24–30 fps video.

**Edge quality per clip**, 1:1 at 1080x1920 (15 s segments of dev sources, region mode):
1. *Muse* (`de0f272a…`, from 1018 s; curly hair, glasses, hands, bright room, camera cuts including a two-shot): the outline follows the curls but stray curls are cut. Glasses are fine. No halo on the bright wall. In close-ups the head fills the top of the frame and hides most of the word. Smoothing carries one frame of the previous shot across a cut (edge contrast hides most of it). Reset at camera cuts.
2. *MKBHD* (`76c57000…`, from 205 s; bright grey studio, gestures): the cleanest. Tight outline, no halo, stable.
3. *Altman* (`d62eb082…`, from 2236 s; low light, dark hair on black): a soft dark falloff of 10–15 px into the letters, which reads like a soft shadow. Wisps are lost. It is stable. Before the edge-contrast step this was a 20–30 px grey halo.
4. *Asher* (`d40881cb…`, from 236 s; device held near the face, bright wall): edges are clean. The face sits near the top of the frame, so the word lands at the top edge and "TRUE" reads as "T…E".
5. *Gereon* (`b9f7d8ea…`, from 26 s; soft 720p source, thin grey hair on brown): the softest, a blend of about 20 px at the hairline that looks like a glow. Fine at phone size, marginal at 1:1.

Flicker: on pixels where the source is still, the matte's edge band changes by 0.03–0.06 per 15 fps step on average (p95 ≤ 0.13). Consecutive-frame strips show no visible flicker. Hands: in these close-ups hands never cross a head-level word. A chest-level word disappears completely because the torso fills the 9:16 width (`_chest` rows).

**Changes needed before engine work** (owner decisions marked):
1. Add the visible source rectangle to the plan: `mattes: { sourceStartSec, sourceEndSec, region }`, one pass per visible source tile (two-up: two). Fall back to tiles when the layout has no rectangle. This is the biggest CPU and quality lever.
2. Write the matte at ≤540 px tall and scale it to the source size at the head of the matte branch. 5.12 currently says source size.
3. Redraw the person only inside the behind row's box (union of the behind boxes, or per cue with `enable`), not the full frame.
4. Run the matte alongside the render, for example started first and fed as a second input when ready. Otherwise the 4-core ratio is about 1.6–1.8x. *Owner: accept the sequential ratio, or require overlap?*
5. Reset smoothing at camera cuts (the layout engine already knows the shots).
6. *Owner/Sol: readability.* The behind hero can be mostly hidden: on close-ups where the head fills the top, at chest positions, and with wide words (Asher). Either place the behind row from the face box (YuNet is already in the image) so hair overlaps only the bottom of the letters, or check coverage and draw that cue in front when the matte covers more than about a third of the hero box. 5.12 has no such rule yet.

**G3 status against criteria:**
- Edges on 5 clips: my read is acceptable on MKBHD, Altman and Muse, marginal on Gereon, and Asher limited by placement rather than edges. Owner and Sol to accept or reject from `contact_sheet.jpg`, `edge_zoom.jpg` and the MP4s.
- 30 s render ≤1.5x: passes on CPU (1.40–1.48x) only with changes 1–3, and in wall time only with 4. As 5.12 is written it fails (1.9–2.3x CPU).
- Preview ≥20 fps: passes (22.9–24.1 fps at 24 fps source, CPU delegate in a worker).

### G3 decision (owner, 2026-11-19)

Evidence regenerated after the scratch wipe in `.scratch/dynamic-captions/out/g3/` (git-ignored). Owner answers: edges good enough; matte runs alongside the render; behind hero auto-placed above the head (spec 5.12 updated). G3 passed. Engine work may start once ticket 07 is committed.
