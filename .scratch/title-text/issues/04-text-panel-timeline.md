# 04 - Text panel, timeline lane, Apply to all clips

**What to build:** The Text panel with Vizard's Presets and Settings tabs, the text lane above the subtitle lane, and Apply to all clips for a title.

**Blocked by:** [03 - Studio canvas](03-studio-canvas.md)

**Status:** done (2026-11-27)

Read `../spec.md` section 6. Vizard reference screenshots:
- `/Users/murtaza/.t3/userdata/attachments/2358ee32-8fcd-4fd7-88f7-f7b95689bc87-aa53c2e4-58ce-4d90-b932-e5dac32b83bb.png` (Presets tab)
- `/Users/murtaza/.t3/userdata/attachments/2358ee32-8fcd-4fd7-88f7-f7b95689bc87-f688e0b5-2f64-495e-9cd1-3f9a1866bf9f.png` (Settings tab)
- `/Users/murtaza/.t3/userdata/attachments/2358ee32-8fcd-4fd7-88f7-f7b95689bc87-2e857b99-e1eb-48c7-afad-e82310f0df9b.png` (timeline)

## Scope

- `TextStyleControls`: one presentational component (value: text layer style, onChange, coalescing hooks) with every Settings control of section 6. Reused by the floating toolbar where it fits and by the brand kit (ticket 06).
- `text-panel.tsx` rebuilt: Presets tab ("Add a title", "Add body text", six cards drawn by the real painter, compact layer list) and Settings tab (text box, `TextStyleControls`, start and end fields, "Apply to all clips" for a title). Text-field rules of section 6.
- "Add a title" uses the clip's title (else hook text) and the project's brand title settings when the Studio has them, else the built-in default; it selects the existing title when there is one. A preset card restyles the selected layer, or the title, or adds a title in that style.
- Timeline: text lane above the subtitle lane; chip behaviour on clips shorter than the minimum; new layers last 5 s.
- Apply to all clips: confirmation and result counts as section 6 says, calling the existing apply-studio-edits mutation with the `title` patch and `excludeClipId`.
- Update `studio-dead-ends.test.tsx`, `draft-recovery-dialog.tsx` wording and other Studio tests that name text layers.

## Acceptance

- [x] Every control changes the canvas at once and is one undo step per gesture.
- [x] Shadow, Stroke and Background `+` / `−` behave as section 6 says; Corners and Box display hide while Background is off.
- [x] No greyed-out dead end anywhere in the panel.
- [x] `bun run lint`, `bun run typecheck`, `bun run test`, `bun run check:web-split` pass.

## Evidence (2026-11-27)

Commit 7bd7c8ea9 on `feat/title-text-studio` (the shared controls are in 6b59470cf).

- `TextStyleControls` (`tool-panels/text-style-controls.tsx`), props `{ value: TextLayerStyle; onChange: (patch: Partial<TextLayerStyle>, gesture?: string) => void; onGestureEnd?: () => void }`: font menu (each family in its own face), size (typed or from the menu), alignment, B / I / U toggles, Aa / AB, line spacing in percent, text colour, Shadow / Stroke / Background rows (`+` sets `DEFAULT_TEXT_SHADOW` / `DEFAULT_TEXT_STROKE` / `DEFAULT_TEXT_BACKGROUND`, `−` sets null), Corners and Box display only while Background is on. The floating toolbar uses its `TextFontMenu`, `TextSizeField` and `TextColorSwatch`. `TextStyleSample` (`text-layer-sample.tsx`) draws a style with the real painter (the cards; usable as the brand kit's live sample).
- Undo: a toggle or menu pick is one `setStudioEdits`; a slider or colour drag coalesces under `text-layer-style-<gesture>-<id>` and closes with `endCoalesce()` on release / picker close; typing coalesces under `text-layer-text-<id>` until blur. `studio-text-layers.test.tsx` checks the sequences. Every change is a document edit, so the canvas redraws from it at once.
- `+` / `−` and Corners / Box display: `studio-dead-ends.test.tsx` "Text panel Settings" (both states).
- Dead ends: at the layer cap the add buttons are `aria-disabled` with the reason printed under them and on the cards' labels (existing test kept); Duplicate at the cap says why in the menu and in a toast; Apply to all clips shows only for a title; the Settings tab shows only while a layer is selected.
- Add a title: `newTitleLayer` (clip title, else hook text, else "Your title") with `titleTextLayer` and `DEFAULT_BRAND_TITLE`; with a title on the clip the button reads "Edit the title" and selects it. A preset card restyles the selection, else the title, else adds a title in that style (`presetTarget`, keeps the layer's size).
- Timeline: the text lane sits above the subtitle lane; chips lost their border (accent tint when selected, title/body icon, accessible name); a chip click seeks only when its layer is off screen; the end floor never passes the clip's end. New body layers start at the playhead for 5 s (`newTextLayerTiming`, tests).
- Apply to all clips: confirmation copy per section 6; `POST /projects/:id/clips/apply-studio-edits` with `patches: [{ title: titlePatchOf(layer) }]` and `excludeClipId`; the result reads `{ updated, field, title: { restyled, created, skipped } }` into "Updated the title on N clips and added a title to M clips" plus a skipped line (`applyTitleResultMessage`, tests). On this branch the server refuses the title patch (`editor_document_invalid`), which shows as "Couldn't apply the title to all clips … No other clip was changed." Not run against ticket 05's server.
- Wording: draft recovery says "Titles and text"; reset confirmation says "titles and text".
