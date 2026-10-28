# API extraction: owner brief (2026-10-29)

Owner decision, not up for re-litigation: move every backend surface out of
`apps/web` into a standalone Hono API, consumed by web through TanStack React
Query. One cutover on the `dev` branch; no gradual migration, no dual paths
(see "Pre-production compatibility policy" in `AGENTS.md`). No mobile app work
yet, but the API must be ready for an Expo client (Bearer auth, JSON only).

## Target shape

- `apps/api` — Hono on Bun (`Bun.serve`), deployed as a new Railway service in
  project `narriflow-dev`, environment `dev`. Owns: everything under today's
  `apps/web/app/api/**` (internal Hono app, `/api/v1` REST app, progress
  stream, Clerk webhook, Stripe webhook, docs search?), `apps/web/app/mcp/**`,
  `/.well-known/oauth-*`, review-link routes, and the logic now in the 55
  server actions (14 files) and the ~34 pages/layouts that read
  `@narriflow/services` / `@narriflow/db` directly.
- `packages/auth` — rewritten on `@clerk/backend` (`authenticateRequest`), no
  `next/*`, no React `cache`. Bearer tokens for every first-party client.
- `packages/api-client` — new, shared by web (and later Expo): `hono/client`
  `hc` clients split per domain, TanStack Query `queryOptions` factories and
  query keys per domain, a typed `ApiError` (branch on `code`), and a
  progress-events hook over `fetch` + `eventsource-parser` that invalidates
  queries.
- `apps/web` — Next.js UI only. Pages that need data become client components
  using React Query. No `"use server"`, no `@narriflow/services` or
  `@narriflow/db` value imports (enforced by Biome `noRestrictedImports`).
  Docs (`/docs`, `llms.txt`, docs markdown) and marketing stay in web.
- `apps/worker`, `apps/mcp`, `packages/services|db|validators` keep their roles.

## Libraries

API: `hono`, `@hono/zod-openapi` (already used by REST v1; one route style
everywhere), Hono built-ins (`cors`, `secure-headers`, `request-id`,
`body-limit`, `streaming`), `@clerk/backend`, existing `ioredis`, `stripe`,
`svix`, `hono/testing` + `bun test`.
Client: `hono/client`, `@tanstack/react-query`,
`@tanstack/react-query-devtools` (web dev only), `eventsource-parser`.

## Future clients the API must be ready for (do not build them now)

- **Expo mobile app** (iOS/Android): Bearer auth, JSON only, no cookies.
- **Internal admin dashboard** (owner decision 2026-10-29): staff-only
  surfaces for support and operations — look up users/workspaces, credits and
  billing state, failed runs, publication recovery. The `*-operator.ts`
  modules in `packages/services` (workspace-billing, generated-media,
  social-publication) are today's operator-only entry points and the natural
  first admin endpoints. Plan for it structurally, build none of it now:
  - A distinct **actor kind** for platform staff in the auth layer (separate
    from workspace roles in `WorkspaceRole`), resolved from a server-trusted
    source (e.g. Clerk private/public metadata or an allowlist), never from
    client input.
  - A reserved route group (`/admin/*`) that mounts behind its own
    middleware: staff actor required, stricter rate limits, and an audit log
    entry for every admin mutation.
  - Domain route modules and the api-client stay pluggable so an admin app
    (separate Next app or route group) can reuse the same `hc` + React Query
    pattern without touching user-facing routes.

## Non-negotiables

- Security: every route admitted by the existing Authenticated Request Policy
  (or an explicit independent-trust surface: webhooks, signed links, OAuth
  callbacks, API keys); CORS allowlist; secure headers; body limits; rate
  limits via existing `checkRateLimit`; idempotency keys on create/command
  mutations that can be retried (reuse existing receipt/idempotency machinery
  where it exists); no secrets in client bundles.
- Behavior parity: every server action / page read keeps its current
  semantics, authorization, plan checks and error codes.
- Performance: no N+1 fetch waterfalls in the client; sensible `staleTime`;
  progress events invalidate narrowly; API process reuses one Prisma client.
- Code style: follow `AGENTS.md` conventions; services stay the business
  logic; HTTP adapters stay thin.
- Verification: `bun run lint`, `bun run typecheck`, `bun run test`, the
  `test:*:db` gates, API route tests, and browser checks of real flows.
