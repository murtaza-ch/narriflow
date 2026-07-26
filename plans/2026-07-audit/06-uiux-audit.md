# Narriflow web UI audit — design system, UX, accessibility

Scope: every `.tsx` under `apps/web/app` and `packages/ui/src/components`, against
`packages/ui/src/theme.ts` ("Blueline") and the CLAUDE.md design-language rules.
Read-only audit, no files modified. Every claim below was verified by reading the
cited file/lines, not inferred from filenames.

**Headline finding**: this is an unusually disciplined implementation of its own
design system. Semantic-token usage, `as="button"` semantics, confirm-dialog
gating, empty-state copy, and contrast are consistently correct across dozens of
spot-checked components. The real findings cluster into a short list of specific
leaks (mostly Chakra-default-palette usage bypassing the theme), one missing
design token (overlay/scrim), one structurally unaddressed screen (Studio on
mobile), and one unused-but-exported subsystem (field-level form validation).

---

## 1. Design-system violations

**23 file:line violations across 15 files.** Grouped by file. (A larger set of
hex/rgb hits were investigated and found to be *justified* exceptions — listed
separately at the end of this section so the count above isn't inflated by
false positives.)

### A. Chakra default-palette leaks (bypass the theme entirely)

The theme (`packages/ui/src/theme.ts`) defines exactly five color groups —
`brand`, `accent`, `success`, `warning`, `danger` — and no `gray`. Chakra v3's
`defaultConfig` (merged in via `createSystem(defaultConfig, config)`) still
ships its own built-in `gray` scale and `whiteAlpha`/`blackAlpha` ramps, so any
`colorPalette="gray"` or `whiteAlpha.*` reference silently falls through to
un-audited, un-themed Chakra defaults instead of the graphite `brand.*` scale
theme.ts clearly built for this purpose (`brand.solid/contrast/fg/muted/subtle/
emphasized/focusRing` — defined at theme.ts:296-316, referenced by
**zero** call sites anywhere in the app).

1. `packages/ui/src/components/confirm-dialog.tsx:83` — `colorPalette="gray"` on
   the Cancel button of the **shared `ConfirmDialog`**. Every destructive
   confirmation in the app (delete brand template, disconnect social account,
   delete autopilot rule, etc.) inherits this off-palette Cancel button.
2. `apps/web/app/(app)/settings/social/social-accounts-panel.tsx:228`
3. `apps/web/app/(app)/settings/brand-templates/_components/template-gallery.tsx:301`
4. `apps/web/app/(app)/settings/billing/billing-plans.tsx:284`
5. `apps/web/app/(app)/settings/brand-templates/new/page.tsx:16`
6. `apps/web/app/(app)/settings/brand-templates/[id]/page.tsx:39`
7. `apps/web/app/(app)/settings/brand-templates/[id]/page.tsx:57`
8. `apps/web/app/(app)/autopilot/autopilot-panel.tsx:688`

   (All 8 are the same shape: an `outline` "Cancel"/"Back" button. Fix is
   mechanical — swap `colorPalette="gray"` → `colorPalette="brand"` — but #1
   alone fixes the other seven's worst sibling for free since so much of the
   app routes through `useConfirm()`.)

9. `apps/web/app/(app)/projects/[projectId]/page.tsx:207` — `<Box
   color="whiteAlpha.700">` on the fallback-thumbnail icon. Verified the
   gradients it sits on (`apps/web/app/(app)/projects/_lib/gradient.ts`) are
   all from the sanctioned mode-invariant graphite/ultramarine ramp, so there's
   no live contrast bug — but it's still an unaudited default-Chakra token
   where a Blueline one belongs.
10. `packages/ui/src/components/form.tsx:91` — `color={error ? "red.500" :
    undefined}` inside `FormLabel`. Latent only (this file is unused today —
    see §2.5), but it's a second, different off-palette red baked into
    exported UI-package code.

### B. Hardcoded hex/rgb standing in for chrome (no token exists / token skipped)

