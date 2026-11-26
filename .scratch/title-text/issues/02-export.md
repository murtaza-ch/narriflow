# 02 - Export text layers through libass

**What to build:** The worker burns Text Layers from the shared layout as ASS, and the `drawtext` path is gone. A contact sheet shows the real export of sample layers.

**Blocked by:** [01 - Text Layer model and shared layout](01-model-and-layout.md)

**Status:** done

Read `../spec.md` sections 4 and 5. Critical path: `apps/media/src/tasks/clip-render-attempt.ts` and `apps/media/src/composition-ffmpeg-adapter.ts`; review every change there closely.

## Scope

- A text-layer ASS module in `apps/media/src` that builds the scene for a target's text layers with `layoutTextLayer` and the HarfBuzz `SceneMeasurer`, and writes one script with `sceneEvents` and `assScript`.
- A constant-pose fast path in `pieceEvents` (`caption-scene-ass.ts`): one evaluation and one event per paint layer for a piece whose pose never changes, times on the frame boundaries the filter sees. Existing Scene Style output must not change (their tests stay green untouched).
- Render attempt: write the script beside the caption script per target; pass `textAssPath` and its fonts directory through normal video, B-roll and audiogram; one `ass=` stage at the first `kind: "text"` layer in `compileCompositionPlanVisualLayers`; its own missing-asset error. Glyph recovery regenerates every script that exists, works for a title-only export, and reports title omissions by layer id.
- Literal text: braces escaped for ASS; settle the backslash question with a real libass render as section 4 says, and record the result in this ticket.
- Delete `textLayerFilter`, its tests, `composition-text-weight.test.ts`; rewrite the `text-layers-transition` golden document to the new shape. Find out whether `apps/media/scripts/render-golden.test.ts` runs FFmpeg before running it; do not run heavy suites.
- `apps/media/scripts/text-layer-sheet.ts`: renders PNG frames of a fixed sample set through the real path (FFmpeg + libass, 1080x1920 and 1920x1080): the six presets, both box modes, both corner modes, three alignments, faux bold, shear italic, a real italic face, underline, stroke plus shadow, a three-line title, an overlong word, uppercase, braces, a mixed Urdu and English line, a typed emoji, two overlapping layers. Export the sample set from one module so the Studio prototype page (ticket 03) draws the same samples. Write the PNGs to `.scratch/title-text/sheet/`.

## Acceptance

- [x] The sheet renders locally (`ffmpeg` 7.1.5 with libass is installed) and every sample is legible, boxed and placed as the layout says; attach the PNG paths here.
- [x] A static piece that lives 5 minutes produces one event per paint layer (test).
- [x] Mixed-face shear italic is tested against a real render; any drift is recorded here.
- [x] A text-only render plan (no captions) and a captions-only plan both compile (tests).
- [x] `bun run lint`, `bun run typecheck`, `bun run test` pass.

## Evidence (2026-11-27)

Built: `apps/media/src/text-layer-ass.ts` (`renderTextLayerTrack`, `compileCompositionPlanTextLayers`: one ASS script per target from `layoutTextLayer` + the HarfBuzz `SceneMeasurer`, one measurer per layer so omissions are reported by layer id); the constant-pose fast path in `caption-scene-ass.ts`; one `ass=` stage at the first `kind: "text"` layer in `compileCompositionPlanVisualLayers` (`textAssPath`, optional `textFontsDirectory` defaulting to the vendored caption faces, error `clip_composition_text_asset_missing`), wired through normal video, B-roll and audiogram; the render attempt writes `clip-<id>-<ratio>-text.ass` beside the caption script, and glyph recovery rewrites both scripts (works with no caption script). `textLayerFilter`, its tests and `composition-text-weight.test.ts` are gone; the `text-layers-transition` golden document is in the new shape.

### Contact sheet

`bun apps/media/scripts/text-layer-sheet.ts` (local ffmpeg 7.1.5, libass 0.17.5). 26 samples from `TEXT_LAYER_SAMPLES`, each on its own frame, half size:

- `/Users/murtaza/.t3/worktrees/narriflow/t3-b7351b95-bc429040a1371737/.scratch/title-text/sheet/vertical-flat.png`
- `/Users/murtaza/.t3/worktrees/narriflow/t3-b7351b95-bc429040a1371737/.scratch/title-text/sheet/vertical-photo.png`
- `/Users/murtaza/.t3/worktrees/narriflow/t3-b7351b95-bc429040a1371737/.scratch/title-text/sheet/horizontal-flat.png`
- `/Users/murtaza/.t3/worktrees/narriflow/t3-b7351b95-bc429040a1371737/.scratch/title-text/sheet/horizontal-photo.png`

