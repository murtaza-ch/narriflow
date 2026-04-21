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
- Speech-to-text: AssemblyAI Universal-3 Pro with Universal-2 fallback
- Clip detection: OpenAI Responses API, default `gpt-5.4-mini`
- Rendering: FFmpeg/ffprobe

## Before Testing

You need these accounts and credentials before the ingest, transcription, clip detection, and rendering flow can be tested end to end:

| Service | Required now | Why |
| --- | --- | --- |
| PostgreSQL / Neon / Supabase Postgres | Yes | Stores projects, ingest jobs, workflow runs, and transcripts |
| Clerk | Yes | Required for sign-in and project ownership |
| Cloudflare R2 | Yes | Stores uploaded files, normalized source media, raw transcription payloads, and rendered clips |
| AssemblyAI | Yes | Required for the transcription stage |
| Upstash Redis | Recommended for real testing | Required for live workflow updates between the separate web and worker processes |
| Resend | Optional for this workflow | Only needed for email/webhook flows |
| Stripe | Optional for this workflow | Billing is not part of the current clips workflow |
| OpenAI | Yes for clip generation | Required for AI moment/clip detection after transcription |

## End-to-End Clips Workflow

Narriflow turns a source media input into rendered short clips through four background stages:

1. Ingest: accepts an uploaded file, YouTube URL, or RSS episode and stores the normalized source media in Cloudflare R2.
2. Transcription: extracts audio with FFmpeg, uploads it to AssemblyAI, and requests Universal-3 Pro with Universal-2 fallback for speech-to-text, speaker labels, utterance timing, and word timing.
3. Moment detection: sends the completed transcript to OpenAI through the Responses API. The default model is `gpt-5.4-mini`, and the worker requests strict JSON output for clip candidates.
4. Clip rendering: creates subtitle files, crops/scales video for the requested aspect ratios, burns captions with FFmpeg, uploads MP4 renders to R2, and exposes downloads through presigned URLs.

The worker polls work in this order: ingest jobs, `stt`, `moment_detection`, then `clip_rendering`.

```mermaid
flowchart TD
  A["User input source"] --> B{"Source type"}
  B --> C["File upload"]
  B --> D["YouTube URL"]
  B --> E["RSS episode"]

  C --> F["Web API: presign multipart upload"]
  F --> G["Browser uploads directly to Cloudflare R2"]
  G --> H["Web API: complete upload"]
  H --> I["IngestJob: upload_finalize"]

  D --> J["IngestJob: youtube_import"]
  J --> K["Worker downloads with yt-dlp"]
  E --> L["IngestJob: rss_import"]
  L --> M["Worker downloads enclosure"]

  I --> N["Project source stored in R2"]
  K --> N
  M --> N

  N --> O["User starts generation"]
  O --> P["WorkflowRun: stt"]
  P --> Q["Worker downloads media from R2"]
  Q --> R["FFmpeg extracts mono 16 kHz audio"]
  R --> S["AssemblyAI transcription"]
  S --> T["Transcript saved in Postgres; raw payload saved in R2"]

  T --> U["Auto-queue WorkflowRun: moment_detection"]
  U --> V["Worker formats transcript chunks"]
  V --> W["OpenAI gpt-5.4-mini finds clip-worthy moments"]
  W --> X["Validate JSON; normalize timing; compute scores"]
  X --> Y["Clip rows saved in Postgres"]
  Y --> Z["Auto-queue default 9:16 renders"]
  Z --> AA["WorkflowRun: clip_rendering"]
  AA --> AB["ffprobe inspects source media"]
  AB --> AC["Generate SRT or ASS captions"]
  AC --> AD["FFmpeg crops, scales, burns captions, encodes MP4"]
  AD --> AE["Rendered clips uploaded to R2"]
  AE --> AF["User downloads via presigned R2 URL"]

  P -.progress.-> GG["WorkflowEvent table + Upstash Redis pub/sub"]
  U -.progress.-> GG
  AA -.progress.-> GG
  GG --> HH["SSE stream updates project page"]
```

## Service Responsibilities

| Service or model | Role in the workflow |
| --- | --- |
| Clerk | Authenticates users and gates project access. |
| Cloudflare R2 | Stores source media, raw transcription JSON, and rendered MP4 clips. |
| PostgreSQL + Prisma | Stores projects, ingest jobs, workflow runs, transcripts, clips, render variants, and workflow events. |
| Upstash Redis | Broadcasts workflow events to the web app for live progress updates. Events are also persisted in Postgres. |
| AssemblyAI Universal-3 Pro + Universal-2 | Converts extracted audio into transcript text, speaker-separated utterances, punctuation, and word timings. |
| OpenAI `gpt-5.4-mini` | Analyzes transcripts and returns structured clip candidates with timestamps, hook text, category, reasoning, and scores. |
| FFmpeg | Extracts audio for transcription and renders final MP4 clips with cropped video and burned captions. |
| ffprobe | Reads source media stream metadata such as width, height, audio presence, and video presence. |
| yt-dlp | Downloads YouTube sources before they are stored in R2. |

