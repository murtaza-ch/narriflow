# Title text (Vizard-style text layers)

**Status:** in progress (2026-11-27). Sections 2 and 3 are settled; reviewed by Sol (feasibility), Astra (product) and Opus (data) before implementation.

## 1. What we are building

Every newly generated clip opens with its AI title drawn on the video: bold black text on white rounded boxes, one box hugging each line, centred near the top, for the first 5 seconds. The user restyles it in the Studio with the controls Vizard offers, drags and resizes it on the canvas, stretches it on the timeline, and applies it to every clip of the project. The brand kit stores the default style and an on/off switch. The exported video shows what the Studio shows.

The Studio already has Text Layers (`studioEdits.textLayers`). They are drawn two different ways (DOM in the Studio, FFmpeg `drawtext` in export) that disagree on size, wrapping, weight, box and shadow. This work replaces both with one shared layout drawn by the Caption Scene renderers (ADR 0021), and removes the `drawtext` path.

Reference: Vizard's editor (owner screenshots, 2026-11-27, paths in `issues/03-studio-canvas.md`). Text panel with a Presets tab ("Add a headline", "Add body text", six recommended styles) and a Settings tab (text, font, size, alignment, B/I/U, case, line spacing, colour, Shadow, Stroke, Background, Corners, Box display); a floating toolbar under the selected text (font, size, alignment, case, colour, more); a selection frame with four corner grips and two side grips; a title chip on its own timeline lane above the subtitle lane; the title visible on the project page clip cards.

## 2. Settled decisions

Owner (2026-11-27):
- The auto title shows for the first **5 seconds** by default and is stretched on the timeline like any text chip.
- **New clips only** get an auto title. Existing clips are not backfilled.
- The default style and the on/off switch live in the **brand kit** (brand template). The Studio has the full Vizard-style editing.
- Ship with a full deploy (API Worker, Modal image, web).

Orchestrator:
- **One renderer.** A Text Layer is a static Caption Scene: one pure builder in `packages/caption-scene` turns a layer into pieces; the Studio paints them with `CaptionSceneLayers`, the worker writes them as ASS with `sceneEvents`. No layout number lives in a renderer. `textLayerFilter` (`drawtext`) is deleted.
- **Name.** The UI says "Title" and "Body text". "Headline" is already a Dynamic caption style name and is not used for this feature. The model keeps the name Text Layer with `role: "title" | "body"`. The on-video title is its own text: editing it does not rename the clip, and renaming the clip does not change it.
- **One title per clip in the UI.** When the clip has a `role: "title"` layer, "Add a title" selects it instead of adding another, a preset card restyles it, and Duplicate on a title makes a body layer. The schema does not enforce it; where code needs "the title" it takes the first `role: "title"` layer.
- **Old data.** Pre-production policy: the Text Layer schema is replaced, no dual read. Old stored layers must still parse (a clip that fails to parse is unreadable): both new schemas are plain `z.object` (strip unknown keys, never strict), every new field has a default, `endSec` stays optional, and no old key is reused with a narrower type. Old layers load in the default body style.
- **Fonts.** Titles use the vendored caption faces (same files in Studio and export), grouped into families. No new font files. Uploaded brand fonts (ticket 08, done): a layer draws its `fontAsset` when the renderer has resolved it, as a one-face family (bold by outline, italic by shear unless the file is italic) with its `font` family's face as the glyph fallback; whenever an upload cannot be resolved, it draws in its `font` family. Internal-name collisions: an upload named like a vendored face draws as that face; between uploads the first in layer order wins (`textLayerFaces`, both renderers).
- **Bold, italic, underline always work.** Bold uses the family's heavier face when it has one, else a fill-coloured outside stroke. Italic uses the family's real italic face at that weight when it has one, else a shear. Underline is a drawn rectangle.
- **Wrap.** Explicit newlines are hard breaks; inside a paragraph, words wrap greedily at the layer's width; a word wider than the width breaks at grapheme boundaries. Both renderers measure whole candidate lines (Studio by canvas, worker by HarfBuzz), as caption scenes do today. Parity target: identical line breaks on the contact-sheet samples.
- **Units.** Font size, stroke width, shadow blur and offsets are in units of `min(canvasWidth, canvasHeight) / 1080` (the `sceneSpace` convention). Position and width are percentages of the canvas. The builder works in full target-canvas pixels for every target; the Studio scales once by `displayWidth / canvasWidth`.
- **Timing.** Layer times are edited-timeline seconds, start inclusive, end exclusive, as today. A `role: "title"` layer is pinned to the clip: trims, extends and cuts keep its edited-time start and end (clamped to the new duration). A body layer keeps following its footage (`rebaseTextLayers`, unchanged). Text layers keep today's behaviour through inserted Scene Blocks.
- **Apply to all clips** sets this title's style, position, width and timing on every other clip's title layer, keeping each clip's own text, and creates a title (from that clip's `title`, else `hookText`) on a clip that has none. Clips at the layer limit or with no usable text are skipped and counted. Timing is clamped to each clip's edited duration.
- **Who gets an auto title.** Clips from AI clipping (including regenerate). Not: caption-only generation ("Captioned video"), clips made from a selection, clips made from a library range. Duplicating a clip copies its layers.
- A project with no brand snapshot gets the built-in title default. Changing a project's campaign style does not restyle existing titles.
- No plan gating for titles. Brand template title settings follow the existing template entitlement.
- The clip-selection prompt is not changed.

