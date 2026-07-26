# Plan 022: Make the project workspace usable on narrow screens and name every meter

> **Executor instructions**: Follow this plan step by step. Run every
> verification command. Touch only the listed files. Stop on any STOP
> condition. The reviewer maintains `plans/README.md`.
>
> **Working-tree override**: the uncommitted working tree is the current
> product. Work in it directly. Do not branch, stage, commit, push, or revert
> unrelated changes.
>
> **Drift check**:
> `git diff --stat 05d273d..HEAD -- 'apps/web/app/(app)/projects/[projectId]/page.tsx' apps/web/app/layout.tsx packages/ui/src/components/meter.tsx packages/ui/src/components/stat-band.tsx apps/web/app/'(app)'/_components/sidebar.tsx apps/web/app/'(app)'/dashboard/page.tsx`
> Also compare the live code with the excerpts below because all scoped files
> contain intentional uncommitted product work.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: plan 021 (dependency install must be stable)
- **Category**: bug, accessibility, ux
- **Planned at**: commit `05d273d`, 2026-07-09, live working tree
- **Result**: REOPENED 2026-07-10 — the tab rail/shared forwarding fixes remain
  verified; the upload progress caller is unnamed and lacks a focused a11y test.

## Why this matters

At a verified 390×844 viewport, the seven project workspace tab labels shrink
into one overlapping string, so Clips, Transcript, Repurpose, Dubbing, Publish,
Analytics, and Activity are not reliably readable or tappable. The shared meter
also puts an `aria-label` passed by callers on a wrapper instead of the element
with `role="meter"`, leaving screen-reader users without a usable name. The
root layout additionally triggers Next.js's documented smooth-scroll warning
on route transitions.

## Current state and evidence

- Accepted before screenshot:
  `/tmp/narriflow-audit/06-repurpose-mobile.png` at 390×844. It visibly shows
  the seven labels overlapping across one line.
- `apps/web/app/(app)/projects/[projectId]/page.tsx:428-471` puts
  `overflowX="auto"` on `Tabs.List`, but every `Tabs.Trigger` may shrink. The
  total label width is compressed instead of becoming a scrollable tab rail.
- Preserve Chakra `Tabs.Root/List/Trigger` semantics and the existing Blueline
  line indicator. Do not replace tabs with a bespoke navigation system.
- `packages/ui/src/components/meter.tsx:21-53` spreads arbitrary `BoxProps`
  onto the outer wrapper, while the inner `role="meter"` uses only
  `aria-label={label}`. Dashboard passes `aria-label="Monthly processing
  minutes used"`, which lands on the wrong node. Sidebar supplies no label.
- `apps/web/app/layout.tsx:60-64` has smooth scrolling in global styles but no
  `data-scroll-behavior="smooth"` marker on `<html>`, producing a Next 16.2
  development warning during `/` → `/pricing` navigation.

## Scope

Only modify:

- `apps/web/app/(app)/projects/[projectId]/page.tsx`
- `packages/ui/src/components/meter.tsx`
- `packages/ui/src/components/stat-band.tsx`
- `apps/web/app/(app)/_components/sidebar.tsx`
- `apps/web/app/layout.tsx`

Out of scope:

- The clip studio's separate responsive redesign. The audit shows its fixed
  inspector/timeline is not mobile-ready; that is a larger explicit direction.
- Changing tab names, order, route behavior, or mounted Activity/SSE semantics.
- Changing colors, fonts, spacing system, or design language.
- Adding a new component-test framework in this plan.

## Commands

| Purpose | Command | Expected |
|---|---|---|
| Format/lint | `bun run lint:biome` | exit 0 |
| Typecheck | `bun run typecheck` | exit 0 |
| Tests | `bun run test` | exit 0 |
| Build | `bun run build` | exit 0 |

## Steps

### Step 1: Turn the project tabs into a real scrollable rail

Keep the Chakra tab primitives and existing indicator. Ensure the list itself
is constrained to the content width and each trigger has `flexShrink="0"` and
`whiteSpace="nowrap"` so the labels never compress. Keep horizontal overflow
on the rail and choose an unobtrusive but discoverable scrollbar behavior that
matches the existing design. Do not add a visual asset or invent new styling.

