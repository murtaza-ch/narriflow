# 07 - Studio preview: paint the emoji layer on all three caption paths

**What to build:** The Studio shows emojis exactly where and when the export will draw them, with
no cost to first load or playback. No controls yet (ticket 09). Rules: [../RULES.md](../RULES.md).
Spec D3 and section 4.

**Blocked by:** [04 - The emoji layer](04-emoji-layer.md)

**Status:** done

## Areas

`apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/` painters and overlays,
a new `studio/_components/emoji/` folder for the layer and its hooks. Not the tool panels
(`captions-panel.tsx` only loses the old toggle wiring).

## Deliverables

1. `emoji/use-caption-emoji-art.ts`: loads art for the ids the plan's caption layers use
   (`loadCaptionEmojiArt`, dynamic import, deduplicated, cached for the session). Returns the map
   and a pending flag. Follow the painter's existing `pending` / `load` pattern
   (`caption-scene-painter.tsx` about lines 93-108). The emoji index and art must not enter the
   Studio's initial chunks.
2. `emoji/caption-emoji-layer.tsx`: one component mounted above the captions for every preset
   kind. It builds cue boxes, calls `buildCaptionEmojiPieces`, and paints with the existing Scene
   painter (`CaptionSceneLayers` / `CaptionScenePainter`) driven by the same playback clock.
   - Scene Styles: `sceneCueBoxes` on the scene the overlay already built
     (`interactive-scene-overlay.tsx`, `useCaptionScene`). The emoji layer has its own memo key
     (`captionEmojiLayerKey`); an emoji edit must not rebuild the template's scene, and a template
     rebuild must not re-fetch art.
   - Dynamic Styles: `blockCueBox` from the block layout the block painter already computes
     (`caption-block-painter.tsx`, shared `layoutCaptionBlock`).
   - Classic presets: `lineCueBox` from the cue element's layout box (offset metrics, which ignore
     the line's animation transform), converted to canvas px, measured when the cue or the preview
     size changes and never per frame.
   - The build is deferred the way the caption-panel performance work defers scene builds (read the
     current `caption-scene-painter.tsx` and `interactive-scene-overlay.tsx`; they carry uncommitted
     work on build caching that you must keep intact).
3. Delete the old Studio emoji: `CaptionEmoji`, `showEmojis`, `emojiWindow` and their imports in
   `caption-style-engine.tsx` (about 42-52, 70, 171-196, 325, 553-640, 652-730),
   `caption-cue-at.ts` (42-46), `interactive-caption-overlay.tsx` (about 468), and the old toggle
   wiring in `captions-panel.tsx` (about 434, 452, 719-725; ticket 09 adds the new section). Update
   their tests. Remove the atlas alias from `apps/web/tsconfig.json` (lines 9, 13) if nothing in web
   still needs it.
4. A prototype page for verification, beside the existing ones in `apps/web/app/prototype/`
   (see `caption-parity` there): renders a fixed set of cues with emojis on one classic, one
   Dynamic and several Scene presets, LTR and RTL, with a scrubber, using the real layer.
5. Tests: the box providers' conversions (classic layout box to canvas px), the memo key behaviour
   (emoji edit keeps the scene build key; palette change rebuilds only the emoji layer), art hook
   deduplication.
6. Verify in a browser if a dev server can be started cheaply (`bun run --cwd apps/web dev` needs
   `NEXT_PUBLIC_API_URL`; the prototype page needs no API). Take screenshots of the prototype page
   at the pop's midpoint and at rest for each preset kind and save them to the scratchpad
   (`/private/tmp/claude-501/-Users-murtaza-Documents-dev-narriflow/f7147bb1-206f-4f6e-a8fc-276dea0eb55b/scratchpad/emoji-studio/`).
   Compare one of them with the matching export frame from ticket 06 if it exists in
   `.../scratchpad/emoji-export/`. If you cannot run a browser, say so.
7. Budget: confirm with the Next build analyser or by reading the import graph that the Studio's
   initial chunks do not include `@narriflow/caption-emoji`; record the emoji-layer build time for
   a 60 s clip with 20 emojis in the browser.

## Acceptance

- [x] Deliverables 1 to 7.
- [x] `bun run lint`, `bun run typecheck`, web tests (`bun run --cwd apps/web test`),
      `bun run check:web-split` (lint: no diagnostic in a touched file; see Evidence).

## Evidence