## 3. Model

New file `packages/validators/src/text-layer.ts` (re-exported from the package index; `studio-edits.ts` imports it).

```ts
textLayerStyleSchema = z.object({
  font: TextLayerFontFamily            // key of TEXT_LAYER_FONTS, default "Inter"
  fontAsset: BrandFontReference | null // uploaded brand font; wins over `font` when resolvable. default null
  fontSize: 8..240, default 48         // units
  bold: boolean, default true
  italic: boolean, default false
  underline: boolean, default false
  textCase: "none" | "uppercase", default "none"
  align: "left" | "center" | "right", default "center"
  lineHeight: 0.8..2.5, default 1.2    // line pitch as a multiple of fontSize; the UI shows it as a percentage
  color: hex, default "#FFFFFF"
  stroke: { color: hex, width: 0.5..16 } | null, default { "#000000", 3 }
  shadow: { color: hex, opacity: 0..1, blur: 0..40, offsetX: -60..60, offsetY: -60..60 } | null, default null
  background: { color: hex, opacity: 0..1, corners: "rounded" | "square", display: "line" | "block" } | null, default null
})

studioTextLayerSchema = z.object({
  id, role: "title" | "body" (default "body"),
  text: trimmed, 1..280 chars, newlines allowed, not blank,
  startSec (default 0), endSec: number | null, optional (absent = null),   // refinement endSec > startSec kept
  positionX: 0..100 (default 50), positionY: 0..100 (default 12),          // centre of the layer's frame
  widthPct: 10..100 (default 86),                                          // wrap width, % of canvas width
  style: textLayerStyleSchema (prefault {})
})
```

- Schema defaults are the body look (white, bold, black stroke). Named constants: `DEFAULT_TITLE_STYLE` (Inter, bold, 48, `#000000`, no stroke, no shadow, background `#FFFFFF` opacity 1, rounded, `line`); the values an effect gets when it is switched on: `DEFAULT_TEXT_STROKE` (`#000000`, 4), `DEFAULT_TEXT_SHADOW` (`#000000`, 0.6, blur 8, offset 0 / 4), `DEFAULT_TEXT_BACKGROUND` (`#FFFFFF`, 1, rounded, line).
- `TEXT_LAYER_STYLE_PRESETS`: six named styles matching Vizard's recommended cards with our faces: white on black line boxes; black on white line boxes (the default title); yellow bold italic with a thick black stroke; teal on a cream square block; black bold italic serif with no box; blue bold serif with a white stroke.
- `TEXT_LAYER_FONTS`: families built from `CAPTION_FONT_FACES` (template-only faces may be used here), each with `regular`, and optional `bold`, `italic`, `boldItalic` face names. `resolveTextLayerFace(style) → { face, fauxBold, shearDeg }` is the one place the toggles are resolved. A real italic face is used only when the family has one at the resolved weight.
- Zod is v4: `.default(value)` returns the value unparsed, so nested object defaults use `.prefault({})`; a test proves `{ id, text }` and a real old stored layer (from `apps/media/src/__fixtures__/render-golden/documents.json`) parse to the full default style.
- `studioTextLayersEqual` compares `style` with a generic deep-equal, not a field list.
- `applyStudioEditsPatchSchema` gains a fourth branch `title: { style, positionX, positionY, widthPct, startSec, endSec }`; the grouped form allows 4 patches.

Brand template gains `title` (new nullable JSON column on `BrandTemplate`, one migration):

