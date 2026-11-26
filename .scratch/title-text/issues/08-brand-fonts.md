# 08 - Uploaded brand fonts in Text Layers

**What to build:** A Text Layer can use an uploaded brand font, drawn from the same file in the Studio and the export.

**Blocked by:** [02 - Export](02-export.md), [04 - Text panel](04-text-panel-timeline.md)

**Status:** ready-for-agent

Read `../spec.md` sections 2 and 4, and Sol's review notes below. This ticket is separable: if it cannot reach parity, it does not ship and layers keep drawing in their `font` family.

## Scope

- Scene face type: `TextPiece.face` and `Measure` accept an upload reference (id + fingerprint) with a catalog fallback, next to a catalog name. `memoMeasure` and baseline cache keys include it. Catalog behaviour and caching for the existing Scene Styles do not change.
- Worker: `SceneMeasurer` resolves the upload through `brandCaptionFace` / `CaptionGlyphPlanner` (already used by classic captions); the text script's fonts directory holds the target's resolved uploads and the catalog faces; ASS `\fn` selects the upload. Two uploads, or an upload and a catalog face, that share an internal font name: the first in layer order wins in both measurement and painting, and the worker logs it.
- Studio: `canvasMeasure` and the painter resolve the upload (`wordFace` already paints a brand face for classic captions); rebuild when the browser font loads; the same fallback order as the worker.
- `documentFontReferences` and the Studio bootstrap collect `style.fontAsset`. Brand template title style: `brandFontService.assertSelection` on create and update, and the font-delete guard also checks the template `title` column.
- `TextStyleControls` offers the brand's fonts in the font menu.

## Acceptance

- [ ] A sheet sample with an uploaded font matches the Studio prototype page.
- [ ] Existing Scene Style tests pass untouched.
- [ ] `bun run lint`, `bun run typecheck`, `bun run test` pass.
