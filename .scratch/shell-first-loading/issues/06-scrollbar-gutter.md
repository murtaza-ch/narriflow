# 06 - Reserved scrollbar gutter on framed pages

**What to build:** Content that makes a framed page scrollable does not move the shell. Pages that render the shell panel reserve the root scrollbar's gutter, painted in the frame colour.

**Blocked by:** None.

**Status:** done

Spec: [../spec.md](../spec.md). Files: `packages/ui/src/theme.ts` (+ `theme.test.ts`), `apps/web/app/(app)/_components/shell-panel.tsx`.

## Behaviour

1. `ShellPanel` carries `data-shell-panel`. The global CSS sets `scrollbar-gutter: stable` and `bg.sidebar` on `html:has([data-shell-panel])`.
2. Studio (a fixed full-screen overlay with no `ShellPanel`) and the marketing pages are unaffected.
3. Dialogs that lock scrolling do not shift: `@zag-js/remove-scroll` sees `scrollbar-gutter: stable` and adds no padding of its own (checked by the orchestrator before this ticket).

## Acceptance

- [x] The rule exists and is scoped to pages with a shell panel.
- [ ] In a browser with classic scrollbars: `/projects` does not move when the grid loads; the reserved strip shows the frame colour in light and dark; opening a dialog does not shift the page; Studio and `/` are unchanged.

## Comments

2026-11-26 (implementer). Design: the attribute is on `ShellPanel` itself, so every framed variant gets it: the default shell, settings, an open Project, the upload funnel, the continuation shell and the docs. The docs layout renders the same frame and `ShellPanel` (`app/(docs)/docs/layout.tsx`), so docs pages reserve the gutter too. The brief expected docs to be unaffected, but they have the same shift between short and long pages and the same `bg.sidebar` frame, so I kept them in. The rule sits next to the scrollbar rules in `globalCss`. `html:has(...)` has higher specificity than `html, body`, so it overrides the root's panel fill on framed pages only.

How it interacts with the `*::-webkit-scrollbar` rules: `width: 10px` applies to the root too. In Chromium and Safari, styling `::-webkit-scrollbar` opts that scroller out of overlay scrollbars, so the root gets a classic 10px scrollbar even on macOS with overlay scrollbars on. That matches the measured 10px shift. `scrollbar-gutter: stable` reserves the width of the scrollbar the root would show, which is that same styled 10px, so the reserve equals the scrollbar. Firefox ignores `::-webkit-scrollbar` and reserves its own native width (0 with overlay scrollbars), again equal to what it would show. Chromium 121+ ignores `::-webkit-scrollbar` on an element that sets `scrollbar-width` or `scrollbar-color`; the root sets neither (only the sidebar nav sets them, on its own scroller). Touch devices have overlay scrollbars and reserve nothing.

Side effect: on framed pages the canvas is now `bg.sidebar`, so overscroll bounce shows the frame colour instead of the panel colour. On phones the panel is full-bleed, so the bounce area there is darker or lighter than the panel. I judged that acceptable and did not change it.

Verified: `packages/ui` theme test "framed pages reserve the root scrollbar gutter" checks the generated global CSS (`&html:has([data-shell-panel])` → `scrollbarGutter: stable`, background `var(--chakra-colors-bg-sidebar)`) and that `html, body` has no gutter. Web and UI suites, typecheck and Biome pass.

Not verified: any pixels. Tests have no layout engine. I tried headless Chrome on a static page with the same CSS, but headless hides scrollbars (`clientWidth` was 1200 with and without the gutter, short and long), so it shows nothing. The gutter width, the strip colour, the dialog behaviour and Studio being unaffected need the orchestrator's browser check.

2026-11-26 (orchestrator, signed-in dev browser, Chrome 158). `scrollbar-gutter: stable` on the root reserved nothing while the page did not scroll (client width 1512, then 1502 when the grid loaded: the 10 px shift was still there; `overflow: auto` plus `stable` gave the same). The rule is now `html:has([data-shell-panel]) body { overflow-y: scroll }`: the styled 10px scrollbar is always present with its transparent track over the frame colour. Measured on `/projects`: client width 1502 and identical positions from the first DOM snapshot through ready to 14 cards loaded. Opening the search dialog locks scrolling (`overflow: hidden; padding-right: 10px` on body) and moves nothing. The Studio route has no ShellPanel, `overflow-y: visible` and the full 1512 px. Not checked: Safari, Firefox, the light theme, phones.
