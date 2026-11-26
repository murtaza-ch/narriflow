# 08 - Uploaded brand fonts in Text Layers

**What to build:** A Text Layer can use an uploaded brand font, drawn from the same file in the Studio and the export.

**Blocked by:** [02 - Export](02-export.md), [04 - Text panel](04-text-panel-timeline.md)

**Status:** done (2026-11-27)

Read `../spec.md` sections 2 and 4, and Sol's review notes below. This ticket is separable: if it cannot reach parity, it does not ship and layers keep drawing in their `font` family.

## Scope

- Scene face type: `TextPiece.face` and `Measure` accept an upload reference (id + fingerprint) with a catalog fallback, next to a catalog name. `memoMeasure` and baseline cache keys include it. Catalog behaviour and caching for the existing Scene Styles do not change.
- Worker: `SceneMeasurer` resolves the upload through `brandCaptionFace` / `CaptionGlyphPlanner` (already used by classic captions); the text script's fonts directory holds the target's resolved uploads and the catalog faces; ASS `\fn` selects the upload. Two uploads, or an upload and a catalog face, that share an internal font name: the first in layer order wins in both measurement and painting, and the worker logs it.
- Studio: `canvasMeasure` and the painter resolve the upload (`wordFace` already paints a brand face for classic captions); rebuild when the browser font loads; the same fallback order as the worker.
- `documentFontReferences` and the Studio bootstrap collect `style.fontAsset`. Brand template title style: `brandFontService.assertSelection` on create and update, and the font-delete guard also checks the template `title` column.
- `TextStyleControls` offers the brand's fonts in the font menu.

## Acceptance

- [x] A sheet sample with an uploaded font matches the Studio prototype page.
- [x] Existing Scene Style tests pass untouched.
- [x] `bun run lint`, `bun run typecheck`, `bun run test` pass.

## Evidence (2026-11-27)

Branch `feat/title-text-fonts` (from `feat/title-text` 806635411). Uploaded fonts reach parity, so the ticket ships.

### Model