Every sample is legible, boxed and placed as the layout says. Notes from looking at them:
- Three lines on 60% black line boxes (review item 1): no darker stripes where the boxes overlap (one shape, nonzero fill).
- 60% black block with a shadow (review item 2): the shadow shows through the box as a soft dark halo under the glyphs, inside the box; nothing at the box edges. Unsurprising; no change.
- Typed emoji: a wide gap after 🎉. The space after an emoji is planned in the monochrome emoji face (the existing caption fallback path), whose space is wide; measurement and drawing agree, so the box fits.
- The serif italic preset (black, no box) is hard to read on dark footage by design of the preset.
- The first sheet run found a real bug: the shared measurement path (`wordParts`) strips braces and backslashes the way captions draw them, so a text layer with braces drew ~45 px wider than its box. Fixed: `SceneMeasurer` takes `literalText`, which both measures and writes braces and backslashes as typed; test "braces and backslashes are measured as libass draws them".

### Backslash decision

Kept. The writer emits each `\` as `\` + U+2060 WORD JOINER, and braces as `\{` `\}` (`escapeLiteralAssText`). Settled by a real render (libass 0.17.5, local) of: `a\nb a\Nb a\hb` (escapes act), the same with U+2060 after each backslash (drawn literally), `a\{b\}c` (literal braces), and a backslash right before a fallback-face override, `x\{\fnNoto Nastaliq Urdu}ب...`: without the joiner libass printed the override block as text; with it, `x\ب y` drew correctly. No face reported a missing glyph for U+2060 (libass skips default-ignorables in fallback lookup; checked across 8 faces). The image pins libass 0.17.3; the 0.17.4 and 0.17.5 changelog entries do not touch escape parsing, but the pinned version itself was not run (no Docker here). Tests: `text-layer-ass.test.ts` (escaped script text; one line of ink for `back\Nslash`; `x\ب y` next to a fallback face) and `composition-ffmpeg-adapter.test.ts` (real FFmpeg burn with quotes, percents, braces, backslashes, `\N`).

### Fast path

`text-layer-ass.test.ts`: a static text piece with a shadow living 1 s to 301 s gives exactly 2 events (shadow, fill), `[1, 301]`. The fast path's events equal the sampled path's for still pieces of two layers at 24, 30, 29.97 and 60 fps. All existing Scene Style suites pass unedited (`bun test src/caption` in apps/media: 319 pass, 24 snapshots).

### Mixed-face shear italic drift

Measured against real libass (`text-layer-ass.test.ts`, 72 units, bold Inter, 1080 x 1920), ink centroid of the leaning line minus the upright one:
- Latin only ("Hello italic world"): 0.38 px at the baseline; 7.8 px at 38 px above it (model 8.1 px). Leans about the baseline as the model says.
- Mixed Urdu and English ("Hello یہ جواب world", Noto Nastaliq Urdu fallback): 3.4 px at the baseline; 12.7 px at 38 px above (model 8.1 px). libass shears the fallback runs about a different point than the single `\pos` compensation assumes, so a mixed-face shear-italic line sits ~3-4 px right of the Studio at this size. Not fixed (it would need per-face events); the test guards it from growing (< 5 px at the baseline). Real italic faces and single-face lines are unaffected.

### Plans

`composition-ffmpeg-adapter.test.ts`: "a text-only plan and a captions-only plan both compile"; "every Text Layer burns in one ass stage, under the captions"; missing text script raises `clip_composition_text_asset_missing`.

### Not run

`apps/media/scripts/render-golden.test.ts` runs real renders in `beforeAll` (`runSuite`), so it was left unrun as instructed; its `text-layers-transition` document is updated, and its captured baseline (argv, frames) will differ for that case on the next capture since the text now burns through libass.

## Verification (final tree)

Commits: dbdbe572b (ticket 01 review fixes), c1f458492 (this ticket). Both tickets verified on this tree:

- `bun run lint`: pass (exit 0; the 20 warnings are pre-existing, in landing/hero CSS and a prototype HTML).
- `bun run typecheck`: 17/17 tasks pass.
- `bun run test` equivalent, run in two parts because the media package's script includes `render-golden.test.ts`, which renders real fixtures:
  - root script tests (`bun test scripts/env-check.test.ts scripts/check-web-backend-imports.test.ts scripts/dev-settings.test.ts scripts/audio-library`): 65 pass, 0 fail.
  - `bunx turbo run test --filter='!@narriflow/media'`: 15/15 tasks; validators 1389 pass, caption-scene 3248 pass / 1 skip, composition-plan 437, services 1699 pass / 1567 skip (PostgreSQL suites skip), api 994 pass / 60 skip, api-client 242, web 1473, caption-fonts 221, caption-emoji 114, mcp-core 170, auth 96, mcp-server 13, ui 11, db 7, email 5; 0 fail.
  - apps/media `bun test src/ scripts/check-render-environment.test.ts`: 1217 pass, 1 skip, 0 fail (Bun 1.4.4 matches the image).
- `bun run --cwd apps/api test:inventory`: 302 routes, 0 problems. `openapi:check`: matches all 32 REST operations. `build:worker`: import audit passed. `bun run check:web-split`: passed.
- Not run: `apps/media/scripts/render-golden.test.ts` (heavy), PostgreSQL suites, `next build`, Docker or workerd gates.
