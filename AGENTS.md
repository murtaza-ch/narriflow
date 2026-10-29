# AGENTS.md

Narriflow turns long videos into short, captioned, virality-scored clips
(OpusClip-class), plus content repurposing, dubbing, and social publishing.

## Engineering principles

I like ambitious ideas, simple systems, and software that feels obvious. Do not preserve complexity just because it already exists. Do not introduce machinery because it looks architecturally impressive. Understand the real constraint, then fight for the smallest model that makes the correct behavior unsurprising.

For unfamiliar features, don't write from scratch, first search github for open-source projects, compare approaches, then get started.

Channel both "measure twice, cut once" and YAGNI. Fight scope creep. Honor the developer's intent in a minimal, realistic way.

## Monorepo layout (Bun + Turborepo)

- `apps/web` — Next.js 16 App Router UI + Clerk sign-in. A client of the API: no database, storage, billing or provider access, no Server Actions, no backend route handlers (only docs content: search, Markdown, llms text, OG images). Biome and `bun run check:web-split` ban importing `@narriflow/{services,db,auth,mcp-core,email,api}`.
  Public docs live at `/docs`: pages in `content/docs/**.mdx` (Mintlify component names), navigation in `lib/docs/navigation.ts`, UI in `app/(docs)`. The API reference renders from the generated public OpenAPI document (`@narriflow/api-client/openapi`), never from a live API. Write the API origin in pages as `https://api.narriflow.example` (`lib/docs/api-origin.ts`); the MDX build replaces it with `NEXT_PUBLIC_API_URL`. In-app links go through `lib/docs-url.ts`.
- `apps/api` — Hono-on-Bun API on its own origin (Railway): first-party `/api/*` routes per domain (`src/domains/<domain>/{routes,admission,runtime}.ts`), public REST `/api/v1/*`, remote `/mcp`, provider webhooks, the progress stream. Each domain's `admission.ts` declares every route's capability, rate scope or independent trust; `bun run --cwd apps/api test:inventory` fails on an undeclared route or a phantom declaration. HTTP modules admit, validate, call services and serialize; business logic stays in `packages/services`.
- `apps/worker` — independent Bun loops for ingest, workflow stages, previews/layout, publishing, and maintenance. Uses FFmpeg/ffprobe/yt-dlp.
- `apps/mcp` — stdio MCP server (project + autopilot tools).
- `packages/`:
  - `db` — Prisma/Postgres.
  - `services` — shared service layer; the real business logic lives here.
  - `validators` — zod schemas + shared caption/emoji constants.
  - `composition-plan` — shared Studio preview and export composition policy.
  - `api-client` — the browser's typed client for the API: transport (Clerk Bearer, Workspace hint), cache scope, per-domain `queries`/`mutations`, the progress stream, and the generated public OpenAPI document. Import a domain from `@narriflow/api-client/<domain>`.
  - `mcp-core` — shared MCP tools, authentication, and transport support.
  - `auth` — Clerk helpers.
  - `ui` — Chakra UI v3.
  - `email`, `config`.

## Critical paths (where bugs hurt most)

- Plan catalog (prices, credits, features, limits) — `packages/validators/src/pricing.ts`; every plan check goes through `hasFeature`/`planLimits` or `requirePlanFeature`/`requireWithinPlanLimit` (`packages/services/src/plan-features.ts`), never a bare tier comparison.
- Credits and capacity — `packages/services/src/processing-usage.ts`; Stripe billing — `packages/services/src/workspace-billing.service.ts` + `billing.service.ts`.
- Request admission — `apps/api/src/http/request-policy.ts` + each domain's `admission.ts` (ADR 0009); web-side gating in `apps/web/app/_components/workspace-query-gate.tsx`.
- Upload Session admission, verification, and ingest handoff — `packages/services/src/upload-session.service.ts`.
- Workflow claiming/reaper — `packages/services/src/workflow-run-lifecycle.ts`.
- Clip render pipeline — `apps/worker/src/tasks/clip-render-attempt.ts` + `apps/worker/src/composition-ffmpeg-adapter.ts`.
- Social publishing — `packages/services/src/social.service.ts` + `apps/worker/src/tasks/social-publisher.ts`.

## Verification

- `bun run lint` (repository-wide Biome check)
- `bun run typecheck`
- `bun run test` (fast deterministic suites, including API, API-client and web tests; PostgreSQL suites report as skipped).
- `bun run --cwd apps/api test:inventory` (mounted routes vs admission declarations) and `bun run --cwd apps/api openapi:check` (the committed public OpenAPI document matches the REST routes).
- `bun run check:web-split` (no backend imports, Server Actions or route handlers in web; add `-- --bundle` after `bun run --cwd apps/web build` to scan the client bundle). Building web needs `NEXT_PUBLIC_API_URL`.
- `bun run env:check` compares the four local env files.
- Disposable-schema PostgreSQL gates: `bun run test:workflow:db`, `bun run test:upload-session:db`, `bun run test:processing-usage:db`, `bun run test:workspace-billing:db`, `bun run test:social-publication:db`, `bun run test:clip-editor-persistence:db`, `bun run test:authenticated-request-policy:db`, `bun run test:brand-profiles:db`, `bun run test:vizard-expansion:db`, `bun run test:integration-api:db`, and `bun run test:library-search:db` (needs pgvector).

