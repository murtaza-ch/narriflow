# Railway facts (read 2026-10-29 via CLI)

- Account: murtazach275@gmail.com, workspace "Ghulam Murtaza's Projects", plan hobby.
- Project `narriflow-dev` (`3dbc2617-db01-4c86-a3f7-2d5b2ae5bc00`), env `dev`
  (`a7248225-c37b-4054-80a3-045424c006a0`). CLI is linked from the repo root.
- Worker `@narriflow/worker` (`194b54c2-…`): builder DOCKERFILE,
  `dockerfilePath` `/apps/worker/Dockerfile`, start `bun run apps/worker/src/index.ts`,
  healthcheck `/health`, pre-deploy `bun run --cwd packages/db prisma:migrate:deploy`
  (the worker is the single migration owner — API must not run migrations),
  region `us-east4-eqdc4a` (Virginia), 1 replica, restart ON_FAILURE ×10,
  watch patterns `/apps/worker/**`, `/**`, deploys from GitHub `murtaza-ch/narriflow` branch `dev`.
  No public domain.
- Neon is AWS `us-east-2`; us-east4 is Railway's closest US-East region. Put the
  API in `us-east4` too.
- Worker variables (names): ASSEMBLYAI_API_KEY DATABASE_URL DIRECT_URL
  GENERATED_IMAGE_* GENERATED_MEDIA_* GOOGLE_CLIENT_ID/SECRET INGEST_POLL_INTERVAL_MS
  NARRIFLOW_EMAIL_FROM NEXT_PUBLIC_APP_URL NODE_ENV OPENAI_API_KEY OPENAI_IMAGE_*
  PORT R2_* REFRAME_MODEL_PATH REFRAME_PYTHON RESEND_API_KEY
  SOCIAL_PUBLICATION_CHECKPOINT_KEY SOCIAL_TOKEN_ENCRYPTION_KEY STRIPE_PRICE_*
  STRIPE_SECRET_KEY TIKTOK_CLIENT_KEY/SECRET UPSTASH_REDIS_TOKEN/URL
  WORKER_APP_BASE_URL WORKFLOW_* intervals.
- Vercel `narriflow-dev` currently holds every backend secret (DB, Redis, R2? —
  check, Stripe, Clerk, OpenAI, AssemblyAI, Resend, social, review, MCP,
  generated-media keys). After cutover Vercel keeps only Clerk publishable/secret
  (for `proxy.ts`), `NEXT_PUBLIC_*` UI values and `NEXT_PUBLIC_API_URL`.
- Registered external providers in dev: Google (YouTube), TikTok, Stripe, Clerk.
  No Zoom/Meta/LinkedIn/X credentials anywhere.
