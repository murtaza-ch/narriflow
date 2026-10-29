# 03 - Correct rotation and sample-aspect geometry

**What to build:** Use one display-oriented coordinate system for Studio, layout analysis, previews and exports, correcting only rotated/anamorphic/odd-SAR cases.

**Blocked by:** [02 - Normalize process starts and expose complete media facts](02-process-and-media-boundary.md)

**Status:** done

**Suggested implementer:** Claude

**Contract:** [Render hardening spec](../spec.md). Read the relevant contract sections and AGENTS.md before claiming.

## File ownership

Exhaustive write set, relative to repository root. This ticket may also update its own issue file with status and evidence. All other paths are read-only. Shared paths are serialized by blocker ancestry. If an additional file is necessary, amend the write set and dependency edges before editing it.

- `apps/worker/src/worker-process.ts`
- `apps/worker/src/composition-ffmpeg-adapter.ts`
- `apps/worker/src/tasks/clip-render-attempt.ts`
- `apps/worker/src/tasks/clip-render-attempt-runtime.ts`
- `apps/worker/src/tasks/clip-preview.ts`
- `apps/worker/src/tasks/auto-layout-analysis.ts`
- `apps/worker/src/layout-evidence-runtime.ts`
- `apps/worker/src/tasks/reframe.ts`
- `packages/composition-plan/src/clip-composition-plan.ts`
- `packages/composition-plan/src/display-geometry.ts`
- `packages/composition-plan/src/display-geometry.test.ts`
- `apps/worker/src/composition-display-geometry.test.ts`
- `apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/video-preview.tsx`
- `apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/composition-preview-adapter.ts`
- `apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/composition-preview-adapter.test.ts`
- `apps/worker/src/__fixtures__/render-golden/expected/03-display-geometry.json`

## Implementation

1. Adopt the inspection display transform in the shared planner and all media consumers listed. Match FFmpeg autorotation exactly once; transform detector/PiP coordinates and source dimensions together. Keep the new geometry helper internal to the composition package unless existing exports require a separately coordinated edit.
2. Calculate displayed aspect using SAR before existing center/fit/crop policy. Normalize output to square pixels only on paths whose existing output needs correction; keep ordinary identity-transform square-pixel args untouched.
3. Make the Studio consumer of the shared composition plan use corrected display dimensions and compatible durable evidence. Browser video dimensions are already display-oriented; avoid applying the matrix again to a decoded preview proxy. Keep crop math in the shared plan.

## Acceptance

- [x] 90/180/270 and mirrored display matrices show the expected subject, with no crop clamping or invalid crop.
- [x] Anamorphic 2:1 SAR and odd 321x181 sources retain correct displayed proportions and end at SAR 1:1. (SAR 2:1 verified by the golden gate; real odd 321x181 by a unit test. The golden `odd-321x181` fixture is actually 320x180, see Comments.)
- [x] Fit/center/speaker/PiP and preview/export use the same transformed coordinates.
- [x] Normal crops, argv, decoded frames and audio remain exact; corrected expectations affect only geometry-defect fixtures.

## Verification

Run from repository root. The command interface below is delivered by ticket 01 where applicable. Run media checks inside the pinned image. Record output/evidence rather than merely listing commands.

```sh
bun test packages/composition-plan/src/display-geometry.test.ts apps/worker/src/composition-display-geometry.test.ts apps/worker/src/tasks/clip-preview.test.ts apps/worker/src/tasks/auto-layout-analysis.test.ts
```

Run the full normal exact golden comparison from spec.md. For an approved defect ticket, also run its declared corrected expectations; preserve all unrelated baseline results.

`bun run lint` and `bun run typecheck` must pass for the assembled change. Capture scoped failures caused by unrelated in-flight work before changing any unowned file.

DB checks, when listed, must use `bash .scratch/api-extraction/db-gate.sh ...`; never run gates against shared Neon. No shared resource mutations or deployments are authorized by this ticket.

## Evidence

Base HEAD 91f6517d plus uncommitted edits. Host-only golden gate (see ticket 01).

- Parity-glue extraction first: `compositionSourceFor(probe, identity)` exported from `clip-render-attempt.ts` is now the one derivation of the planner source; `render-golden.ts` calls it. Unchanged-behavior verify exit 0 (`/tmp/narriflow-golden/candidate-03a`).
- Final gate: `bun apps/worker/scripts/render-golden.ts verify --baseline /tmp/narriflow-golden/baseline --suite all --out /tmp/narriflow-golden/candidate-03` exit 0. Normal 18/18 identical (plan, crops, cues, layers, argv/graph, frames+PTS, PCM, ffprobe); 4 corrected and passing (rot90, rot270, rot90-mirror, sar-2x1; `expected/03-display-geometry.json`, retain cue/layer/captions); rot180/mirror-h guards pass; 14 other defects unchanged xfail. PCM hashes of the 4 corrected cases equal the baseline. Log `/tmp/narriflow-golden/verify-03.log`.
- Visual: `/tmp/narriflow-golden/ticket-03/comparison.png` (baseline vs corrected for rot90, rot270, rot90-mirror, sar-2x1) and `source-quad-720p.png`. Corrected quadrants match the rotated/reflected source (rot90 TL green TR yellow BL red BR blue; rot270 blue/red over yellow/green; rot90-mirror yellow/green over blue/red); the SAR 2:1 ellipse is a circle.
- `cd apps/worker && bun test`: 792 pass, 0 fail. Worker typecheck clean. Web `composition-preview-adapter.test.ts` 31 pass; web typecheck shows no error in the touched files. Biome clean on all touched paths.

