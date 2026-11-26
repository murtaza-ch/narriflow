# 03 - Studio canvas: painted layers, selection frame, floating toolbar

**What to build:** In the Studio a Text Layer is painted by the scene painter, selected with a frame that has four corner grips and two side grips, dragged and resized on the canvas, and edited from a floating toolbar.

**Blocked by:** [01 - Text Layer model and shared layout](01-model-and-layout.md)

**Status:** done (2026-11-27), except the live reload check (see Acceptance)

Read `../spec.md` section 6. Vizard reference screenshots (open them):
- `/Users/murtaza/.t3/userdata/attachments/2358ee32-8fcd-4fd7-88f7-f7b95689bc87-811fbadd-ef3a-41c6-abac-587024031dd4.png` (canvas, title selected)
- `/Users/murtaza/.t3/userdata/attachments/2358ee32-8fcd-4fd7-88f7-f7b95689bc87-f688e0b5-2f64-495e-9cd1-3f9a1866bf9f.png` (Settings tab and floating toolbar)
- `/Users/murtaza/.t3/userdata/attachments/2358ee32-8fcd-4fd7-88f7-f7b95689bc87-4d870cb3-3a4c-427e-b5cd-2e0c927baab1.png` (font menu)
- `/Users/murtaza/.t3/userdata/attachments/2358ee32-8fcd-4fd7-88f7-f7b95689bc87-d0c8dc43-0605-4336-8adb-b7d17cd5a62e.png` (size menu)

## Scope

- `interactive-text-layer.tsx` and `video-preview.tsx`: paint each visible layer with `layoutTextLayer` + `canvasMeasure` + `CaptionSceneLayers` in target-canvas pixels scaled once; rebuild when fonts load; the layer moves live while dragged.
- Selection frame from the layout `frame`: corner grips scale `fontSize` and `widthPct` together; side grips change `widthPct` with the opposite edge fixed; existing snap guides; the frame's centre stays inside the canvas. One coalesced undo frame per gesture (`setStudioEdits` + coalesce key + `endCoalesce`, as today).
- Click selects the topmost layer under the pointer; double-click focuses the Settings text box.
- Floating toolbar under the selected layer (flips above, stays on screen): font menu with each family in its own face, size (menu + direct entry), alignment, case, text colour, more menu (Duplicate, Delete; "Apply to all clips" for a title, wired in ticket 04).
- Selecting a layer opens Text → Settings; deleting returns to Text → Presets.
- A prototype page `apps/web/app/prototype/text-layers` (like the existing prototype pages) that draws the ticket 02 sample set with the real painter on the same backgrounds, and one interactive sample with the selection frame, toolbar and the style controls on local state, no API. It is how the export contact sheet is compared with the Studio.
- Product UI rules in spec section 6; reuse `panel-ui` and `studio.*` tokens.

## Acceptance

- [x] The prototype page renders every sample; screenshots at 9:16 and 16:9 saved under `.scratch/title-text/studio/`.
- [ ] Dragging, corner resize and side resize each land as one undo step and survive reload. One undo step: verified. Survive reload: not run in a live Studio (see Evidence).
- [x] A title over the captions is selectable from its chip when the caption is on top.
- [x] `bun run lint`, `bun run typecheck`, `bun run test`, `bun run check:web-split` pass.

## Evidence (2026-11-27)

Branch `feat/title-text-studio`: 6b59470cf (canvas, toolbar, shared controls), 7bd7c8ea9 (panel, timeline), plus the prototype commit.

- Painting: `text-layer-scene.ts` builds all of a target's layers as one scene with `buildTextLayerScene` and `canvasMeasure(null, …)` (faces load first; the build is forced once they have), painted by `CaptionSceneLayers` at `previewWidth / target.canvas.width` (`studio-text-layers.tsx`, mounted in `video-preview.tsx` from the plan target's `kind: "text"` layers and `target.canvas`). No layout number in the Studio: the frame, boxes and lines come from the builder.
- Braces and backslashes: `canvasMeasure` measures the text as given (only the worker's caption path, `assDrawnText`, drops them), so it already agrees with the worker's literal measurer. Sample 23 has identical boxes in the export sheet and the Studio sheet.
- Gestures (`text-layer-gestures.ts`, 5 tests): drag snaps on the centre and keeps it on the canvas; corners scale size and width by one factor, held when either leaves its range; side grips keep the opposite edge; toolbar placement flips above and stays inside. In a real browser (headless Chrome over CDP on the prototype page): drag moved the frame 120 px; the bottom-right corner took size 48 → 56 about the centre; the right grip moved only the right edge (left edge stayed at 24 px); double-click focused the Text box; the font menu lists 42 families each in its own face; the more menu reads Duplicate / Apply to all clips / Delete. Screenshots: `studio/interactive-settings.png`, `interactive-font-menu.png`, `interactive-more-menu.png`.
- One undo step per gesture: the canvas draws a local draft during the gesture and commits once (`applyGesture`: one `setStudioEdits` with `text-layer-canvas-<gesture>-<id>`, then `endCoalesce()`); `studio-text-layers.test.tsx` asserts the exact call sequence.
- Survive reload: the change is an ordinary `studioEdits.textLayers` edit saved by the existing autosave; not exercised in a live Studio. A live run needs this branch's API (the deployed dev API has the old layer schema) against the shared dev database, so it was not done here.
- Title under captions: text layers paint at z 4 (under the caption overlays at 5/6, as the export burns them under captions); a chip click selects the layer, and the selected layer's frame and grips sit at z 7, above the captions, so they stay reachable.
- Click selects the topmost: hit areas are in document order (a later layer's area is above an earlier one's).

Studio vs export (contact sheet vs `studio/{vertical,horizontal}-{flat,photo}.png`, all 26 samples, tile by tile at full size):
- Line breaks: identical on every sample, both canvases.
- Box size, baseline, stroke weight, italic lean (16 shear, 17 real), underline (18): no visible difference at 2× zoom.
- 25 (typed emoji): the export's box is about 1 em wider (≈52 canvas px at 1080×1920); all of the extra width is the gap after 🎉. The Studio draws the same glyphs with a normal space. Not a Studio bug: it is the shared caption fallback path on the worker (the pinned emoji fallback face's run around 🎉), which the spec says text layers follow; reported to the orchestrator.
- 24 (Urdu and English): the boxes differ by about 1 px. Shaping noise between HarfBuzz and Canvas.
- The photo background is a CSS radial gradient of the same four colours, not FFmpeg's `gradients` source; it only matters for the backdrop, not the text.
