# 09 - Validate rendered media before upload or success

**What to build:** Reject empty, truncated or contract-breaking full renders and previews and persist measured duration.

**Blocked by:** [08 - Burn shared emoji and enforce glyph coverage](08-emoji-and-glyphs.md)

**Status:** done

**Suggested implementer:** Sol

**Contract:** [Render hardening spec](../spec.md). Read the relevant contract sections and AGENTS.md before claiming.

## File ownership

Exhaustive write set, relative to repository root. This ticket may also update its own issue file with status and evidence. All other paths are read-only. Shared paths are serialized by blocker ancestry. If an additional file is necessary, amend the write set and dependency edges before editing it.

- `apps/worker/src/render-output-validation.ts`
- `apps/worker/src/render-output-validation.test.ts`
- `apps/worker/src/tasks/clip-render-attempt.ts`
- `apps/worker/src/tasks/clip-render-attempt-core-paths.test.ts`
- `apps/worker/src/tasks/clip-preview.ts`
- `apps/worker/src/tasks/clip-preview.test.ts`

Write-set amendment (2026-10-29): add `apps/worker/scripts/render-golden.ts` and `apps/worker/src/__fixtures__/render-golden/expected/09-output-validation.json` so the gate exercises the production validator and activates the two invalid-output defects. Ticket 08 is closed; ticket 10 remains blocked by 09. No compiler-input derivation or encode behavior changes. Also own `apps/worker/src/worker-process.ts` for an opt-out from source-clock packet sampling during output inspection; the full decode already supplies timestamp evidence, keeping validation to one ffprobe. Tickets 02/06/08 are closed; the later process consumers remain unchanged. Add `apps/worker/src/tasks/clip-render-attempt{,-assets}.test.ts` and `apps/worker/src/render-output-validation.test-fixture.ts`: existing lifecycle tests fabricate empty process stdout and sub-1KB files; update those process fakes to supply validated media facts without bypassing the production validator.

## Implementation

1. Implement the spec stream/size/duration/SAR/color/fps/audio/full-decode contract using Worker Process Module facts, including absent frame counts and AAC priming/padding.
2. Validate all 720p/1080p exports and previews before storage or completeClipRenderVariant. Return measured duration/size and carry peak facts from 05. Invalid output cannot upload.
3. Distinguish retryable interrupted-read truncation from confirmed impossible range/corrupt immutable source. Propagate process-start failure as executor failure, not media-invalid.
4. Use bounded full decode for these short outputs. Keep normal encode commands untouched; validation adds independent read-only processes.

## Acceptance

- [x] Exit-zero no-stream MP4 and 20.38/30s interrupted-range output fail and never upload/complete.
- [x] A one-frame video tolerance and explicit audio-packet allowance pass legitimate AAC outputs without hiding substantial truncation.
- [x] Frame count, exact canvas, streams, SAR, color, pixel format, timestamps and decode are checked, including previews.
- [x] Stored duration comes from validated media and size from the local stat. Normal golden frames/argv/audio remain exact.

## Verification

Run from repository root. The command interface below is delivered by ticket 01 where applicable. Run media checks inside the pinned image. Record output/evidence rather than merely listing commands.

```sh
bun test apps/worker/src/render-output-validation.test.ts apps/worker/src/tasks/clip-render-attempt-core-paths.test.ts apps/worker/src/tasks/clip-preview.test.ts
```

Run the full normal exact golden comparison from spec.md. For an approved defect ticket, also run its declared corrected expectations; preserve all unrelated baseline results.

`bun run lint` and `bun run typecheck` must pass for the assembled change. Capture scoped failures caused by unrelated in-flight work before changing any unowned file.

DB checks, when listed, must use `bash .scratch/api-extraction/db-gate.sh ...`; never run gates against shared Neon. No shared resource mutations or deployments are authorized by this ticket.

## Evidence

Base `dev` HEAD `c3c5108709be6236bf0aea9dd0e7434954e758f2`, plus this ticket's uncommitted write set. No commit, env edit, deployment or shared-resource mutation. Host gate uses the same macOS arm64 FFmpeg 8.0.1/Bun 1.4.2 fingerprint `90cf30a30583bbe5` as ticket 01. No container runtime is available; pinned Linux verification remains ticket 21's existing gate.

