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
- `apps/api` — Hono API on Cloudflare Workers at its own origin: first-party `/api/*` routes per domain (`src/domains/<domain>/{routes,admission,runtime}.ts`), public REST `/api/v1/*`, remote `/mcp`, provider webhooks, hibernating progress sockets. Each domain's `admission.ts` declares every route's capability, rate scope or independent trust; `bun run --cwd apps/api test:inventory` fails on an undeclared route or a phantom declaration. HTTP modules admit, validate, call services and serialize; business logic stays in `packages/services`.
- `apps/media` — one-shot Modal Functions and the outbound laptop fetch agent. Pinned Python/Bun images own FFmpeg/ffprobe/yt-dlp and media transfer. Executors have no database credential; signed API commands fence every mutation.
- `apps/mcp` — authenticated stdio bridge to remote `/mcp`; no local database or provider access.
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
- Execution authority and recovery — `packages/services/src/{executor-control,execution-dispatch,workflow-run-lifecycle}.ts`; durable scheduling in `apps/api/src/workflows`.
- Clip render pipeline — `apps/media/src/tasks/clip-render-attempt.ts` + `apps/media/src/composition-ffmpeg-adapter.ts`.
- Social publishing — `packages/services/src/{publication-execution,social-publication-lifecycle}.ts`.

## Verification

- `bun run lint` (repository-wide Biome check)
- `bun run typecheck`
- `bun run test` (fast deterministic suites, including API, API-client and web tests; PostgreSQL suites report as skipped).
- `bun run --cwd apps/api test:inventory` (mounted routes vs admission declarations) and `bun run --cwd apps/api openapi:check` (the committed public OpenAPI document matches the REST routes).
- `bun run check:web-split` (no backend imports, Server Actions or route handlers in web; add `-- --bundle` after `bun run --cwd apps/web build` to scan the client bundle). Building web needs `NEXT_PUBLIC_API_URL`.
- `bun run env:check` compares the three app-local env files and Wrangler storage bindings. Root dotenv files are refused.
- Disposable-schema PostgreSQL gates: `bun run test:workflow:db`, `bun run test:upload-session:db`, `bun run test:processing-usage:db`, `bun run test:workspace-billing:db`, `bun run test:social-publication:db`, `bun run test:clip-editor-persistence:db`, `bun run test:authenticated-request-policy:db`, `bun run test:brand-profiles:db`, `bun run test:vizard-expansion:db`, `bun run test:integration-api:db`, `bun run test:library-search:db` (needs pgvector), and `bun run test:execution:db`. Set an isolated test database explicitly; shared development is forbidden. See `docs/runbooks/environments.md` for target guards.
- Native Linux verification: `apps/media/scripts/gates/native-ci.md`; Worker import audit: `bun run --cwd apps/api build:worker`.

## Conventions

- Two origins: **W** (web, human links) and **A** (API, provider callbacks, webhooks, MCP, REST). Configure `WEB_ORIGIN`/`API_ORIGIN`, never derive an origin from `Host`. The browser calls A directly with a Clerk Bearer token and an `X-Workspace-Id` hint; there is no cookie auth and no Vercel rewrite.
- Browser clients use API-client domains. Worker runtimes import narrow `@narriflow/services/<module>` exports; the full services barrel is forbidden in the Worker bundle. Services remain re-exported from `packages/services/src/index.ts` for non-Worker consumers. When a domain module has separate production wiring, name that wiring `<concept>-runtime.ts`; keep the injected domain implementation in `<concept>.ts`. Use `.service.ts` for service implementations, not as a second name for runtime wiring.
- `GLOSSARY.md` defines domain vocabulary. `docs/adr/README.md` indexes architectural decisions and explains when to add one.
- Zod schemas live in `packages/validators`.
- Caption preview, burn-in, and subtitle files share one cue model: the composition plan's cue derivation (`deriveCaptionCues` in `packages/composition-plan/src/clip-composition-plan.ts`, grouped by each preset's `wordsPerCue`) and `CAPTION_POSITION_Y_DEFAULTS` in `packages/validators/src/caption-preset.ts` — never fork it.
- Structured logs use `console.warn(JSON.stringify({ level, message, ...ctx }))`.
- Color roles live on the `accent` semantic token in `packages/ui/src/theme.ts`: blue `accent` marks interactive state (focus, checked, selected, current, progress); neutral `brand` is for primary buttons, text and surfaces. The Studio follows the same roles through its `studio.*` tokens.

## Agent skills

- Issues and specs use the local Markdown tracker in `.scratch/`. See `docs/agents/issue-tracker.md` for ticket dependencies, claims, and completion.
- Domain docs use one root `GLOSSARY.md` and `docs/adr/`. See `docs/agents/domain.md` for consumer rules.

## Env

- App-local env files: `apps/api/.dev.vars`, `apps/web/.env.local`, `packages/db/.env`. Never a root `.env`. See `README.md`. Web holds only `NEXT_PUBLIC_*` values and the Clerk secret its proxy needs.
- `.env*` and `.dev.vars*` are gitignored except examples. Never commit secrets or mount host environment files into media images.

### Shared development resources

Local apps and deployed development apps intentionally use the same resources.

| Resource | Shared selection |
| --- | --- |
| Neon | `narriflow-dev` / `production` / `neondb` |
| R2 bucket | `narriflow-dev`, Cloudflare account `5359f28d385b8632c3abee12d1f5b011` |
| Web | Local Next.js and Vercel `narriflow-dev` |
| API / scheduler / media | One Cloudflare Worker + Workflows environment per database, Modal workspace `murtazach275` |

- PostgreSQL owns domain state and dispatch obligations. Workflows schedule exact references; executors acquire a live owner through the signed control API. No polling scheduler or DB credential in Modal or the laptop.
- Local web/API development uses the same selected cloud schedulers and resources as deployed development. Bind the local API through a `remote: true` Service binding. Do not pair a local database with another environment's scheduler or Hyperdrive.
- Apply migrations once before dependent code. Verify both migration URLs and the deployed Hyperdrive target. Candidate gates use separate isolated resources until the single cutover is accepted.
- Run `bun run env:check` before local startup. It checks local consistency without printing secrets; deployed bindings and secrets require separate verification. Keep localhost origins while syncing shared provider and encryption settings selectively.
- Before pushing `dev`, follow `docs/runbooks/serverless-cutover.md`; old deployment consumers must be stopped and their automatic deployments disabled. Resource status and identifiers live in `docs/runbooks/environments.md`.

## Pre-production compatibility policy

- Narriflow has no production users, production data, or mixed-version deployments yet. Do not preserve obsolete behavior solely for backward compatibility.
- When replacing a local-only implementation or data shape, remove the old path in the same change. Update or reset local test data instead of adding dual reads, dual writes, legacy parsers, fallback renderers, shadow modes, or cutover selectors.
- Keep fallbacks that are part of the current product contract, such as typed degradation when analysis or optional media is unavailable. These fallbacks must use the current architecture and must not call an older implementation.
- If production users, production data, or rolling mixed-version deployments are introduced, update this policy before adding any compatibility layer.

## DB

- Generate client: `bun run --cwd packages/db prisma:generate`.
- Migrations under `packages/db/prisma/migrations`; apply with `bun run --cwd packages/db prisma:migrate:deploy`.
- Pending migrations must be applied before deploying code that uses them.