Design: `resolveDisplayGeometry` (worker-process.ts) is the only place the display matrix and SAR become planner dimensions (quarter turns, flips, SAR; oblique matrices keep coded dimensions). Callers pass those dimensions to the unchanged planner. The graph adds `scale=WxH,setsar=1` only for anamorphic sources and `,setsar=1` after an inexact center/fit scale only for sources whose geometry needed correction (rotated, reflected, anamorphic, odd-sized). A plan/source mismatch throws `clip_composition_source_geometry_mismatch`. Detector segments are re-extracted (autorotated) from an oriented local source. Anamorphic preview proxies are scaled to square pixels. Auto-layout analysis records display dimensions, so old coded-dimension evidence for rotated sources is invalidated by the existing dimension check. Studio ignores durable dimensions whose aspect differs from the proxy by more than 1%.

## Comments

- Write set not used: `packages/composition-plan/**`, `layout-evidence-runtime.ts`, `reframe.ts`, `video-preview.tsx` and the `display-geometry` composition-plan files needed no change (the planner takes display dimensions; proxy `videoWidth` is already display-oriented). The test lives in `apps/worker/src/composition-display-geometry.test.ts`.
- Fixture defect (ticket 01): `odd-321x181.mp4` is really 320x180 (lavfi testsrc2 rounds to even). Its 404:405 output SAR is the same universal result every ordinary 1280x720 center crop has today (405x720 -> 1080x1920): almost all normal outputs carry SAR 404:405, which the owner's byte-identical rule keeps. So `odd-321x181` stays an expected failure and was not activated. Declaring SAR 1:1 on all inexact center/fit scales would fix it with identical pixels but change argv for most normal cases; that needs an owner decision (ticket 09 output validation will meet this).
- `tasks/clip-render-attempt.test.ts` fakes lacking `facts` keep coded dimensions by design.

### Addendum: every output declares SAR 1:1 (orchestrator decision, replaces the odd-321x181 open item above)

- Root cause of the universal 404:405: `crop` rounds an odd width to the chroma multiple (405 -> 404), so `scale` then tags SAR 404:405 even though the planned ratio is exact. The center and fit compile paths now append `,setsar=1` after their scale unconditionally; the predicate was dropped. Decoded frames and PCM are bit-identical; only argv/graph, the SPS-carried SAR/DAR tags and extradata size change.
- Harness: `render-golden.ts` accepts `"change": "output-sar"` in an `expected/` entry (also for cases with an empty contract). It allows only the appended `,setsar=1` (argv/graph, filter-instance numbering in diagnostics) and SAR/DAR/extradata_size tags, and asserts candidate video streams are SAR 1:1 with a matching DAR. Frame/PTS, PCM, loudness and decode compare exactly. Record: `expected/03b-output-sar.json` (11 normal cases, 10 defect cases, and `odd-321x181` activated with its contract).
- Gate: `bun apps/worker/scripts/render-golden.ts verify --baseline /tmp/narriflow-golden/baseline --suite all --out /tmp/narriflow-golden/candidate-03b` exit 0, log `/tmp/narriflow-golden/verify-03b.log`. Normal 18/18 pass; known defects: 13 expected failures/guards unchanged, 5 corrected and passing (rot90, rot270, rot90-mirror, sar-2x1, odd-321x181), 0 xpass, 0 changed.
- Across the 36 cases: 30 targets changed argv (the four geometry fixes plus the SAR declaration); frame hashes changed only for rot90, rot270, rot90-mirror and sar-2x1 (the geometry fixes); PCM hashes changed in 0 cases.
- Per-case summary (candidate-03b): pass solo-auto-vertical, two-up-speaker-vertical, screen-pip-portrait, explicit-split-portrait, rtl-arabic-captions, cjk-dense-captions, logo-broll-music-sfx-censor, cut-and-inserted-scenes, exact-source-end, treatments-720p-watermark-1080p, image-background-fit, audio-only-audiogram, mono-44k, silent-video, ntsc-24000-1001, ntsc-30000-1001, text-layers-transition, speed-playback-rate-ui-only; activated-pass rot90, rot270, rot90-mirror, sar-2x1, odd-321x181; guard-pass rot180, mirror-h; xfail audio-late-start, audio-short, audio-late-cut-scene-music, vfr-irregular, hdr-pq, hdr-hlg, hot-mix, emoji-sequences, missing-glyph, seek-past-source-end, http-interrupted-read.
- Tests updated: `composition-display-geometry.test.ts` (graphs now carry `setsar=1`) and three expectations in `composition-ffmpeg-adapter.test.ts` (outside the listed write set; needed for the new argv). `cd apps/worker && bun test`: 792 pass, 0 fail; worker typecheck, the script typecheck and biome are clean.