11. `packages/ui/src/components/media-well.tsx:39` — `bg="rgba(14, 16, 19,
    0.72)"` (timecode-chip scrim). Comment self-identifies it as a "sanctioned
    mode-invariant exception," which is reasonable — canvas/well content needs
    an alpha-blend no solid token can express — **but the same literal is then
    copy-pasted** rather than factored into a token or export:
12. `apps/web/app/(app)/projects/[projectId]/clip-card.tsx:587` — identical
    `rgba(14, 16, 19, 0.72)`.
13. `apps/web/app/(app)/projects/_components/project-thumbnail.tsx:192` —
    identical `rgba(14, 16, 19, 0.72)` again, third copy.
14. `.../studio/_components/transcript-panel.tsx:92` — `bg="rgba(255,255,255,0.06)"`
    (pause-indicator chip).
15. `.../studio/_components/transcript-panel.tsx:169` —
    `_hover={{ bg: "rgba(255,255,255,0.04)" }}`.
16. `.../studio/_components/transcript-panel.tsx:201` —
    `_hover={{ bg: "rgba(255,255,255,0.06)" }}`.
17. `.../studio/_components/transcript-panel.tsx:422` — `bg="rgba(255,255,255,0.03)"`.
18. `.../studio/_components/tool-panels/broll-panel.tsx:309` — `bg="rgba(0,0,0,0.6)"`.
19. `.../studio/_components/video-preview.tsx:284` — `bg="rgba(0,0,0,0.4)"`
    (layout-blur overlay).
20. `.../studio/_components/keyboard-shortcuts-modal.tsx:63` —
    `<Dialog.Backdrop bg="rgba(0,0,0,0.7)" .../>`.

    Items 11-20 are seven *different* hand-picked alpha values (0.72, 0.7, 0.6,
    0.4, 0.06, 0.04, 0.03) all doing one of two jobs — "scrim behind text on
    footage" or "hover-wash on dark studio chrome" — with no shared token for
    either. See §2 for the duplication angle on the same evidence.

21. `.../studio/_components/keyboard-shortcuts-modal.tsx:76` —
    `boxShadow="0 24px 60px rgba(0,0,0,0.7)"`. The theme already defines
    mode-invariant `shadows.card` / `shadows.cardHover` tokens (flat values,
    not `_light`/`_dark` — they work identically through a `Portal`, unlike
    `_dark`-conditional semantic tokens), and `packages/ui/src/components/
    confirm-dialog.tsx:57` correctly uses `boxShadow="card"`. This modal forks
    its own dramatically heavier shadow instead, diverging from "structure is
    drawn, not lifted."
22. `.../studio/_components/interactive-caption-overlay.tsx:112` —
    `bg="white"` on the crop/resize-handle dot (chrome, not user content).
23. `.../studio/_components/video-preview.tsx:208` — `bg="black"` on the video
    letterbox stage; visually indistinguishable from `studio.canvas`
    (`#0E1013`) but not tokenized.

### Verified NOT violations (investigated, correctly justified — listed so the
count above isn't padded, and so no one "fixes" these later by mistake)

- `apps/web/app/opengraph-image.tsx` — Next.js `ImageResponse`/satori can't
  consume CSS custom properties; hex values are commented as literal mirrors
  of the exact theme tokens.
- `apps/web/app/global-error.tsx` — root error boundary renders with **no**
  React tree/providers per Next.js convention; correctly reproduces the
  documented dark-mode-safe accent contrast (`#5B6CFF` bg / `#0E1013` label).
- All caption/text/brand color arrays and defaults (`template-form.tsx:61-72,
  108-109, 302`; `captions-panel.tsx:362, 569, 614, 621, 666, 673`;
  `text-panel.tsx:11-16, 50, 54, 144-149`; `caption-preset-form.tsx:73-75`;
  `preset-card.tsx:47-52`; `caption-style-engine.tsx:34, 144`;
  `template-gallery.tsx:231`; `template-form.tsx:658`) — all are genuinely
  user-authored caption/brand colors or burn-in-shadow rendering fidelity,
  each already commented "literal by design." Confirmed correct.
- `apps/web/app/(auth)/_components/oauth-buttons.tsx:19-55` — third-party OAuth
  brand mark colors (Google/Facebook/Microsoft); must stay literal.
