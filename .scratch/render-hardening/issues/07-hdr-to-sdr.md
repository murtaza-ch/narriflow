# 07 - Tone-map HDR before composing SDR layers

**What to build:** Export correctly converted and tagged BT.709 SDR for HDR sources without changing normal SDR output.

**Blocked by:** [06 - Normalize affected VFR clocks to sane CFR](06-vfr-clock.md)

**Status:** done

**Suggested implementer:** Claude

**Contract:** [Render hardening spec](../spec.md). Read the relevant contract sections and AGENTS.md before claiming.

## File ownership

Exhaustive write set, relative to repository root. This ticket may also update its own issue file with status and evidence. All other paths are read-only. Shared paths are serialized by blocker ancestry. If an additional file is necessary, amend the write set and dependency edges before editing it.

- `apps/worker/src/composition-ffmpeg-adapter.ts`
- `apps/worker/src/composition-hdr.test.ts`
- `apps/worker/src/__fixtures__/render-golden/expected/07-hdr-to-sdr.json`
- `apps/worker/src/tasks/clip-render-attempt.ts` (amended: probes HDR scene and B-roll videos and passes `assets.hdr`)
- `apps/worker/scripts/render-golden.ts` (amended: harness passes `assets.hdr` through the same exported `hdrColorOf`; no mirrored logic)

## Implementation

1. Use source primaries/transfer/range/mastering facts to linearize, tone-map, convert to limited-range BT.709 and remove stale HDR metadata before SDR overlays.
2. Use the pinned zscale/tonemap CPU path described in the spec, including Hable parameters and peak assumptions in expected results. Correct HDR optional video layers too.
3. Handle supported Dolby Vision base layers explicitly and reject unsupported enhancement-only content with a typed code. Keep SDR filter paths and tags unchanged.

## Acceptance

- [x] PQ and HLG reference patches demonstrate actual conversion, highlight rolloff and correct SDR overlay luminance; changing tags alone fails tests.
- [x] Output is H.264 yuv420p with BT.709 primaries/transfer/matrix/range and no stale PQ/HLG mastering side data.
- [x] Missing required HDR filter is a deployment-health failure, not silent relabeling.
- [x] Normal SDR golden args, decoded frames, audio and color tags remain exact.

## Verification

Run from repository root. The command interface below is delivered by ticket 01 where applicable. Run media checks inside the pinned image. Record output/evidence rather than merely listing commands.

```sh
bun test apps/worker/src/composition-hdr.test.ts apps/worker/src/composition-ffmpeg-adapter.test.ts
```

Run the full normal exact golden comparison from spec.md. For an approved defect ticket, also run its declared corrected expectations; preserve all unrelated baseline results.

`bun run lint` and `bun run typecheck` must pass for the assembled change. Capture scoped failures caused by unrelated in-flight work before changing any unowned file.

DB checks, when listed, must use `bash .scratch/api-extraction/db-gate.sh ...`; never run gates against shared Neon. No shared resource mutations or deployments are authorized by this ticket.

## Evidence

Base `b2e6ad13` plus this ticket's uncommitted paths. Host macOS arm64, FFmpeg 8.0.1 (zscale/libzimg, tonemap present). Pinned image FFmpeg 7:7.1.5-0+deb13u1: Debian's `debian/rules` passes `--enable-gpl --enable-libzimg` (checked on sources.debian.org), `libzimg2 3.0.5+ds1-1+b2` is in the lock, and `runtime-lock.json` `requiredFilters` already lists `zscale` and `tonemap`. No container runtime here, so the in-image run stays with ticket 21. `colorspace` cannot linearize PQ/HLG and libplacebo needs a GPU, so zscale + tonemap is the only CPU path both builds share.

