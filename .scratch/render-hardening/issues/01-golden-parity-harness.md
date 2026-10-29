# 01 - Golden parity harness and pinned reference image

**What to build:** Capture reproducible normal and known-defect references before any render behavior changes.

**Blocked by:** None

**Status:** done

**Suggested implementer:** Claude

**Contract:** [Render hardening spec](../spec.md). Read the relevant contract sections and AGENTS.md before claiming.

## File ownership

Exhaustive write set, relative to repository root. This ticket may also update its own issue file with status and evidence. All other paths are read-only. Shared paths are serialized by blocker ancestry. If an additional file is necessary, amend the write set and dependency edges before editing it.

- `apps/worker/Dockerfile`
- `apps/worker/runtime-lock.json`
- `apps/worker/scripts/render-golden.ts`
- `apps/worker/scripts/render-golden.test.ts`
- `apps/worker/scripts/check-render-environment.ts`
- `apps/worker/src/__fixtures__/render-golden/manifest.json`
- `apps/worker/src/__fixtures__/render-golden/documents.json`
- `apps/worker/src/__fixtures__/render-golden/evidence.json`
- `apps/worker/src/__fixtures__/render-golden/known-defects.json`

## Implementation

1. Recover current deployed Linux artifact versions before pinning. Pin base/provider image digests, package snapshot/checksums, FFmpeg/ffprobe/libass/fontconfig, Python wheel versions/hashes and YuNet commit/SHA-256; emit a runtime fingerprint. Do not upgrade dependencies to establish the baseline.
2. Implement the DB-free capture/verify CLI in the spec. Freeze source/optional-media/fonts/documents/evidence by content hash, support a read-only golden asset cache, and retain artifacts outside candidate images.
3. Cover the entire normal matrix and explicit known-defect recordings in the spec, including playback-rate changes that do not retime exports. Capture plans, argv/graph bytes, frame/PTS/audio hashes, ffprobe facts, decode, loudness/peak and review snapshots.
4. Keep known defects explicit expected failures with narrow future contracts. Exact comparisons are the default. SSIM/loudness tolerances are available only in the separately authorized encoder comparison mode.

## Acceptance

- [x] (host variant, see Comments) Two captures of the frozen normal set in the pinned image produce identical plans/normalized argv, decoded frames/PTS and PCM.
- [x] Changed crop, one changed cue, missing frame, audio drift and altered encoder argument each make the normal gate fail.
- [x] The runner distinguishes known broken fixtures from normal references; neither skips silently nor accepts them as corrected output.
- [x] A tampered model/font/source hash fails before rendering. Runtime fingerprint includes actual resolved fallback font files.
- [x] Document the baseline image/commit, content hashes, command syntax, fixture staging and report paths in this ticket.

## Verification

Run from repository root. The command interface below is delivered by ticket 01 where applicable. Run media checks inside the pinned image. Record output/evidence rather than merely listing commands.

```sh
bun test apps/worker/scripts/render-golden.test.ts
docker build -f apps/worker/Dockerfile -t narriflow-render-golden .
```

Run the capture and verify docker commands in spec.md; preserve /tmp/narriflow-golden/baseline for later tickets.

DB checks, when listed, must use `bash .scratch/api-extraction/db-gate.sh ...`; never run gates against shared Neon. No shared resource mutations or deployments are authorized by this ticket.

## Evidence

Environment adaptation (orchestrator decision): no container runtime exists on this machine, so the parity gate is a same-environment before/after comparison on the macOS host. The Linux image is pinned (Dockerfile + lock) but built and golden-verified later (Railway build, ticket 21 via `railway ssh`).

