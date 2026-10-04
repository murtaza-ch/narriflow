# AGENTS.md

Narriflow turns long videos into short, captioned, virality-scored clips
(OpusClip-class), plus content repurposing, dubbing, and social publishing.

## Engineering principles

I like ambitious ideas, simple systems, and software that feels obvious. Do not preserve complexity just because it already exists. Do not introduce machinery because it looks architecturally impressive. Understand the real constraint, then fight for the smallest model that makes the correct behavior unsurprising.

Channel both "measure twice, cut once" and YAGNI. Fight scope creep. Honor the developer's intent in a minimal, realistic way.

## Monorepo layout (Bun + Turborepo)

- `apps/web` — Next.js 16 App Router + Hono API (`app/api/[[...route]]/route.ts`) + Clerk auth.
- `apps/worker` — independent Bun loops for ingest, workflow stages, previews/layout, publishing, and maintenance. Uses FFmpeg/ffprobe/yt-dlp.
- `apps/mcp` — stdio MCP server (project + autopilot tools).
- `packages/`:
  - `db` — Prisma/Postgres.
  - `services` — shared service layer; the real business logic lives here.
  - `validators` — zod schemas + shared caption/emoji constants.
  - `composition-plan` — shared Studio preview and export composition policy.
  - `mcp-core` — shared MCP tools, authentication, and transport support.
  - `auth` — Clerk helpers.
  - `ui` — Chakra UI v3.
  - `email`, `config`.

## Critical paths (where bugs hurt most)

- Quota gate — `packages/services/src/project.service.ts`; Stripe billing webhook — `packages/services/src/billing.service.ts`.
- Upload Session admission, verification, and ingest handoff — `packages/services/src/upload-session.service.ts`.
- Workflow claiming/reaper — `packages/services/src/workflow-run-lifecycle.ts`.
- Clip render pipeline — `apps/worker/src/tasks/clip-render-attempt.ts` + `apps/worker/src/composition-ffmpeg-adapter.ts`.
- Social publishing — `packages/services/src/social.service.ts` + `apps/worker/src/tasks/social-publisher.ts`.

## Verification

- `bun run lint` (repository-wide Biome check)
- `bun run typecheck`
- `bun run test` (fast deterministic suites, including active web tests; PostgreSQL suites report as skipped).
- Disposable-schema PostgreSQL gates: `bun run test:workflow:db`, `bun run test:upload-session:db`, `bun run test:workspace-billing:db`, `bun run test:social-publication:db`, `bun run test:clip-editor-persistence:db`, `bun run test:authenticated-request-policy:db`, `bun run test:brand-profiles:db`, and `bun run test:vizard-expansion:db`.

## Conventions

- Services are re-exported from `packages/services/src/index.ts`. When a domain module has separate production wiring, name that wiring `<concept>-runtime.ts`; keep the injected domain implementation in `<concept>.ts`. Use `.service.ts` for service implementations, not as a second name for runtime wiring.
- `CONTEXT.md` defines domain vocabulary. `docs/adr/README.md` indexes architectural decisions and explains when to add one.
- Zod schemas live in `packages/validators`.
- Caption preview and burn-in share one cue model (`CAPTION_CHUNK_SIZE`, `CAPTION_POSITION_Y_DEFAULTS` in `packages/validators/src/caption-preset.ts`) — never fork it.
- Structured logs use `console.warn(JSON.stringify({ level, message, ...ctx }))`.

## Env

- App-local env files: `apps/web/.env.local`, `apps/worker/.env`, `packages/db/.env`. Never a root `.env`. See `README.md`.
- `.env*` is gitignored — never commit real secrets.

### Local and deployed development must stay separate

| Resource | Local | Deployed dev |
| --- | --- | --- |
| Neon branch / database | `local-murtaza` / `narriflow_local` | `deployed-dev` / `neondb` |
| Redis | `redis://127.0.0.1:6379` | Deployed Upstash database |
| R2 bucket | `narriflow-local-murtaza` | `narriflow-dev` |
| Applications | Local web and worker via `bun run dev` | Vercel `narriflow-dev` and Railway `@narriflow/worker` in environment `dev` |

- PostgreSQL owns the durable `IngestJob` and `WorkflowRun` queues. Never start a local worker against the deployed database; it can claim deployed jobs and run maintenance or publishing against deployed data.
- Keep web, worker, and migration connections on the same database within each environment. Prisma prefers `DIRECT_URL` over `DATABASE_URL`; verify both before migrations. The inherited `neondb` on the local branch is unused; local applications must use `narriflow_local`.
- Keep Redis and R2 separate too. Use the local bucket's scoped credentials, and never download deployed variables over local env files or copy deployed jobs into the local database.
- Before local startup, run `brew services start redis` and `bun run env:check`. The check validates local file consistency only; it does not verify deployed settings or prove isolation from deployed resources.
- Apply migrations separately to the intended database before running new code. Pushing to GitHub `dev` triggers both deployed applications. See [the environment runbook](docs/runbooks/environments.md) for resource IDs and setup details.

## Pre-production compatibility policy

- Narriflow has no production users, production data, or mixed-version deployments yet. Do not preserve obsolete behavior solely for backward compatibility.
- When replacing a local-only implementation or data shape, remove the old path in the same change. Update or reset local test data instead of adding dual reads, dual writes, legacy parsers, fallback renderers, shadow modes, or cutover selectors.
- Keep fallbacks that are part of the current product contract, such as typed degradation when analysis or optional media is unavailable. These fallbacks must use the current architecture and must not call an older implementation.
- If production users, production data, or rolling mixed-version deployments are introduced, update this policy before adding any compatibility layer.

## DB

- Generate client: `bun run --cwd packages/db prisma:generate`.
- Migrations under `packages/db/prisma/migrations`; apply with `bun run --cwd packages/db prisma:migrate:deploy`.
- Pending migrations must be applied before deploying code that uses them.