Implemented 2026-11-26. Nothing committed.

### Files

Studio (`apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/`):

- `emoji/use-caption-emoji-art.ts` (new): `createCaptionEmojiArtCache(loadArt)` (per-id dedupe, joins
  in-flight requests, unknown ids count as answered, a failed request is retried by the next load) and
  `useCaptionEmojiArt(ids)`; the session cache dynamic-imports `@narriflow/caption-emoji/art`.
- `emoji/caption-emoji-layer.tsx` (new): `CaptionEmojiLayer`, the one layer for all three paths, plus
  `buildCaptionEmojiLayer(plan)` and `captionEmojiPlanKey(plan)`.
- `emoji/scene-caption-emojis.tsx` (new): `SceneCaptionEmojis`, `sceneEmojiCueSource(built)`, `sceneEmojiGeometry(input)`.
- `emoji/cue-emoji-boxes.ts` (new): `classicLineEmojiCueBox`, `blockEmojiCueBox`, `oneCueSourceKey`.
- `emoji/cue-caption-emojis.tsx` (new): `ClassicCaptionEmojis`, `BlockCaptionEmojis`.
- `emoji/caption-emoji-fixture.ts` (new): a fixed clip with `captionEmojis` through the real plan (tests and prototype).
- `emoji/caption-emoji-layer.test.ts` (new, 12 tests).
- `caption-scene-painter.tsx`: `MeasuredScene.input?` (the build input; 2 lines). Nothing else changed: the
  deferred build, `buildSceneOnce`, `stableByKey`, mount window and tick are untouched.
- `interactive-scene-overlay.tsx`: one mount line (`<SceneCaptionEmojis>` after the scene layers, same wrapper).
- `interactive-caption-overlay.tsx`: line-size state + `onLineSize`, mounts `ClassicCaptionEmojis` and
  `BlockCaptionEmojis`; `showEmojis` and `timeSec` removed.
- `caption-style-engine.tsx`: `CaptionEmoji`, `showEmojis`, `timeSec`, `emoji`/`emojiWindow` on
  `CaptionCueWord`, the atlas and sprite imports and `emojiForWord` removed; new `onLineSize` prop
  reported from the line's existing ResizeObserver/font-load measure. Tests rewritten.
- `caption-cue-at.ts`: `emoji`, `emojiWindow` removed. Tests updated.
- `tool-panels/captions-panel.tsx`: the two `showEmojis` props and the Emoji toggle chip removed
  (and the now unused `Smile` import, a stale comment word). Apply-to-all handler untouched.

Elsewhere (minimal, listed for the coordinator):

- `packages/caption-scene/src/emoji/style.ts` (new) + `style.test.ts` + one export line in `emoji/index.ts`:
  `captionEmojiLayerStyle(preset)`, `captionEmojiLayerEmojis(layers)`, `captionEmojiCueDirection(words, language)`,
  so the export can call the same derivation instead of writing its own.
- `apps/web/package.json` (+`@narriflow/caption-emoji`), `bun.lock` (one line), `apps/web/next.config.ts`
  (`transpilePackages` + caption-emoji), `apps/web/tsconfig.json` (atlas.png alias removed; the
  `caption-fonts/emoji` alias stays: `captionGraphemes` still comes from there until ticket 10 moves it).
- `apps/web/app/prototype/caption-emojis/{page.tsx,caption-emojis.tsx,frames.ts}` (new): the harness.

### Style derivation (all three paths)