At 390px, the current tab must remain in view after selecting it; if Chakra
does not do this automatically, use the smallest client-side scroll-into-view
behavior that respects reduced motion. Do not convert this server page into a
client component just for scrolling; prefer native overflow behavior.

**Verify**:

- At 390×844 on the existing project URL, labels do not overlap; at least the
  visible subset has normal word spacing and the remaining tabs are reachable
  by horizontal scroll.
- DOM snapshot still exposes one `tablist`, seven uniquely named tabs, and one
  selected tab.
- Desktop 1440px retains the existing single-line rail without unwanted wrap.

### Step 2: Forward accessible names to the meter element

Make the meter's accessible-name contract explicit. Support `aria-label` and
`aria-labelledby` as component props, remove those props before spreading the
rest onto the wrapper, and place them on the inner element with `role="meter"`.
When neither is supplied, the visible `label` may remain the fallback accessible
name. Add a meaningful label to the sidebar usage meter (for example,
`"Monthly processing minutes used"`). `StatBand.Item` already has a visible
label; derive the optional meter's accessible name from it. Preserve value
clamping and appearance.

**Verify**:

- The dashboard DOM snapshot exposes a named monthly-usage meter.
- The sidebar usage meter is also named when the desktop sidebar is present.
- Dashboard/settings stat-band meters are named from their visible stat label.
- `rg -n 'role="meter"|aria-label|aria-labelledby' packages/ui/src/components/meter.tsx`
  shows accessible props on the role element, not only the wrapper.

### Step 3: Declare smooth-scroll route-transition behavior

Add Next.js's `data-scroll-behavior="smooth"` marker to the root `<html>`
element because the existing CSS deliberately uses smooth scrolling. Do not
remove smooth scrolling or alter global CSS.

**Verify**:

- Navigate from `/` to `/pricing` in development; the warning about
  `scroll-behavior: smooth` and missing `data-scroll-behavior` no longer appears.

### Step 4: Run release gates and inspect scope

Run lint, typecheck, tests, and build. Inspect the complete diff and visually
compare the same 390×844 project state with the accepted before screenshot.

## Done criteria

- [ ] Project tab labels never overlap at 390×844 and remain horizontally
  reachable.
- [ ] Tab semantics and desktop layout are preserved.
- [ ] Every non-decorative meter has a programmatic accessible name on the
  `role="meter"` node.
- [ ] The Next smooth-scroll warning is gone.
- [ ] Lint, typecheck, tests, and production build pass.
- [ ] Only the five scoped files were changed by this executor.

## STOP conditions

Stop and report if:

- Fixing the rail requires converting the server page into a client component.
- Chakra tab selection/keyboard semantics break.
- The meter fix requires a breaking change to callers outside the scoped files.
- The visual fix requires changing global design tokens or unrelated layout.
- A verification fails twice after one reasonable correction.

## Maintenance notes

- A proper mobile studio inspector/bottom sheet remains a separately approved
  direction; do not hide that gap behind this small tab fix.
- Future tab additions must use the same non-shrinking rail contract.

## Reopened accessibility follow-up (2026-07-10)

The shared `Meter` now forwards explicit accessible names correctly, but the
upload progress caller renders `<Meter value={progress} />` without `label`,
`aria-label`, or `aria-labelledby`
(`apps/web/app/(app)/upload/_components/upload-shell.tsx:219-228`). The adjacent
percentage text does not name the element with `role="meter"`.

- Pass an explicit `aria-label="Upload progress"` or associate the adjacent
  visible status with `aria-labelledby`.
- Add a focused rendered accessibility test asserting one meter named “Upload
  progress” with the current value.
- Re-run narrow upload/error/progress browser states and full release gates.

Plan status is **REOPENED** until this caller and test are complete; the tab
rail, shared meter forwarding, sidebar/dashboard labels and smooth-scroll fix
remain verified.
