# Shared development environment

The serverless code uses local Next.js, a local Cloudflare API through Wrangler, one deployed Worker/Workflows environment and Modal Functions. The browser calls the API origin directly. Human links use the web origin. See [ADR0019](../adr/0019-serverless-execution.md).

The cutover is still in progress. Candidate resources below are isolated from the shared development database. The shared migration, API routing switch, old-consumer retirement and admission reopening have not been accepted. Follow [the cutover record](serverless-cutover.md) before changing these selections.

## Resource selections

| Resource | Shared development | Isolated candidate |
| --- | --- | --- |
| Neon project | `narriflow-dev`, `ancient-violet-37185608` | Same project, separate branch/database |
| Branch | `production`, `br-twilight-surf-b5rozv0y` | `br-little-tooth-b5mlaj9i` |
| Database | `neondb` | `serverless_pipeline_gates` |
| Direct endpoint | `ep-rough-hill-b57kvyah.c-7.us-east-2.aws.neon.tech` | `ep-wispy-field-b5wyn9o3.c-7.us-east-2.aws.neon.tech` |
| API | Routing switch pending | `https://narriflow-api-candidate.murtazach275.workers.dev` |
| Hyperdrive | Final selection pending | `89ce779c45464717afa3398590d531c5`, caching off |
| Modal | Final deployment selection pending | Workspace `murtazach275`, environment `main`, app `narriflow-media-gates` |
| Storage | Private R2 `narriflow-dev` | Same bucket, exact owned fixture namespaces |
| Web | `https://narriflow-dev.vercel.app` | Local web or explicit candidate origin |

Cloudflare account `5359f28d385b8632c3abee12d1f5b011` belongs to `murtazach275@gmail.com`. Use that account for Wrangler, bindings and R2. The candidate has admission closed. Do not use a shared-database local API with the isolated candidate's scheduler binding.

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

Library search requires `vector` in the `public` schema. Its cosine HNSW index lives in the migration because Prisma cannot express its index type. Keep the applied migration history and the extension while disposable schemas exist.

## Providers and media

Scribe uses `ELEVENLABS_API_KEY` and `ELEVENLABS_WEBHOOK_ID` in the API control steps, plus `ELEVENLABS_WEBHOOK_SECRET` for signed callbacks. The callback URL is `${API_ORIGIN}/api/webhooks/elevenlabs`. Update the provider's configured URL at cutover and verify both callbacks and correlated durable recovery. A waiting transcription owns no media container or database connection.

Social OAuth callbacks use `${API_ORIGIN}/api/social/oauth/callback`. Clerk, Stripe, Scribe, Zoom, MCP audience and integration clients must all use the selected API origin. Vercel builds with that same `NEXT_PUBLIC_API_URL` and the matching WebSocket CSP.

Native binaries, fonts and models are pinned by `apps/media/runtime-lock.json` and checked at build/start. Use `apps/media/images/Dockerfile` with the appropriate profile ignore file. Deploy from an immutable tracked archive; a live checkout changing during Modal upload invalidates that build. [Native CI](../../apps/media/scripts/gates/native-ci.md) runs without host environment files or external network.

YouTube development uses one allowlisted device session, the outbound LocalFetchMailbox socket and the pinned lean image. Keep the session JSON mode0600 and run `bun run fetch:local --session /absolute/private/device-session.json`. The agent checks the fingerprint before connecting. Production routes cannot use device execution. The sticky HTTP proxy path remains configured for launch; purchase is deferred.

R2 CORS admits the local and deployed web origins, direct PUT and readable ETags. Keep a verified enabled seven-day incomplete-MPU rule. Application cleanup uses exact admitted keys, reference/hold rechecks and current authority. Never list a bucket and infer unreferenced media from an old execution alone.

## Restore

Use [the execution restore procedure](execution-restore.md). Only the proved quiesced snapshot can authorize restore. A pre-retirement fixture backup is not that proof. Metadata recovery admits no external deliveries until the explicit redispatch stage. The epoch bump must fence every prior execution before reopening admission.