| Input | Scene Style | Dynamic Style | Classic |
| --- | --- | --- | --- |
| `palette` | `captionEmojiLayerStyle(preset)` = `resolveCaptionEmojiPalette(preset, captionEmojiTemplateColours(preset))` | same | same |
| `size` | `preset.emojiSize ?? 1` | same | same |
| `position` | `preset.emojiPosition ?? "auto"` | same | same |
| `sticker` | `preset.emojiSticker !== false` | same | same |
| `shadowColour` | `captionEmojiTemplateColours(preset).shadow` (= `preset.shadowColor`) | same | same |
| `slot` | `captionSceneEmojiSlot(preset.scene)` | `"above"` | `"above"` (a Scene preset's untimed classic line keeps its scene's slot) |
| `bodyPx` | `captionSceneMeta(scene).bodyPx * sceneInputFromPreset(...).scale` (= `preset.fontSize`) | `preset.fontSize * layout.scale * captionDynamicStyle(block.style).roles.body.sizeEm` | `preset.fontSize * fit`, `fit = min(1, CAPTION_FIT_WIDTH_FRACTION * canvas.width / (naturalWidth + 2 * (outlineWidth + outerOutlineWidth)))` (the worker's `cueGeometry` formula) |
| `anchorYPct` | `sceneInputFromPreset(...).anchor.yPct` (the overlay passes `layer.anchor`) | `layer.anchor.yPct` | `layer.anchor.yPct` |
| `direction` | `captionEmojiCueDirection(cue.words, cue.language)` = `captionTextDirection(words joined by " ", languageDirection(language))` | `paint.direction` (`captionBlockDirection(block.texts, language)`, the shared block geometry's) | `captionEmojiCueDirection(layer.words, layer.language)` |
| emojis | `captionEmojiLayerEmojis(layers)`: `{ cueIndex, id, tone?, atMs: atSec * 1000 }` (no rounding, as `sceneCuesFromLayers` converts) | same, one layer | same, one layer |
| cue box | `sceneCueBoxes(built.scene, built.input.cues, { measure: built.measure, canvas, bodyPx, direction })` | `blockCueBox(paint.layout, paint.words.map(w => w.measured), timing)` | `lineCueBox` (below) |
| `fromMs`/`toMs` | from `sceneCueBoxes` | `activeRange.startSec/endSec * 1000` | `activeRange.startSec/endSec * 1000` |
| `fps` | not passed (placement uses `SCENE_DEFAULT_FPS`) | same | same |

Classic box: `centerX, centerY` = the anchor in canvas px; `width = (offsetWidth / scale) * fit + 2 * stroke`;
`top/bottom = centerY ∓ ((offsetHeight / scale) * fit) / 2 ∓ stroke`; `tiltDeg` = `CAPTION_CUE_TILTS_DEG[cueIndex % 4]`
when `CAPTION_MOTIONS[captionClassicAnimation(preset)].tilt`, else 0; pivot = anchor. The vertical extent is the
font's line box (the line div has `line-height: normal`), not ink. For the worker to match, use its own line box:
`centerX = lineCenterX`, `width = lineWidth + 2 * strokePx`, `top = lineTopY - strokePx`,
`bottom = lineTopY + (ascentEm + descentEm) * px + strokePx`, `tiltDeg`, `pivot = (anchorX, anchorY)`,
`bodyPx = px`. Expected differences: (1) HarfBuzz advance vs browser layout width (a few px); (2) libass centres
the `\pos` bbox, the Studio the advance box, so the worker's `lineCenterX` sits `(widthEm / 2 - bboxCenterEm) * px`
off the anchor (side bearings, 1 to 3 px); (3) `offsetWidth/Height` are whole display px, so up to 0.5 / scale
canvas px (1.4 px at 0.35); (4) if the worker passes ink instead of the line box, the Studio box is taller by
`(ascent - inkTop + descent - inkBottom) * px`, about 0.2 to 0.3 em, and its emoji sits that much further out.
Dynamic and Scene boxes have no such difference beyond each side's own text measurement (Canvas vs HarfBuzz),
since both run the same shared function on the same layout.

### Memo keys and when things build

- Scene: the emoji layer's source key is the built scene object's identity (`scene:<n>`). A scene object is
  built once per `sceneBuildKey` (plus a face load), so the emoji layer rebuilds exactly when the scene does.
  Emojis are not in `SceneCue` (plan emojis are a separate field), so an emoji edit keeps `sceneBuildKey`.
  Cue boxes are computed from `built.input` (the cues the scene was built from), never a newer input.
- Layer key: `captionEmojiLayerKey({ ...input, cueBoxes: [] }, source.key)`: the source key stands for the
  boxes. Plans are kept per key (`stableByKey`), built in a deferred render (`useDeferredValue`), and cached
  per plan object in a WeakMap, so an interrupted deferred render (every playback tick is one) never builds
  twice. The cue boxes themselves are computed inside that deferred build.
- Style follows the current layers' preset; a palette, size, position or sticker change rebuilds only the
  emoji layer (tested).
- Art: one session cache per id. A scene rebuild reuses loaded art (tested: concurrent loads share one
  request, answered ids are never asked again).
- Classic: `CaptionCue` reports `offsetWidth/offsetHeight` from the measure it already runs (the line's
  ResizeObserver and font loads; the line node is new per cue, so it reports once per cue and on a resize).
  The overlay stores `{ cueId, width, height, scale }` only when it changed; no layout read per frame and no
  render loop (the callback goes through a ref, `setState` returns the previous object when equal).
- All three providers are `memo` components with stable props, so the video preview's per-tick re-render
  does not reach them. Pieces paint through `CaptionSceneLayers` (mount window, tick evaluates only live
  pieces).

### Budget

- Chunks: by import graph, the web app's only runtime import of `@narriflow/caption-emoji` is the dynamic
  `import("@narriflow/caption-emoji/art")` in `use-caption-emoji-art.ts`; `caption-scene` imports `/draw`
  (geometry and path parser, no data) statically and `/art` as a type only. Checked on the dev server too:
  the 42 initial scripts of `/prototype/caption-emojis` (same modules as the Studio) contain `/draw` code
  but no catalog (`woman-astronaut` absent). No `next build` was run (banned).
- Build time, 60 s clip, 20 emojis, in headless Chrome 158 on the dev Mac, dev build (unminified, dev React),
  real Canvas measurement, cue boxes + placement, median of 7, five page loads: Horizon (2,775 scene pieces)
  16.7 / 16.9 / 17.0 ms, Wordform (1,950) 14.6 / 14.7 ms, Lyrics (466) 18.2 / 18.5 ms. Two loads ran slower
  (Horizon 55.4 / 55.9, Wordform 46, Lyrics 33 ms) with the machine busy. 20 of 20 placed, 112 emoji pieces.
  This runs once per layer build in a deferred render, never per frame.

### Browser check

- Prototype: `/prototype/caption-emojis` (dev only; no API or sign-in). `?t=` sets the shared clock (scrubber
  and Play on the page), `?only=<preset>[-rtl]` shows one frame, `?pop=<n>&offset=<ms>` puts each frame at its
  own n-th emoji's anchor plus an offset. Frames: bold-pop (classic), headline (Dynamic), lyrics, dialogue,
  horizon, index, bubble (Scene), LTR and Urdu.
- agent-browser could not screenshot in this environment (even a `data:` page timed out; the display link
  failed, `CVDisplayLinkCreateWithCGDisplay failed`), so screenshots were taken with headless Chrome directly
  (`--headless=new --virtual-time-budget=15000 --screenshot`, scratch profile).
- Screenshots in `/private/tmp/claude-501/-Users-murtaza-Documents-dev-narriflow/f7147bb1-206f-4f6e-a8fc-276dea0eb55b/scratchpad/emoji-studio/`:
  `grid-pop-mid.png` (all 10 frames, emoji 0 anchor + 90 ms: every frame draws its emoji), `grid-rest.png`
  (+450 ms: the classic and short RTL cues have ended, so their emojis are gone, as placed), `closeups.png`
  and `<frame>-pop.png` / `<frame>-rest.png` for bold-pop, headline, lyrics, horizon, bubble-rtl, headline-rtl.
  Seen: sticker outline and offset shadow on every emoji, palettes follow the template (Headline green, Horizon
  pink, Bubble pink, Index lime), Lyrics and Dialogue use their slots, Headline Urdu places below (face zone).
- Export comparison: ticket 06's frames (`emoji-export/ltr/headline-0-rest.png`) use a different clip, so only
  the look compares: same palette roles, outline, shadow, slot above the block, size about 10% of the width.
  No pixel comparison was possible.

### Commands

- `bun run typecheck`: 17 of 17 successful.
- `bun run --cwd apps/web test`: 1,264 pass, 0 fail.
- `bun test src/emoji/style.test.ts src/emoji/layer.test.ts` in `packages/caption-scene`: 28 pass.
- `bun run check:web-split`: passed.
- `bun run lint`: 169 errors, none in a file this ticket touched (`.scratch/**`, web CSS/HTML prototypes,
  `apps/web/scripts/caption-cards/render.ts`; earlier tickets recorded 168). `bunx biome check` on every
  touched file: clean.

### Not covered

- `blockEmojiCueBox` has no unit test of its own (a block paint needs browser measurement; `blockCueBox` is
  tested in caption-scene); it is exercised in the prototype's Dynamic frames.
- While a classic or Dynamic caption is being dragged, its emoji stays at the old place until the drop.
- The Captions panel's own preview card draws no emojis (ticket 09 may add them).