- Required parity command: `bun apps/worker/scripts/render-golden.ts verify --baseline /tmp/narriflow-golden/baseline --suite all --out /tmp/narriflow-golden/candidate-09`: **exit 0**, normal 18/18 pass, 16 corrected defects pass, two existing rotation/reflection guards unchanged, zero mismatches/xpass. Log `/tmp/narriflow-golden/verify-09.log`; report `/tmp/narriflow-golden/candidate-09/report.md`. No baseline refresh, encode change, or new argv/frame/PCM exception. `expected/09-output-validation.json` activates only `seek-past-source-end` and `http-interrupted-read`, asserting `render.ok == false` and `typedFailure == render_output_invalid` while retaining plans/crops/cues/layers/captions. The runner calls the production expectation builder and validator, retaining rejected artifacts for forensic measurements only.
- `bun test apps/worker/src/render-output-validation.test.ts`: **25 pass, 0 fail**. Real FFmpeg covers AAC priming/padding, missing frame count, exact one-frame video and one-frame-plus-one-AAC-packet audio boundaries, NTSC, low-rate mono, silent audio schedule, absent/empty output, seek past EOF, corrupted payload with intact headers, and health failure propagation. Header mutations test codec/profile/pixel format/canvas/SAR/color/fps/audio/frame count/container bounds. Caption warning arrays and peak facts survive in the result.
- Preview tests exercise the existing streamed-source command through a test-owned local HTTP range server. Valid output returns measured mono 44.1 kHz facts; both a short read and no-frame EOF output fail before returning a candidate to storage.
- Attempt tests assert exit-zero no-video and short candidates requeue with `render_output_invalid`, never upload, never complete, and emit rejected measured telemetry. Existing source/Scene/lifecycle mocks now provide probe and decode facts through the real validator.
- `cd apps/worker && bun test`: **927 pass, 0 fail**, 51 files, including scripts. Log `/tmp/ticket09-worker.log`.
- `cd packages/services && bun test`: **exit 0**; PostgreSQL tests skipped as intended.
- `bash .scratch/api-extraction/db-gate.sh bun run test:workflow:db`: **184 pass, 0 fail**, seven files, throwaway local PostgreSQL only. Log `/tmp/ticket09-workflow-db.log`.
- `bun run --cwd apps/worker typecheck`: **exit 0**, includes `scripts/`. Log `/tmp/ticket09-typecheck.log`.
- Scoped `bunx biome check` on all 12 implementation/test/fixture paths: **clean**. Log `/tmp/ticket09-biome.log`. `git diff --check`: clean.


## Comments

