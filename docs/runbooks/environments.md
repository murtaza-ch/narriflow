# Shared development environment

The serverless code uses local Next.js, a local Cloudflare API through Wrangler, one deployed Worker/Workflows environment and Modal Functions. The browser calls the API origin directly. Human links use the web origin. See [ADR0019](../adr/0019-serverless-execution.md).

The owner-directed development switch is in progress as of 2026-11-04. The original shared database has all163 migrations applied after backup and a successful local rehearsal. Users, Workspaces, Projects and Clips were preserved. The candidate remains isolated and closed. Full performance and end-to-end acceptance is deferred to owner testing; see [the cutover record](serverless-cutover.md).

## Resource selections

| Resource | Shared development | Isolated candidate |
| --- | --- | --- |
| Neon project | `narriflow-dev`, `ancient-violet-37185608` | Same project, separate branch/database |
| Branch | `production`, `br-twilight-surf-b5rozv0y` | `br-little-tooth-b5mlaj9i` |
| Database | `neondb` | `serverless_pipeline_gates` |
| Direct endpoint | `ep-rough-hill-b57kvyah.c-7.us-east-2.aws.neon.tech` | `ep-wispy-field-b5wyn9o3.c-7.us-east-2.aws.neon.tech` |
| API | `https://narriflow-api-dev.murtazach275.workers.dev` | `https://narriflow-api-candidate.murtazach275.workers.dev` |
| Hyperdrive | `52c739ac003143d8b1fc07d2603b68ad`, caching off, origin limit 30 | `89ce779c45464717afa3398590d531c5`, caching off |
| Modal | Workspace `murtazach275`, environment `main`, app `narriflow-media-dev` | Workspace `murtazach275`, environment `main`, app `narriflow-media-gates` |
| Storage | Private R2 `narriflow-dev` | Same bucket, exact owned fixture namespaces |
| Web | `https://narriflow-dev.vercel.app` | Local web or explicit candidate origin |

Cloudflare account `5359f28d385b8632c3abee12d1f5b011` belongs to `murtazach275@gmail.com`. Use that account for Wrangler, bindings and R2. The candidate has admission closed. Shared Workflows are `narriflow-import-dev`, `narriflow-render-dev`, `narriflow-operation-dev` and `narriflow-maintenance-dev`. Its bridge is `https://murtazach275--narriflow-media-dev-bridge.us-east.modal.run`. Both HTTP and PostgreSQL admission remain closed during migration and deployment wiring; the final versioned configuration reopens HTTP for the owner-directed switch. Do not use a shared-database local API with the isolated candidate's scheduler binding.

The retiring infrastructure is Railway project `3dbc2617-db01-4c86-a3f7-2d5b2ae5bc00`, environment `a7248225-c37b-4054-80a3-045424c006a0`, API `ba6b549f-56b3-4df3-9c24-91f5dfa4ee3b` and worker `194b54c2-54c8-41ff-ac1f-1d496e1611b7`. The prior API origin is `https://narriflowapi-dev.up.railway.app`. Upstash `narriflow-dev-live` has ID `af538fa1-440d-47ed-896e-c78ae9a6a409`. These identifiers are retained for the explicit stop/revoke/delete procedure, not for starting old consumers.

## Local configuration

Keep secrets only in `apps/api/.dev.vars`, `apps/web/.env.local` and `packages/db/.env`, plus the optional `apps/mcp/.env` containing bridge credentials. Root dotenv files are forbidden because Bun can autoload them into unrelated native children. Do not generate a root `.env.local` through Neon CLI deployment.

Web holds public configuration and the Clerk secret needed by its proxy. The API owns database, storage control, provider and encryption settings. Deployed API requests and Workflow steps receive the database through Hyperdrive. The launcher reads local `DATABASE_URL`/`DIRECT_URL` only to configure local Hyperdrive and removes them before creating Worker bindings. Media and the laptop never receive a database URL.

`apps/api/scripts/dev.ts` derives a temporary local Wrangler configuration from the versioned configuration. A `remote: true` Service binding calls the deployed Worker's `DevelopmentBindings` entrypoint for cloud Workflows and Durable Objects. Dashboard bindings are possible for deployed Workers; record every persistent binding in Wrangler before deploying. Verify local DB identity, deployed Hyperdrive target, storage, epoch and signing keys agree before starting development.

Keep `NEXT_PUBLIC_APP_URL=http://localhost:3000`, `NEXT_PUBLIC_API_URL=http://localhost:4000`, corresponding API origins, `NODE_ENV=development` and local allowed origins when syncing shared secrets. Check the selected resource settings selectively; do not replace the whole local file with a deployed environment.

```sh
bun run env:check
bun run dev
```

The environment check compares local database identities, origins, Clerk, obsolete runtime settings and the Wrangler R2 account/bucket. It never prints values. Deployed bindings and secret stores require separate verification.

## Migrations and tests

