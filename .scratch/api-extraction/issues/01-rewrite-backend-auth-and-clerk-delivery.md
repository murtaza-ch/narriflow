# 01. Rewrite backend auth and Clerk delivery

**What to build:** Bun can verify a Clerk Bearer identity, provision the App User/personal Workspace and process raw Svix Clerk delivery without Next dependencies.

**Blocked by:** None

**Status:** ready-for-agent

**Suggested implementer:** Claude. The other pairing side reviews and returns findings to this owner.

Read [spec.md](../spec.md). It is the complete contract; the original brief/plan/reviews are not prerequisites. Claim this ticket before editing.

## Exact ownership

Paths are repo-relative. Every existing file below is exclusively assigned for this phase, including files that only need verification. A new `/**` directory includes its local tests/helpers, not adjacent directories. Read other files as evidence; do not edit them.

Existing files:

- `apps/web/app/api/webhooks/clerk/route.ts`
- `bun.lock`
- `packages/auth/package.json`
- `packages/auth/src/index.ts`
- `packages/auth/test-fixtures/personal-workspace-auth.ts`
- `packages/auth/tsconfig.build.json`
- `packages/auth/tsconfig.json`
- `packages/email/src/index.ts`

New files/directories or reserved skeletons handed off by a blocker:

- `packages/auth/src/**`
- `apps/api/src/domains/platform/clerk/**`

## Endpoints, actions, pages and refresh sites

Rows retain their section/ordinal or exact source-line identifier from the independent inventory. Abbreviated table filenames are accompanied by the literal ownership manifest and exact source occurrences below. All action/page/fetch/refresh rows in owned files are in scope, including no-refresh callers and media navigation. Baseline observations do not override the spec's selected origins, route style, guest Bearer or new endpoints.

### Inventory 4 row 2

| # | File | Methods | What it does | Next-specific dependencies | Trust / auth | Verdict |
|---|---|---|---|---|---|---|
| 2 | `app/api/webhooks/clerk/route.ts` (143 lines) | POST | Svix-verified Clerk webhook: `user.created/updated` to `syncClerkUserPayload`, `user.deleted` to `markUserDeletedByClerkId`, `email.*` relayed by `@narriflow/email` `relayClerkEmail`; idempotent via `getWebhookDeliveryLog` / `recordWebhookDeliveryLog("clerk", svixId)`. | `headers()` from `next/headers`; `UserJSON` type from `@clerk/nextjs/server`; `validateWebhookEnv()` from `lib/env.ts` (`server-only`); `runtime = "nodejs"`. | Svix signature (`CLERK_WEBHOOK_SECRET`) | **Move to API** (backend writes users). Replace `headers()` with `c.req.header`, type from `@clerk/backend`; update the endpoint URL in the Clerk dashboard (external registration). |

Baseline already captured by the orchestrator in `.scratch/api-extraction/baseline.md` (warm web typecheck median 4s at 5d65a0c8). Dependency-install lockfile ownership is serial 01 -> 02 -> 03 -> 04, then 31.

## Acceptance criteria

- [x] Missing/malformed Bearer remains 401 even with a Clerk cookie; session-only token type, authorizedParties and provider-unavailable 503 tested.
- [x] Provisioning, stale user refresh, defaults, personal Workspace, uniqueness races and confirmed-Clerk-404 email release preserved.
- [x] Explicit selection resolver supports bootstrap fallback and refuses invalid scoped selection; staff variant resolves only from verified identity and server allowlist.
- [x] Clerk bytes/signature/delivery receipts/email relay preserved; auth and email imports run under Bun without Next/server-only/React.
- [ ] No unowned files changed; paired review findings and verification evidence recorded under Comments.

## Verification

Run these from the repository root after dependencies are installed. A command naming a new package script is implemented by the owning setup ticket, not silently skipped. PostgreSQL gates need a disposable schema; a skipped DB suite does not satisfy its gate. During the undeployed integration sequence, record any unrelated transitional compile failure with its owning blocker; this ticket's behavior tests must pass and the final integrated gates cannot be waived.

```sh
bun test packages/auth apps/api/src/domains/platform/clerk
```

## Comments

Claimed and implemented by Claude (Sonnet 5.5), 2026-10-29.

