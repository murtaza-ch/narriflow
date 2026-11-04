# Narriflow monorepo

Narriflow turns long videos into captioned short clips, with content repurposing, dubbing and social publishing. It is a pre-production Bun monorepo. Use Bun1.3.6, pinned in `package.json` and the native images.

Current domain vocabulary lives in [GLOSSARY.md](GLOSSARY.md). [ADR0019](docs/adr/0019-serverless-execution.md) and the [execution inventory](docs/serverless-execution-inventory.md) describe the serverless architecture. The integrated candidate remains admission-closed until the [cutover gates](docs/runbooks/serverless-cutover.md) pass.

## Repository layout

| Path | Responsibility |
| --- | --- |
| `apps/web` | Next.js16 UI, public docs and Clerk sign-in on Vercel. Calls the API directly |
| `apps/api` | Hono on Cloudflare Workers. First-party routes, public REST, remote MCP, webhooks, Workflows and Durable Objects |
| `apps/media` | One-shot Modal Functions and outbound laptop fetch agent. Pinned Python/Bun images own native media and arbitrary-URL egress |
| `apps/mcp` | Authenticated stdio bridge to the remote MCP endpoint |
| `packages/services` | Domain transitions, usage, fenced execution, dispatch and recovery |
| `packages/db` | Prisma schema, migrations and invocation-scoped adapter-pg clients |
| `packages/validators` | Shared schemas, pricing, captions and provider capabilities |
| `packages/composition-plan` | Shared Studio preview and export composition policy |
| `packages/api-client` | Browser transport, queries/mutations, progress sockets and generated public OpenAPI |
| `packages/mcp-core` | Remote MCP tools, resources, Apps, Tasks and authentication |
| `packages/ui`, `packages/auth`, `packages/email`, `packages/config` | Shared UI, authentication, email and configuration |
| `integrations/zapier`, `integrations/make` | External integration definitions and their independent tests |

## Execution model

PostgreSQL owns admission, usage, attempts, artifacts and terminal outcomes. A domain transition commits its dispatch obligation in the same transaction. Cloudflare Workflows schedules exact references, waits durably and rereads the ledger before each action. Hourly safety recovery and daily retention use bounded indexed pages.

Modal and the laptop hold no database credential. Each invocation acquires an executor owner through the signed API, records its real process start and publishes only assigned artifacts under the live fence. Cancellation revokes database authority before best-effort external cancellation. Attempt-unique R2 keys protect committed objects from stale executors.

Source acquisition preserves a whole original video and an independently verified audio binding. Audio can start Scribe while video finishes. Supplied or declined captions preserve their own path. Selection uses bounded concurrent transcript windows followed by one global finalizer. Deduplicated preparation supplies render groups, Studio preview, audio peaks and layout evidence. A RenderRun parent remains unleased while its children work and settles the frozen batch once.

ProjectProgress uses authorized hibernating WebSockets. RateLimiter is a separate Durable Object and new mutations fail closed when it is unavailable. Hyperdrive query caching is off; Prisma connections belong to one request or Workflow step. Liveness and DO keepalives do not open Postgres.

## Local environment files

Copy these examples into their app-local destinations and fill the required settings:

| Example | Local destination |
| --- | --- |
| [`apps/api/.dev.vars.example`](apps/api/.dev.vars.example) | `apps/api/.dev.vars` |
| [`apps/web/.env.example`](apps/web/.env.example) | `apps/web/.env.local` |
| [`packages/db/.env.example`](packages/db/.env.example) | `packages/db/.env` |
| [`apps/mcp/.env.example`](apps/mcp/.env.example), optional | `apps/mcp/.env` |

Never create a root dotenv file. Keep secrets out of Git, images and logs. The web holds public settings and the Clerk secret its proxy needs. The API owns backend provider and storage control credentials; Modal receives only its narrowly selected secret stores and short-lived grants.

