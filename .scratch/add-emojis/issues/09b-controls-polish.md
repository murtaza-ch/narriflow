# 09b - Studio controls polish

**What to build:** Three fixes from the coordinator's look at ticket 09's screenshots. Rules:
[../RULES.md](../RULES.md).

**Blocked by:** [09 - Studio controls](09-studio-controls.md)

**Status:** done

## Areas

`studio/_components/emoji/**` and the prototype page `apps/web/app/prototype/caption-emoji-controls/`.

## Deliverables

1. **Light theme was never captured.** The files named `*-light.png` in
   `.../scratchpad/emoji-studio/controls/` are dark (`none-light.png`, `picker-live-light.png`).
   Find out why (the prototype page ignoring the theme, or the screenshot run not switching it),
   make the prototype switchable by a URL option, capture every state in light, look at each, and
   fix what is wrong in light (contrast of chips, the selected palette card, the picker's hover and
   selected cells, the skin-tone ring, the "On screen now" selected chip).
2. **The picker's search field has a visible border.** Narriflow fields have no border: a soft
   filled field with a grey focus state. Copy the field treatment the Studio's other search or text
   inputs use (look at the captions panel and transcript panel) and remove the border.
3. **The per-line "Add emoji" action is hover-only.** The owner's reference (Vizard) shows a
   button on every line, always visible. When emojis are on, show a quiet, always-visible add
   button at the right of each subtitle line that has no emoji (icon only, with an accessible name
   and a tooltip, same size and position as the chip that replaces it), so the row does not shift
   when an emoji is added. Lines that have emojis show their chips as today. When emojis are off,
   keep it hover-only.

## Acceptance

- [x] Deliverables 1 to 3, with light and dark screenshots saved to
      `.../scratchpad/emoji-studio/controls-v2/`.
- [x] Web tests, `bun run typecheck`, biome on touched files, `bun run check:web-split`.

## Evidence

Implemented 2026-11-26. Nothing committed.

### 1. Light theme

Why the old `*-light.png` were dark: neither suspected cause. The prototype did switch modes
(`?mode=light` ran `setColorMode`; the native range input in `picker-live-light.png` is light). The
Studio is graphite in both modes by design: `studio/layout.tsx` pins its box with
`className="dark" data-theme="dark"`, and every `studio.*` token is mode-invariant. The app's mode
lives on `<html>` (`light`/`dark` class plus `color-scheme`, set by the bootstrap script in
`app/layout.tsx` and `ColorModeProvider` in `packages/ui`). Inside the Studio, light mode reaches
only (a) portaled overlays, which render in `body` outside the pin, and (b) native controls,
through `color-scheme`. The prototype had no pin, so it was not a faithful test of either.

- Prototype (`controls.tsx`): the page uses the app `bg` (porcelain in light); the Studio area
  carries the same pin as `studio/layout.tsx`, so overlays meet the modes they meet in the Studio.
  `?mode=light|dark` documented in `page.tsx`.
- Fix (`emoji-picker-host.tsx`): the picker's `Popover.Positioner` re-pins with
  `className="dark" data-theme="dark"`. Before, the loading state's `Spinner` (`accent.solid` over
  a `border` track, both mode-dependent) drew in light colours on the graphite popover in light mode.
- Looked at every state in light (list below). Chips, the selected palette card (Template), picker
  hover/selected cells, the skin-tone ring and the "On screen now" selected chip use `studio.*`
  tokens and render the same as dark; contrast unchanged and fine. The tone ring (`studio.accent`
  #8EAEEC, 2px inset) reads clearly in `picker-tones-*`.

### 2. Search field

The field used the Studio's `softFocusWithin` (a 1px grey inset edge on focus). The picker focuses
the field on open and keeps focus there (arrows move the active cell by aria-activedescendant), so
the edge showed the whole time and read as a border. It also sat on `studio.surface` with a
`studio.subtle` fill, a sunken step. Now (`emoji-picker.tsx`): no edge, and focus is a grey fill
step. `studio.subtle` at rest, `studio.raised` while focused (the normal open look), the same
one-step-up-from-surface fill other popover controls use (the picker's Remove button). The clear
button's hover moved to `studio.borderStrong` so it stays visible on the raised fill.

### 3. Always-visible line Add

`emoji-chips.tsx` `LineEmojiChips`: with emojis on and no emoji on the line, the add button is
always shown (`SmilePlus` icon, `aria-label="Add emoji to this line"`, `title="Add emoji"` as the
Studio's `LineAction` does, quiet `studio.subtle` fill, 26px square with 8px radius like the
chip). It sits at the row's right where the first chip appears, so adding an emoji does not move the
row. Lines with emojis show their chips as before, and the add button stays a hover action (now
placed before the chips, so the chip takes the button's spot). Emojis off: hover-only as before.
The hover action stays shown while its picker is open. Prototype: the line rows now carry inert
stand-ins for the transcript's three hover `LineAction`s, so chips sit where they do in the Studio;
new `?state=mixed` (every other line without an emoji); `?open=add` prefers a shown add button.

Test: `emoji-chips.test.tsx` (3): shown when on and empty; hover action when the line has emojis;
hover action when off.

### Screenshots

`/private/tmp/claude-501/-Users-murtaza-Documents-dev-narriflow/f7147bb1-206f-4f6e-a8fc-276dea0eb55b/scratchpad/emoji-studio/controls-v2/`,
each as `-light.png` and `-dark.png`: off, none, running, added, empty, error, offline, confirm,
readonly, nowords, some, mixed, picker-live, picker-line, picker-add (from a shown add),
picker-search (money), picker-glyph (🔥), picker-tones (thumbs, medium-dark), picker-nomatch,
rtl-some, rtl-picker, horizon-some, headline-some; plus `picker-add-hover-dark.png` (the hover add
on a line with an emoji, kept visible while open). 2x, 880x900 viewport, headless Chrome.
Headless virtual time sometimes catches the popover's enter animation half-faded. Those were
retaken, and a real-browser check (DevTools, light, `open=add`) showed the popover open at full
opacity with the right add expanded.

### Commands

- `bun run typecheck`: 17 of 17 successful. (Earlier runs failed only on
  `@narriflow/caption-fonts/graphemes` while ticket 10 was mid-move; cleared once its tsconfig path
  landed.)
- `bun run --cwd apps/web test`: 1,312 pass, 0 fail (3 new).
- `bun run check:web-split`: passed.
- `bunx biome check` on the emoji folder and the prototype folder: clean (28 files).

### Not mine, found while looking

- `studio/layout.tsx` pins Chakra tokens with `.dark` but not `color-scheme`, so in light app mode
  unstyled native controls and scrollbars inside the Studio render in the light scheme (seen on
  the prototype's native range input). The picker's scrollbar is custom-styled and unaffected.
- The Studio's other portaled overlays (export menu, music block popover, timeline popover, dialogs)
  also render outside the pin. They use `studio.*` tokens, so they are fine unless one of them
  contains a mode-dependent `@narriflow/ui` component (not audited).
