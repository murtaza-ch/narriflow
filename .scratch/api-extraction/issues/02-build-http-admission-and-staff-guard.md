# 02. Build HTTP admission and staff guard

**What to build:** Every API route can use one explicit admission/error/limit contract, and the reserved staff-only group cannot accidentally inherit Workspace Admin privileges.

**Blocked by:** [01 - Rewrite backend auth and Clerk delivery](01-rewrite-backend-auth-and-clerk-delivery.md)

**Status:** ready-for-agent

**Suggested implementer:** Claude. The other pairing side reviews and returns findings to this owner.

Read [spec.md](../spec.md). It is the complete contract; the original brief/plan/reviews are not prerequisites. Claim this ticket before editing.

## Exact ownership

Paths are repo-relative. Every existing file below is exclusively assigned for this phase, including files that only need verification. A new `/**` directory includes its local tests/helpers, not adjacent directories. Read other files as evidence; do not edit them.

Existing files:

- `apps/web/lib/authenticated-request-hono.test.ts`
- `apps/web/lib/authenticated-request-hono.ts`
- `apps/web/lib/authenticated-request-http.test.ts`
- `apps/web/lib/authenticated-request-http.ts`
- `apps/web/lib/authenticated-request-input.test.ts`
- `apps/web/lib/authenticated-request-input.ts`
- `apps/web/lib/authenticated-request-policy.db.test.ts`
- `apps/web/lib/authenticated-request-policy.server.ts`
- `apps/web/lib/authenticated-request-policy.test.ts`
- `apps/web/lib/authenticated-request-policy.ts`
- `apps/web/lib/authenticated-request-project.ts`
- `apps/web/scripts/run-authenticated-request-policy-db-tests.ts`
- `bun.lock`
- `packages/services/src/operation-receipt-runtime.ts`
- `packages/services/src/operation-receipt.db.test.ts`
- `packages/services/src/operation-receipt.test.ts`
- `packages/services/src/operation-receipt.ts`

New files/directories or reserved skeletons handed off by a blocker:

- `packages/services/src/workspace-receipt-commands.ts`
- `packages/services/src/projects-receipt-commands.ts`
- `packages/services/src/clips-receipt-commands.ts`
- `packages/services/src/ingest-receipt-commands.ts`
- `packages/services/src/recipes-receipt-commands.ts`
- `packages/services/src/publishing-receipt-commands.ts`
- `packages/services/src/brand-receipt-commands.ts`
- `packages/services/src/automation-receipt-commands.ts`
- `packages/services/src/developer-receipt-commands.ts`
- `packages/services/src/reviews-receipt-commands.ts`
- `packages/services/src/exports-receipt-commands.ts`
- `apps/api/package.json`
- `apps/api/tsconfig.json`
- `apps/api/tsconfig.build.json`
- `apps/api/src/http/**`
- `apps/api/src/config.ts`
- `apps/api/scripts/run-authenticated-request-policy-db-tests.ts`
- `packages/validators/src/api/errors.ts`
- `packages/validators/src/api/origins.ts`

## Endpoints, actions, pages and refresh sites

Rows retain their section/ordinal or exact source-line identifier from the independent inventory. Abbreviated table filenames are accompanied by the literal ownership manifest and exact source occurrences below. All action/page/fetch/refresh rows in owned files are in scope, including no-refresh callers and media navigation. Baseline observations do not override the spec's selected origins, route style, guest Bearer or new endpoints.

No direct UI/domain rows. This ticket supplies the shared contracts or final gates described above.

## Acceptance criteria

- [x] Policy order identity, Workspace, capability/status, rate, Project, input, operation and one outer requestId tested, including concealment and mismatch.
- [x] Common failures cover malformed JSON/validation/413/404/unexpected errors with safe fields; per-request actor promise, never global authorization caching.
- [x] CORS exact origins/headers, secure headers and chunked body limits respect independent MCP/webhook trust; receipt replay precedes mutation-limit refusal.
- [x] Receipt command union composes typed per-domain literal-name modules; no arbitrary-string escape and no new table.
- [x] Reserved admin guard distinguishes staff from Workspace Admin, uses 60/10 per-minute rates, and refuses future mutation registration without injected audit.
- [ ] No unowned files changed; paired review findings and verification evidence recorded under Comments.

## Verification

Run these from the repository root after dependencies are installed. A command naming a new package script is implemented by the owning setup ticket, not silently skipped. PostgreSQL gates need a disposable schema; a skipped DB suite does not satisfy its gate. During the undeployed integration sequence, record any unrelated transitional compile failure with its owning blocker; this ticket's behavior tests must pass and the final integrated gates cannot be waived.

```sh
bun test apps/api/src/http packages/services/src/operation-receipt.test.ts
bun run test:authenticated-request-policy:db
```