Use the same Clerk instance in web and API. `NEXT_PUBLIC_API_URL` must match `API_ORIGIN`; `NEXT_PUBLIC_APP_URL` must match `WEB_ORIGIN`. The browser calls the API with a Clerk Bearer token and a Workspace hint. Human links use the web origin. There is no API rewrite through Vercel.

Run `bun run env:check` before startup. It checks the three local files, database identities, origins, Clerk and Wrangler R2 selection without printing credentials. Verify deployed secrets and bindings separately. [The environment runbook](docs/runbooks/environments.md) records resource IDs and the candidate's isolation boundary.

## Cloud services

Cloudflare requires Workers Paid, Workflows, Durable Objects, uncached Hyperdrive and a private R2 bucket. Use account `5359f28d385b8632c3abee12d1f5b011`, owned by `murtazach275@gmail.com`. Native execution uses Modal workspace `murtazach275`, environment `main`.

Keep bindings in `apps/api/wrangler.jsonc`. Cloudflare's dashboard can edit a deployed Worker's bindings, but record the configuration in Git before deploying. The development launcher generates a local `remote: true` Service binding to the selected deployed Worker's `DevelopmentBindings` entrypoint. That Worker owns the real Workflows and progress/mailbox Durable Objects. Both ends must use the same database, epoch, signing keys and storage selection.

R2 CORS must allow each web origin, direct uploads and the `ETag` response header. Keep a verified seven-day incomplete-multipart abort rule. Application cleanup acts on exact admitted keys and rechecks current references and grant holds.

Scribe requires `ELEVENLABS_API_KEY`, `ELEVENLABS_WEBHOOK_ID` and the API's signing secret. Configure the signed completed-transcription webhook at `${API_ORIGIN}/api/webhooks/elevenlabs`. Durable correlated recovery shares its finalizer. Language selection, whole-source audio and provider-request uncertainty remain explicit. See [ADR0018](docs/adr/0018-elevenlabs-scribe-transcription.md).

OpenAI supplies clip selection, generated media, translation and speech. Provider/model settings live in the API example and the selected Modal secret stores. Pexels, Stripe, social developer apps and the existing email adapter are required only for their respective product flows.

### Native social publishing

Use one callback URL for every provider app, on the API origin:

```text
${API_ORIGIN}/api/social/oauth/callback
```

Required provider products/scopes:

- TikTok: Login Kit and Content Posting API with `user.info.basic`, `video.upload`, and `video.publish`.
- YouTube: YouTube Data API with `https://www.googleapis.com/auth/youtube.upload` and `https://www.googleapis.com/auth/youtube.readonly`.
- Instagram: Meta app with Instagram Graph API/Facebook Login permissions for `instagram_basic`, `instagram_content_publish`, `pages_show_list`, `pages_read_engagement`, and `business_management`; the account must be an Instagram Business or Creator account connected to a Facebook Page.
- LinkedIn: Sign In with LinkedIn/OpenID plus member posting permission `w_member_social`.
- X: OAuth 2.0 with `tweet.read`, `tweet.write`, `users.read`, `offline.access`, and `media.write`.

### MCP

Copy [`apps/mcp/.env.example`](apps/mcp/.env.example) to `apps/mcp/.env`.

Minimum values:

- `NARRIFLOW_API_KEY` set to a scoped Business-workspace key created in **Settings -> Developer access**.
- `NARRIFLOW_URL`: the API origin (`http://localhost:4000` locally), using HTTPS when hosted.

Run the stdio server with:

```bash
bun run dev:mcp
```

The optional stdio bridge forwards MCP messages to the API's `/mcp` endpoint.
The API authenticates every request and owns tools, resources, Apps, Tasks and
human links. The bridge needs no database credentials. The root
`bun run dev` command does not start it. Remote clients can also connect to
`/mcp` directly with OAuth or scoped workspace API keys.

Available tools:

- `narriflow_list_projects`
- `narriflow_get_project`
- `narriflow_get_workspace_usage`
- `narriflow_list_workspaces`
- `narriflow_list_autopilot_rules`
- `narriflow_create_rss_autopilot_rule`
- `narriflow_run_autopilot_rule_now`

