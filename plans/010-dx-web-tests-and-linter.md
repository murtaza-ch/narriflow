# Plan 010: Web test harness + Biome linter

> **Executor**: follow step by step, verify each step. STOP conditions override improvisation.
> **Drift check**: `git status --short` — uncommitted tree; excerpts from disk.

## Status
- **Priority**: P3 · **Effort**: M · **Risk**: LOW · **Depends on**: none
- **Category**: dx/tests · **Planned at**: `05d273d`, 2026-07-06

## Why this matters
Two DX gaps: (1) `apps/web`'s `test` script is a no-op echo even though a real
test file exists (`content-pack-form.test.ts`), so it never runs in `bun run
test` or CI; (2) there is no linter/formatter at all (every package's `lint`
script is `echo '... no-op'`), so style/quality drift is uncaught. Both are cheap
to close and make the repo look and behave like a maintained product.

## Current state (verified)
- `apps/web/package.json` — `"test": "echo 'web test: no-op'"`, `"lint": "echo 'web lint: no-op'"`.
- Existing web test: `apps/web/app/(app)/upload/_lib/content-pack-form.test.ts`.
- `packages/services` and `packages/validators` already use `"test": "bun test"` (the working pattern to copy).
- No `biome.json`, no `.eslintrc`, no `@biomejs/biome` in root `package.json` (`grep -iE "biome|eslint|prettier" package.json` → none).
- Every `lint` script across apps/* and packages/* is `echo '... no-op'`.
- Root scripts run via turbo: `bun run test`, `bun run lint`, `bun run typecheck`.
- Package manager: `bun@1.3.6`.

## Commands
| Purpose | Command | Expected |
|---|---|---|
| Typecheck | `bun run typecheck` | exit 0 |
| Tests | `bun run test` | all pass (now incl. web) |
| Lint | `bun run lint` | exit 0 (after Biome config is tuned to pass on current code) |
| Biome direct | `bunx @biomejs/biome check .` | exit 0 after config tuning |

## Scope
**In scope**:
- `apps/web/package.json` — set `test` to `bun test` (and, part 2, `lint` to run Biome on this package or defer to root).
- Root `package.json` — add `@biomejs/biome` devDependency and a root `lint`/`format` script if that's the cleanest wiring (see Step 3).
- Create `biome.json` at repo root.
- Optionally set each package's `lint` script to invoke Biome (only if it keeps `bun run lint` green — see Step 3).

**Out of scope**:
- Do NOT reformat the codebase. No `biome check --write`, no `--fix` mass edits. This plan adopts a linter with a **baseline config that passes on the code as-is**; it must not produce a large source diff.
- No pre-commit hook framework in this plan (follow-up).
- No changes to source `.ts`/`.tsx` files.

## Steps

### Step 1: Wire the web test script
In `apps/web/package.json`, change `"test": "echo 'web test: no-op'"` to
`"test": "bun test"` (match `packages/services`). Run `bun test` in `apps/web`
to confirm `content-pack-form.test.ts` passes. If it fails for a pre-existing
reason unrelated to this change, STOP and report (do not fix app logic here).

**Verify**: `bun run test` → all pass; the `@narriflow/web` task now runs real tests (not the echo). `grep '"test"' apps/web/package.json` → `bun test`.

### Step 2: Add Biome (pinned) as a dev dependency
Add `@biomejs/biome` to the root `package.json` `devDependencies`, pinned to a
specific recent version (e.g. `"2.x.y"` — use `bunx @biomejs/biome --version` or
the latest stable; pin exactly, no `^`). Run `bun install`. This mutates the
lockfile + node_modules, which is expected and allowed for this plan.

**Verify**: `bunx @biomejs/biome --version` prints a version.

### Step 3: Baseline `biome.json` that PASSES on current code
Create `biome.json` at the repo root. Configure it so `bunx @biomejs/biome check .`
exits 0 **without changing any source file**:
- `files.includes`: source globs; **ignore** generated/vendored paths: `node_modules`, `.next`, `dist`, `.turbo`, `packages/db/prisma/migrations`, any generated Prisma client, `**/*.pen`.
- `formatter.enabled: false` OR set it to match the existing style but do NOT run it in `check` — the goal is linting, and enabling an opinionated formatter would flag the whole tree. Simplest safe choice: `formatter.enabled: false`.
- `linter.enabled: true`, `linter.rules.recommended: true`.
- Then run `bunx @biomejs/biome check .`. For every rule that reports errors on
  the existing code, set that specific rule to `"off"` (or `"warn"`) in
  `linter.rules` until `check` exits 0. This produces an incremental-adoption
  baseline: enabled rules guard new code; noisy pre-existing violations are
  parked (documented as follow-up), NOT auto-fixed.
- Do this iteratively; cap at a reasonable number of iterations. If after
  disabling the reported rules the check still won't pass without code edits,
  STOP and report the remaining rule(s) rather than editing source.

Wire scripts:
- Root `package.json`: add `"lint": "biome check ."` **only if** it exits 0 with
  the tuned config; OR keep root `lint` as the turbo aggregator and set each
  package's `lint` to `biome check .` scoped to its dir. Choose whichever keeps
  `bun run lint` exit 0. Simplest: set root `package.json` to add a top-level
  `"lint:biome": "biome check ."` and leave the turbo `lint` pipeline alone to
  avoid touching 10 package.jsons. Prefer the minimal wiring that yields a
  green `bunx @biomejs/biome check .`.

**Verify**: `bunx @biomejs/biome check .` → exit 0; `git diff --stat` shows NO source `.ts`/`.tsx` files changed by Biome (only `biome.json`, `package.json`, lockfile).

## Test plan
- The web test file is the coverage here (now actually running). No new tests required.
- Verify `bun run test` includes `@narriflow/web` running `content-pack-form.test.ts`.

## Done criteria
- [ ] `grep '"test"' apps/web/package.json` → `bun test`
- [ ] `bun run test` exits 0 and runs the web test (not the echo)
- [ ] `biome.json` exists; `bunx @biomejs/biome check .` exits 0
- [ ] `git diff --name-only` shows NO source `.ts`/`.tsx` reformatted by Biome
- [ ] `bun run typecheck` exits 0
- [ ] Only package.json(s), lockfile, and biome.json changed by this plan (`git status`)

## STOP conditions
- The web test fails for a pre-existing reason → STOP, report (don't fix app code).
- Biome cannot be made to pass on current code without source edits after disabling reported rules → STOP, report the offending rules; do NOT reformat the codebase to satisfy it.
- `bun install` fails offline / can't fetch Biome → STOP, report; leave the test-script change (Step 1) in place as it stands alone.

## Maintenance notes
- Follow-up (separate): a pre-commit hook (lint-staged + a git hook) and gradually re-enabling the parked Biome rules with targeted fixes.
- The CI workflow (plans/005) runs typecheck+test; add `lint` to CI only once the Biome baseline is proven stable.
