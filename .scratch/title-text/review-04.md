# UX review of the Studio (Astra, 2026-11-27) with the orchestrator's decisions

Reviewed at integration commit 208b2d376. The orchestrator checked the high findings in the code; they are real. Fix on `feat/title-text-studio` after merging `feat/title-text` into it.

Accepted:
1. **Text hidden behind image B-roll.** `video-preview.tsx` ~2159 puts image B-roll at z 20 over text paint (4) and the frame (7). The export burns text above B-roll. Paint text layers above B-roll (image and video) and keep the frame and grips above them; check every other overlay's z order against the composition order (captions above text, logo, watermark).
2. **"Edit the title" can do nothing.** `text-panel.tsx` opens Settings only when `selectedId` changes, so reselecting the selected title from Presets, its row or its chip leaves Presets showing and double-click has no field to focus. Make "open Settings" part of the select command (every select from the canvas, chip, row or button shows Settings, and double-click focuses the field after it mounts).
3. **The selected frame swallows clicks on a layer above it.** `text-layer-canvas.tsx` ~203: the frame captures pointers over its whole rectangle. Only the grips capture; a press inside the frame goes through the normal topmost-layer hit test and starts a move only when that hit is the selected layer.
4. **Overlapping chips hide each other.** `timeline.tsx` ~1780: chips with overlapping intervals sit on the same row, so a duplicate covers its original and its trim handles. Stack overlapping text chips into rows inside the text lane (greedy: each chip takes the first row where it does not overlap), lane height growing with the row count.
5. **Dragging to an edge loses the grips.** `text-layer-gestures.ts` ~22 constrains only the centre. Constrain the frame so at least the grips on one side stay inside the canvas: clamp so the frame keeps a minimum visible overlap (for example 24 preview px of the frame inside each axis), and when the frame is wider or taller than the canvas, keep its centre inside.
6. **Colour picker.** `text-style-controls.tsx` ~187 shows Chakra's alpha slider though only RGB is stored: show the hue slider only. End the undo chain at the end of each picker gesture (pointer up), not only when the picker closes.
7. **Toolbar too wide on a narrow preview.** `text-layer-toolbar.tsx`: under ~380 px of available width use a compact layout (font, size, colour, more; alignment and case move into the more menu), always inside the preview's container.
8. **Chip wobble retimes.** `timeline.tsx` ~1707 writes timing before the 3 px threshold: write nothing until the threshold is passed. An open-ended chip dragged to the clip end keeps at least the minimum visible duration.
9. **Inserted Scene Block gap.** Selecting a chip or row checks visibility against the raw interval; the painter excludes inserted scenes. Check the layer's visible composite ranges and seek to its first visible frame when the playhead is in a gap or outside the layer.
10. **Apply to all result wording.** Show updated, created and skipped counts (zeros included); "every other clip already matches" only when nothing was skipped; a one-clip project says there are no other clips (and the action is not offered there, or explains itself).
11. **Lost response.** When the request's outcome is unknown (network error or timeout after sending), say the change could not be confirmed and offer to try again; keep "No other clip was changed" for a definite server refusal.
12. **Keyboard.** Timeline text chips: a tab stop, Enter/Space selects. Frame grips stay pointer-only; instead, with a text layer selected and focus on the canvas, arrow keys nudge it by 1% (Shift 5%), one undo step per key press burst.
13. **Paste over 280 characters.** Show a character count near the limit and an inline note when a paste was shortened.
14. **Size field.** Leaving the field without typing commits nothing; a typed value keeps one decimal.
15. **Prototype fixture.** Move the "made with Narriflow" body layer in `apps/web/app/prototype/text-layers/text-layers.tsx` off the title before re-capturing screenshots.

Not accepted:
- **Preset card target.** Ticket 04's rule stands: a card restyles the selected layer, else the title, else adds a title. Selecting body text and clicking a card should restyle that body text.
- **"Add a title" timing.** The title is the clip's opener: it starts at 0 for the brand duration, and the Studio seeks to its start so the user sees it. The playhead-based 5 s window is for body text. (The brand settings now come from the project's brand snapshot, in progress on another branch.)
- **Emoji gap in export.** Being fixed in the worker on the brand-fonts branch.