- `.../studio/_components/timeline.tsx:125,127,203-204` — Canvas 2D
  `ctx.fillStyle` requires literal color strings; the wrapping div's gradient
  is commented as a literal mirror of `studio.subtle`/`studio.surface`.
- `.../studio/_components/tool-panels/captions-panel.tsx:114-131` and
  `video-preview.tsx:146-182` — `Portal`-rendered content correctly uses
  literal `studio.*` tokens rather than `_dark`/`_light` conditional ones.
  This is architecturally necessary: `StudioLayout`
  (`.../studio/layout.tsx:11-21`) forces dark mode via a `className="dark"` Box
  wrapper, but Chakra's `Portal` teleports to `document.body`, **outside**
  that wrapper — so anything portaled must use mode-invariant `studio.*`
  tokens or it would flip to the user's real light/dark preference. Confirmed
  via `packages/ui/src/components/color-mode.tsx` (next-themes sets the
  `.dark`/`.light` class that drives `_dark`/`_light`).
- `fg.disabled` (theme.ts:430-432; fails contrast at 2.89:1 light / 3.30:1
  dark) — checked all 15 call sites; every one is gated on a genuine
  `disabled`/`_disabled` state, which WCAG 1.4.3 exempts. Correct usage.
- `danger.solid` (fails AA for *text* at 4.42:1 dark-on-panel, self-documented
  in theme.ts:383-384) — grepped for any `color="danger.solid"` text usage:
  zero. Always `danger.fg` for text, `danger.solid` reserved for
  backgrounds/stripes (3:1 UI threshold, which it passes). Correct.

---

## 2. Duplicated/forked utilities

1. **`apps/web/app/(app)/projects/_lib/format.ts` deletion is safe.** Grepped
   every `.tsx`/`.ts` under `apps/web` for `_lib/format` imports: zero hits.
   `apps/web/lib/format.ts` is the sole formatter and is imported in 18 files.
   Nothing references the deleted file. No action needed — flagging as
   verified-clean per the brief's request.

2. **No shared fetch/error-handling utility.** 16 client components each
   hand-roll `fetch()` + manual `res.json().catch(() => ({}))` + status
   checking + `toaster.create`, with no common wrapper in `apps/web/lib`
   (which has `env.ts`, `format.ts`, `project-state.ts`, `safe-redirect.ts`,
   `utils.ts`, `workflow-stream.ts` — no `api.ts`/`fetcher.ts`). Sites:
   `settings/social/social-accounts-panel.tsx`,
   `settings/brand-templates/_components/template-form.tsx`,
   `settings/billing/billing-plans.tsx`,
   `projects/[projectId]/dubbing-panel.tsx`,
   `projects/[projectId]/content-suite-panel.tsx`,
   `projects/[projectId]/clip-card.tsx`,
   `projects/[projectId]/social-scheduling-panel.tsx`,
   `projects/[projectId]/render-clips-button.tsx`,
   `.../studio/_components/studio-shell.tsx`,
   `.../studio/_components/tool-panels/captions-panel.tsx`,
   `.../studio/_components/tool-panels/broll-panel.tsx`,
   `.../studio/_components/tool-panels/brand-template-panel.tsx`,
   `projects/_components/projects-explorer.tsx`,
   `projects/[projectId]/clips/[clipId]/edit/caption-preset-form.tsx`,
   `autopilot/autopilot-panel.tsx`, `upload/_components/upload-shell.tsx`.
   The error-*message* layer is well centralized (see below) — it's only the
   fetch/parse/try-catch plumbing that's copy-pasted 16 times.

3. **Message-mapping is properly centralized (not a duplication problem).**
   `packages/validators/src/error-messages.ts:92` exports `userErrorMessage()`,
   consumed by 8 files consistently; auth flows use a parallel
   `getClerkErrorMessage()` + shared `apps/web/app/(auth)/_components/
   form-error.tsx` (`role="alert"`, danger tokens). Good pattern — noted so it
   isn't mistaken for a gap.

