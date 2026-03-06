# Narriflow Monorepo

Bun-first monorepo for Narriflow.

## Stack

- Package manager + task runner: Bun
- Monorepo orchestrator: Turborepo
- Web app: Next.js 16
- API surface: Hono route handlers inside the web app
- Database: Prisma + PostgreSQL
- Background processing: custom Bun worker polling ingest jobs and `stt` workflow runs
- Media storage: Cloudflare R2
- Live workflow events: Upstash Redis pub/sub
- Auth: Clerk
- Speech-to-text: Deepgram `nova-3`

## Before Testing

You need these accounts and credentials before the ingest + transcription flow can be tested end to end:

| Service | Required now | Why |
| --- | --- | --- |
| PostgreSQL / Neon / Supabase Postgres | Yes | Stores projects, ingest jobs, workflow runs, and transcripts |
| Clerk | Yes | Required for sign-in and project ownership |
| Cloudflare R2 | Yes | Stores uploaded files, normalized source media, and raw transcription payloads |
| Deepgram | Yes | Required for the transcription stage |
| Upstash Redis | Recommended for real testing | Required for live workflow updates between the separate web and worker processes |
| Resend | Optional for this milestone | Only needed for email/webhook flows |
| Stripe | Optional for this milestone | Billing is not part of the current transcription milestone |
| OpenAI | Optional for this milestone | Reserved for later generation stages |

## Local Environment Files

Use app-local env files instead of inventing a root `.env`.

### Web

Copy [`apps/web/.env.example`](/Users/murtaza/Documents/dev/narriflow/apps/web/.env.example) to `apps/web/.env.local`.

Minimum values for the current milestone:

- `DATABASE_URL`
- `CLERK_PUBLISHABLE_KEY`
- `CLERK_SECRET_KEY`
- `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`
- `UPSTASH_REDIS_URL`
- `UPSTASH_REDIS_TOKEN`
- `R2_ACCOUNT_ID`
- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`
- `R2_BUCKET`

Notes:

- `CLERK_WEBHOOK_SECRET`, `RESEND_API_KEY`, and `NARRIFLOW_EMAIL_FROM` are only required if you are exercising the Clerk webhook and email path locally.
- `DEEPGRAM_API_KEY` is listed in the web example because many deployments share one secret set, but the web app does not use it directly for the current transcription flow.
- `TRIGGER_SECRET_KEY` is not used by the current custom worker polling flow.

### Worker

Copy [`apps/worker/.env.example`](/Users/murtaza/Documents/dev/narriflow/apps/worker/.env.example) to `apps/worker/.env`.

Minimum values for the current milestone:

- `DATABASE_URL`
- `UPSTASH_REDIS_URL`
- `UPSTASH_REDIS_TOKEN`
- `R2_ACCOUNT_ID`
- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`
- `R2_BUCKET`
- `DEEPGRAM_API_KEY`

Useful runtime settings:

- `PORT=4001`
- `INGEST_POLL_INTERVAL_MS=2500`

## Third-Party Setup

### Clerk

1. Create a Clerk application.
2. Enable the sign-in and sign-up methods you want to use locally.
3. Copy the publishable key and secret key into the web env.
4. Add the webhook secret if you plan to exercise the Clerk webhook route locally.

### Cloudflare R2

1. Create an R2 bucket.
2. Create an API token with object read/write access for that bucket.
3. Copy `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, and `R2_BUCKET` into both the web and worker env files.

### Deepgram

1. Create a Deepgram account.
2. Generate an API key.
3. Set `DEEPGRAM_API_KEY` in the worker env.

### Upstash Redis

1. Create a Redis database.
2. Copy the connection URL/token into both web and worker env files.

Why this matters:

- The worker publishes workflow events.
- The web app subscribes to workflow events for SSE.
- Without Upstash, the page can still recover state from the database on reload, but live progress updates between processes will be missing.

## Local Machine Dependencies

Install these on the machine that runs the worker:

- `ffmpeg`
- `yt-dlp`

Why:

- `ffmpeg` is required to extract transcription-ready audio before sending it to Deepgram.
- `yt-dlp` is required for the YouTube import path.

If you use the worker container, [`apps/worker/Dockerfile`](/Users/murtaza/Documents/dev/narriflow/apps/worker/Dockerfile) now installs both tools.

## Database Setup

Run this after `DATABASE_URL` is configured:

```bash
bun install
export DATABASE_URL="postgresql://user:password@localhost:5432/narriflow?schema=public"
export DIRECT_URL="$DATABASE_URL"
bun --cwd packages/db run prisma:migrate:dev
bun --cwd packages/db run prisma:generate
```

Important:

- `packages/db/prisma.config.ts` prefers `DIRECT_URL` and falls back to `DATABASE_URL`.
- For Neon, use a pooled connection for `DATABASE_URL` and a direct connection for `DIRECT_URL`.
- `apps/web/.env.local` is not automatically loaded when you run Prisma commands from `packages/db`.
- If you do not want to export it every time, copy [`packages/db/.env.example`](/Users/murtaza/Documents/dev/narriflow/packages/db/.env.example) to `packages/db/.env`.

## Local Pipeline

Run the apps in separate terminals:

```bash
bun --cwd apps/web run dev
```

```bash
bun --cwd apps/worker run dev
```

Or run both through Turbo:

```bash
bun run dev
```

Runtime ports:

- Web: `http://localhost:3000`
- Worker health: `http://localhost:4001/health`

## Test Flow For The Current Milestone

1. Start the web app and worker.
2. Sign in through Clerk.
3. Create a project by upload, YouTube URL, or RSS import.
4. Wait until ingest reaches `ready`.
5. Start transcription from the project page.
6. Confirm the worker claims an `stt` workflow run.
7. Confirm the transcript appears in the project page.
8. Export `TXT`, `SRT`, and `VTT`.

## Pre-Test Checklist

- `DATABASE_URL` points to a live Postgres database.
- Prisma migration for the `Transcript` model has been applied.
- Web and worker env files both exist.
- R2 credentials work from both processes.
- `DEEPGRAM_API_KEY` is present in the worker.
- Upstash credentials are present in both processes if you want live progress updates.
- `ffmpeg` and `yt-dlp` are installed on the worker host, or you are using the worker container.

## Verification Commands

```bash
bun run typecheck
bun run test
```