## Comments

Claimed and implemented by Claude (Sonnet 5.5), 2026-10-29. Paired review not run by the implementer (last acceptance box left open for the orchestrator).

### Public contract for later tickets (`apps/api/src/http`)
- Registration: `.post(path, admit(declaration), [requireIdempotencyKey()], validate("json", schema), handler)`. `admit` takes `{kind: "signed_in" | "workspace" | "project", capability, projectParam: "id"|"projectId", rate?: {scope, prefix, limit, windowSeconds?}, tier?, editorClipParam?, deferRateRefusal?}`. Existing operation keys are preserved exactly (`prefix:actorUserId|workspaceId`). Handlers read `getActor(c)`, `getSignedInActor(c)`, `getProject(c)`, `getRecordedRateLimit(c)`; validated input via `c.req.valid(...)`. The declaration alone supplies capability; the HTTP method only chooses the default rate tier.
- Composition (04) must mount, in this order: `apiRequestId()`, `requestLogger()`, `apiSecurityHeaders()`, `limitRequestEnvelope()`, `firstPartyCors({allowedOrigins})`, `limitBody(class)` per route class, `requireJsonContentType()` on JSON classes, `errorEnvelopeMiddleware()`, `app.onError(apiErrorHandler)`, `app.notFound(apiNotFoundHandler)`, `installRequestPolicy(runtime)`, then `requireAdmissionDeclaration()` last among `use("*")` and before domain routes. `createProductionRequestPolicyRuntime({authenticate: createBearerAuthenticator(...), clerkClient, staffAllowlist})` builds the runtime; `runtime.actorsFor(request)` returns fresh (unmemoized) actor promises, which the stream ticket (29) must call again at every heartbeat. MCP, REST and webhook adapters are mounted before and outside this chain; do not apply `errorEnvelopeMiddleware`, first-party CORS or `requireAdmissionDeclaration` to them. `publicReadCors()` is for discovery documents.
- Tiers (`limits.ts`): read 300/60, mutation 60/60 (default by method, key includes Workspace), `tier: "editor"` = 120/60 per actor+Workspace+clip plus 300/60 actor-global and no mutation bucket, `tier: "stream"` = 30/60 per actor, `tier: "read"` override for polling POSTs such as upload-session status/grants. Public/guest per-IP tiers via `ipRateLimit` (60 and 30 per minute); admin 60/10 in `admin.ts`.
- Receipt commands: declare `deferRateRefusal: true` and call `enforceRecordedRateLimit(getRecordedRateLimit(c))` from the receipt's `beforeAccept` (after locked recheck). Replay is answered first; exhausted -> 429 `rate_limited` with window guidance, limiter outage -> 503 `mutations_unavailable` Retry-After 5. A route that declares the flag but never enforces is unthrottled: domain tests must cover it. `packages/services/src/<domain>-receipt-commands.ts` (11 modules) now hold the literal names (existing 12 distributed; workspace/projects/recipes/brand/reviews empty) and `ReceiptCommand` collapses to `never` if a list is widened to `string[]`.
- Idempotency: `requireIdempotencyKey()` (1-128 chars, 400 `idempotency_key_required`), `readCampaignRetryOf()`, `reconcileIdempotencyKey(header, nativeBodyKey)` (400 `idempotency_key_mismatch`). Staff: `createAdminRoutes({rateLimit, audit?})` -> mount `.app` at `/api/admin`; `mutation()` throws `AdminAuditRequiredError` at registration without an injected `AdminAudit`; non-staff (including Workspace admins) get 403 `staff_required`, staff get the envelope 404.
- Config (`src/config.ts`): `loadApiConfig(env)` covers core + Clerk groups (origins, CORS, authorized parties, staff allowlist, stream caps, `TRUSTED_CLIENT_IP_HEADER`); optional provider groups are left to their domains. New env name introduced: `TRUSTED_CLIENT_IP_HEADER` (set to `x-real-ip` on Railway only after verifying Railway overwrites it; unset trusts no forwarded header).