Design (all in `composition-ffmpeg-adapter.ts`): `hdrColorOf(inspection)` returns null for SDR (no change to argv, graph or frames) and, for a PQ or HLG first video stream, the zscale names of its primaries/matrix/range plus the tone-map peak. Chain, inserted after geometry and the CFR `fps=` stage: `zscale=tin=<pq|hlg>:pin=..:min=..:rin=..:t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0:peak=P,zscale=t=bt709:m=bt709:p=bt709:r=limited:dither=ordered,format=yuv420p`. Input is stated explicitly so untagged or half-tagged files still convert. Peak P (units of 100 cd/m2): HLG 10; PQ MaxCLL, else mastering max luminance, when 100..10000 cd/m2, else 10 (1000 cd/m2 assumption). Missing/odd companion tags assume BT.2020 primaries and matrix, limited range. Final frames get `setparams` BT.709 tags only when something was converted (the CLI left primaries/transfer untagged across a scene concat with `-colorspace` args alone). No stale mastering/CLL side data survives. HDR inserted-scene and B-roll videos run the same chain after trim and before fit (`assets.hdr` by asset ref, filled by the attempt from each asset's probe). Dolby Vision: HDR10/HLG-compatible base layers (compat id 1/4/6, profile 7/8) convert; SDR-compatible base is SDR and untouched; profile 5, compat id 0 or no base layer fails `hdr_dolby_vision_unsupported` (permanent).
Fallbacks that keep a render alive: no/invalid metadata -> default peak; missing tags -> assumed BT.2020; unreadable B-roll probe -> SDR path. Unrecoverable by design: a missing zscale/tonemap (deployment health, caught by the lock's `requiredFilters` and `check-render-environment`) and unsupported Dolby Vision.
zimg facts measured here and encoded in the test reference: tonemap = hable(x)/hable(peak) unclamped; the linear -> `t=bt709` step is a pure 1/2.4 power (BT.1886), not the BT.709 OETF; HLG system gamma 1.2 is applied per channel (ARIB B67), not by luma.

Parity gate `bun apps/worker/scripts/render-golden.ts verify --baseline /tmp/narriflow-golden/baseline --suite all --out /tmp/narriflow-golden/candidate-07`: **exit 0**. Normal 18/18 identical (argv, graph, frames, PCM, ffprobe). Known defects: 6 expected failures unchanged, 0 unexpectedly passing, 12 corrected and passing (hdr-pq 7/7, hdr-hlg 7/7). hdr-pq/hdr-hlg: ffprobe output h264 yuv420p, color_range tv, primaries/transfer/space bt709, no mastering/CLL side data; frames 90 -> 90; audio PCM sha identical to baseline. Log `/tmp/narriflow-golden/verify-07.log`, report `/tmp/narriflow-golden/candidate-07/report.md`.
`bun test` in apps/worker: 874 pass, 0 fail (new `composition-hdr.test.ts`: 13 tests). Worker typecheck clean; biome clean on the five paths. `composition-hdr.test.ts` renders real x265 PQ/HLG media of eight known patches (grays 1..800 cd/m2, red, green, skin) and compares output Y/Cb/Cr with an independent reference (ST 2084 / HLG EOTF, BT.2020 -> BT.709, Hable, BT.1886): luma within 4, chroma within 6 for both transfers, a MaxCLL 4000 file, and an HDR inserted scene video; a relabel-only control is more than 8 luma codes off. Stills in `/tmp/narriflow-golden/ticket-07/` (`compare-pq.png`, `compare-hlg.png`: relabel | our chain | independent reference; `baseline-vertical-*` vs `candidate-vertical-*` are the harness renders).

## Comments

- Write set amended (see list): optional layers needed per-asset facts that only the attempt has; the harness calls the same exported `hdrColorOf`, so the parity gate stayed exact before and after.
- Known limit: an HDR scene video inserted into an SDR source that carries no color tags at all concatenates a BT.709-tagged branch with untagged ones; swscale then shifts grays by about 2 codes. Tagged SDR sources (nearly all real ones) are exact (tested).
- Tone mapping runs at source resolution before crop, on float frames; a 4K HDR source is slow on CPU. Ticket 16 (resource bounds) should budget it.
- Request for ticket 14/17: classify ffmpeg stderr `No such filter: 'zscale'` / `'tonemap'` as executor/configuration health, and `hdr_dolby_vision_unsupported` as permanent. Ticket 21: run `check-render-environment.ts --enforce` in the image to confirm zscale/tonemap.
- Pre-existing, not mine: `bunx tsc` over `scripts/render-golden.ts` reports `encodedArgs` at line 1073 (from ticket 05's mix-peak guard); the script is outside the worker tsconfig.