**Baseline (current code, nothing changed)**
- commit `5680477046a7972435a728c7ce3d0b9b9513fe4f` on `dev`. `apps/worker`, `packages/{composition-plan,validators,services,caption-fonts}` were clean; the only uncommitted paths were this ticket's own (Dockerfile, runtime-lock.json, scripts/, `__fixtures__/render-golden/`), recorded in `capture.json` `git.dirtyPaths`.
- host: macOS arm64, FFmpeg/ffprobe 8.0.1 (Homebrew ffmpeg-full 8.0.1_3, libx264.165, libass.9, fontconfig 2.17.1), Bun 1.4.2.
- runtime fingerprint id `90cf30a30583bbe50e3972558024cc2ce7b9bffe683b79411d839e93d0d05f7f`; fixture toolchain id `61eaae45762c8f89`. It includes the FFmpeg binary hash, the SHA-256 of libass/fontconfig/freetype/harfbuzz/x264/x265/zimg/libav*, filter and encoder presence, the resolved file and SHA-256 for 13 fallback font queries (`fc-match`), a libass render of RTL/CJK/emoji/symbol text, the 20 vendored caption faces, the face model SHA-256 and the Python wheel set.
- baseline: `/tmp/narriflow-golden/baseline` (70 MB: `capture.json`, per-case `record.json`, `<target>.mp4`, `snapshots/*.png`, ASS files). Durable copy: `~/.cache/narriflow-render-golden/baseline-5680477046-90cf30a3`.
- 36 cases: 18 normal, 18 known-defect. Content hashes: the 29 fixtures are pinned per toolchain in `manifest.json` (`sha256ByToolchain`); `capture.json` also records the SHA-256 of manifest, documents, evidence and known-defects.

