# Plan 012: Fix accessibility + dead-code lint violations, re-enable rules

> **Executor**: follow step by step, verify each step. STOP if a "fix" would change behavior.
> **Drift check**: `git status --short` — uncommitted tree.

## Status
- **Priority**: P3 · **Effort**: S · **Risk**: LOW · **Depends on**: plan 010 (Biome present)
- **Category**: a11y/tech-debt · **Planned at**: `05d273d`, 2026-07-06

## Why this matters
Plan 010 adopted Biome with several rules parked `off` so it passed on existing
code. Two rule families are worth fixing now (real quality, not cosmetics):
**accessibility** (`a11y/useButtonType`, `a11y/useMediaCaption`) and **dead code**
(`correctness/noUnusedImports`, `noUnusedVariables`, `noUnusedFunctionParameters`).
Fixing them and then re-enabling those specific rules means they stay enforced
going forward.

## Current state (verified — the only files with these violations)
a11y (`useButtonType` / `useMediaCaption`):
- `apps/web/app/(app)/projects/[projectId]/clip-card.tsx`
- `apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/top-bar.tsx`
- `apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/video-preview.tsx`
- `apps/web/app/(app)/upload/_components/video-preview.tsx`
- `apps/web/app/global-error.tsx`

dead code (`noUnusedImports` / `noUnusedVariables` / `noUnusedFunctionParameters`):
- `apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/interactive-caption-overlay.tsx`
- `apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/top-bar.tsx`
- `apps/web/app/(app)/projects/[projectId]/project-events.tsx`
- `apps/web/app/(app)/projects/[projectId]/transcript-panel.tsx`
- `apps/web/app/(marketing)/blog/[slug]/page.tsx`
- `apps/web/app/onboarding/page.tsx`
- `packages/services/src/brand-template.service.ts`
- `packages/services/src/social-oauth.service.ts`

`biome.json` (root) parks these rules under `linter.rules` (set to `"off"` by plan 010).

Get the exact lines with:
`bunx @biomejs/biome lint --only=a11y/useButtonType --only=a11y/useMediaCaption --only=correctness/noUnusedImports --only=correctness/noUnusedVariables --only=correctness/noUnusedFunctionParameters .`

## Commands
| Purpose | Command | Expected |
|---|---|---|
| See violations | (command above) | lists exact locations |
| Typecheck | `bun run typecheck` | exit 0 |
| Tests | `bun run test` | all pass |
| Lint | `bunx @biomejs/biome check .` | exit 0 after fixes + re-enable |

## Scope
**In scope**: the files listed above + `biome.json`.
**Out of scope**: any other parked rule (organizeImports, noNonNullAssertion,
noArrayIndexKey, etc. stay parked — separate follow-up); no behavior changes; no
reformatting.

## Steps

### Step 1: Fix `a11y/useButtonType`
For each flagged `<button>` (or Chakra `Button`/`IconButton` rendering a native
button) missing an explicit type, add `type="button"` (unless it is genuinely a
form submit button — then `type="submit"`). This prevents accidental form
submits. Do it by hand per location; do NOT run `--write`.

**Verify**: `bunx @biomejs/biome lint --only=a11y/useButtonType .` → no diagnostics.

### Step 2: Fix `a11y/useMediaCaption`
For flagged `<audio>`/`<video>` elements: add a `<track kind="captions" />`
where a caption source is available, OR if captions genuinely don't apply (e.g.
a silent preview/scrubbing element or a decorative video with no speech), the
correct fix is to disable the rule *for that element* via the standard Biome
suppression comment (`// biome-ignore lint/a11y/useMediaCaption: <reason>`) with a
clear reason — this is legitimate for media without spoken content. Prefer a real
`<track>` where the app has caption/transcript data; use a justified suppression
only where captions don't apply. Do NOT globally disable the rule.

**Verify**: `bunx @biomejs/biome lint --only=a11y/useMediaCaption .` → no diagnostics (fixed or justifiably suppressed inline).

### Step 3: Remove dead code
For each `noUnusedImports`/`noUnusedVariables`/`noUnusedFunctionParameters`
violation: remove the unused import/variable, or prefix an intentionally-unused
function parameter with `_` (Biome's convention for "intentionally unused").
Read each site to be sure it's truly unused (not used via a side effect, JSX, or
a type-only reference) before deleting — if unsure whether removal changes
behavior, STOP and report that specific site.

**Verify**: `bunx @biomejs/biome lint --only=correctness/noUnusedImports --only=correctness/noUnusedVariables --only=correctness/noUnusedFunctionParameters .` → no diagnostics; `bun run typecheck` → exit 0 (removing a used import would fail typecheck).

### Step 4: Re-enable the fixed rules
In `biome.json`, change these five rules from `"off"` to `"error"` (or remove the
override so `recommended` governs them):
`a11y/useButtonType`, `a11y/useMediaCaption`, `correctness/noUnusedImports`,
`correctness/noUnusedVariables`, `correctness/noUnusedFunctionParameters`.
Leave all other parked rules as-is.

**Verify**: `bunx @biomejs/biome check .` → exit 0 with those rules now active.

## Test plan
- No new tests; these are lint/a11y fixes. Gate: full suite green + `biome check` exit 0 + `typecheck` exit 0.

## Done criteria
- [ ] `bun run typecheck` exits 0; `bun run test` exits 0
- [ ] `bunx @biomejs/biome check .` exits 0
- [ ] The 5 rules are `"error"` (not `"off"`) in `biome.json`
- [ ] `git diff` shows only the listed files + `biome.json` changed, with small targeted edits (no mass reformat)

## STOP conditions
- Removing an "unused" symbol breaks typecheck (it was used) → restore it, report the false positive, keep that rule parked.
- A media element genuinely needs captions but the app has no caption data to wire → use a justified inline suppression and note it; don't invent a track.

## Maintenance notes
- Remaining parked Biome rules (organizeImports, noNonNullAssertion, noArrayIndexKey, useOptionalChain, noExplicitAny, etc.) are the next incremental-adoption targets.
- Reviewer: confirm no `type="submit"` was added to a button that shouldn't submit a form.
