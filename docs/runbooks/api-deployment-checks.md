# API deployment checks

The API (`apps/api`, Cloudflare Worker at its own origin) and the web app deploy from the same revision; see [ADR 0017](../adr/0017-standalone-api.md) and [ADR 0019](../adr/0019-serverless-execution.md). Resource selections live in [the environment runbook](environments.md) and the infrastructure order in [the serverless cutover record](serverless-cutover.md). This page is the list of checks to run against a deployed web and API pair.

## Before pushing

1. `bun run lint`, `bun run typecheck`, `bun run test`, `bun run --cwd apps/api test:inventory`, `bun run --cwd apps/api openapi:check`, `bun run --cwd apps/api build:worker`.
2. `bun run check:web-split`.
3. `bun run env:check` passes for `apps/api/.dev.vars`, `apps/web/.env.local` and `packages/db/.env`.

## Provider registrations

When the API origin changes, update the Clerk webhook and OAuth resource, Stripe webhook, Scribe callback, Google and TikTok redirect URIs and TikTok webhook, then reconnect MCP clients, Zapier and Make connections, the n8n variable and the CLI helper. Set `NEXT_PUBLIC_API_URL` on Vercel (a build-time variable), and `CLERK_AUTHORIZED_PARTIES`, `WEB_ORIGIN` and `CORS_ALLOWED_ORIGINS` on the API.

## Checks on the deployed pair

- `GET A/api/health` and `GET A/api/ready` answer without Clerk; while admission is closed or fenced, everything else answers `503 server_draining`.
- Sign in on W, open `/home`: the browser sends `Authorization: Bearer` (no cookie) to A, CORS allows exactly W, the response carries `X-Workspace-Id`.
- A request with a valid cookie but no Bearer, a token from another authorized party, and a removed Workspace selection are refused (`401`, `401`, `409 workspace_selection_changed`).
- `curl -H "Origin: https://other.example" A/api/session/bootstrap` gets no CORS allowance.
- Review pages: the response headers for `/review/*` list A in `connect-src`; guest access, media and opt-out work from W.
- Two clients behind different addresses get separate rate-limit buckets (`TRUSTED_CLIENT_IP_HEADER` names the header the ingress overwrites; on Cloudflare that is `CF-Connecting-IP`).
- Stripe test event, Clerk user event and a TikTok publication webhook each reach A and are accepted exactly once on redelivery.
- `A/.well-known/oauth-protected-resource/mcp` names `A/mcp`; a reconnected client lists tools; a REST call with an `nf_` key to `A/api/v1/workspace` succeeds.
- A multi-minute progress stream (more than 60 seconds) survives token refresh; a membership change ends it.

## Rollback

Redeploy the previous web and API revisions together and restore the previous provider endpoints. Close admission first if the change touched execution; an arbitrary backup or PITR cannot authorize replay over later execution history (see [the execution restore procedure](execution-restore.md)).
