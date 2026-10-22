# App redesign: apply the Studio design language app-wide

The owner approved the redesigned Studio and the project page (clip card, tabs, Edit clip length dialog). This spec applies the same design to every app route except the marketing site (`(home)`, `(marketing)`) and `prototype/`. The change is visual only.

## Already done at the theme level (don't redo)

The theme lives in `packages/ui/src/theme.ts`; read its color-role comment on the `accent` token first. Pages inherit these:

- Inputs, textareas, selects, native selects, number inputs, the date picker and the combobox are soft-filled. Each has a `bg.soft` fill, `bg.softHover` on hover, no visible border, a 10px radius and an accent focus ring.
- Buttons:
  - The `outline` and `subtle` variants both render a soft fill with no border.
  - `ghost` is transparent with a soft hover.
  - `solid` with the default `brand` palette is the neutral ink primary button.
  - Radii are 8px for xs and sm, 10px for md and lg.
- Card `outline` variant: `bg.panel` with a `border.card` edge. `border.card` is a hairline in light mode and transparent in dark.
- Segmented controls have a soft track and a raised neutral thumb, with no border.
- Tabs draw an accent underline. Checkboxes, radios, switches, sliders, progress bars and meters use the accent.
- `NavLink` marks the current page with `accent.subtle` behind `accent.fg` text.
- `success.*` tokens alias the accent; the product has no green. Focus rings are the accent everywhere.
- `textStyle="eyebrow"` is now a 13px/500 section label.
- `StatBand` has no divider rules.

New tokens:
- `bg.soft` and `bg.softHover`: translucent control fills that read on any surface.
- `border.card`: the card edge (a hairline in light mode, none in dark).

## Rules for pages

1. **Flat surfaces.** Separate surfaces with fill and spacing, not borders.
   - Cards and panels: `bg="bg.panel"`, `borderRadius="l3"`, and `borderWidth="1px" borderColor="border.card"` (so light mode keeps a hairline).
   - Never use `borderColor="border"`, `"border.subtle"` or `"border.emphasized"` on cards, panels, stat tiles, chips, pills, buttons or inputs.
   - Don't nest cards. Inner groups use spacing, or `bg="bg.soft"` tiles with `borderRadius="l2"` and no border.
   - Hairline row dividers (`border.subtle`) are fine only inside dense lists and tables.
2. **No eyebrows or filler.**
   - Delete small labels above page and section titles, and remove the `eyebrow` prop from `PageHeader`, unless the label carries information the title doesn't, such as a workspace name on a shared page.
   - Delete filler subtext: counts that restate what's visible, intro lines above grids, and status pills when the state is obvious.
   - Keep copy that states a consequence or an instruction. Delete exactly the filler; don't rewrite meaningful copy.
3. **Type.**
   - Section headings: `fontSize="16px" fontWeight="500"`.
   - Section labels: `textStyle="eyebrow" color="fg.muted"`, never uppercase.
   - Body: 14px. Secondary text: 13px `fg.muted`. Meta: 12px `fg.subtle`.
   - Minimum size is 12px, except tiny badge text.
   - Page titles come from `PageHeader`.
4. **Numbers.**
   - `textStyle="data"` (monospace) is only for timecodes and clock-format durations (00:01:23), IDs and keys, and hex values.
   - Counts, stats, money, sizes and percentages use the body font with `fontVariantNumeric="tabular-nums"`.
5. **Controls.**
   - Remove local `borderColor`, `borderWidth` and `bg` overrides on `Input`, `Textarea`, `Select`, `NativeSelect` and `NumberInput`, so the theme's soft field applies.
   - Buttons: `variant="outline"` becomes `variant="subtle"`. Keep one neutral solid primary per view (remove `colorPalette="accent"` from solid buttons). Destructive primaries use `colorPalette="danger"`.
   - Hand-built toggle groups: use the kit `SegmentedControl`, or soft buttons with the selected item `variant="subtle"` and the rest `variant="ghost"`.
6. **Color roles.**
   - Accent (`accent.solid`, `accent.fg`, `accent.subtle`) marks state: selected, checked, current, focus, progress, live or in-progress work, and ready or done.
   - Neutral (`fg`, `brand`) is for text, surfaces and primary buttons.
   - `danger` and `warning` are for status only. Never use green or hardcoded hex for chrome.
   - Selected tile or card: `borderWidth="2px" borderColor={selected ? "accent.solid" : "transparent"}`.
   - Selected chip: `bg="accent.subtle" borderColor="accent.solid"` with `fg` text; unselected chips use `bg="bg.soft"` with a transparent border.
   - Playheads and progress fills: accent.
7. **Icons.**
   - Lucide icons, 16px in buttons and 18–20px standalone.
   - No icons inside bordered squares. Use a bare icon in `fg.muted`, or a soft circle (`bg.soft`, no border).
8. **Empty states.** Use the kit `EmptyState` from `@narriflow/ui/components/empty-state`. It is a subtle card (`bg.subtle`, `l3` radius, a `border.card` hairline) holding:
   - the icon in a soft circle
   - a 15px/500 title
   - one 13px `fg.muted` line
   - one action

   The owner asked for this card because a boxless empty state looked too flat. Don't hand-build empty states, and never use dashed boxes.
9. **Dialogs and drawers.**
   - The theme already removes their borders.
   - Title: 18px/500.
   - Close: a round 32px ghost icon button.
   - Cancel: `Dialog.ActionTrigger` (never `Dialog.CloseTrigger`, which the recipe pins to the corner), placed next to the primary, right-aligned.
   - No header or footer border lines.
10. **Menus and popovers.** The theme styles them; remove local borders.
11. **Light and dark mode.** Both must work.
    - Use semantic tokens only (`bg`, `bg.subtle`, `bg.panel`, `bg.raised`, `bg.muted`, `bg.soft`, `bg.softHover`, `fg`, `fg.muted`, `fg.subtle`, `border.card`, `border.subtle`, `accent.*`, `danger.*`, `warning.*`).
    - Never use `studio.*` tokens outside the Studio.
    - Keep the existing intentional exceptions: footage wells (`MediaWell`, the graphite `rgba(14, 16, 19, 0.72)` scrims over video), caption preset and brand colors, and anything feeding render or export.

## Constraints

- Change visuals only. Leave logic, data flow, props, routes, `aria-*` labels, `data-testid` attributes and copy that carries meaning untouched.
- Stay inside your assigned files. Don't edit `packages/ui` or the Studio (`clips/[clipId]/studio/`).
- Match the surrounding code style: tabs or spaces as the file already uses, and the same comment density.

## Reference implementations

The Studio uses `studio.*` tokens. When you copy a pattern from it, translate each token to its app equivalent:

| Studio token | App token |
| --- | --- |
| `canvas` | `bg` |
| `subtle` | `bg.subtle` |
| `surface` | `bg.panel` |
| `raised` | `bg.raised` |
| `accent` | `accent.solid` |
| `accentSubtle` | `accent.subtle` |
| `fg` / `fgMuted` / `fgSubtle` | `fg` / `fg.muted` / `fg.subtle` |

Read these first:
- `apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/tool-panels/panel-ui.tsx`: the primitives (tabs, section labels, tiles, chips, soft buttons, soft fields)
- `.../studio/_components/studio-export-menu.tsx`, `reset-confirm-dialog.tsx`, `auto-censor-review-drawer.tsx`, `keyboard-shortcuts-modal.tsx`
- Approved app pieces: `apps/web/app/(app)/projects/[projectId]/clip-row.tsx` (card), `project-tabs.tsx`, `panel-header.tsx`
