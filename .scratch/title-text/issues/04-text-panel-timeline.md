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

## Review round 2 (2026-11-27)

Fixes for the 15 accepted items of `review-04.md` (Astra's UX review, orchestrator decisions), on `feat/title-text-studio` after merging `feat/title-text` (208b2d376). The three "Not accepted" items are unchanged. Paths are under `apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/` unless noted.

1. **Text under image B-roll.** One stacking table, `preview-stacking.ts` (`PREVIEW_Z`), in the plan's order: image B-roll 20, inserted scene 24, text 30, captions 40 (emojis 41, caption frame 42), logo 50, transition 60, watermark 70, the selected text frame 75, status 80, snap guides 90. `video-preview.tsx`, `interactive-caption-overlay.tsx`, `interactive-scene-overlay.tsx`, `emoji/cue-caption-emojis.tsx` and `studio-text-layers.tsx` use it. Captions were also under image B-roll (5/6 against 20); logo, transition and watermark were 25/30/35. Test: `text-lane.test.tsx` "Preview stacking".
2. **"Edit the title" did nothing.** The panel tab is a small store (`text-panel-tab.ts`); the select command sets Settings (`select(id)` in `studio-text-layers.tsx`), as do chip clicks and chip keys (`timeline.tsx`), so selecting the selected layer again shows Settings and a double-click's focus request finds the field. A preset card passes `settings: false` so the cards stay in view; a delete sets Presets. Test: `studio-text-layers.test.tsx` "selecting shows Settings, even for the layer already selected".
3. **The frame swallowed clicks.** The selected frame is `pointer-events: none`; only its six grips take the pointer. A press inside it goes to the topmost hit area (document order), which moves a layer only if it is the one hit. Browser check (headless Chrome over CDP, prototype): body dragged over the selected title, a press on the body inside the title's frame selected the body. Screenshot `studio/interactive-overlap-select.png`.
4. **Overlapping chips.** `textChipRows` (greedy, start order, document order on ties) puts each chip on the first row it fits; the text lane grows with the rows (26 px + 3 px gap). Tests: `text-layer-commands.test.ts` "overlapping chips stack into rows"; `text-lane.test.tsx` renders `TextLayerChip`s and checks a duplicate on row 1 (top 29 px), the original and a later chip on row 0. The prototype has no timeline, so stacking has no screenshot.
5. **Edge drags lost the grips.** `keepTextLayerReachable` holds the centre so at least 24 preview px of the frame stays inside on each axis, and the centre stays on the canvas (the schema's 0–100 range, which also covers frames larger than the canvas); drags and arrow nudges use it. Tests: `text-layer-gestures.test.ts` (edge, small frame, frame wider than the canvas, nudge). Browser: a drag far past the bottom-left left 24 px of the frame inside vertically and the top grips on the canvas (`studio/` screenshots; the Studio's video box clips, the prototype now does too).
6. **Colour picker.** Hue slider only (`ColorPicker.ChannelSlider channel="hue"`, no alpha); the undo chain ends on `onValueChangeEnd` (pointer up) as well as on close. Browser: the open picker has one channel slider, `hue`. Screenshot `studio/interactive-colour-picker.png`.
7. **Toolbar on a narrow preview.** Under 380 px of room in the preview area the toolbar is compact: font, size, colour, more; alignment and Uppercase move into the more menu. Browser (`?narrow=1`): `data-compact`, 279 px wide, the more menu lists Align left / centre / right, Uppercase, Duplicate, Apply to all clips, Delete. Screenshot `studio/interactive-compact-toolbar.png`.
8. **Chip wobble.** Nothing is written until the 3 px threshold is passed; an open-ended chip dragged to the end keeps the minimum length (start at most clip end − 0.5 s). Covered by reading (`timeline.tsx` `handlePointerMove`); no automated pointer test of the chip drag.
9. **Inserted scenes.** Selecting from a chip, a row or a button seeks with `textLayerSeekTarget` over `baseEditedRangeToComposite` (the composite ranges with scenes cut out): no seek when the playhead shows the layer, else its first visible frame. Also fixed: the plan cuts a layer at each scene into pieces that share the layer id, which collided as layout and piece keys; each piece is now its own canvas entry keyed by the plan's id. Tests: `text-layer-commands.test.ts` "a layer is shown from its first visible frame"; `studio-text-layers.test.tsx` "a chip or row in an inserted scene's gap".
10. **Result wording.** `applyTitleResultMessage`: "Updated N · Added N · Skipped N" always (zeros included); "Every other clip already matches" only when nothing changed or was skipped, "No other clip changed" when clips were skipped. The confirmation reads the project's clips (`clipQueries.list`) while open; with no other clip it says so and offers only Close. Tests: `text-layer-commands.test.ts`, `studio-text-layers.test.tsx` "Apply to all clips confirmation".
11. **Lost response.** `applyFailureKind`: a 4xx answer is a refusal ("Couldn't apply the title. No other clip was changed."); no answer, a 5xx, `scope_changed` or an unreadable reply is unknown ("Couldn't confirm the change … some clips may have changed. Try again …"). Both keep the dialog open with Try again. Tests: same files.
12. **Keyboard.** Chips are tab stops (Enter / Space selects, shows Settings and the layer). With a selected layer focused on the canvas, arrows nudge 1 % (Shift 5 %), one undo step per burst (`text-layer-nudge-<id>`, closed on key up); a press on the canvas focuses the hit area. Tests: `text-lane.test.tsx` (`tabindex="0"`), `studio-text-layers.test.tsx` "an arrow-key burst is one coalesced change"; browser: 1 % then 5 %.
13. **Long paste.** A paste that would pass 280 characters is cut in place with a note under the field; from 240 characters the field shows "n / 280". Test: `studio-dead-ends.test.tsx` "near the 280-character limit"; the paste note is not covered by an automated test (server rendering cannot paste).
14. **Size field.** Leaving the field without typing commits nothing (a 56.5 from a resize stays); a typed size keeps one decimal, line spacing stays whole. Test: `tool-panels/text-style-controls.test.ts` (`parseNumberDraft`).
15. **Prototype fixture.** The "made with Narriflow" body layer moved to 70 %; screenshots re-captured.