4. **`StatusBadge` is correctly the single source of truth.** Used verbatim in
   `transcript-panel.tsx`, `project-events.tsx`, `social-accounts-panel.tsx`,
   `page.tsx`, `project-row.tsx`, `project-card.tsx`. No forked badge/status
   color-mapping logic found anywhere (`projects-skeleton.tsx` only mimics its
   *shape* in a comment for its loading placeholder — not a duplication).

5. **A fully-built, unused accessible form system.**
   `packages/ui/src/components/form.tsx` implements a complete react-hook-form
   ↔ Chakra `Field` integration (`FormField`/`FormItem`/`FormLabel`/
   `FormControl`/`FormMessage`, wired for `aria-invalid` + `aria-describedby`)
   and is re-exported from the package's public entry point
   (`packages/ui/src/index.ts:46`). Grepped the whole app: `react-hook-form` is
   imported **zero** times in `apps/web`, and `Field.Root`/`Field.ErrorText`
   are used **zero** times. Every real form (`template-form.tsx`,
   `content-suite-panel.tsx`, `render-clips-button.tsx`, `broll-panel.tsx`,
   `autopilot-panel.tsx`, plus all four Clerk auth pages) instead hand-rolls a
   flat `useState<string | null>` error banner. This is dead/parallel-effort
   code carrying a latent violation (`red.500`, item A10 above) — see §5 for
   the accessibility angle and the top-10 list for the recommended action
   (adopt or delete).

6. **Ad hoc overlay/scrim rgba values** (§1 items 11-20) are as much a
   duplication problem as a token problem: three files independently copy the
   exact string `rgba(14, 16, 19, 0.72)`, and four more files each invent a
   slightly different alpha-black/alpha-white wash for what is conceptually
   the same "scrim" or "hover tint on dark chrome" concept.

7. **Not duplicated (verified, ruled out):** `apps/web/app/(app)/upload/
   _components/video-preview.tsx` and `.../studio/_components/video-preview.tsx`
   share a name but are genuinely different components (upload-source preview
   for YouTube/RSS/link cards vs. the full studio editing canvas with
   aspect-ratio switching and caption overlays) — diffed both files, no
   meaningful overlap to extract.

---

## 3. UX gaps per screen

