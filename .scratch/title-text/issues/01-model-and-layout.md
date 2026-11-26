# 01 - Text Layer model and shared layout

**What to build:** The new Text Layer schema, the title constants, the brand title schema, the Apply-to-all `title` branch, and the pure builder that turns a layer into Caption Scene pieces. After this ticket the repository typechecks and the fast suites pass, with the Studio and the worker still drawing layers the old way from the new fields.

**Blocked by:** None.

**Status:** ready-for-agent

Read `../spec.md` sections 2, 3 and 4 first, and ADR 0021 (`docs/adr/0021-caption-scenes.md`).

## Scope

- `packages/validators/src/text-layer.ts`: `textLayerStyleSchema`, `studioTextLayerSchema` (moved out of `studio-edits.ts`), `TEXT_LAYER_FONTS`, `resolveTextLayerFace`, `DEFAULT_TITLE_STYLE`, the three effect defaults, `TEXT_LAYER_STYLE_PRESETS`, `brandTitleSchema`, a helper that builds a title layer from a text and brand title settings (used by the seed, the Studio and Apply-to-all), and the 120-character grapheme-safe word-boundary cut.
- `studio-edits.ts`: use the new schema; `studioTextLayersEqual` with a generic deep-equal on `style`; the `title` branch of `applyStudioEditsPatchSchema` (the "exactly one of" refine and the grouped `max(4)`).
- `editor-document.ts`: a `role: "title"` layer keeps its edited-time start and end through trims, extends and cuts (clamped to the new duration); body layers rebase as today.
- Brand template schemas (`brand-template.ts`): `title` on input, update, summary and snapshot. Selection capsule (`clip-selection.ts`): `title` on the strict `editor` object, nullable with a null default.
- `packages/caption-scene/src/text-layer/`: `layoutTextLayer` as section 4 describes, with tests using a deterministic fake measure: wrap threshold, unequal line widths, explicit and blank lines, an overlong word, alignment, both box modes, both corner modes, faux bold with and without a user stroke, shear italic, underline, z bands across two overlapping layers, braces kept, the active window.
- Composition plan: the `kind: "text"` layer carries the new value; no layout there. Update its tests.
- Every other consumer compiles against the new shape with the smallest bridging edit (the worker's `drawtext` stage and the Studio's DOM layer read `layer.style.*` for now; tickets 02 and 03 replace them). `documentFontReferences` and the Studio bootstrap read `layer.style.fontAsset`.
- `GLOSSARY.md`: Text Layer, Title (the `role: "title"` layer), Body text.

## Acceptance

- [ ] `{ id, text }` and the real old layer from `apps/media/src/__fixtures__/render-golden/documents.json` parse to the full default style; a layer of only whitespace or newlines is refused.
- [ ] A document with an old-shape layer round-trips through the editor document codec without error.
- [ ] `layoutTextLayer` tests pass and no layout constant exists outside the module.
- [ ] `bun run lint`, `bun run typecheck`, `bun run test` pass. Database test files typecheck and are not run.