For the remote endpoint, OAuth discovery, Codex/Claude setup, scopes, billing,
and deployment guidance, see [`docs/integrations/mcp.md`](docs/integrations/mcp.md).

## AI clip generation controls

Clip detection settings are stored in the latest content pack for each project:

- Default mode: best clips.
- Default count: 10 clips, configurable from 3 to 30.
- Default preferred duration: 30-60 seconds.
- Default hard duration: 15-90 seconds.
- Default platform targets: TikTok, YouTube Shorts, and Instagram Reels.
- Clips render automatically after detection in the selected aspect ratio.

Selection asks OpenAI for a larger candidate pool than the final clip count, repairs timings against word-level transcript data, deduplicates overlaps, then selects a diverse set across the source timeline. Ranking combines hook strength, emotional intensity, story completeness, pacing, duration fit, and platform scores.

## Database setup

`packages/db/prisma.config.ts` reads `packages/db/.env` and prefers `DIRECT_URL` over `DATABASE_URL`. Verify both target the intended database before applying migrations. Apply the committed chain once before deploying dependent code; never let an executor migrate.

```bash
bun install --frozen-lockfile
bun run --cwd packages/db prisma:migrate:deploy
bun run --cwd packages/db prisma:generate
```

Regenerate Prisma after schema changes. PostgreSQL needs pgvector for library search. The extension belongs in `public`; disposable-schema tests never drop it.

## Local pipeline

Start the selected cloud Worker, bindings and Modal deployment before local development. `bun run dev` starts the local web and API. The launcher uses local Hyperdrive connection settings and the remote scheduler binding, so verify their database identity agrees first.

```bash
bun run env:check
bun run dev
```

Web uses `http://localhost:3000`; API uses `http://localhost:4000`. Static `/api/health` does not query the database. `/api/ready` verifies the required migration names and execution admission state.

YouTube development uses the Mac's network through an allowlisted outbound device session. Build the pinned lean image as `narriflow-media:local-fetch`, obtain the session through the API's local-fetch route and keep its JSON file mode0600. Then run:

```bash
bun run fetch:local --session /absolute/private/device-session.json
```

The agent opens outbound connections only, runs at most two native jobs and has no DB credential. Its native startup check must match the configured fingerprint. At launch, the configured sticky HTTP proxy uses the same shared acquisition library. Proxy purchase remains deferred.

## Verification

```bash
bun run lint
bun run typecheck
bun run test
bun run --cwd apps/api test:inventory
bun run --cwd apps/api openapi:check
bun run --cwd apps/api build:worker
bun run check:web-split
bun run env:check
```

Build web with `NEXT_PUBLIC_API_URL` and run `bun run check:web-split -- --bundle` after the build. Fast tests skip database suites. Run every root `test:*:db` command separately with explicit isolated database variables. The guard accepts local `narriflow_serverless_gates_*` databases or the isolated serverless pipeline database, and rejects shared development before connecting. Local verification uses PostgreSQL17 with pgvector and disposable schemas.

[Native Linux CI](apps/media/scripts/gates/native-ci.md) builds the pinned image from tracked files, then runs native and fault tests with no external network or host credentials. Exact golden parity, real cloud fences, storage, restore, quota, latency and idle checks are separate [release gates](.scratch/serverless-cutover/spec.md#7-verification-gates). Record their raw evidence before calling the cutover complete.

### Local checks before pushing

GitHub Actions CI is disabled. The versioned `.githooks/pre-push` hook runs the checks locally and blocks the push on failure. `bun run prepare` installs the hooks; `bun run verify:local` runs the same verification manually. Use Bun1.3.6 and Node22 or newer.

The hook runs lint, cached types and unit tests, API contracts, the Worker import audit, the browser boundary check and environment consistency. PostgreSQL gates and resource-heavy suites are disabled by owner decision; see `AGENTS.md`.