```ts
brandTitleSchema = z.object({ enabled: boolean (default true), durationSec: 1..600 | null (default 5; null = whole clip),
  positionX (50), positionY (12), widthPct (86), style: textLayerStyleSchema (default: parsed DEFAULT_TITLE_STYLE) })
```
`null` on a template means the built-in default (enabled, 5 s, default title style). The template input, update, summary and snapshot schemas all carry it (snapshot with a default, so stored project snapshots parse). The selection capsule's strict `editor` object gets `title: brandTitleSchema.nullable().default(null)`.

## 4. Shared layout (`packages/caption-scene/src/text-layer/`)

`layoutTextLayer(layer, canvas, measure, window, zBase) → { pieces, frame, lines }`:
- Applies case, splits on newlines, wraps greedily at `widthPct` of the canvas width measuring whole candidate lines; an oversized word breaks at grapheme boundaries (`@narriflow/caption-fonts` graphemes). A blank line keeps its line pitch and draws no box.
- One `TextPiece` per line (baseline anchored; right alignment by measured advance). Faux bold: an upper piece with a fill-coloured stroke of `fauxWidth`; with a user stroke, an under piece with the user-coloured stroke of `fauxWidth + userWidth`. Shadows go once, on the widest silhouette.
- Italic by shear: a constant `skx` with the pivot on the baseline, so the line does not move.
- Background `line`: one rounded-rectangle `ShapePiece` per non-blank line, hugging that line. Background `block`: one rectangle around all lines. Radius 0 for `square`. Plates sit behind every line's text. Plate height, padding, radius, underline offset and thickness are em-based constants in this module and nowhere else. With the default line height adjacent line boxes overlap slightly so they read as one stacked label, as in Vizard. Underline width is the line's measured advance.
- Each Text Layer gets its own `z` band (`zBase`), in document order, so a later layer's plate covers an earlier layer's text.
- `frame` is the wrap box (width from `widthPct`, height of the text block including plates), centred on `positionX, positionY`. The Studio's selection frame and hit area use it.
- Pieces are static: one key per track, alive for the layer's active range.
- Literal text: `{` and `}` are kept and escaped in ASS (`\{`, `\}`; the pinned libass 0.17.3 supports them). A backslash is kept only if a real render proves a safe encoding (for example a U+2060 after it), including at a fallback-face boundary; otherwise the builder removes backslashes before measuring, for both renderers.
- Right-to-left text, fallback faces and typed emoji (monochrome fallback) follow the existing caption measurement path; paragraph direction comes from the text itself.

## 5. Export

- All text layers of a target are written to one ASS script (`assScript` with a fixed base style; no caption preset needed) by `sceneEvents`, next to the caption script in the render attempt's output loop, and burned by one `ass=` stage at the first `kind: "text"` layer's place in the visual order (under captions). It exists whether or not the clip has captions, and is passed through the normal video, B-roll and audiogram paths. Its own render inputs (`textAssPath`, fonts directory) and its own missing-asset error; `clip_composition_caption_asset_missing` stays about captions.
- The ASS writer gets a constant-pose fast path: a piece whose pose never changes is evaluated once and emits one event per paint layer, with its start and end on the frame boundaries the filter sees. A title that lasts the whole clip costs the same as a 5 second one.
- Glyph recovery (`captionRecoveryFor`) regenerates every script that exists, works for a title-only export, and reports title omissions by layer id. A script whose glyphs were all omitted is still a valid script.
- Subtitle files (SRT/VTT) never contain text layers. The preview proxy task draws none (unchanged).
- The plan keeps `kind: "text"` layers and their clamped active range; it does no layout.
- `textLayerFilter`, its tests and `composition-text-weight.test.ts` are removed; the render golden document that has text layers is rewritten to the new shape.
- `apps/media/scripts/text-layer-sheet.ts` renders a contact sheet of sample layers through the real export path (FFmpeg + libass on a flat colour and on a photo-like gradient) to PNG.

## 6. Studio