**Strengths worth naming (so the gaps below read as gaps, not a general
critique):**
- Empty states are present and well-written across all 13 list-type views
  checked (dashboard, projects, transcript, content suite, analytics, social
  scheduling, dubbing, autopilot, brand templates, blog). Copy consistently
  explains what to do next (e.g. transcript-panel.tsx:20-21: "Start
  transcription once ingest is ready. Speaker labels and subtitle exports
  arrive with it.").
- `window.confirm` is fully migrated away from (zero remaining call sites);
  destructive actions (disconnect social account —
  `social-accounts-panel.tsx:123-132`; delete brand template —
  `template-gallery.tsx`; delete autopilot rule — `autopilot-panel.tsx`) are
  correctly gated behind the shared `useConfirm()`/`ConfirmDialog`.
  In-session/reversible edits (studio timeline segment delete, text-layer
  remove) skip the modal but are covered by real Undo/Redo
  (`keyboard-shortcuts-modal.tsx:20-21`) — a reasonable, deliberate tradeoff,
  not an oversight.
- The "one solid button per view" rule is enforced with real discipline, in
  places with explicit comments confirming it's deliberate: `billing-plans.tsx:264`
  (`variant={recommended ? "solid" : "outline"}` — only the recommended tier
  is solid), `autopilot-panel.tsx:355-356` ("Header owns the solid CTA — this
  is a quiet accent link"), `upload/_components/upload-shell.tsx:1095-1096`
  ("attached solid Continue is this view's one solid button"). Sampled 9
  complex screens (autopilot, dubbing, social-scheduling,
  advanced-clip-settings, template-form, upload-shell, content-suite-panel,
  render-clips-button, clip-card) — no violations found.

**Gaps:**
- `apps/web/app/(app)/settings` (root) has no `loading.tsx`/`error.tsx`, but
  it's a pure redirect (`page.tsx:3-4` → `/settings/brand-templates`) so this
  is a non-issue.
- `apps/web/app/(app)/settings/brand-templates/new` has no `loading.tsx`.
  Minor — it's a create form, not a data-heavy fetch.
- Only `projects/[projectId]` and the studio have route-scoped `error.tsx`;
  every other route (dashboard, autopilot, upload, settings/billing,
  settings/brand-templates, settings/social, projects list, clip edit) falls
  back to the shared `apps/web/app/(app)/error.tsx`. That fallback is
  well-built (preserves the sidebar/layout since it only replaces the
  segment, offers "Try again" + a dashboard link, uses the blueprint-grid
  empty-state treatment) — so this is a minor prioritization note, not a real
  gap.
- **No field-level validation feedback anywhere in the app's own forms** (see
  §2.5). `template-form.tsx`, the autopilot rule dialog
  (`autopilot-panel.tsx:673-679`), and others show one flat error string per
  form rather than marking the specific invalid field. For single-field flows
  (paste-link, sign-in) this is invisible; for multi-field forms it means a
  user (especially a screen-reader user) isn't told *which* field to fix
  beyond what happens to be in the message text.
- `.../studio/_components/tool-panels/text-panel.tsx:104-118` — the
  preset-preview row is a plain `Flex` with `onClick`/`cursor="pointer"` and
  no `role`/`tabIndex`/key handler, so the "preview this preset" affordance is
  mouse-only (the actual "add to canvas" action is a real nested button and
  works fine via keyboard — only the preview-select convenience is
  inaccessible). This is the **only** instance of this pattern found after
  checking ~15 other selectable-card/row components, all of which correctly
  use `as="button"`.
- ARIA tabs (`text-panel.tsx:71-99` presets/custom toggle,
  `tool-sidebar.tsx:139-178` tool tabs) use real `<button>`s with
  `role="tab"`/`aria-selected` so Tab+Enter works, but skip the WAI-ARIA APG
  roving-tabindex arrow-key pattern and `aria-controls`/panel-`id` pairing.
  Nice-to-have, not a blocker.

---

## 4. Responsive/mobile

**Verified solid** (read full layout code, not just breakpoint-prop grep
counts): `dashboard-view.tsx` (`p={{base:6,md:10}}`, `fontSize={{base:"28px",
md:"40px"}}`, `SimpleGrid columns={{base:1,sm:2,lg:3,"2xl":4}}`),
`projects-explorer.tsx`/`project-card.tsx` grid, `template-gallery.tsx:81-86`
(`templateColumns={{base:"repeat(2,1fr)", md:"repeat(3,1fr)",
lg:"repeat(4,1fr)"}}`), `billing-plans.tsx` plan grid
(`templateColumns={{base:"1fr", md:...}}`), project detail page
(`direction={{base:"column", md:"row"}}` at line 393). The
`Sidebar`/`MobileNav` split (`_components/sidebar.tsx:62`
`display={{base:"none", lg:"flex"}}` / `_components/mobile-nav.tsx:71`
`display={{base:"block", lg:"none"}}`) is clean, closes the drawer on route
change, and duplicates the usage meter sensibly since mobile has nowhere else
to put it.

**The one real break: the Studio editor is not usable below ~900-1000px, and
there is no graceful message.**

- `.../studio/_components/studio-shell.tsx:638-654` lays out
  `TranscriptPanel` + `VideoPreview` + `ToolSidebar` in a single non-wrapping
  `Flex` row (default `direction="row"`), with no breakpoint-based
  `direction` change and no panel-hiding at any width.
- `transcript-panel.tsx:324` — `w={{base:"240px", md:"280px", xl:"300px"}}`
  and `tool-sidebar.tsx:120` — `w={{base:"260px", md:"300px"}}` are both
  fixed-pixel *even at the smallest breakpoint*. On a 375-428px phone, the two
  side panels alone (500-560px combined) already exceed the viewport before
  `VideoPreview`'s `flex="1"` gets any room at all.
- `.../studio/layout.tsx:11-21` forces `position="fixed" inset="0"` (a
  full-viewport takeover) with no size gate.
- Grepped the entire 16-file studio directory for `useMediaQuery`,
  `matchMedia`, `isMobile`, `innerWidth`, `useBreakpoint`: **zero matches.**
  There is no mobile detection anywhere in the Studio, and no "open this on a
  larger screen" message — a user landing here on a phone gets a silently
  broken, horizontally-crushed layout instead of a clear explanation.

**Out of strict scope, flagged for hygiene:** the 7 "landing lab" variant
pages (`app/(landing)/lp/{blueprint,studio,pop,signal,volt,system,atelier}/*
-client.tsx` + `variant-dial.tsx`) are unlinked from the rest of the product —
grepped for any `"/lp/"` reference outside the `(landing)` route group itself:
zero. They're reachable only by direct URL, consistent with the "landing lab"
A/B-test framing already in project memory. They also carry the large
majority of this repo's hex/rgb literals (~46 hex + ~73 rgb across the 8
files) since they're independent one-off marketing designs, not meant to
inherit Blueline. Recommend either an explicit "excluded from design-system
audits" note or pruning the variants that lost the A/B test, since as-is they
would dominate a naive grep-based violation count for anyone auditing this
repo without checking linkage first.

