# Plan 035: Replace the unusable mobile Studio layout with a touch-first workspace

> **Decision-gated UX plan**: Approve either the honest desktop-only guard or
> the full touch workspace before implementation. Do not silently remove mobile
> editing or ship a compressed desktop layout.
>
> **2026-07-10 market recommendation**: For the initial podcast/recurring-content
> team ICP, ship Decision A now and instrument mobile Studio entry, device,
> attempted actions, abandonment and support requests. Fund Decision B only when
> usage/interviews show mobile editing materially affects activation or
> retention. A native app is not part of either decision.

## Status

- **Priority**: P1 UX
- **Effort**: L (guard is S)
- **Risk**: MED
- **Depends on**: plan 032
- **Category**: responsive UX, accessibility, editor
- **Planned at**: commit `05d273d`, 2026-07-09, live working tree
- **Recommended next action**: Decision A guard (S), with demand instrumentation

## Evidence and current state

At 390 px the fixed inspector occupies most of the viewport, hides the video,
and competes with the timeline and top bar. Core tools technically exist but
the primary edit/preview loop is not usable. The rest of Narriflow now adapts
well at the same viewport, so Studio is the visible outlier.

Audit evidence: `/tmp/narriflow-audit/04-studio-mobile.png`.

## Decision A: honest guard (fast release safety)

Below the supported editor breakpoint, show the clip thumbnail/status and a
clear “Open Studio on a larger screen” state with a copyable deep link. Keep
safe actions such as download and accept/reject available. Do not load the full
editor or leave controls partially visible. This is preferable to the current
broken layout if touch editing is not a launch promise.

Instrument entry and exit with privacy-safe product events: viewport/device
class, whether the user attempted trim/caption/export, deep-link copy/open,
return on desktop, and explicit “I need mobile editing” feedback. Do not record
media/transcript text or infer demand merely from landing on a mobile URL.

## Decision B: touch-first Studio (recommended product investment)

1. Keep a stable player at the top, a compact scrubbable timeline below it, and
   one sticky action bar. Move inspector tools into an accessible bottom sheet
   with snap points; never cover the whole frame while scrubbing.
2. Turn tool categories into a horizontally reachable rail. The active tool
   opens one focused sheet; back closes the sheet before leaving Studio.
3. Provide frame-accurate nudge buttons and draggable trim handles with minimum
   touch targets, haptics where supported, visible timecodes, undo/redo, and a
   non-gesture keyboard/screen-reader path.
4. Put format/export and secondary actions in a labelled overflow sheet. Keep
   save state and failure/retry visible without stealing player space.
5. Reuse existing tokens/components and edit state. Do not fork a separate
   mobile edit model; desktop and mobile must serialize the same validated
   `studioEdits` contract and render identically.

## Verification

- 320/390/430 px portrait and 667/844 px landscape capture comparisons.
- Edit caption, trim, B-roll/text, undo, save, preview, and export flows.
- VoiceOver/keyboard focus order, reduced motion, 44 px touch targets, no
  clipped dialogs/sheets, and no horizontal page overflow.
- Save failure/offline/reconnect and navigation-loss tests.
- Desktop 1440 px regression capture and full lint/typecheck/tests/build.

## Success criteria

- The player remains at least 60% visible during the core trim/caption loop.
- Every primary action is reachable with one sheet/rail transition.
- No edit is lost when rotating, backgrounding, or navigating.
- Preview and exported render remain contract-identical to desktop.

For Decision A, success instead means no compressed editor is reachable below
the supported breakpoint, safe review/download actions remain available, the
deep link restores the exact clip, and demand instrumentation is trustworthy.

## STOP conditions

- Product has not chosen guard versus touch workspace.
- Mobile controls would write a second edit format.
- Gesture-only actions lack an accessible alternative.
- Visual changes proceed without matching current Studio screenshots/tokens.
