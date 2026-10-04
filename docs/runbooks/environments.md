# Local and deployed environments

This runbook records the two isolated development environments. Do not copy
secrets between them or download deployed variables over local env files.

## Local

- Neon branch: `local-murtaza` (`br-steep-breeze-aiwp6wmc`)
- Database: `narriflow_local`
- Redis: `redis://127.0.0.1:6379`, installed with `brew install redis` and run with `brew services start redis`
- R2 bucket: `narriflow-local-murtaza`, using scoped credentials
- R2 CORS allows `http://localhost:3000` and `http://127.0.0.1:3000`.
- R2 aborts incomplete multipart uploads after seven days.

The local branch inherited the default `neondb` database, but the applications
point only to the clean `narriflow_local` database. No inherited jobs were
consumed. Local web and worker settings live in `apps/web/.env.local` and
`apps/worker/.env`; migration settings live in `packages/db/.env`.

Start Redis, verify the three local env files, and then start both applications:

```sh
brew services start redis
bun run env:check
bun run dev
```

The root command starts the web app and worker together. Both databases have
the complete 91-migration chain applied.

## Deployed development

- Web: Vercel project `narriflow-dev`, at `narriflow-dev.vercel.app`
- Worker: Railway project `narriflow-dev`, service `@narriflow/worker`, environment `dev`
- Neon branch: `deployed-dev` (`br-fragrant-lab-aim9z0dg`)
- Database: `neondb`
- Redis: the existing deployed Upstash database
- R2 bucket: `narriflow-dev`

The GitHub `dev` integration auto-deploys the Vercel web app and Railway
worker. Apply migrations before starting the deployed processes:

```sh
bun run --cwd packages/db prisma:migrate:deploy
```

Run that command with the deployed database variables in the deployment
environment. Do not use it with local `packages/db/.env`, and do not overwrite
local files by downloading deployment variables.

## Verification on 13 September 2026

Vercel and Railway deployed commit `43be5e9` successfully. Railway applied its
pre-deploy migration check with no pending migrations. Its YouTube helper
started successfully. The previously failing YouTube source downloaded on
Railway and passed ffprobe validation: 955 seconds, 151,272,773 bytes. This is
a successful access test, not a guarantee against future provider restrictions.

The new local QA project `864531e8-7ceb-4cc9-b25b-9dad493ba601` completed import,
transcription, detection, and automatic rendering of three clips. All three
rendered objects were verified in the local R2 bucket. This project is absent
from the deployed database, which retained its seven existing projects.

`bun run env:check`, lint, typecheck, and the fast test command passed. The
checker and this runbook are local working-tree additions beyond the deployed
commit.

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
