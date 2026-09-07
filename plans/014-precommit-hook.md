# Plan 014: Pre-commit hook (Biome check on staged files)

> **Executor**: follow step by step, verify each step.
> **Drift check**: `git status --short` — uncommitted tree.

## Status
- **Priority**: P3 · **Effort**: S · **Risk**: LOW · **Depends on**: plan 010 (Biome present)
- **Category**: dx · **Planned at**: `05d273d`, 2026-07-06

## Why this matters
There is no pre-commit hook, so lint/format regressions land silently. A
lightweight hook that runs Biome on staged files gives fast local feedback
without a heavy framework. Keep it fast (staged files only) and non-blocking to
install (no mandatory new runtime dependency beyond Biome, which plan 010 added).

## Current state (verified)
- No `.husky/`, no `core.hooksPath`, no `prepare` script (`grep -n "prepare\|husky\|hooksPath" package.json` → none).
- Biome is installed (plan 010): `bunx @biomejs/biome check .` works.
- Package manager: `bun@1.3.6`. Root `package.json` has a `scripts` block.

## Commands
| Purpose | Command | Expected |
|---|---|---|
| Typecheck | `bun run typecheck` | exit 0 |
| Hook dry-run | `bash .husky/pre-commit` (or the hook path) | exit 0 on a clean tree |
| Lint | `bunx @biomejs/biome check .` | exit 0 |

## Scope
**In scope**:
- A git hook script + a `prepare` script wiring it up via `core.hooksPath` (no
  husky dependency required — a committed hooks dir + `git config core.hooksPath`
  set by a `prepare` script is enough and avoids adding a dep).
- Root `package.json` (`prepare` script).

**Out of scope**: lint-staged or any new dependency; changing CI; touching source.

## Steps

### Step 1: Committed hooks directory
Create a `.githooks/` directory at the repo root with a `pre-commit` file
(executable) that runs Biome on the staged files and blocks the commit on error:

```sh
#!/bin/sh
# Pre-commit: run Biome on staged JS/TS files. Fast, staged-only.
staged=$(git diff --cached --name-only --diff-filter=ACMR | grep -E '\.(ts|tsx|js|jsx|json)$' || true)
[ -z "$staged" ] && exit 0
echo "$staged" | xargs bunx @biomejs/biome check --no-errors-on-unmatched || {
  echo "\nBiome found issues in staged files. Fix them or run: bunx @biomejs/biome check --write <files>"
  exit 1
}
```

Make it executable (`chmod +x .githooks/pre-commit`). Note: the working tree has
many pre-existing files that violate parked rules — but because the hook only
checks *staged* files against the *current* `biome.json` (which passes on the
repo today), it won't spuriously block unrelated commits. Confirm the hook exits
0 when no relevant files are staged.

### Step 2: Auto-install via `prepare`
Add to root `package.json` scripts:
```json
"prepare": "git config core.hooksPath .githooks || true"
```
`bun install` runs `prepare`, pointing git at the committed hooks dir. The
`|| true` keeps non-git environments (CI tarballs) from failing install. Do NOT
overwrite the existing `postinstall` (which runs prisma generate) — add
`prepare` alongside it.

**Verify**: run `bun run prepare` then `git config core.hooksPath` → `.githooks`.

### Step 3: Sanity-check the hook
With a clean index, run the hook script directly (`sh .githooks/pre-commit`) →
exit 0. Optionally stage a trivially-clean file and confirm it passes. Do NOT
commit anything.

**Verify**: `sh .githooks/pre-commit` → exit 0.

## Test plan
- No unit tests. Gate: `bun run typecheck` + `bun run test` still green (the hook
  doesn't affect them), and the hook script runs without error on a clean tree.

## Done criteria
- [ ] `.githooks/pre-commit` exists, is executable, runs Biome on staged files
- [ ] Root `package.json` has a `prepare` script setting `core.hooksPath`
- [ ] `git config core.hooksPath` → `.githooks` after `bun run prepare`
- [ ] `bun run typecheck` + `bun run test` still exit 0
- [ ] Only `.githooks/*` and root `package.json` changed (`git status`)

## STOP conditions
- Setting `core.hooksPath` conflicts with an existing hooks setup → report; don't clobber.
- The hook errors on a clean tree (e.g. `bunx` not resolving Biome) → report; leave the script but don't wire `prepare` in a way that breaks `bun install`.

## Maintenance notes
- Contributors must run `bun install` once for the hook to activate (documented behavior of `prepare`).
- Follow-up: add typecheck to the hook if commit latency stays acceptable, and add `lint` to CI once the Biome baseline is stable.
