# Plan 006: UI polish — loading states, empty states, accessibility, copy

> **Executor**: follow step by step, verify each step. STOP if excerpts don't match.
> **Drift check**: `git status --short apps/web` — working tree is uncommitted; excerpts are from disk.

## Status
- **Priority**: P2 · **Effort**: M · **Risk**: LOW · **Depends on**: none
- **Category**: ux/polish · **Planned at**: `05d273d`, 2026-07-06

## Why this matters
The product is being sold as professional/modern. Gaps that read as unfinished:
no route-level `loading.tsx` anywhere (slow server-rendered routes flash blank),
a few developer-facing empty-state strings leak internals (e.g. "set
PEXELS_API_KEY"), icon-only buttons lack `aria-label`, and error copy tone is
inconsistent. These are low-risk, high-polish fixes.

## Current state (verified)
- `find apps/web/app -name "loading.tsx"` → empty. Route segments with a `page.tsx`:
  `dashboard`, `projects`, `projects/[projectId]`, `upload`, `autopilot`,
  `settings`, `settings/{social,brand-templates,billing}`.
- Dev-ish empty copy: `apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/tool-panels/broll-panel.tsx` — `<EmptyHint text="Stock B-roll isn't configured yet (set PEXELS_API_KEY)." />` (search `PEXELS_API_KEY`).
- Icon-only buttons without `aria-label` in `studio/_components/video-preview.tsx` (aspect-ratio/layout controls, ~lines 137-206) — some use only `title`.
- A skeleton pattern already exists: `apps/web/app/(app)/projects/_components/projects-skeleton.tsx` (or similar `*-skeleton.tsx`). Reuse its style for new `loading.tsx` files. Confirm with `find apps/web/app -name "*skeleton*"`.

Conventions: Chakra v3 semantic tokens (`bg.panel`, `fg.muted`, `border`); client components need `"use client"` only if they use hooks — `loading.tsx` files are server components and must NOT include `"use client"`.

## Commands
| Purpose | Command | Expected |
|---|---|---|
| Typecheck | `bun run typecheck` | exit 0 |
| Tests | `bun run test` | all pass |
| Loading files | `find apps/web/app -name "loading.tsx"` | lists new files after step 1 |

## Scope
**In scope**:
- Create `loading.tsx` for: `(app)/dashboard`, `(app)/projects`, `(app)/projects/[projectId]`, `(app)/upload`, `(app)/settings/billing`, `(app)/settings/social`, `(app)/settings/brand-templates`, `(app)/autopilot`. (Only where the route does real server data-loading; if a segment renders instantly with no async, skip it and note why.)
- `broll-panel.tsx` — user-friendly empty copy.
- `video-preview.tsx` — add `aria-label` to icon-only controls.
- Optionally a shared `apps/web/app/(app)/_components/route-skeleton.tsx` if it reduces duplication.

**Out of scope**: no logic changes, no new deps, no restyle of existing working components beyond the copy/aria fixes, no studio layout/responsive rework (separate concern).

## Steps

### Step 1: Route loading states
For each in-scope segment, add a `loading.tsx` server component that renders a
lightweight skeleton matching that page's layout (reuse the existing
`*-skeleton.tsx` where one exists, e.g. projects). Keep them simple — a header
placeholder + a few card/row placeholders using Chakra `Box`/`Skeleton` with
`bg.panel`/`border` tokens. Do NOT add `"use client"`.

For `projects/[projectId]/loading.tsx` and `dashboard/loading.tsx`, match the
real page's top-level structure (title bar + panel grid) so there's no layout
shift when content resolves.

**Verify**: `find apps/web/app -name "loading.tsx" | wc -l` ≥ 6; `bun run typecheck` → 0.

### Step 2: Friendly empty/config copy
In `broll-panel.tsx`, replace the `PEXELS_API_KEY` empty-state text with
user-facing copy, e.g. `"Stock B-roll search isn't available on your workspace yet."`
Search the rest of `apps/web/app` for other internal-leaking strings
(`grep -rn "API_KEY\|env\|process.env\|TODO\|FIXME\|lorem" apps/web/app --include=*.tsx`)
and fix any user-visible ones you find (leave code comments alone).

**Verify**: `grep -rn "PEXELS_API_KEY" apps/web/app` → empty.

### Step 3: Accessibility labels
Add `aria-label` to icon-only interactive controls in `video-preview.tsx`
(aspect-ratio buttons, layout toggle). Where a `title` already conveys intent,
add a matching `aria-label`. Do a quick sweep for other icon-only buttons in the
studio tool-panels and add labels where missing (`grep -rn "<IconButton\|aria-label" apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio` to spot gaps).

**Verify**: `bun run typecheck` → 0; the video-preview controls each have an `aria-label`.

## Test plan
Presentation-only; no unit tests. Gate on typecheck + full suite staying green,
plus the greps in the done criteria. If a dev server is available, note manual
confirmation that a slow route shows a skeleton.

## Done criteria
- [ ] `bun run typecheck` exits 0; `bun run test` exits 0
- [ ] `find apps/web/app -name "loading.tsx"` lists ≥6 files
- [ ] `grep -rn "PEXELS_API_KEY" apps/web/app` empty
- [ ] video-preview icon controls have `aria-label`
- [ ] Only in-scope files added/modified (`git status`)

## STOP conditions
- A segment's `page.tsx` is fully static (no async data) — skip its `loading.tsx` and note it; don't force one.
- The existing skeleton component's API is unclear — build a minimal inline skeleton instead and note it.

## Maintenance notes
- New route segments should get a `loading.tsx`. Follow-up: a responsive pass on the studio for tablet widths (deferred).