- **First open.** A new clip opens paused on its first frame with the title visible and not selected. Clicking the title, its chip or its list row selects it and opens Text → Settings; a chip or row whose layer is not on screen seeks to its start.
- **Canvas.** The layer is painted by the scene painter. The selection frame is the layout `frame`: four corner grips scale font size and width together; two side grips change the wrap width (the opposite edge stays put). Drag moves it with the existing snap guides; the frame's centre stays inside the canvas and the grips stay reachable. Double-click focuses the text box in Settings. Where layers overlap a click selects the topmost; the chip and list row select the one underneath.
- **Floating toolbar** under the selected layer (above it when there is no room, always on screen): font, size, alignment, case, colour, and a more menu (Duplicate, Delete, and Apply to all clips for a title). It shows the same values as Settings.
- **Text panel.** Presets tab: "Add a title" (prefilled with the clip's title, in the project's brand title style; selects the existing title when there is one), "Add body text", six recommended style cards drawn by the real painter, and a compact list of the clip's layers. Settings tab (for the selected layer): text box; font menu with each family in its own face; size with a menu and direct entry; alignment; B / I / U as independent toggles; case (Aa / AB, the typed text is never rewritten); line spacing as a percentage; text colour; Shadow, Stroke and Background rows where `+` switches the effect on with its default and shows its controls and `−` removes it; Corners and Box display, shown only while Background is on; start and end time fields; "Apply to all clips" for a title. The style controls are one presentational component (value + onChange) reused by the brand kit.
- **Text field.** An empty or whitespace-only draft is never committed; on blur it returns to the last saved text. Delete and Backspace inside the field edit characters, they do not delete the layer.
- **Apply to all clips.** A confirmation says each clip keeps its own words, that style, placement, width and timing change, that clips without a title get one, and that Studio undo only covers the open clip. Afterwards it reports updated, created and skipped counts.
- **Delete.** Deleting a layer returns to Text → Presets. Undo restores it exactly.
- **Timeline.** The text lane sits above the subtitle lane. Chips move and trim as today; on a clip shorter than the minimum chip length the available footage wins. A new layer starts at the playhead and lasts 5 s (clamped to the clip).
- UI rules of this product: no borders, soft fills, grey field focus, shadowless dropdowns, blue `accent` for selected state, `studio.*` tokens, existing `panel-ui` pieces, accessible names on every control (the text and background swatches named apart). No greyed-out dead ends.

## 7. Auto title and brand kit

- The seed (`prepareDetectedClipSeed`) carries the project's brand title settings, read from `project.brandSnapshot` with `brandTemplateSnapshotSchema.safeParse` (a null or unreadable snapshot means the built-in default). `clipStudioEdits` adds the layer with the fixed id `"title"` (the seed is hashed and compared, so nothing random goes in it) from `clip.title` (else `hookText`), cut at a word boundary, grapheme-safe, to 120 characters, starting at 0 for `durationSec` clamped to the clip's edited duration (`null` = until the clip ends). Skipped when the brand title is off, for caption-only generation, or when there is no text.
- Brand template persistence carries `title` through every mapping: `toSummary`, `buildSnapshot`, `create`, `update`, `duplicate` in `brand-template.service.ts`; the brand profile service uses `brandTemplateService.buildSnapshot` instead of its own second builder.
- Brand kit template form: a Title section with the on/off switch, display duration, and the shared style controls with a live sample. Switching the title off keeps its style. The existing note that changes apply to new projects only covers it.
- Apply to all clips: Clip Editor Document Persistence handles the `title` branch with its own merge (it is not a `studioEdits` key). The stored state carries each clip's `title` and `hookText`.

## 8. Project page cards

A card that plays the preview proxy (no finished render for the selected format) paints the clip's title layer over the video with the same painter: on the first frame behind the play button when the layer is active there, and following the player's edited time through play, pause, seek and replay. A finished render already has it burned in and gets no overlay.

## 9. Verification

`bun run lint`, `bun run typecheck`, `bun run test`, `bun run check:web-split`, `bun run --cwd apps/api test:inventory`, `bun run --cwd apps/api openapi:check`, `bun run --cwd apps/api build:worker`. No PostgreSQL gates (fix database test files so they typecheck; do not run them), no full `next build`, no Docker or workerd gates, and check whether `apps/media/scripts/render-golden.test.ts` runs FFmpeg before running it (AGENTS.md).

Parity is judged on the contact sheet (section 5) beside the Studio prototype page drawing the same samples, and on one real export from the dev environment after deploy.

## 10. Deploy

Drain renders, then: migration → API Worker → Modal image, then the Worker's toolchain fingerprint secret at once → web. Keep the window between the API and web deploys short: the old web strips layer style on save. Stored render preparations that contain text layers re-prepare once.

## 11. Tickets

See `issues/`. 01 → 02; then 03 → 04 and 05 in parallel; then 06, 07, 08.
