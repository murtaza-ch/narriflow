# Cutover environment: variable names only

Names, never values. Written for ticket 31, 2026-10-29. Sources: `apps/api/src/config.ts`, `apps/api/src/runtime.ts` and the services the API runs (`process.env` reads), `apps/web` (`process.env` reads and Clerk's SDK), `apps/worker` (unchanged), the old `apps/web/.env.example`, and `.scratch/api-extraction/railway-facts.md`. `A` is the API's public HTTPS origin (Railway generates it when the service gets a domain; record it in `docs/runbooks/environments.md`), `W` is `https://narriflow-dev.vercel.app`.

## 1. Railway: new service `@narriflow/api` (environment `dev`)

Service settings (also in `apps/api/railway.json`): builder Dockerfile `apps/api/Dockerfile`, build context the repository root, region `us-east4` (next to Neon `us-east-2`; same as the worker), **no pre-deploy migration** (the worker owns `prisma:migrate:deploy`), health check `/api/ready`, draining 25 s, 1 replica, restart ON_FAILURE x5, watch patterns `/apps/api/**`, `/packages/**`, `/bun.lock`, `/package.json`, branch `dev` of `murtaza-ch/narriflow`. Generate a public domain (this is `A`). Pool budget: `DATABASE_POOL_MAX` (default 10) x replicas must stay within the Neon pooler's limit shared with the worker.

### Required (the process refuses to start without them)

`NODE_ENV` (= `production`), `API_ORIGIN` (= `A`), `WEB_ORIGIN` (= `W`), `CLERK_AUTHORIZED_PARTIES` (= `W`; add `http://localhost:3000` and `http://127.0.0.1:3000` only if local web must talk to the deployed API), `CLERK_SECRET_KEY`, `CLERK_PUBLISHABLE_KEY`, `CLERK_WEBHOOK_SECRET` (new Clerk endpoint, see section 4), `DATABASE_URL` (pooled; **not** `DIRECT_URL`).

`PORT` is set by Railway. `RAILWAY_GIT_COMMIT_SHA` is set by Railway.

### Required whenever the feature is used (set all of them for parity with Vercel's old set)

- CORS: `CORS_ALLOWED_ORIGINS` (= `W`; defaults to `WEB_ORIGIN`; never `A`, no wildcards).
- Ingress: `TRUSTED_CLIENT_IP_HEADER` = `x-real-ip` (Railway documents it as the client address; **verify on the live domain** that a caller-supplied value is overwritten and two clients get separate rate-limit buckets, otherwise every guest shares one bucket).
- Storage and events: `R2_ACCOUNT_ID`, `R2_BUCKET`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `UPSTASH_REDIS_URL` (same endpoint as the worker; `UPSTASH_REDIS_TOKEN` has no consumer).
- Stripe (all or none; with `STRIPE_SECRET_KEY` set the API validates the rest at startup): `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` (the new endpoint's `whsec_`), `STRIPE_PORTAL_CONFIGURATION_ID`, `STRIPE_PRICE_CREATOR_MONTHLY`, `STRIPE_PRICE_CREATOR_ANNUAL`, `STRIPE_PRICE_PRO_MONTHLY`, `STRIPE_PRICE_PRO_ANNUAL`, `STRIPE_PRICE_BUSINESS_MONTHLY`, `STRIPE_PRICE_BUSINESS_ANNUAL`, `STRIPE_PRICE_BUSINESS_SEAT_MONTHLY`, `STRIPE_PRICE_BUSINESS_SEAT_ANNUAL`.
- MCP and OAuth: `CLERK_OAUTH_ISSUER`, `CLERK_OAUTH_CONSENT_ORIGIN`, `MCP_ALLOWED_HOSTS`, `MCP_ALLOWED_ORIGINS`, `MCP_CONTINUATION_SECRET` (copy the existing value so issued links stay valid).
- Review and email: `REVIEW_ACCESS_SECRET` (same value as the worker), `REVIEW_SESSION_SECRET`, `RESEND_API_KEY`, `NARRIFLOW_EMAIL_FROM`.
- Social providers (a missing provider degrades to its typed refusal): `SOCIAL_TOKEN_ENCRYPTION_KEY` (same value as the worker), `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `NEXT_PUBLIC_GOOGLE_CLIENT_ID` (public Drive picker client ID, verifies picker tokens), `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET`. Not registered today, so leave unset: `META_CLIENT_ID`, `META_CLIENT_SECRET`, `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET`, `X_CLIENT_ID`, `X_CLIENT_SECRET`, `ZOOM_CLIENT_ID`, `ZOOM_CLIENT_SECRET`, `ZOOM_WEBHOOK_SECRET_TOKEN`.
- AI and media: `OPENAI_API_KEY`, `GENERATED_MEDIA_PROMPT_ACTIVE_KEY_VERSION`, `GENERATED_MEDIA_PROMPT_ENCRYPTION_KEY`, `GENERATED_MEDIA_PROMPT_DECRYPTION_KEYS_JSON`, `GENERATED_MEDIA_PROMPT_FINGERPRINT_KEY` (all four prompt values identical to the worker's), `PEXELS_API_KEY`.

### Optional tuning (defaults are validated; set only with a reason)

`DATABASE_POOL_MAX`, `DATABASE_POOL_IDLE_TIMEOUT_MS`, `DATABASE_POOL_CONNECTION_TIMEOUT_MS`, `API_STREAM_MAX_CONNECTIONS`, `API_STREAM_MAX_CONNECTIONS_PER_ACTOR`, `PLATFORM_STAFF_CLERK_USER_IDS`, `OPENAI_CLIP_MODEL`, `OPENAI_CONTENT_MODEL`, `OPENAI_ASSISTED_COPY_MODEL`, `OPENAI_TTS_MODEL`, `OPENAI_IMAGE_MODEL`, `OPENAI_IMAGE_QUALITY`, `ASSISTED_COPY_TIMEOUT_MS`, `GENERATED_IMAGE_MAX_ATTEMPTS`, `GENERATED_IMAGE_MAX_PROMPT_CHARACTERS`, `GENERATED_IMAGE_MAX_OUTPUT_BYTES`, `PEXELS_SEARCH_CACHE_TTL_SEC`, `EXPORT_BUNDLE_RETENTION_DAYS`, `R2_MULTIPART_CONCURRENCY`, `THUMBNAIL_EXTRACTION_CONCURRENCY`, `META_GRAPH_VERSION`, `LINKEDIN_API_VERSION`, `YOUTUBE_API_VERSION`, `YOUTUBE_UPLOAD_CHUNK_BYTES`, `UPLOAD_SINGLE_PUT_THRESHOLD_BYTES`, `UPLOAD_MULTIPART_PART_SIZE_BYTES`, `UPLOAD_MULTIPART_CONCURRENCY`, `UPLOAD_MAXIMUM_MULTIPART_PARTS`, `UPLOAD_MAXIMUM_GRANT_PARTS`, `UPLOAD_GRANT_TTL_SECONDS`, `UPLOAD_SESSION_IDLE_MS`, `UPLOAD_SESSION_HARD_LIFETIME_MS`.

Never on the API: `ASSEMBLYAI_API_KEY`, `DIRECT_URL`, `R2_INCOMPLETE_MULTIPART_LIFECYCLE_DAYS`, `SOCIAL_PUBLICATION_CHECKPOINT_KEY`, `WORKER_*`, `YTDLP_*`, `REFRAME_*` (worker only).

## 2. Vercel `narriflow-dev`: add, keep, remove

**Add (Production target, which this project deploys from `dev`; also Preview if previews are used):**

- `NEXT_PUBLIC_API_URL` = `A`. It is read at **build time** (CSP `connect-src`, docs examples, prerender) and at runtime, so it must exist before the build that ships this revision; changing it needs a new deployment. The build fails with an explicit message without it.

**Keep:** `NEXT_PUBLIC_APP_URL` (= `W`), `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY` (proxy only), `NEXT_PUBLIC_CLERK_SIGN_IN_URL`, `NEXT_PUBLIC_CLERK_SIGN_UP_URL`, `NEXT_PUBLIC_CLERK_SIGN_IN_FALLBACK_REDIRECT_URL`, `NEXT_PUBLIC_CLERK_SIGN_UP_FALLBACK_REDIRECT_URL`, `NEXT_PUBLIC_GOOGLE_API_KEY`, `NEXT_PUBLIC_GOOGLE_CLIENT_ID`, `NEXT_PUBLIC_GOOGLE_APP_ID`, `NEXT_PUBLIC_DROPBOX_APP_KEY`. `CLERK_PUBLISHABLE_KEY` is optional (the SDK prefers the `NEXT_PUBLIC_` name). `NODE_ENV` is set by Vercel.

**Remove (after the new revision is READY and verified; none are read by `apps/web` any more):**

- `ASSEMBLYAI_API_KEY`
- `CLERK_OAUTH_CONSENT_ORIGIN`
- `CLERK_OAUTH_ISSUER`
- `CLERK_WEBHOOK_SECRET`
- `DATABASE_URL`
- `DIRECT_URL`
- `EXPORT_BUNDLE_RETENTION_DAYS`
- `GENERATED_IMAGE_MAX_ATTEMPTS`
- `GENERATED_IMAGE_MAX_OUTPUT_BYTES`
- `GENERATED_IMAGE_MAX_PROMPT_CHARACTERS`
- `GENERATED_MEDIA_PROMPT_ACTIVE_KEY_VERSION`
- `GENERATED_MEDIA_PROMPT_DECRYPTION_KEYS_JSON`
- `GENERATED_MEDIA_PROMPT_ENCRYPTION_KEY`
- `GENERATED_MEDIA_PROMPT_FINGERPRINT_KEY`
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `INGEST_POLL_INTERVAL_MS`
- `LINKEDIN_API_VERSION`
- `LINKEDIN_CLIENT_ID`
- `LINKEDIN_CLIENT_SECRET`
- `MCP_ALLOWED_HOSTS`
- `MCP_ALLOWED_ORIGINS`
- `MCP_CONTINUATION_SECRET`
- `META_CLIENT_ID`
- `META_CLIENT_SECRET`
- `META_GRAPH_VERSION`
- `NARRIFLOW_EMAIL_FROM`
- `NEXT_PUBLIC_POSTHOG_HOST`
- `NEXT_PUBLIC_POSTHOG_KEY`
- `NEXT_PUBLIC_SENTRY_DSN`
- `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`
- `OPENAI_API_KEY`
- `OPENAI_IMAGE_MODEL`
- `OPENAI_IMAGE_QUALITY`
- `OTEL_EXPORTER_OTLP_ENDPOINT`
- `PEXELS_API_KEY`
- `R2_ACCESS_KEY_ID`
- `R2_ACCOUNT_ID`
- `R2_BUCKET`
- `R2_INCOMPLETE_MULTIPART_LIFECYCLE_DAYS`
- `R2_SECRET_ACCESS_KEY`
- `RESEND_API_KEY`
- `REVIEW_ACCESS_SECRET`
- `REVIEW_SESSION_SECRET`
- `SENTRY_AUTH_TOKEN`
- `SOCIAL_TOKEN_ENCRYPTION_KEY`
- `STRIPE_PORTAL_CONFIGURATION_ID`
- `STRIPE_PRICE_BUSINESS_ANNUAL`
- `STRIPE_PRICE_BUSINESS_MONTHLY`
- `STRIPE_PRICE_BUSINESS_SEAT_ANNUAL`
- `STRIPE_PRICE_BUSINESS_SEAT_MONTHLY`
- `STRIPE_PRICE_CREATOR_ANNUAL`
- `STRIPE_PRICE_CREATOR_MONTHLY`
- `STRIPE_PRICE_PRO_ANNUAL`
- `STRIPE_PRICE_PRO_MONTHLY`
- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `TIKTOK_CLIENT_KEY`
- `TIKTOK_CLIENT_SECRET`
- `UPSTASH_REDIS_TOKEN`
- `UPSTASH_REDIS_URL`
- `X_CLIENT_ID`
- `X_CLIENT_SECRET`
- `ZOOM_CLIENT_ID`
- `ZOOM_CLIENT_SECRET`
- `ZOOM_WEBHOOK_SECRET_TOKEN`

Also remove anything else holding a backend secret that is not on the keep list (old local-only names such as `DEEPGRAM_API_KEY`, `TRIGGER_SECRET_KEY`, `OPENAI_COPY_MODEL`, `GENERATED_IMAGE_*_LIMIT`/`*_CONCURRENCY` are not read by any app). Rotate nothing by default: the values move to Railway, they are not exposed. `bun run env:check` warns, by name, about backend settings left in the local web file.

## 3. Railway worker `@narriflow/worker`: changes

No variable is added or renamed and no code path calls the API. Check only:

- `WORKER_APP_BASE_URL` stays `W` (human links in notification emails), never `A`.
- Values that must equal the API's: `DATABASE_URL`, `R2_ACCOUNT_ID`, `R2_BUCKET`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `UPSTASH_REDIS_URL`, `SOCIAL_TOKEN_ENCRYPTION_KEY`, `REVIEW_ACCESS_SECRET`, `GENERATED_MEDIA_PROMPT_*` (four), `OPENAI_IMAGE_MODEL`, and the Stripe, Google and TikTok credentials it already holds.
- The worker remains the only service that runs `prisma:migrate:deploy` (pre-deploy). Deploy order for a revision that adds a migration: migrate (worker deploy or by hand), then API, then web.
- `apps/worker/Dockerfile` already copies `apps/api/package.json` for the frozen install; no change.

## 4. Provider re-registration (exact paths, `A` = API origin, `W` = web origin)

| Provider | Setting | New value |
| --- | --- | --- |
| Google Cloud (YouTube Shorts, Drive picker) | OAuth client > Authorized redirect URIs | add `A/api/social/oauth/callback`, remove `W/api/social/oauth/callback` |
| Google Cloud | Authorized JavaScript origins (Picker) | unchanged: `W` stays (and `http://localhost:3000`) |
| TikTok for Developers | Login Kit redirect URI | `A/api/social/oauth/callback` |
| TikTok for Developers | Content Posting webhook / callback URL | `A/api/webhooks/tiktok/publication` |
| Stripe (dashboard > Developers > Webhooks) | Endpoint URL | add `A/api/webhooks/stripe` with the same event types as `docs/runbooks/workspace-billing.md`; copy its new signing secret to `STRIPE_WEBHOOK_SECRET` on the API; delete the old `W/api/webhooks/stripe` endpoint after a replayed event succeeds. Checkout success/cancel and billing-portal return URLs are sent by the API and stay `W/settings/billing` |
| Clerk (Webhooks) | Endpoint URL | `A/api/webhooks/clerk`; copy its signing secret to `CLERK_WEBHOOK_SECRET` on the API; keep the same event subscriptions; delete the old `W/api/webhooks/clerk` endpoint |
| Clerk (OAuth applications / MCP resource) | Resource indicator and audience | exactly `A/mcp`; Clerk remains the issuer (`CLERK_OAUTH_ISSUER` on the API). Discovery moves to `A/.well-known/oauth-protected-resource`, `A/.well-known/oauth-protected-resource/mcp`, `A/.well-known/oauth-authorization-server`. Re-check audience claims, PKCE S256 and the nine application scopes with a real client |
| Clerk (sessions) | Session token `azp` | no registration; confirm a real token's `azp` equals `W` because `CLERK_AUTHORIZED_PARTIES` allows only listed origins |
| Zoom | OAuth redirect `A/api/zoom/oauth/callback`, event URL `A/api/webhooks/zoom` | none today (app unregistered) |
| Meta, LinkedIn, X | Redirect `A/api/social/oauth/callback` | none today (not configured) |

Client reconnection (not provider consoles): MCP clients (Codex, Claude, ChatGPT, Cursor) re-add `A/mcp`; Zapier and Make connections set **Narriflow URL** to `A`; n8n variable `NARRIFLOW_URL` = `A`; `apps/mcp/.env` `NARRIFLOW_URL` = `A`; `integrations/zapier` and `integrations/make` defaults are fail-loud placeholders until the hostname is assigned (ticket 32 replaces them). R2 bucket CORS keeps allowing `W`, `http://localhost:3000` and `http://127.0.0.1:3000` (browser uploads go straight to R2; the API origin is not a browser origin for R2).

## 5. Local files (set by the orchestrator, not by this ticket)

- `apps/api/.env` (new): from `apps/api/.env.example`; `API_ORIGIN=http://localhost:4000`, `WEB_ORIGIN=http://localhost:3000`, `CORS_ALLOWED_ORIGINS`/`CLERK_AUTHORIZED_PARTIES` = `http://localhost:3000`; every backend secret moves here from `apps/web/.env.local`.
- `apps/web/.env.local`: reduce to the keep list above plus `NEXT_PUBLIC_API_URL=http://localhost:4000`.
- `apps/worker/.env`, `packages/db/.env`: unchanged.
- Run `bun run env:check` (it compares all four) before `bun run dev`.