## Conventions

- Two origins: **W** (web, human links) and **A** (API, provider callbacks, webhooks, MCP, REST). Configure `WEB_ORIGIN`/`API_ORIGIN`, never derive an origin from `Host`. The browser calls A directly with a Clerk Bearer token and an `X-Workspace-Id` hint; there is no cookie auth and no Vercel rewrite.
- Services are re-exported from `packages/services/src/index.ts`. When a domain module has separate production wiring, name that wiring `<concept>-runtime.ts`; keep the injected domain implementation in `<concept>.ts`. Use `.service.ts` for service implementations, not as a second name for runtime wiring.
- `GLOSSARY.md` defines domain vocabulary. `docs/adr/README.md` indexes architectural decisions and explains when to add one.
- Zod schemas live in `packages/validators`.
- Caption preview, burn-in, and subtitle files share one cue model: the composition plan's cue derivation (`deriveCaptionCues` in `packages/composition-plan/src/clip-composition-plan.ts`, grouped by each preset's `wordsPerCue`) and `CAPTION_POSITION_Y_DEFAULTS` in `packages/validators/src/caption-preset.ts` — never fork it.
- Structured logs use `console.warn(JSON.stringify({ level, message, ...ctx }))`.
- Color roles live on the `accent` semantic token in `packages/ui/src/theme.ts`: blue `accent` marks interactive state (focus, checked, selected, current, progress); neutral `brand` is for primary buttons, text and surfaces. The Studio follows the same roles through its `studio.*` tokens.

## Agent skills

- Issues and specs use the local Markdown tracker in `.scratch/`. See `docs/agents/issue-tracker.md` for ticket dependencies, claims, and completion.
- Domain docs use one root `GLOSSARY.md` and `docs/adr/`. See `docs/agents/domain.md` for consumer rules.

## Env

- App-local env files: `apps/api/.env`, `apps/web/.env.local`, `apps/worker/.env`, `packages/db/.env`. Never a root `.env`. See `README.md`. Web holds only `NEXT_PUBLIC_*` values and the Clerk secret its proxy needs.
- `.env*` is gitignored — never commit real secrets.

### Shared development resources

Local apps and deployed development apps intentionally use the same resources.

| Resource                         | Shared selection                                                                                                 |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Neon project / branch / database | `narriflow-dev` / `production` / `neondb`                                                                      |
| Redis                            | Upstash `narriflow-dev-live`                                                                                     |
| R2 bucket                        | `narriflow-dev`                                                                                                  |
| Applications                     | Local web, API and worker via `bun run dev`; Vercel `narriflow-dev` (web); Railway `@narriflow/api` and `@narriflow/worker` in environment `dev` |

- PostgreSQL owns the durable `IngestJob` and `WorkflowRun` queues. Local and Railway workers share the queue and can process jobs created by either API. Maintenance and publishing also affect the shared data.
- Keep web, worker, and migration connections on this same database. Prisma prefers `DIRECT_URL` over `DATABASE_URL`; verify both before migrations.
- Use the same R2 bucket/account, Upstash endpoint, provider accounts, and data encryption keys everywhere. Sync shared resource settings from Railway's `dev` worker selectively; retain localhost URLs, development mode, and native tool paths in local files.
- Run `bun run env:check` before local startup. It checks local file consistency without printing secrets; deployed settings must be checked separately. A local Redis service is not needed.
- Apply migrations once to the shared database before running new code. Pushing to GitHub `dev` triggers all three deployed applications. See [the environment runbook](docs/runbooks/environments.md) for resource IDs and setup details.

## Pre-production compatibility policy

- Narriflow has no production users, production data, or mixed-version deployments yet. Do not preserve obsolete behavior solely for backward compatibility.
- When replacing a local-only implementation or data shape, remove the old path in the same change. Update or reset local test data instead of adding dual reads, dual writes, legacy parsers, fallback renderers, shadow modes, or cutover selectors.
- Keep fallbacks that are part of the current product contract, such as typed degradation when analysis or optional media is unavailable. These fallbacks must use the current architecture and must not call an older implementation.
- If production users, production data, or rolling mixed-version deployments are introduced, update this policy before adding any compatibility layer.

## DB

- Generate client: `bun run --cwd packages/db prisma:generate`.
- Migrations under `packages/db/prisma/migrations`; apply with `bun run --cwd packages/db prisma:migrate:deploy`.
- Pending migrations must be applied before deploying code that uses them.
