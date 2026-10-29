# One standalone API serves every client; the web app only presents

Narriflow's backend is one Hono-on-Bun service (`apps/api`) on Railway, at its own origin. The web app (`apps/web`, Vercel) is a client of it, like the stdio MCP server, the public REST consumers and any future mobile app. Before this decision the Next.js app also hosted the API, the MCP transport, provider webhooks, the progress stream and every Server Action and server-rendered read, so each of those shared Vercel's deployment, timeouts and secrets.

## Decision

- The API owns `/api/*` (first-party), `/api/v1/*` (public REST), `/mcp` with its upload and discovery paths, provider webhooks (Clerk, Stripe, TikTok, Zoom) and `/api/stream/:projectId`. Services stay in `packages/services`; HTTP modules admit, validate, call services and serialize.
- The browser calls the API directly (`NEXT_PUBLIC_API_URL`) with a Clerk session token as `Authorization: Bearer` and `credentials: 'omit'`. There is no Vercel rewrite or proxy adapter: Vercel in the path of every SSE and MCP request would keep the old timeout and deployment coupling and force one canonical MCP resource origin through forwarding. The cost is a one-time re-registration of provider callbacks and MCP clients, affordable before production.
- The selected Workspace is an explicit `X-Workspace-Id` hint from per-user local storage, revalidated against live membership on every request. The active-Workspace cookie is gone, so a removed selection answers a safe `409 workspace_selection_changed` instead of falling through into the personal Workspace.
- Two origins, never conflated: **W** (human links, notifications, review and invite URLs, Checkout return URLs) and **A** (provider callbacks, webhooks, REST `statusUrl`, the MCP resource, machine clients). Both are configured (`WEB_ORIGIN`, `API_ORIGIN`), never read from `Host`.
- The web app keeps React Query as the owner of ordinary remote UI state; the Studio Editing Session still owns drafts, history, revision barriers and cloud convergence (ADR 0002). Pages and components import from `@narriflow/api-client` (typed `hc` clients per domain, queries, mutations, invalidation, the progress stream) and `@narriflow/validators`.
- `apps/web/proxy.ts` only redirects unsigned page navigations. Client gates handle membership, Workspace and billing state.
- Internal routes are chained `Hono` registrations declared with their admission (ADR 0009); only public REST uses `OpenAPIHono`. The public OpenAPI document is generated from the REST app at build time and committed as `packages/api-client/src/openapi/public-v1.json`; docs render from that file and never need the API to be up.

## Enforcement

Biome's `noRestrictedImports` bans `@narriflow/services`, `db`, `auth`, `mcp-core`, `email` and `api` throughout `apps/web` (type imports included). `bun run check:web-split` also follows relative paths into backend source, rejects a `"use server"` directive, allows route handlers only for docs content (search, Markdown, llms text, OG images), rejects backend dependencies in the web manifest, and, after a build, scans `.next/static` for backend module names and for the names of every API and worker secret variable. `bun run --cwd apps/api test:inventory` compares the mounted routes with the domains' admission tables in both directions. CI runs these gates. `NEXT_PUBLIC_API_URL` is read at build time (Content Security Policy `connect-src`, docs examples), so it is part of Turbo's environment hash and the build fails without it.

## Considered options

We rejected Vercel rewrites to the API (the coupling above, plus one more canonical origin and host policy per surface); keeping the Hono catch-all in Next with the API as a second copy (two backends to keep in step); one giant exported application type for the client (slow inference; domain-by-domain type-only exports instead, the warm web typecheck median was 4 s before and 4 s after, so no declaration precompilation was added); and a mobile or admin client now (the seam is kept, nothing more).

## Consequences

Provider consoles list API-origin callbacks (Google and TikTok redirect URIs, the Stripe and Clerk webhook endpoints, the Clerk OAuth resource and audience); MCP clients, Zapier and Make connections, n8n variables and the CLI helper move to the API origin. The worker never calls the API; it shares the database, Redis and R2 with it, so `bun run env:check` compares the API, web, worker and database files. The Railway API service is sized by its Neon pool budget: pool size times replicas stays within the pooler's limit, and replicas share stream subscribers only through Redis. Rollback is a redeploy of the previous web and API revisions together; there is no compatibility layer to keep.