---

## 5. Accessibility (WCAG 2.1 AA)

### Contrast — computed from theme.ts hex values (WCAG relative-luminance formula)

| Pair | Ratio | Verdict |
|---|---|---|
| light `fg.muted` #585E69 / `bg` #FBFBFC | 6.31:1 | Pass (normal text) |
| light `fg.subtle` #666C76 / `bg` | 5.11:1 | Pass |
| light `fg.disabled` #8F96A0 / `bg` | **2.89:1** | Fails 3:1 — but WCAG exempts disabled controls; verified all 15 use-sites are correctly gated on a disabled state |
| light `accent.fg`(=600) #2438E8 / `bg` | 7.24:1 | Pass |
| light `border.control` #818893 / `bg`,`bg.panel` | 3.46:1 / 3.57:1 | Pass (3:1 non-text threshold) |
| dark `fg.muted` #9AA3B0 / `bg` #0E1013 | 7.48:1 | Pass |
| dark `fg.disabled` #5E6675 / `bg` | 3.30:1 | Same exemption as above |
| dark `danger.solid`(=500) #E5484D / `bg.panel` #171B21 | **4.42:1** | Fails 4.5:1 for *text* — self-documented in theme.ts:383-384; verified `danger.solid` is never used as a text color anywhere (only `danger.fg`, 6.52:1, which passes) |
| dark `accent.solid` #5B6CFF / white | 4.17:1 | Fails, exactly as the theme's own comment predicts — confirms the team correctly avoids this combination |
| dark `accent.solid` #5B6CFF / `accent.contrast` #0E1013 | 4.57:1 | Pass — confirms the chosen dark-label-on-fill button contrast is correct |
| studio `fgSubtle` #828D9C / `studio.raised` #242A33 | 4.29:1 | Pass (UI/large-text threshold only — matches theme.ts's own "fgSubtle is only legible on canvas/subtle/surface" comment) |
| studio `borderControl` #606B7D / `studio.subtle` #14171C | 3.33:1 | Pass (3:1 non-text) |

No live contrast failures found beyond the two the theme itself already
documents and correctly routes around.

### Structural checks

- **Semantic interactivity is consistently correct.** Spot-checked ~15
  clickable card/row/tab components (`preset-card.tsx`, `template-gallery.tsx`
  radio row, `broll-panel.tsx` result grid, `tool-sidebar.tsx` tool tabs,
  `mobile-nav.tsx` menu/close/theme buttons, `theme-toggle.tsx`) — all
  correctly use `as="button"`/`chakra.button` plus the right ARIA role
  (`role="radio"` + `aria-checked`, `role="tab"` + `aria-selected`,
  `aria-pressed`, `aria-expanded`). **One exception found**:
  `text-panel.tsx:104-118` (see §3).
