# Plan 021: Eliminate critical/high production dependency advisories and freeze CI installs

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. Touch only the files listed as in scope. If anything in the
> "STOP conditions" section occurs, stop and report — do not improvise.
> The reviewer maintains `plans/README.md`; do not edit it.
>
> **Working-tree override**: the current product exists in a large uncommitted
> working tree. Work directly in that tree and do not create a fresh worktree,
> commit, push, or open a PR.
>
> **Drift check (run first)**:
> `git diff --stat 05d273d..HEAD -- package.json apps/web/package.json apps/worker/package.json packages/auth/package.json packages/services/package.json packages/ui/package.json bun.lock .github/workflows/ci.yml`
> `HEAD` is expected to remain `05d273d`; also inspect the live excerpts below
> because these files already contain intentional uncommitted product changes.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: MED
- **Depends on**: none
- **Category**: security, dx
- **Planned at**: commit `05d273d`, 2026-07-09, against the live working tree

## Why this matters

`bun audit --production --audit-level=high` currently exits 1 with 40 findings,
including two critical Clerk middleware authorization-bypass advisories and
high-severity Next.js, Hono, XML, Axios, WebSocket, protobuf, and URI findings.
Several vulnerable trees come only from unused direct dependencies. CI also
uses a mutable install and does not run a production build or dependency audit,
so lockfile drift and known release blockers can ship unnoticed.

## Current state

- `apps/web/package.json` currently resolves `@clerk/nextjs@6.39.1`,
  `next@16.2.3`, and `hono@4.12.14`. The first two versions are affected by
  critical/high authorization and App Router advisories; Hono is below the
  fixed `4.12.25` threshold.
- `packages/auth/package.json` independently declares `@clerk/nextjs`.
- `packages/ui/package.json` has a Next peer range beginning at `^16.0.0`.
- `packages/services/package.json` resolves `fast-xml-parser@5.6.0`; its
  `fast-xml-builder` subtree is affected by a high-severity attribute-injection
  advisory. `5.9.3` is the current compatible release.
- `apps/worker/package.json` declares `@trigger.dev/sdk`, but
  `rg -n '@trigger.dev/sdk|trigger.dev' --glob '!bun.lock' .` finds no source
  import. Narriflow uses its own Bun polling worker; this unused dependency is
  the only source of several vulnerable `ws`, `systeminformation`, and protobuf
  paths.
- `apps/web/package.json` declares `@posthog/nextjs`, `@sentry/nextjs`, and
  `@vercel/otel`, but repository-wide source searches find no imports or setup
  for any of them. PostHog introduces the vulnerable Axios/form-data tree and
  Sentry introduces a vulnerable protobuf tree. Remove these dormant packages;
  do not pretend observability is active.
- The exact shared UI pins `@chakra-ui/react: 3.34.0` and
  `@emotion/react: 11.14.0` are deliberate. `plans/README.md` documents that
  resolving two Chakra versions caused an app-wide 500. They must remain exact
  and resolve to one copy.
- `.github/workflows/ci.yml` uses `bun install`, typecheck, and test only.
- Verified fixed compatible versions on 2026-07-09:
  `@clerk/nextjs@6.39.5`, `next@16.2.10`, `hono@4.12.28`,
  `fast-xml-parser@5.9.3`. Do not take Clerk 7 or other unrelated major bumps.
- Bun 1.3.6 supports `bun ci` as a frozen-lockfile install and
  `bun audit --production --audit-level=high` as a failing release gate.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Refresh lock after manifest edits | `bun install` | exit 0 |
| Prove frozen install | `bun ci` | exit 0, lockfile unchanged |
| Production audit | `bun audit --production --audit-level=high` | exit 0; no critical/high findings |
| Typecheck | `bun run typecheck` | exit 0, 10/10 packages pass |
| Tests | `bun run test` | exit 0, all existing tests pass |
| Lint | `bun run lint:biome` | exit 0 |
| Production build | `bun run build` | exit 0; Next production build succeeds |

## Scope

**In scope** (the only files you may modify):

- `package.json`
- `apps/web/package.json`
- `apps/worker/package.json`
- `packages/auth/package.json`
- `packages/services/package.json`
- `packages/ui/package.json`
- `bun.lock`
- `.github/workflows/ci.yml`

**Out of scope**:

- All application/source files.
- Any major-version migration.
- Chakra or Emotion version changes.
- Adding/configuring PostHog, Sentry, or OpenTelemetry; dormant declarations
  are being removed because no implementation exists.
- Broadly updating every outdated package. This plan remediates the audit with
  the smallest compatible set.

## Git workflow

- Work directly in the current dirty tree because it is the current product.
- Do not create a branch, commit, push, stage files, or open a PR.
- Do not revert or reformat unrelated existing changes.

## Steps

### Step 1: Remove unused vulnerable dependency trees