### Public contract for later tickets (`@narriflow/auth`)
- `createServerClerkClient({secretKey, publishableKey})`: the one Backend client. `createBearerAuthenticator({client, authorizedParties})(request)` returns `authenticated {identity: VerifiedClerkIdentity}` | `unauthenticated {reason: missing_credential|malformed_credential|rejected_token}` | `unavailable` (map to 401 `authentication_required` / 401 / 503). Throws at startup on an empty or non-origin/wildcard `authorizedParties`. Clerk only sees a rebuilt request carrying the single Authorization header, so cookies, handshakes and redirects cannot occur.
- `getAppUserForClerkIdentity(clerkUserId, clerkClient)` (clerkClient needs only `users.getUser`); `syncClerkUserPayload(payload, clerkClient)` now REQUIRES the directory (used to confirm a Clerk 404 before releasing an email).
- `resolveWorkspaceContext(user, hint?)` = bootstrap with personal fallback + `workspaceSelectionChanged`; `resolveScopedWorkspaceContext(user, hint)` returns `null` for missing/removed/malformed hint (caller answers 409 `workspace_selection_changed`; never falls back); `selectWorkspaceForActor(actorUserId, workspaceId)` returns the context or `null` (non-member). Non-UUID hints are treated as invalid without a DB read.
- `parseStaffAllowlist(env)` / `resolvePlatformActor(VerifiedClerkIdentity, allowlist)` -> `PlatformActor | null`; only an exact allowlisted Clerk id grants staff.
- `verifyClerkWebhook(rawBody, {id,timestamp,signature}, secret)` (Svix). Webhook adapter: `apps/api/src/domains/platform/clerk/webhook.ts` `handleClerkWebhook(request, deps)` (framework-free `Request -> Response`; mount as `app.post("/api/webhooks/clerk", c => handleClerkWebhook(c.req.raw, deps))` under the 1 MiB webhook body limit) and `runtime.ts` `createClerkWebhookDependencies({webhookSecret, clerkClient})`.
- Removed: `getCurrentAppUser`, `requireCurrentAppUser`, `getWorkspaceContextForUser`, `setActiveWorkspaceForActor`, `listCurrentUserWorkspaces`, `ACTIVE_WORKSPACE_COOKIE`.

### Deviations / decisions
- `apps/web/app/api/webhooks/clerk/route.ts` deleted (moved to API per inventory). Clerk dashboard endpoint must be re-registered at `A/api/webhooks/clerk` in the cutover.
- Webhook error bodies no longer echo exception text (spec: unknown failures never expose internals); status codes and delivery-log content unchanged. A verified body that is not `{type: string, data: object}` now returns 400 (the old code threw outside its try).
- `isClerkAPIResponseError` is not exported by `@clerk/backend`; `isClerkNotFound` checks the class `kind` and status 404 instead of importing `@clerk/shared` transitively.
- Provider-outage mapping (503): Clerk reasons `jwk-remote-failed-to-load|jwk-remote-invalid|jwk-remote-missing|jwk-failed-to-resolve|jwk-local-missing|secret-key-invalid|unexpected-error` plus any thrown client error. `jwk-kid-mismatch` stays 401.
- Svix verification lives in `packages/auth` (not apps/api) so it is testable before ticket 04 creates `apps/api/package.json`; the apps/api adapter takes `verify` by injection, so its tests run from the repo root without that manifest.
- `packages/auth/tsconfig.json` now excludes `src/**/*.test.ts` (same as `packages/services`).
- Stale `packages/auth/node_modules/{next,@clerk/nextjs}` symlinks were removed so the package cannot import them by accident.

### Requests for other owners
- 02: `request-policy-runtime.ts` must use the new API above; `apps/web/lib/authenticated-request-policy.server.ts` (still imports `getCurrentAppUser`, `getWorkspaceContextForUser`) is dropped with it.
- 04: `svix` and `@clerk/backend` are already installed through `@narriflow/auth`; apps/api needs `@narriflow/auth` and `@narriflow/email` workspace deps for `runtime.ts` to resolve. Register `CLERK_WEBHOOK_SECRET` validation in API config.
- 05 / 24 / owners of `app/(app)/_actions/workspace.ts`, `app/invite/[token]/actions.ts`, `app/workspaces/new/actions.ts`, `app/mcp/integrations/[workspaceId]/[...upload]/route.ts`: transitional web typecheck errors from removed exports (listed below).
- `apps/web/lib/personal-workspace-auth.test.ts` still passes unchanged: it spawns the fixture path, which I kept.

### Evidence
- `bun test packages/auth apps/api/src/domains/platform/clerk` -> 86 pass, 0 fail (5 files). Includes real RS256 session-token verification through `@clerk/backend` with a local `jwtKey` (valid, expired, wrong key, unlisted `azp`, machine tokens, cookie ignored), outage mapping, staff allowlist, provisioning/race/404-release (DB mocked), Svix signature over exact bytes, and bundle-graph + plain-Bun import checks proving `packages/auth` and `packages/email` contain no next, @clerk/nextjs, server-only or React.
- `bun test ./packages/auth/test-fixtures/personal-workspace-auth.ts` 32 pass; `bun test apps/web/lib/personal-workspace-auth.test.ts` 1 pass.
- `bunx biome check packages/auth apps/api packages/email` clean. `packages/auth` and `packages/email` `bun run typecheck` clean; `packages/auth` build clean. `apps/api/.../clerk/*.ts` typechecked with a temporary path-mapped tsconfig (no manifest yet): clean.
- Web typecheck (transitional, owners above): `app/(app)/_actions/workspace.ts`, `app/invite/[token]/actions.ts`, `app/workspaces/new/actions.ts` (missing `setActiveWorkspaceForActor`); `app/mcp/integrations/[workspaceId]/[...upload]/route.ts` (missing `getCurrentAppUser`); `lib/authenticated-request-policy.server.ts` (missing `getCurrentAppUser`, `getWorkspaceContextForUser`).
- Paired review: not run by this implementer; requested from the orchestrator.
