# API extraction cutover

The backend moved out of the Next.js app into the standalone API (`apps/api`, Railway) in one coordinated cutover; see [ADR 0017](../adr/0017-standalone-api.md). Narriflow is pre-production, so there is no compatibility layer and no mixed-version window to protect: the web app, API and worker are deployed from the same revision, and provider registrations and client connections move with them. Variable names, sources and the provider table live in `.scratch/api-extraction/deploy-env.md`; this runbook is the order and the checks.

## Before pushing

1. `bun run lint`, `bun run typecheck`, `bun run test`, `bun run --cwd apps/api test:inventory`, `bun run --cwd apps/api openapi:check`.
2. `NEXT_PUBLIC_API_URL=http://localhost:4000 bun run --cwd apps/web build`, then `bun run check:web-split -- --bundle`.
3. Every `bun run test:*:db` gate on a disposable schema (never the shared database).
4. `docker build -f apps/api/Dockerfile -t narriflow-api:extraction .` and `docker run --rm --entrypoint bun --workdir /app/apps/api narriflow-api:extraction scripts/native-smoke.ts` (font metadata, argon2 passcode hashing, sharp and ffprobe, FFmpeg thumbnail).
5. Local `bun run env:check` passes with `apps/api/.env`, `apps/web/.env.local`, `apps/worker/.env` and `packages/db/.env`.

## Order

1. Create the Railway service `@narriflow/api` (settings and variables in `deploy-env.md`), generate its public domain, set `API_ORIGIN` and record the domain in [the environment runbook](environments.md). Do not deploy traffic-bearing web yet.
2. Set `NEXT_PUBLIC_API_URL` on Vercel (build-time variable), `CLERK_AUTHORIZED_PARTIES` and `WEB_ORIGIN`/`CORS_ALLOWED_ORIGINS` on the API.
3. Apply any pending migration with the worker's pre-deploy, then push `dev`: Vercel builds the web app, Railway builds the API and the worker. All three come from the same commit.
4. Register the new provider endpoints (`deploy-env.md` section 4): Clerk webhook and OAuth resource, Stripe webhook, Google and TikTok redirect URIs and TikTok webhook. Copy the new signing secrets into the API's variables and redeploy it.
5. Reconnect MCP clients, Zapier and Make connections, the n8n variable and the CLI helper to the API origin.
6. Remove the backend variables from Vercel only after the deployed web app works against the API.

## Checks on the deployed pair

- `GET A/api/health` and `GET A/api/ready` answer without Clerk or Redis; draining answers `503 server_draining` on everything else.
- Sign in on W, open `/home`: the browser sends `Authorization: Bearer` (no cookie) to A, CORS allows exactly W, the response carries `X-Workspace-Id`.
- A request with a valid cookie but no Bearer, a token from another authorized party, and a removed Workspace selection are refused (`401`, `401`, `409 workspace_selection_changed`).
- `curl -H "Origin: https://other.example" A/api/session/bootstrap` gets no CORS allowance.
- Review pages: the response headers for `/review/*` list A in `connect-src`; guest access, media and opt-out work from W.
- Two clients behind different addresses get separate rate-limit buckets (`TRUSTED_CLIENT_IP_HEADER=x-real-ip` overwrites caller values on Railway's ingress).
- Stripe test event, Clerk user event and a TikTok publication webhook each reach A and are accepted exactly once on redelivery.
- `A/.well-known/oauth-protected-resource/mcp` names `A/mcp`; a reconnected client lists tools; a REST call with an `nf_` key to `A/api/v1/workspace` succeeds.
- A multi-minute progress stream (more than 60 seconds) survives token refresh; a membership change ends it.

## Rollback

Redeploy the previous web and API-less revision together, restore the old variables on Vercel and the old webhook endpoints, and reconnect clients to the web origin. Nothing in the database changed.