Implementation and boundaries
- Every 720p/1080p attempt validates synchronously before joining the upload queue. The queue accepts a `ValidatedRenderResult`; persistence uses its decoded video duration and regular-file stat size. Existing `completeClipRenderVariant` propagates those values to both ClipRender and ClipExportVariant, preserving its transactional aggregate updates. Preview encoding similarly returns a validated result before PUT, and waveform peaks use measured duration.
- One output `inspectMedia` call, with source-clock packet analysis disabled, plus one complete local FFmpeg decode. Decode uses `-xerror -err_detect explode -copyts -fps_mode passthrough -enc_time_base:v demux`, wrapped decoded video frames and PCM in FFmpeg's framecrc report. This avoids raw-pixel copies and a second ffprobe/parser. Deadline `min(300s, max(30s, 2 * edited duration))`, stdout cap 32 MiB. Compared FFmpeg's [framecrc muxer](https://github.com/FFmpeg/FFmpeg/blob/n7.1/libavformat/framecrcenc.c) with raw-video frame hashing; wrapped frames supply timestamps/counts after actual decode without hashing every pixel. [FFmpeg documentation](https://www.ffmpeg.org/ffmpeg-formats.html#framecrc) describes the report.
- Rejected telemetry carries expected/measured stream and decode facts and diagnostic codes, plus existing mix peaks and caption warnings. `render_output_invalid` is retryable even when the local output probe maps its unreadable bytes to `source_media_invalid`. An output alone cannot confirm an impossible source range or immutable corruption. Permanent source diagnoses require the separate refreshed content-bound source probe plus repeat local reproduction described by the spec; this ticket does not guess permanence from a short output. Process-start/unavailable/cancellation failures propagate unchanged.
- Exact source sample rate/channels apply when a single known source determines them; previews require mono at the existing source rate. Music/SFX/Scene negotiation has no fixed rate/channel contract in the compiler today, so those outputs require positive measured AAC rate/channels without inventing a new standard or guessing a format from incomplete asset facts. Future complete asset facts can provide exact expectations through the same validator input.
- The existing scene-concat reference is VFR: nominal 30/1, average 222000000/7566667, 222 decoded frames over 7.6 seconds. Inserted-scene plans therefore check the rational nominal clock and strictly increasing decoded PTS, with the same one-frame start/end/duration bounds, rather than inventing a CFR/frame-count contract. Ordinary and normalized-CFR outputs also require average-rate equality, contiguous decoded frames and planned count within one frame. Header nb_frames always agrees with actual decode when reported. AAC decode applies skip samples; at most one measured AAC packet is allowed beyond the video-frame allowance. Container duration is checked separately.
- FFmpeg's full-range planar 8-bit 4:2:0 spelling `yuvj420p` with `colorRange=pc` is accepted as the full-range form of yuv420p for existing SDR output, including the emoji reference. Its measured spelling/range are retained. HDR-to-SDR output must remain yuv420p, limited BT.709, with no mastering/CLL/Dolby Vision metadata. 4:4:4 and other formats fail.

Requests / discovered upstream issues
- Caption warnings are first-class `ValidatedRenderResult.captionGlyphsOmitted` / `.captionEmojiSkipped` arrays, including code points/emoji and cue indexes; accepted and rejected telemetry carries them. Durable DB storage still uses the existing analytics fallback codes. A services/schema owner can add JSON result metadata to ClipRender and ClipExportVariant, wire it through `WorkflowRunLifecycle.completeClipRenderVariant`, and pass this result's two arrays there. No schema/migration was added in this ticket.
- The pre-existing real visual-stack test with a logo plus dip-white transition encodes `yuv444p / High 4:4:4 Predictive`. The new validator correctly rejects it before upload. The test retains its compiled-layer/pixel checks and now asserts the rejection. A compiler owner should force the contracted final 4:2:0 format for this demonstrated branch; doing that here would change encoding beyond this validation ticket.
- Old real-media lifecycle fixtures claimed ten-second renders from 0.8-second sources. Extended those test sources to 20 seconds and aligned the synthetic layout evidence to half-second source-frame boundaries. A 24 fps source partitioned into 0.04-second scenes otherwise loses about 0.25s at concat; this is now rejected, never hidden by a duration tolerance. A compiler/planner owner should address off-frame scene partitions separately. No production render command changed.

## Addendum 2026-10-30: color-tag contract fix (production-risk)

**Defect.** Deployed validation rejected real renders with `output_colorTransfer_mismatch` + `output_colorPrimaries_mismatch` after a successful encode (ticket 13 measurement of 1080p59.94 AV1 podcast footage: clips 0, 2, 3 of 4; `/tmp/exp13/measure*.err`). `render_output_invalid` was also always `retryable`, so the failure would repeat on every attempt.

**Root cause.** `compositionOutputExpectation` demanded the source's four color tags on the output (`range`/`matrix`/`transfer`/`primaries` all `bt709`) for every non-HDR render, but the encoder writes no tags in SDR passthrough; the output carries whatever the filter graph leaves on the frames. Graphs built on `vstack` (two-up) or `overlay` onto a generated `color=` background keep range and matrix but lose transfer and primaries (ffprobe: `color_space=bt709 color_transfer=unknown color_primaries=unknown`); a single-subject crop/scale graph keeps all four, which is why 1 of 4 windows and every golden fixture (uniform tags) passed. Reproduced with FFmpeg on the tagged source (vstack, colour-source overlay) and covered by a real-FFmpeg test.

**Contract now (one source of truth in `composition-ffmpeg-adapter.ts`).**
- `SDR_OUTPUT_COLOR` + `rendersConvertedSdr(probe, hasHdrAssets)`: the encoder's `sdrTagStage` (the `setparams` that writes BT.709 tags after HDR-to-SDR conversion) and `compositionOutputExpectation` both read these. Converted SDR: exact `tv/bt709/bt709/bt709` asserted, plus no mastering/CLL/Dolby Vision metadata (unchanged, ticket 07).
- Everything else is `passthrough`: any partial/absent/unknown/rewritten SDR tags are valid; the output must not carry HDR tags (PQ/HLG transfer, bt2020 primaries, bt2020nc/c/ictcp matrix) unless the source's own field says so. Previews use the same passthrough expectation (`passthroughColor`). 8-bit yuv420p/High is still required.
- `RenderOutputExpectation.color` is now `{mode:"asserted",tags}|{mode:"passthrough",source}`; the old `sdr` flag is gone.

**Retry classification.** `RenderOutputInvalid` is `retryable` only when every code is an integrity/truncation symptom (missing/tiny/unreadable output, probe/decode failure, timestamp/duration/frame-count mismatches, no usable video stream, unreadable video stream). Any plan or pipeline-contract mismatch (colour, canvas, SAR, frame rate, codec/pixel-format, audio format, HDR metadata, container, mix peak) is `permanent`. New code `output_video_stream_unreadable` (null profile/pix_fmt, e.g. a zeroed payload) replaces `output_video_codec_contract` for that case so corrupt reads stay retryable. The 4:4:4 logo+dip-white stack no longer reaches the validator as 4:4:4 (see the pixel-format follow-up below).

**Evidence.**
- Before: `/tmp/exp13/measure*.err`; the original source `/tmp/narriflow-comparison-source.mp4` has since been deleted from /tmp. After, on the other local real 1080p AV1 BT.709-tagged footage (`/private/tmp/urdu-debug/src.mp4`) with four 25s windows x (latest + export), baseline and reuse modes: 32/32 outputs accepted, 0 `FAIL`.
- New tests in `render-output-validation.test.ts` (29 pass): fully tagged source through real `vstack` validates as passthrough and fails the old exact-tag contract; partial/unknown/rewritten tags accepted; HDR tags rejected unless the source's; asserted mode exact; deterministic mismatch permanent vs truncation retryable.
- `cd apps/worker && bun test`: 998 pass, 0 fail. Typecheck exit 0. Biome clean on the six touched paths.
- Parity: `render-golden.ts verify --baseline /tmp/narriflow-golden/baseline --suite all --out /tmp/narriflow-golden/candidate-09fix`: exit 0, normal 18/18 identical, defects unchanged. Log `/tmp/fix09/gate.log`. The encoder argv is byte-identical (the `setparams` text is generated from the same constant).
- No new golden fixture: the harness refuses cases absent from the baseline ("never added to or substituted into an old baseline"), so a partially-tagged-SDR case would fail the required gate. The real-FFmpeg unit test is the regression guard until the next baseline refresh.

### Follow-up: encoder pins 8-bit 4:2:0 (no recoverable render fails)

The logo + dip-white visual stack ended in `yuv444p`/High 4:4:4 Predictive (ticket 09 request to the compiler owner). `x264VideoArgs` in `composition-ffmpeg-adapter.ts` now builds every composition encode (`-c:v libx264 -preset -crf -pix_fmt OUTPUT_PIXEL_FORMAT`; single-video, multi-input and audiogram builders), and the validator reads the same `OUTPUT_PIXEL_FORMAT`. Already-4:2:0 graphs get no conversion inserted, so decoded frames are untouched. Previews were already pinned (`-pix_fmt yuv420p` / final `format=yuv420p`).
- Golden: new `expected/09b-output-pixel-format.json` marks all 36 cases `change: "output-pixel-format"`; the runner's `allowOutputPixelFormat` removes only the `-pix_fmt yuv420p` pair from argv/digest and flags a removed pair; frames, PTS, PCM, loudness, ffprobe and decode stay exact (unit test in `render-golden.test.ts`).
- Parity `/tmp/narriflow-golden/candidate-09fix2` (log `/tmp/fix09/gate2.log`): exit 0, normal 18/18 identical, 16 corrected defects pass, 2 expected failures unchanged. Against the previous candidate (`candidate-09fix`): 40 argv-changed targets in 36 cases, all exactly the appended pair; 0 frame-hash and 0 PCM-hash changes in any case.
- The real visual-stack test now expects `completed`, uploaded, `pix_fmt yuv420p`. `bun test` (apps/worker): 999 pass, 0 fail; typecheck and biome clean.