### Deviations / decisions
- Moved (not duplicated) and deleted from web: `authenticated-request-{policy,policy.server,project,http,hono,input}.ts` and their tests, the policy DB test and its runner. Tests moved to `apps/api/src/http/*.test.ts` with every assertion kept; the adapters `server_action`/`page` became `hono`/`stream`. Dropped only the "preserves framework control-flow exceptions" case because `rethrowFrameworkControlFlow` is removed by the spec; `parseAuthenticatedJsonBody` tests became admission tests (absent optional body validates as `{}`, malformed JSON -> 400 `invalid_json`) because `@hono/zod-validator` replaces the hand-rolled parser.
- Policy API change: `createAuthenticatedRequestPolicy(deps)` has no actor/request-ID dependencies; `execute(request, {requestId, resolveActor})` takes the outer request ID and the request-local actor promise. `rateLimit` accepts one rule or an array; failures keep their codes. Added 415 to failure statuses and a malformed-Project-ID guard (non-UUID -> concealed `project_not_found` instead of a Prisma error).
- Error envelope: expected 503 domain failures keep their code and Retry-After (flagged via `errorEnvelope` context var so the normalizer does not flatten them); literal handler 5xx stay generic. Logs record the matched route pattern, never the URL, query or token.
- `apps/api/src/http/request-policy-runtime.ts` returns 409 `workspace_selection_changed` for an absent, malformed or removed `X-Workspace-Id`, never falling back; identity outage -> 503 `authentication_unavailable`.
- New dependency (this ticket owns bun.lock): `@hono/zod-validator ^0.7.6` (already resolved at 0.7.6 in the lock via zod-openapi). `apps/api/package.json` also lists `@narriflow/auth|db|email|services|validators`, `@prisma/client`, `hono`, `zod`, and dev `@prisma/adapter-pg`, `pg`, `@types/pg`, `@types/node`; `bun install` run, lock diff is the new workspace entry only.
- `apps/api/tsconfig.json` includes `src` only (scripts use Bun types, same as `packages/services/scripts`); validators subpaths resolve through tsconfig `paths` (as the worker does) until 04 adds package exports.

### Requests for other owners
- 04: (1) root `package.json` script `test:authenticated-request-policy:db` must point at `apps/api/scripts/run-authenticated-request-policy-db-tests.ts` (it still names the deleted web runner); (2) add explicit subpath exports to `packages/validators/package.json` for `./api/errors` and `./api/origins` (more under `./api/*` as domains land); (3) rewrite `route.ts` and the inventory test per the mounting order above; (4) `createApiApp` must use `createProductionRequestPolicyRuntime`.
- 06: re-add a Bun-native workspace-entry DB check on `getAppUserForClerkIdentity` (the old `apps/web/lib/workspace-entry.db.fixture.ts` still imports the removed `getCurrentAppUser`); my runner no longer executes it. Wire it into `apps/api/scripts/run-authenticated-request-policy-db-tests.ts` through a follow-up request to me/31.
- 05: bootstrap/selection routes use `admit({kind: "signed_in"})`; consume `selectWorkspaceForActor` from ticket 01.
- 21/29/23/31 (transitional breakage from the deleted web modules): `apps/web/app/(app)/settings/actions.ts`, `apps/web/app/api/stream/[projectId]/route.ts`, `apps/web/app/api/[[...route]]/{route.ts,brand-profile-routes.ts,zoom-http.ts,clip-generation-http.test.ts,social-publication-http.test.ts}`, `apps/web/lib/{authenticated-request-action,authenticated-request-page,authenticated-request-inventory,workflow-stream-reauthorization(.test)}.ts` and `apps/web/lib/rest-api/app.ts` (needs `domainFailureHttpStatus` from `apps/api/src/http/errors.ts`) import the removed modules. This also makes `test:integration-api:db` fail at its last suite (`apps/web/lib/rest-api/events.db.test.ts`); every earlier suite, including `operation-receipt.db.test.ts`, passes.
- Docs (not mine): `docs/adr/0009*`, `docs/runbooks/authentication.md` still describe the web policy files.

### Possible spec issues
- "returns 404 to an admitted staff request" leaves non-staff behavior open; I chose 403 `staff_required` (the admin group's existence is not secret).
- Spec step 4 puts ingress rejections (413/414/431/415) before identity; they run pre-auth by necessity, so unauthenticated callers can see those four codes.
- Railway's client-IP header was not verifiable offline; `TRUSTED_CLIENT_IP_HEADER` stays opt-in.

### Evidence
- `bun test apps/api/src` -> 157 pass, 6 skip (DB suite), 0 fail (13 files, includes ticket 01 Clerk tests; http: policy 16, admission 44, errors 21, limits, cors, admin, idempotency, logging, project-admission, config). `bun test packages/services/src/operation-receipt.test.ts` 13 pass. `bun test packages/validators/src/api` 2 pass.
- `bun apps/api/scripts/run-authenticated-request-policy-db-tests.ts` via `.scratch/api-extraction/db-gate.sh` (local Postgres): 4 pass, 0 skipped.
- `bunx biome check` on apps/api, packages/validators/src/api, the 11 receipt-command modules, operation-receipt(.test).ts: clean. `bun run typecheck` clean in apps/api, packages/services, packages/validators.
- `.scratch/api-extraction/db-gate.sh bun run test:integration-api:db`: all services suites pass (including `operation-receipt.db.test.ts`); fails only at the transitional web suite above.