- **Images**: every `<img>`/`next/image` use has appropriate `alt` — either
  descriptive (`project-thumbnail.tsx:103`, `project/[projectId]/page.tsx:188`,
  `account-menu.tsx:67`, `social-accounts-panel.tsx:266`,
  `upload/_components/video-preview.tsx:284`) or correctly empty (`broll-panel.tsx:292`,
  where the parent `as="button"` already carries `aria-label` at line 277).
- **`aria-live`** is present at the right async-status spots:
  `.../studio/_components/top-bar.tsx:56,67` (render/save status),
  `upload/_components/upload-shell.tsx:194` (progress), `filter-toolbar.tsx:126`,
  `sso-callback/page.tsx:64`, `sign-up/continue/page.tsx:42`,
  `(auth)/_components/resend-button.tsx:74`.
- **Icon-only buttons**: only 3 raw `IconButton` uses in the whole app
  (`template-gallery.tsx`, `advanced-clip-settings.tsx`, `autopilot-panel.tsx`),
  all labeled. Every hand-built icon-only `as="button"` control checked
  carries `aria-label`.
- **Reduced motion**: handled globally — `theme.ts:57-65` zeroes all
  animation/transition durations under `prefers-reduced-motion: reduce`
  site-wide, and `preset-card.tsx:34,39` additionally guards a JS `setInterval`
  loop with `useReducedMotion()`. No gaps found.
- **Focus visibility**: a global `*:focus-visible` ring is defined
  (`theme.ts:33-38`). The few places that strip the native outline
  (`transcript-panel.tsx:175,229` contentEditable blocks;
  `broll-panel.tsx`/`music-panel.tsx` restyled inputs) all compensate — the
  restyled inputs via `_focusWithin` border-color changes on their wrapper
  (`broll-panel.tsx:140,178`; `music-panel.tsx:51`), the contentEditable block
  via a `boxShadow` ring the moment `isEditing` flips true
  (`transcript-panel.tsx:237`). No dead-end unfocusable states found.
- **Heading order**: `packages/ui/src/components/page-header.tsx:49` renders
  exactly one `<Heading as="h1">` per page via the shared `PageHeader`; pages
  that build a custom hero instead (`dashboard-view.tsx:60`, `error.tsx:44`,
  `not-found.tsx:29`) also use exactly one `h1` each, never both. No duplicate
  or skipped-level `h1`s found in the app pages checked. One small
  inconsistency: `apps/web/app/components/auth-shell.tsx:230` uses `<Text
  as="h1">` rather than the `Heading` component — same DOM result, just an
  odd component choice (P2 nit, not a semantics bug).
- **Gap**: no field-level `aria-invalid`/`aria-describedby` anywhere in the
  app's real forms (see §2.5, §3) — the accessible plumbing exists in
  `packages/ui/src/components/form.tsx` but nothing consumes it.

---

## 6. Copy/microcopy

- Empty-state copy is a genuine strength — sampled 15 title/description pairs
  across dashboard, projects, transcript, content suite, analytics, social
  scheduling, dubbing, autopilot and brand templates. All are specific and
  forward-looking, e.g. `social-scheduling-panel.tsx:433-434`: "Nothing
  scheduled yet" / "Queue a rendered clip to a connected account — scheduled
  and published posts will be listed here"; `dubbing-panel.tsx:401-402`: "No
  dubs yet" / "Translate your best clip into another language — narration is
  generated over the finished render." No jargon, no dead ends.
  `billing-plans.tsx:112-115`'s not-configured message is a good example of
  honest, non-alarming copy for an admin edge case.
- Error copy is centralized and consistent (`userErrorMessage()` for
  API/pipeline errors, `getClerkErrorMessage()` for auth,
  `apps/web/app/(auth)/_components/form-error.tsx` rendering both the same
  way) — no raw stack traces or technical codes leaking to users in any
  sampled call site.
- The one recurring copy/UX weak spot is structural, not wording: because
  forms only surface one flat error string (§2.5/§3/§5), a validation failure
  on a multi-field form can only be as specific as that single sentence lets
  it be — there's no per-field "this one" pointer to back it up.

---

## Priority summary

