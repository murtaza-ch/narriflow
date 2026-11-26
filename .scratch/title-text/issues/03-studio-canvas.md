# 03 - Studio canvas: painted layers, selection frame, floating toolbar

**What to build:** In the Studio a Text Layer is painted by the scene painter, selected with a frame that has four corner grips and two side grips, dragged and resized on the canvas, and edited from a floating toolbar.

**Blocked by:** [01 - Text Layer model and shared layout](01-model-and-layout.md)

**Status:** ready-for-agent

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

- [ ] The prototype page renders every sample; screenshots at 9:16 and 16:9 saved under `.scratch/title-text/studio/`.
- [ ] Dragging, corner resize and side resize each land as one undo step and survive reload.
- [ ] A title over the captions is selectable from its chip when the caption is on top.
- [ ] `bun run lint`, `bun run typecheck`, `bun run test`, `bun run check:web-split` pass.