Remove `@trigger.dev/sdk` from `apps/worker/package.json`. Remove
`@posthog/nextjs`, `@sentry/nextjs`, and `@vercel/otel` from
`apps/web/package.json`. Confirm no source imports exist before and after.

**Verify**:

- `rg -n '@trigger.dev/sdk|@posthog/nextjs|@sentry/nextjs|@vercel/otel' --glob '!bun.lock' .`
  returns no matches.

### Step 2: Raise only the known vulnerable direct ranges

Set both Clerk declarations to a range beginning at the fixed compatible
`6.39.5`; set web Next to `^16.2.10`; set web Hono to `^4.12.28`; set the UI
Next peer floor to `^16.2.10`; and set `fast-xml-parser` to `^5.9.3`.
Preserve exact Chakra/Emotion pins.

Run `bun install` to refresh `bun.lock`. If the audit still reports a
high/critical advisory only through a transitive package whose fixed release
fits the parent's declared range, add the narrowest root `overrides` entry in
`package.json` and document it with a JSON-adjacent script/check name if useful.
Known possible case: `fast-uri@3.1.2` is the non-vulnerable patch in the 3.x
line. Do not override across a parent-incompatible major and do not suppress an
audit.

**Verify**:

- `bun audit --production --audit-level=high` exits 0.
- `bun pm ls --all | rg '@clerk/nextjs|next@|hono@|fast-xml-parser|trigger.dev|posthog|sentry'`
  shows fixed versions and no removed packages.
- `rg -n '"@chakra-ui/react": "3.34.0"|"@emotion/react": "11.14.0"' apps/web/package.json packages/ui/package.json`
  returns the expected four exact-pin lines.

### Step 3: Make release checks reproducible in CI

In `.github/workflows/ci.yml`, replace mutable `bun install` with `bun ci`.
Add named steps for Biome, production dependency audit, and the production
build. Keep typecheck and tests. Use the same commands in the table above.
Order checks as: frozen install, lint, typecheck, tests, production audit,
production build.

Add a root `audit:production` script only if it improves local/CI parity; if
added, CI must invoke the script and it must expand to
`bun audit --production --audit-level=high`.

**Verify**:

- `rg -n 'bun ci|lint:biome|typecheck|test|audit|build' .github/workflows/ci.yml`
  shows all six gates.
- `rg -n 'run: bun install' .github/workflows/ci.yml` returns no matches.

### Step 4: Run the full release gate and inspect scope

Run the commands in the table in order. After `bun ci`, verify
`git diff --exit-code -- bun.lock` against the post-install lockfile state (it
must not mutate during the frozen install). Then inspect the full diff.

**Verify**:

- `bun ci` exits 0.
- `bun run lint:biome` exits 0.
- `bun run typecheck` exits 0.
- `bun run test` exits 0.
- `bun audit --production --audit-level=high` exits 0.
- `bun run build` exits 0.
- `git diff --name-only -- package.json apps/web/package.json apps/worker/package.json packages/auth/package.json packages/services/package.json packages/ui/package.json bun.lock .github/workflows/ci.yml`
  lists only intended in-scope changes.

## Test plan

This is a dependency/CI change with no source behavior change. The regression
suite is the full repository typecheck, tests, Biome check, production build,
frozen install, and high-severity production audit. Do not add fake unit tests.

## Done criteria

- [ ] `bun audit --production --audit-level=high` exits 0.
- [ ] Clerk resolves at or above 6.39.5 but below 7.
- [ ] Next resolves at or above 16.2.10 within major 16.
- [ ] Hono resolves at or above 4.12.28 within major 4.
- [ ] `@trigger.dev/sdk`, `@posthog/nextjs`, `@sentry/nextjs`, and
  `@vercel/otel` are absent from manifests and the lockfile.
- [ ] Chakra/Emotion exact shared pins remain unchanged and only one Chakra
  version resolves.
- [ ] CI uses `bun ci` and runs lint, typecheck, tests, production audit, and
  production build.
- [ ] `bun ci`, lint, typecheck, tests, audit, and build all exit 0.
- [ ] No file outside the in-scope list is modified by this plan.

## STOP conditions

Stop and report rather than improvising if:

- Any removed package has a real source/config import that the repository-wide
  checks missed.
- Eliminating critical/high advisories requires a major-version upgrade.
- A transitive override would cross a parent package's declared compatible
  range or causes duplicate framework/runtime versions.
- `bun install` changes either exact Chakra/Emotion pin or resolves more than
  one Chakra version.
- Typecheck, tests, or build fail twice after one reasonable lockfile/install
  correction.
- The fix requires touching an out-of-scope file.

## Maintenance notes

- Add observability integrations only with actual initialization, environment
  validation, privacy review, and a pinned/managed dependency—not as dormant
  `latest` declarations.
- Dependabot/Renovate and scheduled audit automation are follow-ups; this plan
  establishes the deterministic CI gate they would feed.
- Review `bun.lock` for targeted removals/updates rather than trusting its size.