**Commands (repository root)**
```sh
bun apps/worker/scripts/render-golden.ts stage [--pin] [--rebuild]      # generate/verify fixtures in ~/.cache/narriflow-render-golden/<toolchain>/ (NARRIFLOW_GOLDEN_CACHE overrides)
bun apps/worker/scripts/render-golden.ts capture --suite all --out /tmp/narriflow-golden/baseline
bun apps/worker/scripts/render-golden.ts verify  --baseline /tmp/narriflow-golden/baseline --suite all --out /tmp/narriflow-golden/candidate-NN
bun apps/worker/scripts/render-golden.ts describe                        # list suites/cases
bun apps/worker/scripts/check-render-environment.ts [--json] [--enforce --stage build|image|start]
```
`--suite normal|known-defects|all`, `--case a,b` narrows. Reports: `<out>/report.json`, `<out>/report.md` (mismatches named by category: plan, crop, cue, layer, captions, argv, graph, frames, audio, ffprobe, loudness, decode). Exit 0 pass, 1 gate failure, 2 fingerprint mismatch (different environments are never compared). ~2.5 minutes for `all` (the http-interrupted-read case reproduces ffmpeg's real reconnect backoff, ~60-80s).

**Results**
- `bun apps/worker/scripts/render-golden.ts verify --baseline /tmp/narriflow-golden/baseline --suite all --out /tmp/narriflow-golden/candidate-01`: PASS, exit 0. Normal 18/18 identical (plan, crops, cues, layers, ASS, argv and graph bytes, 120-222 frame hashes with PTS per target, PCM chunk hashes, ffprobe facts, loudness, full decode); known defects 18/18 unchanged expected failures or guards. Log `/tmp/narriflow-golden/verify-01.log`, report `/tmp/narriflow-golden/candidate-01/report.md`.
- `bun test apps/worker/scripts/render-golden.test.ts`: 25 pass (five gate mutations, twin check, xfail/xpass/activation/guard verdicts, tampered source, tampered model, fingerprint sections, Dockerfile vs lock).
- `bunx biome check apps/worker/scripts apps/worker/runtime-lock.json apps/worker/src/__fixtures__/render-golden`: clean. `bun run --cwd apps/worker typecheck`: clean (scripts/ are outside tsconfig `include`; type-checked separately with a temporary tsconfig).

**Known-defect recordings (all expected failures today; contract assertions in `known-defects.json`)**
rot90, rot270, rot90-mirror (subject orientation wrong; 90/270 swap width/height), sar-2x1 (SAR 808:405, ellipse not round), odd-321x181 (SAR 404:405), audio-late-start and audio-short (audio span 0.44s / 2.0s short of the video), audio-late-cut-scene-music (dialogue onset -0.47s), vfr-irregular (output 3150/179 and 30/1, not the measured 15/1), hdr-pq/hdr-hlg (BT.2020 PQ/HLG tags carried through), hot-mix (sample peak 1.04, true peak +0.4 dBTP), emoji-sequences (0 emoji pixels), missing-glyph (exit 0, no typed failure), seek-past-source-end (exit-zero MP4 with no video stream), http-interrupted-read (59 of 150 frames, exit 0). rot180 and mirror-h are `expect: "pass"` regression guards: FFmpeg autorotation already renders them correctly, so the display-transform ticket must keep them right (the audit's "180/mirror" concern is about tracked coordinates, not today's pixels).

## Comments

Deviations and gaps
- **Deployed image not inspected.** The Railway worker build log shows only cached layers, so versions were recovered from the last build that executed the apt/pip layers (deployment `320ce761`, 2026-10-24T17:26Z; every later build, incl. current `39b41650`, hit the cache): Debian 13 trixie, `oven/bun:1.3.6@sha256:f20d9cf3...`, provider `...2.0.0-deno@sha256:a0b8b3a2...`, ffmpeg `7:7.1.5-0+deb13u1`, libass9 0.17.3, 241 installed package versions, Python 3.13.5, 14 wheels with PyPI SHA-256, YuNet at opencv_zoo `f12e1279` (SHA-256 `8f2383e4...`, identical to what `main` served). `railway ssh` needs an SSH key registered on the account, so the running container could not be read; ticket 21 must run `check-render-environment.ts --enforce` in it. Resolved fallback font hashes (`runtime-lock.json` `fonts.probes[].expectedSha256`) stay null until then (reported as `gap`).
- **Dockerfile is unbuilt.** It pins digests, installs from `snapshot.debian.org` at `20261024T172700Z` with `pkg=version`, installs wheels with `--require-hashes --no-deps`, verifies the model SHA-256, and runs `check-render-environment.ts --enforce` at build stages. The first Railway build proves it; a snapshot-mirror hiccup is the likely failure mode.
- **Startup enforcement request (ticket 17 / `apps/worker/src/index.ts`, not in this write set).** Railway's service `startCommand` is `bun run apps/worker/src/index.ts`, which overrides the Dockerfile `CMD` that runs the check. The worker should call `assertRenderEnvironment()` (exported from `scripts/check-render-environment.ts`, Node-only imports) at startup. I did not change Railway settings.
- Host fingerprint: macOS and Linux encodes are not claimed identical; `runtime-lock.json` has an authoritative entry only for `linux-x64`; the host is report-only apart from the platform-independent model and caption-face hashes.
- VFR fixture reproduces irregular timestamps (average 15/1, base 30/1, near-coincident frames) but FFmpeg 8.0.1 will not synthesize a 90000/1 base rate; ticket 06 can add one by hand. True container-level audio PTS gaps could not be synthesized either; "gapped" is covered by cut gaps, late and short audio.
- `resolveClipRenderTiming` is not in the harness: documents carry final timing. The glue between `inspectMedia`, `planClipComposition`, audio binding, ASS and `compileClipCompositionCommand` mirrors `clip-render-attempt.ts` (logo, music, SFX, B-roll, scenes, background); a later ticket that changes that glue inside `clip-render-attempt.ts` (not the exports it calls) will not be seen by the gate until ticket 21's integrated run.
- Container size, bitrate and mux tags are recorded but do not gate; decoded frames/PTS, PCM, codec/stream facts and loudness do.

How later tickets use it
- Parity gate for every output-touching ticket: the `verify` command above against `/tmp/narriflow-golden/baseline` (restore from the durable copy if /tmp was cleared). A baseline is never refreshed; verify refuses changed documents/evidence/known-defects and any changed fixture hash.
- Approved defect corrections add `apps/worker/src/__fixtures__/render-golden/expected/NN-<name>.json`: `{"ticket":"03","cases":{"rot90":{"contract":[Assertion...],"retain":["cue","layer"]}}}`. The listed defect cases must then meet the corrected contract (metrics: `render.ok`, `output.{sar,dimensions,pixFmt,color*,rFrameRate,avgFrameRate,durationDeltaFrames,hdrSideData}`, `video.{frameCount,frameCountDelta,quadrants,circleDisplayAspect,saturatedPixels}`, `audio.{samplePeak,truePeakDbtp,spanDeficitSec}`, `sync.avOffsetSec`, `typedFailure`; ops eq/ne/lte/gte/between/absLte/in, `{ref}` values) and only the categories not listed in `retain` may differ from the baseline. A defect that starts passing without such a file fails the gate as `xpass`.
- Encoder-comparison tolerances (SSIM, LU) are not implemented; the encoder experiment ticket must add that mode separately.
