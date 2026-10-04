# Shared development environment

Local web and worker processes, Vercel, and Railway use one development data
set. This is the standard setup for Narriflow's pre-production development.

## Resources

| Resource | Selection |
| --- | --- |
| Neon project | `narriflow-dev` (`fragrant-sun-47011044`) |
| Neon branch | `deployed-dev` (`br-fragrant-lab-aim9z0dg`) |
| PostgreSQL database | `neondb` |
| Pooled host | `ep-floral-dream-aiy6m4jd-pooler.c-4.us-east-1.aws.neon.tech` |
| Direct host | `ep-floral-dream-aiy6m4jd.c-4.us-east-1.aws.neon.tech` |
| R2 bucket | `narriflow-dev` |
| Cloudflare account | `5359f28d385b8632c3abee12d1f5b011` |
| Upstash database | `narriflow-dev-live` (`af538fa1-440d-47ed-896e-c78ae9a6a409`) |
| Redis endpoint | `solid-monkey-116348.upstash.io:6379`, with TLS |
| Vercel app | `narriflow-dev`, at `https://narriflow-dev.vercel.app` |
| Railway project | `narriflow-dev` (`3dbc2617-db01-4c86-a3f7-2d5b2ae5bc00`) |
| Railway environment | `dev` (`a7248225-c37b-4054-80a3-045424c006a0`) |
| Railway worker | `@narriflow/worker` (`194b54c2-54c8-41ff-ac1f-1d496e1611b7`) |

## Local configuration

Keep secrets in `apps/web/.env.local`, `apps/worker/.env`, and
`packages/db/.env`. Never create a root `.env` or commit real credentials.

Use the Railway worker's `dev` variables as the source for shared resource
settings. Set `DATABASE_URL` to the pooled connection and `DIRECT_URL` to the
direct connection, both for `neondb` on the shared branch. Web and worker use
the shared `R2_ACCOUNT_ID`, `R2_BUCKET`, R2 credentials, `UPSTASH_REDIS_URL`, and
`UPSTASH_REDIS_TOKEN`. Keep provider accounts and data encryption keys aligned
across the apps so jobs can move between worker processes.

Keep `NODE_ENV=development`, `NEXT_PUBLIC_APP_URL=http://localhost:3000`, and
native Python/model/yt-dlp paths in the local files. Do not replace a whole
local env file with Railway's container-specific settings.

The R2 bucket's CORS rules must include `http://localhost:3000`,
`http://127.0.0.1:3000`, and `https://narriflow-dev.vercel.app`. Keep its
seven-day incomplete multipart upload cleanup enabled.

Before starting localhost:

```sh
bun run env:check
bun run dev
```

The check compares local database identities, including any app `DIRECT_URL`,
R2 account/bucket, and Redis endpoint without printing secrets. It does not
connect to providers or inspect deployed variables. A local Redis service is
not needed.

## Workers and migrations

`bun run dev` starts both the web app and a local worker. Local and Railway
workers compete for the same durable queues through PostgreSQL claims and
leases. Either can process jobs created by either web app. Maintenance,
publishing, and data deletion affect that same shared data set.

For web-only development using the Railway worker:

```sh
bun run --cwd apps/web dev
```

Prisma prefers `DIRECT_URL` over `DATABASE_URL`. Apply each migration once to
the shared database before running code that requires it:

```sh
bun run --cwd packages/db prisma:migrate:deploy
```

The GitHub `dev` integration deploys the Vercel app and Railway worker.
Railway also runs the migration deployment command before starting its worker.
Disposable-schema database tests still create their own schemas and must clean
them up after the run.

## Fresh data and current contracts

Upload resume, Clip Editor Document, local Studio drafts, layout evidence,
composition plans, publishing intents, and protected generated-media prompts
use their current version 1 contracts. Unknown versions are rejected. These readers
do not upgrade unknown stored versions or automatically replace unknown layout
evidence. Provider API versions follow each provider's contract.

Apply `20261004000000_fresh_development_contracts` with writers stopped, then
run local web, deployed web, and workers from the same code revision. The
migration removes retired fields and statuses and aligns the database with
Prisma. Keep the applied migration history so a new database can be recreated.

## Layout evidence worker configuration

The worker validates layout settings at startup and shares them between background
proxy analysis and export. Invalid values fail startup instead of silently choosing
another value. Set these only in the intended worker environment.

| Setting | Default | Accepted values |
| --- | --- | --- |
| `WORKER_AUTO_LAYOUT_ANALYSIS` | `1` | `0` disables background analysis; `1` enables it |
| `WORKER_AUTO_LAYOUT_BATCH_SIZE` | `2` | Integer from 1 through 10; claims are sequential |
| `WORKER_AUTO_LAYOUT_LEASE_MS` | `180000` | Integer milliseconds from 30000 through 900000 |
| `WORKER_AUTO_LAYOUT_FAILURE_BACKOFF_MS` | `300000` | Nonnegative safe integer milliseconds; `0` allows immediate retry |
| `REFRAME_PYTHON` | `python3` | Interpreter with OpenCV and NumPy installed |
| `REFRAME_MODEL_PATH` | `/usr/local/share/narriflow/face_yunet.onnx` | YuNet model path |
| `REFRAME_SAMPLE_FPS` | `4` | Finite positive sample rate |
| `REFRAME_SCENE_THRESHOLD` | `0.3` | Finite value greater than 0 and at most 1 |
| `WORKER_LAYOUT_ENGINE`, `WORKER_SCREEN_LAYOUT`, `WORKER_SPLIT` | `1` | `0` disables that engine; `1` enables it |
| `WORKER_PIP_MOTION_THRESHOLD` | `0.12` | Finite value greater than 0 and at most 1 |
| `WORKER_PROBE_TIMEOUT_MS` | `120000` | Finite positive timeout for original source probing and detector commands |

Preview analysis probes the original source through WorkerProcess before running
normalized detections on the local proxy. The same original dimensions determine
preview and export zoom limits. A proxy that does not cover the complete Clip
window cannot publish Automatic evidence. Queue completion is fenced by the live
renewed claim lease, editor revision, and proxy identity. Ownership loss aborts
media work, and shutdown releases the current claim immediately. Transient
publication failures use the configured durable backoff.
