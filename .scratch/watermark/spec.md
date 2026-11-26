# Free-plan watermark badge

Status: ready to build. Owner request 2026-11-27: "watermark like Vizard.ai, on the Free plan only".

## What exists

Narriflow already burns a watermark into exports for a workspace whose plan lacks `export.noWatermark` (Free only; Creator, Pro and Business have it). The entitlement is decided server-side and frozen on the export; no client flag can change it. That part stays as it is.

What is wrong is the mark itself: plain text "Made with Narriflow", top-right, drawn with `drawtext` in a font the media image does not have (`Arial Bold` falls back silently to Liberation Sans), while the Studio preview draws CSS Arial.

- Plan: `packages/composition-plan/src/clip-composition-plan.ts` (`CompositionOutputTreatmentVisualLayer`, builder near line 3285).
- Export: `apps/media/src/composition-ffmpeg-adapter.ts` (`output-treatment` stage near line 765).
- Preview: `apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/video-preview.tsx` (near line 2337).

## What to build

Replace the text with one branded badge image, the same pixels in preview and export. There are no production users: remove the text path completely, keep no fallback to it.

### 1. The art (already in the repo, do not redraw)

- `packages/composition-plan/assets/watermark-badge.png`: 940 x 446, RGBA, straight alpha. A white "made with" line above a white rounded pill holding the Narriflow waveform mark and wordmark, with a soft shadow baked in.
- `packages/composition-plan/assets/watermark-badge.svg`: its source (text already outlined as paths). The PNG is `rsvg-convert watermark-badge.svg -o watermark-badge.png`.
- SHA-256 of the PNG: `e5ede2c73284d6e487fb3a1376d5362c9d955115e1e29a864a956f9badf4143c`.

### 2. Plan layer

