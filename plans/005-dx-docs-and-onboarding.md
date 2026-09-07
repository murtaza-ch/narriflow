# Plan 005: DX — CLAUDE.md, README path fix, CI workflow

> **Executor instructions**: Follow step by step; verify each step. These are
> additive docs/CI changes with no runtime impact.
>
> **Drift check (run first)**: `git diff --stat 05d273d..HEAD -- README.md` —
> the README is already modified in the working tree; re-read it before editing.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: dx / docs
- **Planned at**: commit `05d273d`, 2026-07-06

## Why this matters

Three cheap developer-experience wins: (1) the README embeds **absolute macOS
paths** (`/Users/murtaza/Documents/dev/narriflow/...`) in markdown links, which
404 for anyone else and look unprofessional in a repo about to be shared/sold;
(2) there is **no `CLAUDE.md`** so agents/contributors must reverse-engineer the
architecture; (3) there is **no CI** — `bun run typecheck`/`test` never run
automatically, so regressions land silently.

## Current state

- `README.md` contains absolute-path links, e.g. around lines 148, 172, 221,
  305, 325 (search: `grep -n "/Users/murtaza/Documents/dev/narriflow" README.md`).
  ROADMAP.md and plan.md may contain them too — but **only fix README.md in this
  plan** (docs cleanup of the others is out of scope to keep the diff tight).
- No `CLAUDE.md` / `AGENTS.md` at repo root (`ls CLAUDE.md AGENTS.md` → absent).
- No `.github/workflows/` (`ls .github/workflows` → absent).
- Root scripts (`package.json`): `dev`, `build`, `lint` (turbo, currently
  no-op per-package), `typecheck`, `test`, `clean`. Package manager: `bun@1.3.6`.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Typecheck | `bun run typecheck` | exit 0 |
| Tests | `bun run test` | all pass |
| Find abs paths | `grep -n "/Users/murtaza" README.md` | empty after step 1 |

## Scope

**In scope**:
- `README.md` (replace absolute paths with repo-relative).
- Create `CLAUDE.md` at repo root.
- Create `.github/workflows/ci.yml`.

**Out of scope**:
- Adding a linter/formatter or Husky hooks (separate effort; lint scripts stay as-is).
- Editing ROADMAP.md / plan.md paths.
- Any source-code change.

## Steps

### Step 1: Fix README absolute paths

Replace every occurrence of `/Users/murtaza/Documents/dev/narriflow/` with the
empty string so links become repo-relative (e.g.
`[apps/web/.env.example](apps/web/.env.example)`). Do not change link text or
surrounding prose.

**Verify**: `grep -n "/Users/murtaza" README.md` → empty. `grep -c "](apps/" README.md` → ≥1.

### Step 2: Create CLAUDE.md

Create `CLAUDE.md` at the repo root, concise and accurate to this codebase.
Include:

- **One-line what**: Narriflow — turns long videos into short, captioned,
  virality-scored clips (OpusClip-class), plus content repurposing, dubbing, and
  social publishing.
- **Monorepo layout** (Bun + Turborepo):
  - `apps/web` — Next.js 16 App Router + Hono API (`app/api/[[...route]]/route.ts`) + Clerk auth.
  - `apps/worker` — custom Bun poller: ingest → `stt` → `moment_detection` → `clip_rendering` → `dubbing` → RSS autopilot → due social posts. Uses FFmpeg/ffprobe/yt-dlp.
  - `apps/mcp` — stdio MCP server (project + autopilot tools).
  - `packages/`: `db` (Prisma/Postgres), `services` (shared service layer — the real business logic lives here), `validators` (zod schemas + shared caption/emoji constants), `auth` (Clerk helpers), `ui` (Chakra UI v3), `email`, `config`.
- **Critical paths** (where bugs hurt most): quota gate + Stripe billing webhook (`packages/services/src/billing.service.ts`), upload multipart completion + ingest (`project.service.ts`), workflow claiming/reaper (`project.service.ts`), clip render pipeline (`apps/worker/src/tasks/render-clips.ts`), social publishing (`social.service.ts` + `apps/worker/src/tasks/social-publisher.ts`).
- **Verification commands**: `bun run typecheck`, `bun run test`. Note `apps/web` currently has a no-op test script.
- **Conventions**: services are re-exported from `packages/services/src/index.ts`; zod schemas in `packages/validators`; caption preview and burn-in share one cue model (`CAPTION_CHUNK_SIZE`, `CAPTION_POSITION_Y_DEFAULTS` in `packages/validators/src/caption-preset.ts`) — never fork it; structured logs use `console.warn(JSON.stringify({ level, message, ...ctx }))`.
- **Env**: app-local env files (`apps/web/.env.local`, `apps/worker/.env`, `packages/db/.env`); never a root `.env`. See `README.md`. `.env*` is gitignored — never commit real secrets.
- **DB**: `bun --cwd packages/db run prisma:generate`; migrations under `packages/db/prisma/migrations`; apply with `prisma migrate deploy`. **Pending migrations must be applied before deploying code that uses them.**

Keep it under ~60 lines; it's a map, not a manual.

**Verify**: `ls CLAUDE.md` → present; `bun run typecheck` still exit 0 (no code touched).

### Step 3: CI workflow

Create `.github/workflows/ci.yml` that, on `push` and `pull_request`:
- checks out the repo,
- installs Bun (`oven-sh/setup-bun@v2` with `bun-version: 1.3.6`),
- runs `bun install`,
- runs `bun run typecheck`,
- runs `bun run test`.

Do not add deploy steps or secrets. Keep `build` out for now if it requires
env/DB that CI won't have (typecheck + test are the safe gates). Confirm
`bun run typecheck` doesn't require a live DB — Prisma client generation runs in
`postinstall`; if typecheck needs generated client, `bun install` already
triggers `prisma:generate` via the root `postinstall` script (verify in
`package.json`).

**Verify**: `cat .github/workflows/ci.yml` parses as valid YAML (no tabs); the
job steps reference `bun run typecheck` and `bun run test`.

## Test plan

- No code changes; the gate is that `bun run typecheck` and `bun run test` still
  pass locally (unchanged) and that the new files exist and are well-formed.

## Done criteria

- [ ] `grep -n "/Users/murtaza" README.md` → empty
- [ ] `ls CLAUDE.md .github/workflows/ci.yml` → both present
- [ ] `bun run typecheck` exits 0; `bun run test` exits 0
- [ ] Only README.md, CLAUDE.md, .github/workflows/ci.yml added/modified (`git status`)

## STOP conditions

- The root `postinstall` does NOT generate the Prisma client and typecheck fails
  in a clean checkout without it → add an explicit `bun --filter @narriflow/db prisma:generate` step before typecheck and note it.

## Maintenance notes

- Follow-up (separate plan): add a real linter/formatter (Biome) + pre-commit hook, and a web test harness (`apps/web` test script is a no-op today).
- Keep CLAUDE.md's "critical paths" list current as the architecture evolves.