- `TextPiece.face` stays a catalog `CaptionFontName`; a piece gains an optional `upload` (`UploadedFace`: id + fingerprint). `face` is then the upload's fallback: for glyphs it lacks, and the whole face when a renderer cannot resolve the upload. `Measure` takes `upload` as an optional fifth argument, so every Scene Style program and every test measure (4 arguments) is unchanged; `pieceLocalBox` and `memoMeasure` pass or key it only when present, so a catalog face's calls and memo keys are byte-identical to before.
- `packages/caption-scene/src/text-layer/fonts.ts`: `textLayerFaces(layers, resolve)` is the one decision both renderers make: a layer draws its `style.fontAsset` when the renderer resolved it (worker: downloaded and fingerprint-verified; Studio: the brand font's file has loaded), else its `font` family. An upload is a one-face family: bold is the fill-coloured outline, italic a shear unless the file is italic, cap height from the file's metrics; its fallback is the face the `font` family would draw. `layoutTextLayer` takes the chosen face; `buildTextLayerScene` takes the resolver.

### Collision rule (shared by measurement and painting, both renderers)

libass selects by internal full name (`\fn`), and a fonts directory can hold one file per name. Names compare case-insensitively (NFKC):
- An upload whose name equals a vendored caption face's is drawn **as that vendored face** (layout, measurement and `\fn`), wherever it sits in layer order.
- Two uploads with one name: **the first in layer order wins**; a later layer draws the winner's file (and is laid out with its metrics).
- The worker logs each collision as `text_layer_font_name_collision` (layer id, requested font id, name, what it was drawn as); `TextLayerTrack.collisions` carries them.

### Worker

- `SceneMeasurer` takes the resolved uploads (5th argument). A piece's upload plans with `CaptionGlyphPlanner(brandCaptionFace(upload), catalogCaptionFace(fallback, "saved"))`, the chain classic captions use; an unresolved upload plans its catalog face. The writer's `\fn` and `\fs` come from the planned face, so the upload's name and line metrics are written.
- `renderTextLayerTrack` / `compileCompositionPlanTextLayers` take the render's `customFonts`; the track returns `uploads` (collision winners). `prepareTextFontsDirectory` (brand-font-resolution.ts) links every vendored caption and fallback face plus exactly those uploads (no uploads: the vendored directory itself). The render attempt writes it per output as `textFontsDirectory`, threaded through the adapter's video, B-roll and audiogram paths (the `textFontsDirectory` input already existed but nothing passed it). Glyph recovery reuses it.
- `documentFontReferences` and the Studio bootstrap already collected `style.fontAsset` (ticket 01); unchanged.

### Studio

- `canvasMeasure(language, wanted, uploadFace)` and the painter (`MeasuredScene.uploadFace`, faces keyed by face + upload) resolve a piece's upload with `uploadWordFace`: the brand font family, then the layer's catalog face, then the script fallbacks (the worker's requested → saved → script order); its own metrics set the line box and the baseline probe key (the family name is per id and fingerprint).
- `useTextLayerScene` reads `useLoadedBrandFonts()` (new, brand-fonts.tsx); the loaded uploads a layer uses are part of `textLayerSceneKey`, so a layer rebuilds in its upload when the file arrives. Layers without an upload keep their old key.
- `TextFontMenu` (text-style-controls.tsx, shared by Settings and the floating toolbar) lists the brand's uploaded fonts under "Brand fonts" above the families when the plan allows custom fonts; choosing one sets `fontAsset` and keeps `font` as the fallback family, choosing a family clears it. The trigger names the upload ("Saved font" when it is no longer in the library; it then draws in its family). The brand kit title form (ticket 06) gets the same menu by reusing the controls inside the style screen's `BrandFontsProvider`.
- Found while comparing sheets: `facesLoaded` counted an emoji as drawn by the requested face (`captionFaceDraws` accepts Common script), so a build whose own face had already loaded never waited for Noto Emoji. A catalog layer's first build waits for its face and loads the whole stack, so it got lucky; an upload resolves later and measured the emoji in a system face while Noto Emoji was still loading (sample 28 drew ~7 px right of the export, on some runs only). `facesLoaded` now also waits for the fallback stack when the text has an emoji. It changes only when a build waits, never a measurement made after the faces loaded.

### Services

- `brandTemplateService.create` checks `title.style.fontAsset` with `brandFontService.assertSelection`; `update` checks it when it changes (as the caption font is checked). The font-delete guard matches `captionPreset.fontAsset.id` OR `title.style.fontAsset.id` on live templates of the workspace. Tests: `packages/services/src/brand-title-font.test.ts` (4: create checks, unusable font fails create, update checks only a changed font, delete guard where clause).

### Typed emoji gap (export)

Cause: `CaptionGlyphPlanner.plan` keeps neutral text (space, digits, `#`, `*`) in the current face when that face covers it, and the monochrome Noto Emoji and Noto Sans Symbols 2 faces cover all of them. So in "Big news 🎉 today 🔥" the space after 🎉 was planned, measured and written (`\fnNoto Emoji Regular`) in the emoji face, whose space is about an em wide. Measurement and drawing agreed, so the box grew with it. The Studio draws that space in the layer's face (the first face in the CSS stack that covers it).

Fix: a planner option (`neutralsLeavePictureFaces`, on for Text Layer measurement, i.e. `SceneMeasurer` with `literalText`) sends neutral text after an emoji or symbol back to the face of the text before it. Sample 25 at 1080 × 1920 (48 units, Inter ExtraBold): line advance 540.35 px before, 489.19 px after (−51.16 px, about 1.07 em; an Inter space is 9.77 px). Sheet: sample 25's box now matches the Studio exactly (0 px difference at half size, both orientations).

Same bug elsewhere, not changed (reported to the orchestrator): classic captions and Scene Styles keep the old planning. A classic caption word that glues digits, `#` or `*` to an emoji ("🔥100", "🎉2026") draws them in Noto Emoji; a Scene Style piece holding several words with an emoji draws the space after it an em wide. Enabling the option for all caption measurement left the 179 classic/Scene Style worker tests green (they do not cover it), so it is a one-line switch once approved, with an export change for those inputs.

### Contact sheet and Studio sheet

Two samples use `TEXT_LAYER_SAMPLE_UPLOAD` (Geist SemiBold, SIL OFL, the committed `apps/web/assets/fonts/geist/Geist-SemiBold.ttf`; its face and SHA-256 are held to the file by `text-layer-fonts.test.ts`): 27 "Uploaded font" (upright, white box) and 28 "Uploaded font, bold italic, emoji" (faux bold, shear, stroke, 🎉 and digits). The export sheet loads it through the upload path (parse, resolve by id and fingerprint, `prepareTextFontsDirectory`); the Studio prototype page offers it as a brand font (`BrandFontsProvider`, file URL via `new URL(..., import.meta.url)`).

`bun apps/media/scripts/text-layer-sheet.ts` → `.scratch/title-text/sheet/{vertical,horizontal}-{flat,photo}.png`; Studio (`/prototype/text-layers?sheet=…`, headless Chrome) → `.scratch/title-text/studio/` same names. Ink extents per tile, flat backgrounds, half size: all 28 tiles within 2 px in both orientations; 25, 27 and 28 differ by 0 px horizontally (28: 1 px vertically). The three 2 px tiles are pre-existing (presets 5 and 6, Urdu 24). Line breaks identical on every sample.

### Tests

- `packages/caption-scene/src/text-layer/fonts.test.ts` (7): family fallback, one-face upload rules, both collision rules, upload on pieces and calls, cap height, memo keys.
- `apps/media/src/text-layer-fonts.test.ts` (11): fixture, upload measured and written, unresolved upload = family (script identical to a layer without an upload), faux bold + shear, fonts directory contents, both collisions, emoji space and digits in the line's face, classic planner unchanged, real libass: the upload's ink fills its measured advance and differs from the family's; an emoji line's box fits its ink.
- `apps/web/.../text-layer-fonts.test.tsx` (2): build key and uploads; font menu trigger.

### Not verified

- A real render on Modal with a real brand-kit upload (the dev API does not have this branch); the pinned libass 0.17.3 image was not run (local 0.17.5).
- The font menu's open state with brand fonts was not screenshot; its trigger is unit tested.
- A collision between an upload and a pinned fallback face name (Noto script or emoji faces) is not handled by the rule (the Studio has no list of those names): such an upload would share a name with a fallback face in the export's directory.

### Verification (final tree)

- `bun run lint`: exit 0 (20 warnings, all pre-existing in landing/hero CSS and a prototype HTML).
- `bun run typecheck`: 17/17 tasks.
- `bun run test`, run in parts so `apps/media/scripts/render-golden.test.ts` (real renders) stays unrun: root script tests 65 pass; `bunx turbo run test --filter='!@narriflow/media'` and `--filter=@narriflow/web`: validators 1392, caption-scene 3258 pass / 1 skip, composition-plan 437, services 1720 pass / 1567 skip (PostgreSQL), api 994 / 60 skip, api-client 242, web 1495, caption-fonts 221, caption-emoji 114, mcp-core 170, auth 96, mcp-server 13, ui 11, db 7, email 5; 0 fail. apps/media `bun test --timeout 60000 src/ scripts/check-render-environment.test.ts scripts/render-golden-text.test.ts`: 1233 pass, 1 skip, 0 fail. The machine was under heavy load from other sessions (load average 15-25); at the default 5 s timeout, `scene-bounds-over.test.ts` timed out once (it passes alone in 3-5 s, and took 6-8 s on the base files under the same load) and several media suites timed out, so the media run used a 60 s timeout.
- `bun run check:web-split`: passed. `bun run --cwd apps/api test:inventory`: 302 routes, 0 problems. `openapi:check`: 32 operations match. `build:worker`: import audit passed.
- Not run: PostgreSQL suites, `next build`, Docker, workerd, the golden render suite.
