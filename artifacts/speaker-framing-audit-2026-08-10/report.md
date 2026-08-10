# Narriflow speaker-framing audit

Date: 2026-08-10

## Scope

Compared the supplied Narriflow project and studio against the supplied Vizard editor at a 2560px desktop viewport. Exercised layer selection, move, crop, zoom, resize, rotate, reset, autosave/reload, aspect-ratio switching, timeline delete/undo, and keyboard access. Verified render parity through the repository's FFmpeg smoke suite rather than creating a billable/export artifact from the live project.

## Verdict

The framing model and rendered composition were already strong, but two interaction defects broke the two-speaker promise: controls extending beyond a tile were clipped, and Reset removed the entire scene override instead of only the selected speaker. Both are fixed. Narriflow now retains its dense professional studio while matching Vizard's essential direct-manipulation clarity.

## Flow evidence

1. **Narriflow baseline — healthy.** The split composition, transcript, timeline, format, autosave state, and detected scenes loaded correctly. Evidence: `screenshots/01-narriflow-studio-baseline.png`.
2. **Vizard baseline — healthy comparator.** Vizard uses a cleaner, brighter canvas and a compact right tool rail; its timeline contains fewer simultaneously visible controls. Evidence: `screenshots/02-vizard-baseline.png`.
3. **Vizard layer selection — healthy.** Clicking the upper speaker exposes a blue selection outline, resize handles, a floating action bar, and canvas zoom. Evidence: `screenshots/03-vizard-top-speaker-selected.png`.
4. **Narriflow upper layer — healthy.** Selection, crop, zoom, move, resize, and rotation affordances appeared in context and edits autosaved. Evidence: `screenshots/05-narriflow-top-speaker-selected.png` and `screenshots/16-narriflow-crop-real-user.png`.
5. **Narriflow lower layer before fix — broken.** The selection outline appeared, but the toolbar was clipped at the split boundary and the upper layer intercepted its hit targets. The upper rotation handle had the inverse overlap problem. Evidence: `screenshots/09-narriflow-bottom-speaker-selected.png`.
6. **Narriflow lower layer after fix — healthy.** The selected layer now rises above its sibling, and overflow controls remain visible and clickable. Evidence: `screenshots/17-narriflow-bottom-toolbar-fixed.png`.
7. **Independent reset and resize — healthy.** Resetting the upper speaker preserved the lower speaker's 1.4× zoom. Pointer resize and keyboard resize both changed only the selected layer, then reset cleanly. Evidence: `screenshots/18-narriflow-independent-reset.png` and `screenshots/19-narriflow-bottom-resized.png`.
8. **Ratio and timeline behavior — healthy.** 1:1 loaded its own framing state; a 1.2-second timeline section deletion changed 53.30s to 52.10s, Undo restored 53.30s, and a reload confirmed the restored server state. Evidence: `screenshots/14-narriflow-square-ratio.png`, `screenshots/20-narriflow-timeline-delete.png`, and `screenshots/22-narriflow-final-clean.png`.

## Fixed gaps

- Removed frame-level clipping that hid out-of-bounds transform controls; media remains clipped by the dedicated inner media well.
- Raised the selected speaker frame above its sibling so split-boundary controls receive pointer input.
- Changed Reset from whole-scene reset to selected-speaker reset, while removing the persisted override when both speakers return to defaults.
- Added 24px resize hit areas without enlarging the visible 10px handles.
- Added keyboard move/crop, resize, and rotation, visible focus treatment, layer labels, pressed states, and rotation slider values.
- Added regression tests for selected-speaker reset and for timeline deletion rebasing scene timing without changing either speaker transform.

## Remaining comparison notes

- Narriflow is intentionally denser than Vizard because transcript, properties, and timeline are visible together. Vizard is calmer at first glance, but Narriflow exposes more editing context without opening panels.
- Vizard's selected-layer action bar uses unlabeled icons visually; Narriflow's tooltips and accessible names are clearer after the fix.
- Full assistive-technology behavior and contrast compliance cannot be proven from screenshots alone. Keyboard operation and visible focus were tested, but a dedicated VoiceOver/NVDA pass remains outside this audit.