## Technical Terms

- Ingest: preparing an input source so the rest of the pipeline can process it.
- Workflow run: a queued background stage such as `stt`, `moment_detection`, or `clip_rendering`.
- Ingest job: a queued background task for source preparation, such as YouTube or RSS import.
- STT: speech-to-text.
- Utterance: a timed block of speech, usually a speaker turn or sentence-like segment.
- Diarization: separating speakers in a transcript.
- Word timing: timestamps for individual words, used for accurate captions.
- Content pack: generation preferences such as target clip count, target duration, tone constraints, and caption preset.
- Idempotency key: a request key that helps avoid duplicate queued work.
- SRT: a simple subtitle format with numbered timestamp cues.
- ASS: a richer subtitle format that supports positioning and per-word styling.
- Presigned URL: a temporary URL for uploading or downloading R2 objects without exposing storage credentials.
- SSE: Server-Sent Events, a browser stream used for one-way live updates from the server.
- Pub/sub: publish/subscribe messaging; here, Redis broadcasts workflow events to connected clients.

## Local Environment Files

Use app-local env files instead of inventing a root `.env`.

### Web

Copy [`apps/web/.env.example`](/Users/murtaza/Documents/dev/narriflow/apps/web/.env.example) to `apps/web/.env.local`.

Minimum values for the current clips workflow:

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
- `ASSEMBLYAI_API_KEY` and `OPENAI_API_KEY` are listed in the web example because many deployments share one secret set, but the web app does not use them directly in the current worker-driven generation flow.
- `TRIGGER_SECRET_KEY` is not used by the current custom worker polling flow.

### Worker

Copy [`apps/worker/.env.example`](/Users/murtaza/Documents/dev/narriflow/apps/worker/.env.example) to `apps/worker/.env`.

Minimum values for the current clips workflow:

- `DATABASE_URL`
- `UPSTASH_REDIS_URL`
- `UPSTASH_REDIS_TOKEN`
- `R2_ACCOUNT_ID`
- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`
- `R2_BUCKET`
- `ASSEMBLYAI_API_KEY`
- `OPENAI_API_KEY`

Useful runtime settings:

- `PORT=4001`
- `INGEST_POLL_INTERVAL_MS=2500`
- `ASSEMBLYAI_POLL_INTERVAL_MS=5000`
- `ASSEMBLYAI_POLL_TIMEOUT_MS=7200000`
- `OPENAI_CLIP_MODEL=gpt-5.4-mini`
- `OPENAI_CLIP_REASONING_EFFORT=medium`

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

### AssemblyAI

1. Create an AssemblyAI account.
2. Generate an API key.
3. Set `ASSEMBLYAI_API_KEY` in the worker env.
4. The worker uses `speech_models: ["universal-3-pro", "universal-2"]`, `speaker_labels: true`, and `language_detection: true`.

### OpenAI

1. Create an OpenAI API key.
2. Set `OPENAI_API_KEY` in the worker env.
3. Optionally override the clip detection model with `OPENAI_CLIP_MODEL`.

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

- `ffmpeg` is required to extract transcription-ready audio before uploading it to AssemblyAI.
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

## Test Flow

1. Start the web app and worker.
2. Sign in through Clerk.
3. Create a project by upload, YouTube URL, or RSS import.
4. Wait until ingest reaches `ready`.
5. Start transcription from the project page.
6. Confirm the worker claims an `stt` workflow run.
7. Confirm the transcript appears in the project page.
8. Confirm the worker auto-queues and completes `moment_detection`.
9. Confirm detected clips appear in the project page.
10. Confirm the worker auto-queues default `9:16` renders, or trigger rendering manually.
11. Download completed rendered clips from the project page.
12. Export transcript `TXT`, `SRT`, and `VTT` if needed.

## Transcription Validation

For a local AssemblyAI transcription test, configure the worker env with `ASSEMBLYAI_API_KEY`, start the web app and worker, ingest a source, and start transcription from the project page. The completed transcript row should show provider `assemblyai`, the raw AssemblyAI JSON should be stored under `projects/{projectId}/transcripts/` in R2, and clip detection should auto-queue without provider-specific changes.

For a quality bakeoff against older archived outputs, run the same source media through the AssemblyAI pipeline and compare:

- full transcript quality
- speaker consistency
- utterance boundaries
- word timestamp alignment
- burned caption sync after FFmpeg rendering
- GPT-5.4-mini clip candidate quality
- total STT cost per hour

## Pre-Test Checklist

- `DATABASE_URL` points to a live Postgres database.
- Prisma migration for the `Transcript` model has been applied.
- Web and worker env files both exist.
- R2 credentials work from both processes.
- `ASSEMBLYAI_API_KEY` is present in the worker.
- `OPENAI_API_KEY` is present in the worker for clip detection.
- Upstash credentials are present in both processes if you want live progress updates.
- `ffmpeg` and `yt-dlp` are installed on the worker host, or you are using the worker container.

## Verification Commands

```bash
bun run typecheck
bun run test
```
