# 04 - Text panel, timeline lane, Apply to all clips

**What to build:** The Text panel with Vizard's Presets and Settings tabs, the text lane above the subtitle lane, and Apply to all clips for a title.

**Blocked by:** [03 - Studio canvas](03-studio-canvas.md)

**Status:** ready-for-agent

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

- [ ] Every control changes the canvas at once and is one undo step per gesture.
- [ ] Shadow, Stroke and Background `+` / `−` behave as section 6 says; Corners and Box display hide while Background is off.
- [ ] No greyed-out dead end anywhere in the panel.
- [ ] `bun run lint`, `bun run typecheck`, `bun run test`, `bun run check:web-split` pass.
