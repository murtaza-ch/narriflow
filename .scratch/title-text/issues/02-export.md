# 02 - Export text layers through libass

**What to build:** The worker burns Text Layers from the shared layout as ASS, and the `drawtext` path is gone. A contact sheet shows the real export of sample layers.

**Blocked by:** [01 - Text Layer model and shared layout](01-model-and-layout.md)

**Status:** ready-for-agent

Read `../spec.md` sections 4 and 5. Critical path: `apps/media/src/tasks/clip-render-attempt.ts` and `apps/media/src/composition-ffmpeg-adapter.ts`; review every change there closely.

## Scope

- A text-layer ASS module in `apps/media/src` that builds the scene for a target's text layers with `layoutTextLayer` and the HarfBuzz `SceneMeasurer`, and writes one script with `sceneEvents` and `assScript`.
- A constant-pose fast path in `pieceEvents` (`caption-scene-ass.ts`): one evaluation and one event per paint layer for a piece whose pose never changes, times on the frame boundaries the filter sees. Existing Scene Style output must not change (their tests stay green untouched).
- Render attempt: write the script beside the caption script per target; pass `textAssPath` and its fonts directory through normal video, B-roll and audiogram; one `ass=` stage at the first `kind: "text"` layer in `compileCompositionPlanVisualLayers`; its own missing-asset error. Glyph recovery regenerates every script that exists, works for a title-only export, and reports title omissions by layer id.
- Literal text: braces escaped for ASS; settle the backslash question with a real libass render as section 4 says, and record the result in this ticket.
- Delete `textLayerFilter`, its tests, `composition-text-weight.test.ts`; rewrite the `text-layers-transition` golden document to the new shape. Find out whether `apps/media/scripts/render-golden.test.ts` runs FFmpeg before running it; do not run heavy suites.
- `apps/media/scripts/text-layer-sheet.ts`: renders PNG frames of a fixed sample set through the real path (FFmpeg + libass, 1080x1920 and 1920x1080): the six presets, both box modes, both corner modes, three alignments, faux bold, shear italic, a real italic face, underline, stroke plus shadow, a three-line title, an overlong word, uppercase, braces, a mixed Urdu and English line, a typed emoji, two overlapping layers. Export the sample set from one module so the Studio prototype page (ticket 03) draws the same samples. Write the PNGs to `.scratch/title-text/sheet/`.

## Acceptance

- [ ] The sheet renders locally (`ffmpeg` 7.1.5 with libass is installed) and every sample is legible, boxed and placed as the layout says; attach the PNG paths here.
- [ ] A static piece that lives 5 minutes produces one event per paint layer (test).
- [ ] Mixed-face shear italic is tested against a real render; any drift is recorded here.
- [ ] A text-only render plan (no captions) and a captions-only plan both compile (tests).
- [ ] `bun run lint`, `bun run typecheck`, `bun run test` pass.
