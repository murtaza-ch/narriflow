# AGENTS.md

Narriflow turns long videos into short, captioned, virality-scored clips
(OpusClip-class), plus content repurposing, dubbing, and social publishing.

## Engineering principles

I like ambitious ideas, simple systems, and software that feels obvious. Do not preserve complexity just because it already exists. Do not introduce machinery because it looks architecturally impressive. Understand the real constraint, then fight for the smallest model that makes the correct behavior unsurprising.

Channel both "measure twice, cut once" and YAGNI. Fight scope creep. Honor the developer's intent in a minimal, realistic way.

## Monorepo layout (Bun + Turborepo)

- `apps/web` — Next.js 16 App Router + Hono API (`app/api/[[...route]]/route.ts`) + Clerk auth.
- `apps/worker` — custom Bun poller: ingest → `stt` → `moment_detection` → `clip_rendering` → `dubbing` → RSS autopilot → due social posts. Uses FFmpeg/ffprobe/yt-dlp.
- `apps/mcp` — stdio MCP server (project + autopilot tools).
- `packages/`:
  - `db` — Prisma/Postgres.
  - `services` — shared service layer; the real business logic lives here.
  - `validators` — zod schemas + shared caption/emoji constants.
  - `auth` — Clerk helpers.
  - `ui` — Chakra UI v3.
  - `email`, `config`.

## Critical paths (where bugs hurt most)

- Quota gate + Stripe billing webhook — `packages/services/src/billing.service.ts`.
- Upload Session admission, verification, and ingest handoff — `packages/services/src/upload-session.service.ts`.
- Workflow claiming/reaper — `packages/services/src/project.service.ts`.
- Clip render pipeline — `apps/worker/src/tasks/render-clips.ts`.
- Social publishing — `packages/services/src/social.service.ts` + `apps/worker/src/tasks/social-publisher.ts`.

## Verification

- `bun run lint` (repository-wide Biome check)
- `bun run typecheck`
- `bun run test` (fast deterministic suites, including active web tests; PostgreSQL suites report as skipped).
- Disposable-schema PostgreSQL gates: `bun run test:workflow:db`, `bun run test:upload-session:db`, `bun run test:workspace-billing:db`, `bun run test:social-publication:db`, `bun run test:clip-editor-persistence:db`, `bun run test:authenticated-request-policy:db`, and `bun run test:brand-profiles:db`.

## Conventions

- Services are re-exported from `packages/services/src/index.ts`. When a domain module has separate production wiring, name that wiring `<concept>-runtime.ts`; keep the injected domain implementation in `<concept>.ts`. Use `.service.ts` for service implementations, not as a second name for runtime wiring.
- `CONTEXT.md` defines domain vocabulary. `docs/adr/README.md` indexes architectural decisions and explains when to add one.
- Zod schemas live in `packages/validators`.
- Caption preview and burn-in share one cue model (`CAPTION_CHUNK_SIZE`, `CAPTION_POSITION_Y_DEFAULTS` in `packages/validators/src/caption-preset.ts`) — never fork it.
- Structured logs use `console.warn(JSON.stringify({ level, message, ...ctx }))`.
- Design language "Blueline" lives in `packages/ui/src/theme.ts`: porcelain light / graphite dark neutrals + one ultramarine signal accent, Archivo display (`fontFamily="display"`; Expanded width is reserved for `textStyle="eyebrow"` labels), mono for numbers/timecodes (`fg.timecode` for timecodes). Structure is drawn, not lifted: `PageHeader` rule bands, `StatBand`, hairline rows + 3px status stripes; `layerStyle="panel"|"panelHover"` only for true elevation (modals/menus/popovers/toasts/draggable), `layerStyle="well"` + `MediaWell` for anything holding footage (never raw video on white), `layerStyle="blueprint"` for ambient grids. Semantic tokens (`bg.*`, `fg.*` incl. `fg.disabled`, `border.*` incl. `border.control` for input boundaries, `accent.*`, `danger.*`, `studio.*` for the mode-invariant studio chrome), radii `l1/l2/l3`, `textStyle="eyebrow"|"title"|"display"|"data"`, `animation="fade-up"|"rule-in"|"meter-fill"|"spin"|"shimmer"` — no hardcoded hex for UI chrome (user brand/caption color values are the exception; studio chrome uses `studio.*` tokens). One solid (ultramarine) button per view (exception: long-scroll marketing pages may repeat the primary CTA in the closing section); dark-mode solid buttons use dark labels (`accent.contrast`), never white-on-#5B6CFF. Dates/durations via `apps/web/lib/format.ts`.

## Env

- App-local env files: `apps/web/.env.local`, `apps/worker/.env`, `packages/db/.env`. Never a root `.env`. See `README.md`.
- `.env*` is gitignored — never commit real secrets.

## Pre-production compatibility policy

- Narriflow has no production users, production data, or mixed-version deployments yet. Do not preserve obsolete behavior solely for backward compatibility.
- When replacing a local-only implementation or data shape, remove the old path in the same change. Update or reset local test data instead of adding dual reads, dual writes, legacy parsers, fallback renderers, shadow modes, or cutover selectors.
- Keep fallbacks that are part of the current product contract, such as typed degradation when analysis or optional media is unavailable. These fallbacks must use the current architecture and must not call an older implementation.
- If production users, production data, or rolling mixed-version deployments are introduced, update this policy before adding any compatibility layer.

## DB

- Generate client: `bun --cwd packages/db run prisma:generate`.
- Migrations under `packages/db/prisma/migrations`; apply with `prisma migrate deploy`.
- Pending migrations must be applied before deploying code that uses them.