In `@narriflow/composition-plan`, export a constant that is safe for the browser and the Cloudflare Worker (the API Worker imports this package's index, so the index must never import the PNG):

```ts
export const NARRIFLOW_WATERMARK_ART = {
  id: "narriflow-badge-1", width: 940, height: 446,
  sha256: "e5ede2c73284d6e487fb3a1376d5362c9d955115e1e29a864a956f9badf4143c",
} as const;
```

Replace the `watermark` member of `CompositionOutputTreatmentVisualLayer` with:

```ts
readonly watermark:
  | { readonly enabled: false }
  | { readonly enabled: true;
      readonly art: typeof NARRIFLOW_WATERMARK_ART.id;
      /** The frame after the output scale; the badge is placed in these pixels. */
      readonly outputPx: { readonly width: number; readonly height: number };
      readonly rectPx: { readonly x: number; readonly y: number; readonly width: number; readonly height: number } };
```

Geometry, one rule for every aspect ratio (9:16, 1:1, 16:9, 4:5):

- `outputPx` is the canvas for 1080p. For 720p it is exactly what FFmpeg's `scale=trunc(iw*2/3/2)*2:trunc(ih*2/3/2)*2` produces: `2 * floor(n * 2 / 3 / 2)` per side. The planner and the adapter must not be able to disagree about this size; have one of them derive from the other or share one helper.
- `even(n) = 2 * Math.round(n / 2)`.
- `s = min(outputPx.width, outputPx.height)`.
- `width = even(0.26 * s)`, `height = even(width * 446 / 940)`.
- `x = even(0.07 * s)`, `y = even(0.235 * outputPx.height)`.

Expected values (put them in a test table):

| Output | rect (w x h @ x,y) |
|---|---|
| 720x1280 | 188x90 @ 50,300 |
| 1080x1920 | 280x132 @ 76,452 |
| 720x720 | 188x90 @ 50,170 |
| 1080x1080 | 280x132 @ 76,254 |
| 1280x720 | 188x90 @ 50,170 |
| 1920x1080 | 280x132 @ 76,254 |
| 720x900 | 188x90 @ 50,212 |
| 1080x1350 | 280x132 @ 76,318 |

If your arithmetic gives a different number for a row, say so in the report rather than quietly changing the rule.

The mark is static for the whole clip, fully opaque, on top of every other layer (the layer keeps zIndex 70). No outro card, no motion.

If the composition plan (or anything derived from it) feeds a version, cache key or fingerprint that decides whether an existing render is still current, check whether this change needs that value bumped, and report what you found either way.

### 3. Export (media)

- Add the package subpath export `"./watermark-badge.png"` to `packages/composition-plan/package.json`.
- New `apps/media/src/watermark-art.ts`: resolves the PNG's absolute path, verifies its SHA-256 against `NARRIFLOW_WATERMARK_ART.sha256` once (memoised), returns the path. A missing or altered file throws a permanent composition failure (follow how the adapter reports permanent failures today, e.g. `CompositionCommandFailure` with a code such as `watermark_art_invalid`) before FFmpeg starts.
- In the `output-treatment` stage of `compileCompositionPlanVisualLayers`, replace `drawtext` with an image overlay fed by the `movie=` source filter, so the three command builders need no new input slot:

```
movie=filename=<escaped path>,scale=<w>:<h>:flags=lanczos,format=rgba[composition_watermark_N];
[prev]scale=trunc(iw*2/3/2)*2:trunc(ih*2/3/2)*2[composition_output_N];      (720p only)
[composition_output_N][composition_watermark_N]overlay=x=<x>:y=<y>:eof_action=repeat[next]
```

  Follow the conventions of the existing brand-logo overlay stage in the same function (labels, pixel format, how `parts` are returned). Escape the path with the adapter's existing filter-option escaping. Confirm the escaping against the real way the graph is handed to FFmpeg (argument or script file).
- Fail closed. The adapter throws if the layer's `art` id is not `NARRIFLOW_WATERMARK_ART.id`, or if `rectPx` does not sit inside `outputPx`. An enabled watermark must always put an `overlay` in the graph; there must be no branch where `enabled: true` produces a graph without it.
- Do not add `movie` to `requiredFilters` in `apps/media/runtime-lock.json` and do not add fonts: both change the toolchain fingerprint, which needs a Worker secret update. Confirm that nothing in this change alters the fingerprint identity (`apps/media/scripts/check-render-environment.ts`), and confirm the PNG reaches the render image (`apps/media/images/Dockerfile` copies `packages`; check the dockerignore files).
- The entitlement code in `apps/media/src/tasks/clip-render-attempt.ts` and `packages/services` is not part of this change.

### 4. Studio preview (web)

Replace the text `Box` in `video-preview.tsx` with an `<img>` of the same PNG, positioned from the plan: `left = x / outputPx.width`, `top = y / outputPx.height`, `width = rect.width / outputPx.width`, all as percentages of the preview frame, height following the image's aspect. Not draggable, empty `alt`, `aria-hidden`, `pointer-events: none`, same z-order as today.

Import the PNG so the bundler serves the one committed file (package subpath or a relative import, as `apps/web/app/caption-fonts.ts` does for fonts). Read the Next.js docs in `apps/web/node_modules/next/dist/docs/` for static image imports in this Next version before writing it. Do not copy the PNG into `apps/web/public`. `bun run check:web-split` must still pass.

### 5. Publishing never posts a watermarked export on a paid plan

`packages/services/src/social-publication-scheduling.ts` (around line 354) accepts a caller-supplied `clipExportId` if identity, revision and resolution match. It does not look at the export's watermark flag, so a workspace that upgraded can publish an export it made while Free, mark included. Add `watermark: boolean` to `PublicationExportFacts`, select it in `social-publication-scheduling-runtime.ts` `readExport`, and reject with the existing `publication_export_mismatch` error when the export is watermarked and the actor's plan has `export.noWatermark` (use `hasFeature`, never a bare tier comparison). Add a unit test next to the existing ones.

### 6. Tests

- `packages/composition-plan/src/clip-composition-plan.test.ts`: the geometry table above; `{ enabled: false }` when not entitled to a mark; a test that the PNG file's SHA-256 and pixel size equal the constant.
- `apps/media/src/composition-ffmpeg-adapter.test.ts`: the exact graph for 720p and 1080p with the mark; no overlay and no scale for clean 1080p; scale only for clean 720p; missing/altered art fails before FFmpeg; wrong art id and off-frame rect throw. If the file already has tests that run the real FFmpeg, add one that renders a few frames for each of the 8 outputs above and checks the output size and that pixels inside the badge rect changed while a far corner did not.
- Update every test and fixture that pinned the old text. For the golden suite (`apps/media/scripts/render-golden*`, `apps/media/src/__fixtures__/render-golden`), work out whether any committed expectation encodes the old watermark pixels. Recapture only what this change affects, with the suite's own tooling, and list exactly which files changed. If recapture needs a heavy or long run, stop and report instead.
- Web: adjust the existing preview adapter test if its expectations change.

### 7. Docs

- One or two sentences in `docs/adr/0004-clip-composition-plan.md` where it describes the output treatment: the watermark is a single committed badge image, placed by the plan, drawn from the same file in preview and export.
- Fix any user-facing copy that describes the old mark's look or position. Copy that only says Free exports are watermarked stays.

## Not in this change

- No change to which plans get the mark, to pricing copy, or to how the flag is frozen.
- No watermark on the source file or the low-resolution preview proxy.

## Rules

- Work in the shared checkout `/Users/murtaza/Documents/dev/narriflow`. Other sessions have uncommitted edits here (`AGENTS.md`, `apps/api/scripts/dev.ts`, `apps/media/scripts/caption-scene-final.ts`, `apps/web/app/_components/api-provider.tsx`, `docs/runbooks/*`, several `.scratch` folders). Do not touch, revert or stage them.
- Do not commit, push or deploy.
- Verification is the fast set only: `bun run lint`, `bun run typecheck`, `bun run test`, `bun run check:web-split`. No database tests, no `next build`, no Docker, no workerd or MCP integration suites. Use the Bun version the media suite expects (it fails on any other).