**P0 (broken/inaccessible) — 1**
- Studio editor is non-functional on phone/small-tablet viewports with zero
  size gating or fallback messaging (`studio-shell.tsx:638-654`,
  `transcript-panel.tsx:324`, `tool-sidebar.tsx:120`, `layout.tsx:11-21`).

**P1 (clearly worse than competitors) — 4**
- `colorPalette="gray"` in the shared `ConfirmDialog` (and 7 other sites) pulls
  every destructive-confirmation Cancel button off the theme's own neutral
  scale (§1 A1-A8).
- No shared fetch/error-handling utility — 16 components hand-roll the same
  fetch/parse/toast boilerplate (§2.2).
- No field-level form validation feedback anywhere, despite a complete,
  exported, unused react-hook-form `Field` system sitting in
  `packages/ui/src/components/form.tsx` (§2.5, §3, §5).
- Seven ad hoc, undifferentiated overlay/scrim rgba values with no shared
  token, three of them identical literals copy-pasted across files (§1
  B11-B20, §2.6).

**P2 (polish) — remainder**
- `whiteAlpha.700` (§1 A9), latent `red.500` in dead code (§1 A10).
- `keyboard-shortcuts-modal.tsx` forking its own backdrop/shadow instead of
  the established `card`/`cardHover` tokens (§1 B20-B21).
- Raw `"white"`/`"black"` on two studio chrome elements (§1 B22-B23).
- One non-semantic clickable row in `text-panel.tsx` (§3, §5).
- ARIA-tabs roving-tabindex/`aria-controls` nicety (§3, §5).
- `Text as="h1"` vs `Heading as="h1"` inconsistency in `auth-shell.tsx` (§5).
- Landing-lab pages' design-system exemption isn't written down anywhere
  (§4).

---

## Top 10 highest-leverage fixes

1. **`packages/ui/src/components/confirm-dialog.tsx:83`** — change
   `colorPalette="gray"` → `colorPalette="brand"`. One line, fixes the Cancel
   button on every destructive confirmation app-wide.
2. **Gate the Studio for small viewports.** Add a breakpoint/media-query check
   in `studio-shell.tsx` (or `layout.tsx`) that swaps the whole editor for an
   "Open this clip on a larger screen" message below ~900px — matches the
   quality bar the rest of the app already clears.
3. **Add a `studio.scrim`/overlay semantic token** (and a `bg.scrim` for the
   light-mode-facing media-well case) and refactor the 7 ad hoc rgba call
   sites (§1 B11-B20) onto it. Kills three copy-pasted literals and four
   one-off siblings in one pass.
4. **Fix the other 7 `colorPalette="gray"` sites** (§1 A2-A8) the same way as
   #1, now that the shared component is fixed first.
5. **Build one `apiFetch()`/`useApiAction()` helper** in `apps/web/lib` and
   migrate the 16 hand-rolled fetch blocks (§2.2) onto it — cuts duplicated
   error-shape-parsing code and reduces the chance a future call site silently
   swallows a failure.
6. **Decide the fate of `packages/ui/src/components/form.tsx`.** Either wire
   it into the app's real multi-field forms (`template-form.tsx`,
   `autopilot-panel.tsx`'s rule dialog) for proper field-level
   `aria-invalid`/`aria-describedby`, or delete it — right now it's exported
   dead code with its own latent `red.500` violation.
7. **`projects/[projectId]/page.tsx:207`** — swap `whiteAlpha.700` for a
   Blueline-sanctioned value.
8. **`keyboard-shortcuts-modal.tsx:63,76`** — drop the custom
   `Dialog.Backdrop` bg override (match `ConfirmDialog`'s default) and replace
   the one-off `boxShadow` with `"cardHover"` (already mode-invariant, so it
   survives the Portal correctly).
9. **`text-panel.tsx:104-118`** — add `as="button"` (or `role="button"` +
   `tabIndex={0}` + Enter/Space handling) to the preset-preview row to match
   every other selectable card/row in the codebase.
10. **Write down the landing-lab pages' scope exemption** (a short comment/
    README in `app/(landing)/lp/`) so future audits don't need to
    re-discover via grep that these 7 unlinked variant pages are intentionally
    outside Blueline, and prune the ones that lost their A/B test.