Prisma reads `packages/db/.env` and prefers `DIRECT_URL`. Verify both connection variables before migrations. Apply the committed chain once before running dependent code. Do not connect an old consumer to a migrated database or point two schedulers at the same database.

```sh
bun run --cwd packages/db prisma:migrate:deploy
bun run --cwd packages/db prisma:generate
```

Every root `test:*:db` command must use an isolated database. Test runners reject shared development before opening a pool. Accepted targets are a local database named `narriflow_serverless_gates_*`, or the exact isolated candidate database above. They create and remove disposable schemas. Use explicit environment variables rather than relying on app-local files.

CI supplies `narriflow_serverless_gates_ci` on PostgreSQL17 with pgvector, separately per domain job. Local gates use the same naming contract. Never run a test reset against `neondb`.

Run the test server in UTC (`timezone = 'UTC'`, as on Neon). Application SQL doesn't depend on the session time zone, but older migrations seed rows from the session clock. In another zone the seeded `ExecutionEpoch.changedAt` lands hours away, and export admission refuses with `render_admission_epoch_superseded`.

Library search requires `vector` in the `public` schema. Its cosine HNSW index lives in the migration because Prisma cannot express its index type. Keep the applied migration history and the extension while disposable schemas exist.

## Providers and media

Scribe uses `ELEVENLABS_API_KEY` and `ELEVENLABS_WEBHOOK_ID` in the API control steps, plus `ELEVENLABS_WEBHOOK_SECRET` for signed callbacks. The callback URL is `${API_ORIGIN}/api/webhooks/elevenlabs`. Update the provider's configured URL at cutover and verify both callbacks and correlated durable recovery. A waiting transcription owns no media container or database connection.

Social OAuth callbacks use `${API_ORIGIN}/api/social/oauth/callback`. Clerk, Stripe, Scribe, Zoom, MCP audience and integration clients must all use the selected API origin. Vercel builds with that same `NEXT_PUBLIC_API_URL` and the matching WebSocket CSP.

Social provider applications for the development API (set up 2026-11-05). Local and deployed development share these credentials. Changing the API origin means updating every redirect below, plus the TikTok webhook.

| Provider | Application | Access today | Registered redirects |
| --- | --- | --- | --- |
| TikTok | App `7683396282354599957`, sandbox "Local development" | Sandbox target user only. The production app is an unsubmitted draft. | Deployed API only; TikTok has no localhost redirect here. Webhook: `${API_ORIGIN}/api/webhooks/tiktok/publication`. |
| YouTube | Google Cloud `narrifllow-dev`, client `narriflow-dev` | Testing mode, listed test users only. | Deployed API and `http://localhost:4000`. |
| LinkedIn | App `265076568`, Company Page `145410479` | Share on LinkedIn and OpenID Connect are live. | Deployed API and `http://localhost:4000`. |
| X | App `33611538`, pay-per-use project | Prepaid credits; posts fail at $0 balance. | Deployed API and `http://localhost:4000`. |
| Meta | App `1420111250164816`, Facebook Login for Business | Unpublished. People with an app role only. No business portfolio yet. | Deployed API only. |

Worker secrets belong to a version. `wrangler rollback` to a version older than a secret change removes that secret from the live Worker, while `wrangler secret list` still shows it, because the list reads the latest version. After a rollback, check the active version with `wrangler versions view <id> --json`. To recover, run a normal `wrangler deploy` from a clean tree: it keeps the rolled-back code and inherits secrets from the latest version. Do not use `wrangler secret put` after a rollback, because it starts from the latest version.

Meta's Instagram and Pages use cases do not enable permissions on their own: each permission Narriflow requests must be added under Use cases → Customize, or the login dialog reports it as an invalid scope. Instagram uses the Facebook-login permissions (`instagram_basic`, `instagram_content_publish`), not `instagram_business_*`.

Native binaries, fonts and models are pinned by `apps/media/runtime-lock.json` and checked at build/start. Use `apps/media/images/Dockerfile` with the appropriate profile ignore file. Deploy from an immutable tracked archive; a live checkout changing during Modal upload invalidates that build. [Native CI](../../apps/media/scripts/gates/native-ci.md) runs without host environment files or external network.

YouTube development uses one allowlisted device session, the outbound LocalFetchMailbox socket and the pinned lean image. Keep the session JSON mode0600 and run `bun run fetch:local --session /absolute/private/device-session.json`. The agent checks the fingerprint before connecting. Production routes cannot use device execution. The sticky HTTP proxy path remains configured for launch; purchase is deferred.

R2 CORS admits the local and deployed web origins, direct PUT and readable ETags. Keep a verified enabled seven-day incomplete-MPU rule. Application cleanup uses exact admitted keys, reference/hold rechecks and current authority. Never list a bucket and infer unreferenced media from an old execution alone.

## Restore

Use [the execution restore procedure](execution-restore.md). Only the proved quiesced snapshot can authorize restore. A pre-retirement fixture backup is not that proof. Metadata recovery admits no external deliveries until the explicit redispatch stage. The epoch bump must fence every prior execution before reopening admission.
