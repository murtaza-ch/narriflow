# Shared development environment

Local web, API and worker processes, Vercel, and Railway use one development
data set. This is the standard setup for Narriflow's pre-production
development.

Three applications run: the web app (Next.js, Vercel) at origin **W**, the API
(Hono on Bun, Railway) at origin **A**, and the worker (Railway, no public
domain). The browser calls A directly with a Clerk session Bearer token; there
is no Vercel rewrite to the API. Providers, machine clients (REST, MCP, CLI
upload) and webhooks use A. Humans are sent to W. See
[the API extraction cutover](api-extraction-cutover.md) for the cutover steps
and [ADR 0017](../adr/0017-standalone-api.md) for the decision.

| Origin | Local | Deployed dev |
| --- | --- | --- |
| W (web) | `http://localhost:3000` | `https://narriflow-dev.vercel.app` |
| A (API) | `http://localhost:4000` | `https://narriflowapi-dev.up.railway.app` |
| Worker health | `http://localhost:4001/health` | none (no public domain) |

## Resources

| Resource | Selection |
| --- | --- |
| Neon project | `narriflow-dev` (`ancient-violet-37185608`) |
| Neon branch | `production` (`br-twilight-surf-b5rozv0y`) |
| PostgreSQL database | `neondb` |
| Pooled host | `ep-rough-hill-b57kvyah-pooler.c-7.us-east-2.aws.neon.tech` |
| Direct host | `ep-rough-hill-b57kvyah.c-7.us-east-2.aws.neon.tech` |
| R2 bucket | `narriflow-dev` |
| Cloudflare account | `5359f28d385b8632c3abee12d1f5b011` |
| Upstash database | `narriflow-dev-live` (`af538fa1-440d-47ed-896e-c78ae9a6a409`) |
| Redis endpoint | `solid-monkey-116348.upstash.io:6379`, with TLS |
| Vercel app | `narriflow-dev`, at `https://narriflow-dev.vercel.app` |
| Railway project | `narriflow-dev` (`3dbc2617-db01-4c86-a3f7-2d5b2ae5bc00`) |
| Railway environment | `dev` (`a7248225-c37b-4054-80a3-045424c006a0`) |
| Railway worker | `@narriflow/worker` (`194b54c2-54c8-41ff-ac1f-1d496e1611b7`) |
| Railway API | `@narriflow/api` (`ba6b549f-56b3-4df3-9c24-91f5dfa4ee3b`) at `https://narriflowapi-dev.up.railway.app` (target port 8080, `PORT=8080`). Settings live on the service, not in a file (Railway deprecated config-as-code): variable `RAILWAY_DOCKERFILE_PATH=apps/api/Dockerfile`, region `us-east4` (next to Neon `us-east-2`), health check `/api/ready` (300 s timeout, longer than the API's 180 s readiness deadline), 25 s draining, restart on failure ×5, watch paths `/apps/api/**`, `/packages/**`, `/bun.lock`, `/package.json`, `/patches/**`, branch `dev`, no pre-deploy migration (the worker owns them) |

## Local configuration

Keep secrets in `apps/api/.env`, `apps/web/.env.local`, `apps/worker/.env`, and
`packages/db/.env`. Never create a root `.env` or commit real credentials. The
web file holds only `NEXT_PUBLIC_*` values and the Clerk secret its proxy needs;
every backend credential lives in the API and worker files.

The Neon CLI links this checkout through the ignored `.neon` file. `neon.ts`
declares Postgres only; Clerk, R2, and Upstash remain the app's other providers.
`neon deploy` pulls Neon variables into the ignored root `.env.local`. This
file is CLI output, not the web or worker's runtime configuration. When changing
the connection, update the app-local files (`apps/api/.env`,
`packages/db/.env`, `apps/worker/.env`), `apps/mcp/.env`, and the Railway `dev`
API and worker. Vercel no longer holds a database URL. Map Neon's `DATABASE_URL_UNPOOLED` to
the app's `DIRECT_URL`, then redeploy the Railway services and restart local apps.

Use the Railway worker's `dev` variables as the source for shared resource
settings. Set `DATABASE_URL` to the pooled connection and `DIRECT_URL` to the
direct connection, both for `neondb` on the shared branch. The API runtime uses
the pooled URL only; `DIRECT_URL` belongs to the migration job on the worker.
API and worker use the shared `R2_ACCOUNT_ID`, `R2_BUCKET`, R2 credentials and
`UPSTASH_REDIS_URL` (the URL carries the credential; `UPSTASH_REDIS_TOKEN` has
no consumer). Keep provider accounts and data encryption keys aligned across
the API and worker so jobs can move between worker processes.

Keep `NODE_ENV=development`, `NEXT_PUBLIC_APP_URL=http://localhost:3000`,
`NEXT_PUBLIC_API_URL=http://localhost:4000` (web), `API_ORIGIN`/`WEB_ORIGIN` (API),
`WORKER_APP_BASE_URL=http://localhost:3000` (worker; it is the web origin), and
native Python/model/yt-dlp paths in the local files. Do not replace a whole
local env file with Railway's container-specific settings.

The R2 bucket's CORS rules must include `http://localhost:3000`,
`http://127.0.0.1:3000`, and `https://narriflow-dev.vercel.app`: the browser
uploads to R2 directly. The API origin is not a browser origin for R2. Keep its
seven-day incomplete multipart upload cleanup enabled.

Before starting localhost:

```sh
bun run env:check
bun run dev
```

The check reads the API, web, worker and db files and compares database
identities (including any app `DIRECT_URL`), R2 account/bucket, the Redis
endpoint, image generation settings, the shared encryption and review secrets,
the Clerk instance, and the origins (`NEXT_PUBLIC_API_URL` against `API_ORIGIN`,
`NEXT_PUBLIC_APP_URL` against `WEB_ORIGIN`, `CORS_ALLOWED_ORIGINS` and
`CLERK_AUTHORIZED_PARTIES` against the web origin, `WORKER_APP_BASE_URL` against
the web origin) without printing secrets. It warns by name about backend
settings left in the web file. It does not connect to providers or inspect
deployed variables. A local Redis service is not needed.

Deployed variables are listed by name in
`.scratch/api-extraction/deploy-env.md`; verify them in Vercel and Railway
separately.

## Workers and migrations

`bun run dev` starts the web app, the API and a local worker. Local and Railway
workers compete for the same durable queues through PostgreSQL claims and
leases. Either can process jobs created by either web app. Maintenance,
publishing, and data deletion affect that same shared data set.

A worker joins the shared queue only on a platform listed in
`apps/worker/runtime-lock.json`. `linux-x64` is the authoritative Railway image;
`darwin-arm64` is a non-authoritative entry pinned to the Homebrew FFmpeg on
the development Mac (8.0.1). Check a local toolchain with
`bun apps/worker/scripts/check-render-environment.ts --enforce`. After
`brew upgrade ffmpeg`, update that entry's `ffmpeg.versionString`; otherwise the
worker logs `render_environment_invalid` with the mismatch and restarts.

For web and API development using the Railway worker:

```sh
bun run --cwd apps/api dev
bun run --cwd apps/web dev
```

Prisma prefers `DIRECT_URL` over `DATABASE_URL`. Apply each migration once to
the shared database before running code that requires it:

```sh
bun run --cwd packages/db prisma:migrate:deploy
```

### Library search and pgvector

`20261024140000_library_search` runs `CREATE EXTENSION IF NOT EXISTS vector WITH
SCHEMA public` and refers to `public.vector` everywhere, so migrations resolve
the type whatever `search_path` they run with. The shared database (Neon
`narriflow-dev`) needs no setup: Neon ships pgvector on every plan and the
migration role can create it. Any other PostgreSQL that runs migrations,
including the CI service (`pgvector/pgvector:pg17`) and local databases, needs
pgvector installed. The extension belongs to the database. The disposable-schema
gates create it in `public` if it is missing and never drop it; do not drop it
while schemas that use it exist.

The cosine HNSW index `TranscriptPassage_embedding_idx` exists only in the
migration, because Prisma has no index type for it. `prisma migrate diff` lists
it as the one difference; leave it in place.

Both the local and the Railway worker run the `library_index` loop and claim
transcripts through PostgreSQL, so either can index for the other. A worker
that runs this code before the migration is applied fails the `library_index`
loop on every tick (the new table and columns do not exist yet) and, like any
loop, makes the worker exit after 20 consecutive failures, about three minutes.
Apply the migration first. The loop uses `OPENAI_API_KEY` and waits without it; the API needs the
same key to embed search queries. After the migration, existing finished
transcripts are indexed in the background, `LIBRARY_INDEX_BATCH_SIZE` per tick.

A transcript that fails eight times is left alone, with the reason in
`Transcript.passagesIndexError`. After fixing the cause, reset it with
`UPDATE "Transcript" SET "passagesAttempts" = 0 WHERE "passagesIndexError" IS NOT NULL AND "passagesAttempts" >= 8`.

### Workspace Events

The `20261024130000_workspace_events` migration was edited in place after it was
written and before it was ever applied to a shared database: it first created
`WorkspaceEvent` and `WorkspaceEventCounter`, then gained `WorkspaceEventKey` and
`ClipExport.retryCount`. Before deploying, check `_prisma_migrations` on the shared
database. If that migration is already recorded there, Prisma reports a checksum
mismatch and the added objects need their own follow-up migration instead.

Apply `20261024130000_workspace_events` before any API or worker revision that
uses it. Every settlement of an import, generation, export or post writes
Workspace Events, so code running against a database without the migration
fails those settlements.

The GitHub `dev` integration deploys the Vercel app and the Railway API and
worker. Railway runs the migration deployment command before starting the
worker only; the API never migrates. `/api/ready` compares the migration names
shipped in its image with finished, non-rolled-back `_prisma_migrations` rows.
Pending or failed migrations return 503 until the worker pre-deploy command
finishes. Both successes and failures are cached for five seconds, concurrent
health requests share one probe, and each response waits at most two seconds.
The check only reads the database and requires neither Redis nor providers.

The API exits with status 1 if it cannot become ready within 180 seconds of
the first readiness probe, so a failed worker migration cannot leave it waiting indefinitely.
Railway keeps the prior healthy API deployment and applies its configured
health-check timeout and restart policy. Logs name pending migrations with
`api_database_migrations_pending`, query failures with
`api_database_readiness_unavailable`, and the startup deadline with
`api_database_startup_deadline_exceeded`. Fix the worker's migration failure
and redeploy the API; never mark missing migrations applied to bypass readiness.
If the API deployment fails with migrations pending because the worker's build
finished late, redeploy the API once the worker deployment is live.
For a migration that cannot run safely with the prior revision, stop writers
and apply it before deploying the new revision.
Disposable-schema database tests still create their own schemas and must clean
them up after the run.

## Fresh data and current contracts

Upload resume, Clip Editor Document, local Studio drafts, layout evidence,
composition plans, publishing intents, and protected generated-media prompts
use their current version 1 contracts. Unknown versions are rejected. These readers
do not upgrade unknown stored versions or automatically replace unknown layout
evidence. Provider API versions follow each provider's contract.

Apply `20261004000000_fresh_development_contracts` with writers stopped, then
run local web, API and workers, and the deployed apps, from the same code revision. The
migration removes retired fields and statuses and aligns the database with
Prisma. Keep the applied migration history so a new database can be recreated.

## Layout evidence worker configuration

The worker validates layout settings at startup and shares them between background
proxy analysis and export. Invalid values fail startup instead of silently choosing
another value. All implemented analysis engines run without feature switches.

| Setting | Default | Accepted values |
| --- | --- | --- |
| `WORKER_AUTO_LAYOUT_BATCH_SIZE` | `2` | Integer from 1 through 10; claims are sequential |
| `WORKER_AUTO_LAYOUT_LEASE_MS` | `180000` | Integer milliseconds from 30000 through 900000 |
| `WORKER_AUTO_LAYOUT_FAILURE_BACKOFF_MS` | `300000` | Nonnegative safe integer milliseconds; `0` allows immediate retry |
| `REFRAME_PYTHON` | `python3` | Interpreter with OpenCV and NumPy installed |
| `REFRAME_MODEL_PATH` | `/usr/local/share/narriflow/face_yunet.onnx` | YuNet model path |
| `REFRAME_SAMPLE_FPS` | `4` | Finite positive sample rate |
| `REFRAME_SCENE_THRESHOLD` | `0.3` | Finite value greater than 0 and at most 1 |
| `WORKER_PIP_MOTION_THRESHOLD` | `0.12` | Finite value greater than 0 and at most 1 |
| `WORKER_PROBE_TIMEOUT_MS` | `120000` | Finite positive timeout for original source probing and detector commands |

Preview analysis probes the original source through WorkerProcess before running
normalized detections on the local proxy. The same original dimensions determine
preview and export zoom limits. A proxy that does not cover the complete Clip
window cannot publish Automatic evidence. Queue completion is fenced by the live
renewed claim lease, editor revision, and proxy identity. Ownership loss aborts
media work, and shutdown releases the current claim immediately. Transient
publication failures use the configured durable backoff.

## Shared-queue render health and recovery

Shared render and preview consumers must run the pinned worker image. Startup
reserves `PORT` first, default `4001`, and verifies the runtime lock, model,
vendored fonts, required filters and an actual libass glyph render before media
admission. Report-only native hosts may run the isolated golden fixtures, but
cannot claim shared render/preview work. An isolated-fixture override does not
relax this check. Use a single non-watch worker for shared-queue verification.

`/health` combines the existing poll-loop stall watchdog with executor health,
shutdown state and scratch headroom. It reports resource reservations, waiting
uploads, CPU ownership and background queue age. Spawn/configuration failures
quarantine media starts immediately. Readiness is checked after 30 seconds;
two failed checks initiate a nonzero graceful recycle. Source transport fallback
and optional-asset degradation do not repair executor failures.

An unstarted claim or disk deferral is released under the current fence, refunds
that claim and backs off for the shutdown drain before another executor can
claim it. Before group-worker integration, a parent that already started a full
encode keeps its charge on executor/resource release. Completed siblings remain
completed. Shutdown retains its existing refundable release protocol. Ticket 20
must carry this behavior over to the group release/execution ledger.

The CPU scheduler admits one render group or one background preview, automatic
layout or thumbnail batch at a time. Each background batch starts at most one
item; one waiting background item gets a turn between render groups. Already
running work finishes within its operation bound or observes shutdown.

Worker-owned scratch and the b-roll cache are swept at startup and every
`WORKER_SCRATCH_SWEEP_INTERVAL_MS`, default ten minutes. Scratch must have a valid
owner marker, an expired grace period, no live local owner PID and no unexpired
workflow/group claim. Unknown/unmarked paths are preserved. B-roll entries are
copied into group scratch before use; cache pruning does not remove those copies.
Reference-aware object reconciliation runs hourly for one project and one page
per render/export prefix, with a two-minute pass budget. It stays dry-run. Review
its evidence before invoking `reconcile:render-objects --project <uuid> --delete`;
the explicit command rechecks references and protects objects younger than 24h.

Deployment draining must be **at least `WORKER_SHUTDOWN_DRAIN_MS`**, default
30 seconds. This must be configured on Railway before deployment, separately
from the release/reclaim tests. Read-only inspection on 2026-10-30 confirmed the
worker's `startCommand` overrides Dockerfile `CMD` and `/health` is configured,
but the returned live config did not declare draining duration. It is not
verified and was not changed here. Ticket 21 must verify the effective value
and a drained deployment's release/reclaim behavior.

Incomplete multipart uploads require an enabled, whole-bucket abort lifecycle
rule with a finite age, currently documented as seven days for `narriflow-dev`.
`R2_INCOMPLETE_MULTIPART_LIFECYCLE_DAYS` is a startup prerequisite declaration,
not proof of provider configuration. A read-only S3
`GetBucketLifecycleConfiguration` on 2026-10-30 returned `AccessDenied` / HTTP
403 with the worker credentials, so the deployed rule remains unverified.
An account operator must inspect the Cloudflare bucket lifecycle and record the
enabled rule, scope and abort age before the deployment gate closes. No bucket
policy or Railway setting was changed during ticket 17.
