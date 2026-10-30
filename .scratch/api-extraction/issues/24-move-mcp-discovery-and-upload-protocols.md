# 24. Move MCP discovery and upload protocols

**What to build:** MCP JSON-RPC/OAuth/API-key, discovery and five Upload Session POSTs work on the exact new resource origin with live continuation rechecks.

**Blocked by:** [04 - Wire API runtime and partition the catch-all](04-wire-api-runtime-and-partition-the-catch-all.md), [15 - Move intake Upload Sessions and recipes](15-move-intake-upload-sessions-and-recipes.md)

**Status:** done

**Suggested implementer:** Sol. The other pairing side reviews and returns findings to this owner.

Read [spec.md](../spec.md). It is the complete contract; the original brief/plan/reviews are not prerequisites. Claim this ticket before editing.

## Exact ownership

Paths are repo-relative. Every existing file below is exclusively assigned for this phase, including files that only need verification. A new `/**` directory includes its local tests/helpers, not adjacent directories. Read other files as evidence; do not edit them.

Existing files:

- `apps/mcp/.env.example`
- `apps/mcp/package.json`
- `apps/mcp/src/index.ts`
- `apps/mcp/src/upload.test.ts`
- `apps/mcp/src/upload.ts`
- `apps/mcp/tsconfig.json`
- `apps/web/app/.well-known/oauth-authorization-server/route.ts`
- `apps/web/app/.well-known/oauth-protected-resource/mcp/route.ts`
- `apps/web/app/.well-known/oauth-protected-resource/route.ts`
- `apps/web/app/mcp/integrations/[workspaceId]/[...upload]/route.ts`
- `apps/web/app/mcp/route.ts`
- `apps/web/lib/mcp-auth.ts`
- `apps/web/lib/mcp-configuration.test.ts`
- `apps/web/lib/mcp-configuration.ts`
- `apps/web/lib/mcp-continuation-principal.test.ts`
- `apps/web/lib/mcp-continuation-principal.ts`
- `apps/web/lib/mcp-integration-admission.ts`
- `apps/web/lib/mcp-upload-handoff.test.ts`
- `apps/web/lib/mcp-upload-handoff.ts`
- `apps/web/lib/mcp-upload-http.test.ts`
- `apps/web/lib/mcp-upload-http.ts`
- `packages/mcp-core/package.json`
- `packages/mcp-core/scripts/build-apps.mjs`
- `packages/mcp-core/scripts/e2e-clients.ts`
- `packages/mcp-core/src/index.test.ts`
- `packages/mcp-core/src/index.ts`
- `packages/mcp-core/src/mcp-apps-confirmation.test.ts`
- `packages/mcp-core/src/mcp-apps-progress.test.ts`
- `packages/mcp-core/src/mcp-apps-upload.test.ts`
- `packages/mcp-core/src/mcp-apps-views.test.ts`
- `packages/mcp-core/src/mcp-apps.test.ts`
- `packages/mcp-core/src/mcp-apps.ts`
- `packages/mcp-core/src/mcp-apps/v2/app-script.ts`
- `packages/mcp-core/src/mcp-apps/v2/app.ts`
- `packages/mcp-core/src/mcp-apps/v2/document.ts`
- `packages/mcp-core/src/mcp-apps/v2/progress.ts`
- `packages/mcp-core/src/mcp-apps/v2/publication-decision.ts`
- `packages/mcp-core/src/mcp-apps/v2/upload-progress.ts`
- `packages/mcp-core/src/mcp-apps/v2/views.ts`
- `packages/mcp-core/src/mcp-auth.test.ts`
- `packages/mcp-core/src/mcp-auth.ts`
- `packages/mcp-core/src/mcp-confirmation.test.ts`
- `packages/mcp-core/src/mcp-confirmation.ts`
- `packages/mcp-core/src/mcp-connector.test.ts`
- `packages/mcp-core/src/mcp-diagnostics.ts`
- `packages/mcp-core/src/mcp-http-exports.ts`
- `packages/mcp-core/src/mcp-http-handler.ts`
- `packages/mcp-core/src/mcp-http.test.ts`
- `packages/mcp-core/src/mcp-http.ts`
- `packages/mcp-core/src/mcp-projections.ts`
- `packages/mcp-core/src/mcp-stdio.test.ts`
- `packages/mcp-core/src/mcp-stdio.ts`
- `packages/mcp-core/src/mcp-tasks.test.ts`
- `packages/mcp-core/src/mcp-tasks.ts`
- `packages/mcp-core/src/mcp-tool-admission.test.ts`
- `packages/mcp-core/src/mcp-tool-admission.ts`
- `packages/mcp-core/src/mcp-wire.test.ts`
- `packages/mcp-core/src/mcp-workflow.test.ts`
- `packages/mcp-core/tsconfig.build.json`
- `packages/mcp-core/tsconfig.json`

New files/directories or reserved skeletons handed off by a blocker:

- `apps/api/src/domains/integrations/**`
- `apps/api/src/types/integrations.ts`
- `packages/api-client/src/integrations/**`
- `packages/validators/src/api/integrations.ts`

MCP upload bridge and its web server helpers are assigned here, overriding inventory D4. Blocked on 15 so shared Upload Session adapter/resume method exist. 26 alone converts browser pages; preserve public props and the signed-intent transport contract.

The chosen new endpoints for this ticket are the matching owner row in spec.md, "Endpoint and screen contracts added by extraction". All current endpoints/actions below retain their semantics unless that row explicitly changes transport. Fill only this domain's receipt-command module; current native receipts remain native.

## Endpoints, actions, pages and refresh sites

Rows retain their section/ordinal or exact source-line identifier from the independent inventory. Abbreviated table filenames are accompanied by the literal ownership manifest and exact source occurrences below. All action/page/fetch/refresh rows in owned files are in scope, including no-refresh callers and media navigation. Baseline observations do not override the spec's selected origins, route style, guest Bearer or new endpoints.

### Inventory 1.8 function `confirmMcpPublication(form: FormData)`

| File:line | Function | Input | Service / auth calls | Policy helper + capability | Plan check | Returns | Side effects | Client callers | Target endpoint | Domain |
|---|---|---|---|---|---|---|---|---|---|---|
| `app/(app)/integrations/mcp/confirm/actions.ts:10` | `confirmMcpPublication(form: FormData)` | `token`, `decision` (`confirm`/other) | `verifyMcpPreparation`, `acceptMcpConfirmation` (`@narriflow/mcp-core`), `workspaceService.requireActor(..., "publishing.manage")`, `getMcpMutationGuard` + `admitMcpContinuation` (`lib/mcp-auth.ts`, `lib/mcp-continuation-principal.ts`), `socialPublicationScheduling.schedule` | `executeSignedInAction` (the signed continuation token selects the workspace, never the browser's active workspace) | `hasFeature(tier, "integrations.mcp")` and `actor.status === "active"` | never returns: **`redirect()`** to `/integrations/mcp`, `/integrations/mcp/confirm?declined=1`, `/projects/:id?publicationId=...`, `/sign-in?redirect_url=...` (auth required), or `/integrations/mcp/confirm?failure=<code>` | `redirect` only | `app/(app)/integrations/mcp/confirm/page.tsx:39` (`<form action={confirmMcpPublication}>`) | `POST /api/mcp/confirmations` `{token, decision}` -> `{destination}`; client navigates. Auth is browser session + token (signed link); uses `lib/mcp-*` files that import `next/*` (see Section 7) | settings-integrations |

### Inventory 4 row 5

| # | File | Methods | What it does | Next-specific dependencies | Trust / auth | Verdict |
|---|---|---|---|---|---|---|
| 5 | `app/mcp/route.ts` (17 lines) | GET, POST, DELETE, OPTIONS | Remote MCP server endpoint: `createNarriflowMcpHttpHandler` from `@narriflow/mcp-core/http` with `narriflowMcpTokenVerifier`, allowed hosts/origins, resource-metadata URL, `checkRateLimit`, `buildNarriflowMcpServer`. | `runtime/dynamic/maxDuration = 60` exports; `lib/mcp-auth.ts` imports `server-only`. Handler is Web-standard `Request` to `Response`. Excluded from the Clerk matcher. | OAuth bearer (Clerk-issued) or Workspace API key, verified by the handler | **Move to API.** `lib/mcp-auth.ts` reads `NEXT_PUBLIC_APP_URL`, `CLERK_OAUTH_ISSUER`, `MCP_ALLOWED_HOSTS`/`MCP_ALLOWED_ORIGINS`, `CLERK_SECRET_KEY`. The resource URL (`<app origin>/mcp`) is registered in MCP clients and in the `.well-known` metadata; moving the host changes it (or rewrite `/mcp` and `/.well-known/*` from web to the API). |

### Inventory 4 row 6

| # | File | Methods | What it does | Next-specific dependencies | Trust / auth | Verdict |
|---|---|---|---|---|---|---|
| 6 | `app/mcp/integrations/[workspaceId]/[...upload]/route.ts` (50 lines) | POST, OPTIONS | MCP upload transport: validates host/origin (`hostHeaderValidationResponse`, `rejectMcpOrigin`), `workspaceId` UUID, bounded body, then `createMcpUploadHttpHandler` which mounts the browser `createUploadSessionHttpRoutes` under `/mcp/integrations/:workspaceId` (5 POST routes: `upload-sessions/open|finalize|grants|status|discard`). Two admissions: bearer (`authenticateMcpRequest` + `McpToolAdmission narriflow_upload_video`) or the `X-Narriflow-Upload-Intent` handoff token completed by a **signed-in person** (`getCurrentAppUser()` from `@narriflow/auth`, `verifyMcpUploadHandoff`, owner rate limit `mcp-upload-owner:<userId>` 300/60s, direct `getPrismaClient().uploadSession.findFirst`). | `runtime/dynamic/maxDuration = 60`; `getCurrentAppUser` is the Clerk-cookie (Next) session helper; `lib/mcp-auth.ts` `server-only`. Excluded from the Clerk matcher by the `mcp` prefix. | Bearer, or handoff token + browser session | **Move to API** with the MCP route. The handoff branch needs a Clerk Bearer/session instead of the Next cookie helper (the person finishes the upload from the web page `app/(app)/integrations/mcp/upload`). Handoff/continuation URLs are built from `NEXT_PUBLIC_APP_URL` (see section 6). |

### Inventory 4 row 7

| # | File | Methods | What it does | Next-specific dependencies | Trust / auth | Verdict |
|---|---|---|---|---|---|---|
| 7 | `app/.well-known/oauth-authorization-server/route.ts` | GET, OPTIONS | Proxies the Clerk issuer's `/.well-known/oauth-authorization-server` metadata (`fetch` with 10 s timeout, 502 on failure), CORS `*`. | `fetch(..., { next: { revalidate: 3600 } })` (Next data cache) | Public | **Move to API** (replace the Next fetch cache with an in-memory TTL cache). Must stay reachable at the MCP resource's origin (RFC 9728/8414). |

### Inventory 4 row 8

| # | File | Methods | What it does | Next-specific dependencies | Trust / auth | Verdict |
|---|---|---|---|---|---|---|
| 8 | `app/.well-known/oauth-protected-resource/mcp/route.ts` | GET, OPTIONS | Returns `getMcpProtectedResourceMetadata()` JSON, CORS `*`. | none (imports `lib/mcp-auth`, `server-only`) | Public | **Move to API.** |

### Inventory 4 row 9

| # | File | Methods | What it does | Next-specific dependencies | Trust / auth | Verdict |
|---|---|---|---|---|---|---|
| 9 | `app/.well-known/oauth-protected-resource/route.ts` | GET, OPTIONS | Re-exports route 8 (`export { GET, OPTIONS } from "./mcp/route"`). | none | Public | **Move to API** with route 8 (serve both paths). |

### Inventory 5 exact file occurrences: apps/web/app/.well-known/oauth-authorization-server/route.ts

```text
12: const response = await fetch(metadataUrl, {
```

### Inventory 5 exact file occurrences: apps/web/lib/mcp-upload-http.ts

```text
32: const result = await routes.fetch(request);
```

## Acceptance criteria

- [x] MCP transport, metadata/discovery, host/origin rules and exact API/mcp audience move without Clerk-session middleware wrapping independent protocols.
- [x] OAuth/API-key scopes/roles/plan and current originating-principal checks survive both publication and upload continuations.
- [x] All five upload POSTs share relocated Upload Session adapter; signed browser handoff only admits initial open while valid and can identify resume after expiry.
- [x] Status/preparation/handoff/confirm JSON endpoints replace server reads/action with safe destinations; no raw web Prisma query remains.
- [x] CLI/native upload defaults, stdio examples and E2E endpoints use API; mcp-core human handoffs and Apps CSP keep correct web/API meanings.
- [x] No unowned files changed; paired review findings and verification evidence recorded under Comments.

## Verification

Run these from the repository root after dependencies are installed. A command naming a new package script is implemented by the owning setup ticket, not silently skipped. PostgreSQL gates need a disposable schema; a skipped DB suite does not satisfy its gate. During the undeployed integration sequence, record any unrelated transitional compile failure with its owning blocker; this ticket's behavior tests must pass and the final integrated gates cannot be waived.

```sh
bun test apps/api/src/domains/integrations
bun test packages/mcp-core apps/api/src/domains/integrations
bun run test:integration-api:db
bun run --cwd apps/api typecheck
```

## Comments

Append claim, requested seam changes, paired review and evidence here.

- Claimed by GPT-6.1-Sol for ticket 24 in the shared checkout. Edits limited to the ownership list and new integrations domain paths.

### Implemented contract and requests for owners

- MCP and the three discovery paths now live under `apps/api/src/domains/integrations`. The existing `createNarriflowMcpHttpHandler` stays outside first-party session middleware and CORS. Resource and audience use exactly `API_ORIGIN + /mcp`; only the API host is implicitly allowed. MCP origins include the explicit web origin for browser handoffs, plus the protocol allowlist. Discovery proxies the unchanged Clerk issuer document with an hour-long process cache, a 10-second fetch timeout, public GET/OPTIONS CORS and safe 502s.
- The five upload POSTs reuse ticket 15's `ingest/upload-session-http.ts`. Handoff requests verify Clerk **session Bearer** rather than cookies. Initial open verifies the unexpired signed intent and rechecks the originating OAuth token/key, scopes, Workspace role/status/plan and frozen settings. Subsequent transfer calls retain owner authority and signed session binding after expiry. Expired handoff preview uses `uploadSessionService.hasOwnSessionByClientKey(actor, integrationUploadSessionKey(actor.actorUserId, intent.clientIdempotencyKey))`; it performs no raw page DB query.
- Browser routes are `GET /api/integrations/mcp/status`, `/preparations?token=...`, `/upload-handoff?intent=...` and `POST /api/mcp/confirmations {token,decision}`. Continuations use signed-in admission and their signed Workspace, never `X-Workspace-Id`. Success DTOs contain the UI facts and frozen intent, never the encrypted originating OAuth token or caller state. Current member refusals include `details: {reason: role|plan|status, workspace: {workspaceId,workspaceName,role,status,pricingTier}}` for the existing connector recovery UI. Confirmation keeps the native signed publication acceptance identity and defers baseline/principal limiter refusal to `beforeAccept`, after replay lookup.
- **26**: consume `@narriflow/api-client/integrations`: `mcpStatusQueryOptions({transport,scope})`, `mcpPreparationQueryOptions({transport,scope,token,digest})`, `mcpUploadHandoffQueryOptions({transport,scope,intent,digest})`, `mcpContinuationDigest(token)`, `mcpConfirmationMutationOptions({transport,scope})`, `invalidateAfterMcpConfirmation(queryClient,signedWorkspaceScope)` and `createMcpUploadControls({transport,scope,workspaceId,token,resumeOnly})`. Preparation returns `{workspaceId, workspaceName, destinationAccount, expiresAt, intent}`. Upload handoff returns `{workspaceId, clientIdempotencyKey, title?, brandProfileId?, recipeId?, recipeName, resumeOnly, generationContext?}`. The controls match ticket 16's updated `UploadSessionControls` interface. Pass them as `controls` to the browser Upload Session adapter; remove the old path-rewriting `fetcher`. Control methods call A with identity Bearer + signed intent and map expired opens to status. Keep direct storage traffic on the adapter's existing credential-free transport. Keep existing picker props. Delete the old page/action backend imports and raw upload-page Prisma query in your ownership; their old helpers were removed here.
- **31 / composition owner**: inject the process's existing Clerk client into `createMcpTransportDeps(config, clerkClient)` from `apps/api/src/runtime.ts`, passing it through `createExternalRoutes`; the second parameter is supported now. Without that central edit the factory creates its own client, so session verification works but duplicates the core client. Only the handoff branch uses this session verifier; machine MCP remains independent.
- **31**: change `packages/services/scripts/run-integration-api-db-tests.ts`'s final suite from `apps/web/lib/rest-api/events.db.test.ts` to `apps/api/src/domains/rest/events.db.test.ts` and rerun the root gate. The relocated suite already passes independently under the disposable wrapper.
- **31 / configuration owner**: add `NARRIFLOW_URL=http://localhost:4000` and an explicit human `WEB_ORIGIN` to the MCP example, and update the MCP client setup docs to A/mcp. No `.env*` file, including `.env.example`, was edited because the user prohibited env edits. CLI upload and stdio resource defaults are 4000 now; stdio passes `NARRIFLOW_URL` as the API CSP origin. Human links and Task export review URLs retain WEB_ORIGIN; Apps connect/resource CSP uses API/storage domains.
- Paired review is reserved for Claude/orchestrator; no delegate was started. The final acceptance checkbox stays open until that review. No changes were made to files outside ticket 24 ownership, no commits, installs or environment edits.

### Verification evidence

- `bun test apps/api/src/domains/integrations`: **42 pass**, 0 fail, 7 files. Covers exact resource metadata, process TTL, discovery outage, host/origin before credential admission, MCP preflight including signed upload header, every upload action, chunked body bound, **W/mcp OAuth audience refusal**, signed-in-only policy before validation, signed Workspace independent of header, JSON confirmation, route inventory, expired handoff service lookup and current role/plan/status recovery.
- `bun test packages/mcp-core apps/api/src/domains/integrations`: **196 pass**, 0 fail, 22 files. Existing protocol, credential scopes/revocation, continuation, Apps, Task and wire assertions survive.
- `bun test packages/mcp-core apps/api/src/domains/integrations apps/mcp/src packages/api-client/src/integrations`: **204 pass**, 0 fail, 24 files. Includes five client tests for digest-only query keys, abortable identity Bearer reads, scoped status, typed JSON confirmation/errors and expired-upload control mapping. API-client source exports inferred read and mutation DTOs through the chained integrations route type.
- `.scratch/api-extraction/db-gate.sh bun run test:integration-api:db`: **148 pass**, 0 fail/skip in its first nine suites, then the command fails because its last path still names the deleted web REST events test. `.scratch/api-extraction/db-gate.sh bun apps/api/src/domains/rest/run-db-tests.ts`: relocated REST/MCP events suite **7 pass**, 0 fail/skip. All DB execution used the wrapper's local throwaway PostgreSQL, never shared Neon. Root integrated gate still needs the runner path fix and a clean rerun by 31.
- `bun run --cwd packages/mcp-core typecheck`, `bun run --cwd apps/mcp typecheck`, `bun run --cwd packages/validators typecheck`: clean.
- `bun run --cwd apps/api typecheck` and `bun run --cwd packages/api-client typecheck`: no ticket 24 source error. Transitional errors: `apps/api/src/domains/rest/routes.ts:176` middleware environment cast, ticket **23**; `apps/api/src/domains/reviews/guest-replay-child.ts:6` duplicate `@types/pg` Pool types, ticket **27**, API check only. API-client check reports the REST cast only.
- `bun run --cwd apps/web typecheck`: transitional failures in the unconverted MCP pages/action/picker/billing link, ticket **26**, plus `settings/actions.ts`, `settings/api/callback-secret-panel.tsx`, ticket **25**; `settings/workspace/censor-words-card.tsx`, ticket **10**; progress route/reauthorization, ticket **29**; old authenticated action/page helpers, ticket **31**; and REST's cast, ticket **23**. No surviving owned web implementation remains.
- `bunx biome check` on the **33** surviving owned source paths, including new directories: clean. `git diff --check` on owned source paths: clean. No source, manifests, env files or tracker files owned by another ticket were edited by this implementer.
- Paired review pending Claude. Implementation is complete within ticket ownership; the explicit central/config/UI requests above remain with their owners. No disagreement with the spec; env/example edits were withheld under the user's stricter instruction.

- Close-out: **done** for implementation, with the paired-review checkbox deliberately pending Claude. The endpoint migration provides replacements for ticket 26's still-unconverted web reads/action. Environment/example changes remain withheld by user instruction; the exact central changes needed from other owners are recorded above.

- Sol claimed the paired-review fixes on 2026-10-29. No commits, env changes or dependency installs; concurrent 28/29 source ownership retained.

### Sol paired-review resolution, 2026-10-29

- Findings and decisions are recorded per finding in [the paired review's Resolution (Sol)](../review-claude-sol-tickets.md#resolution-sol). Both API type errors are fixed without an install; all seven internal review receipt names now obey the registry naming rule.
- Final scoped tests: 329 pass, 17 DB-only skips, no failures; Zapier 74 pass and Make 13 pass. API, API-client, services and Zapier typechecks pass. OpenAPI still matches all 31 operations. Scoped Biome checks all 15 supported changed code files clean; integrations are excluded by the repository configuration and pass their own checks.
- All DB commands used `db-gate.sh` against local disposable PostgreSQL only. Policy gate 4 pass; review replay gate 6 pass; moved REST/MCP parity gate 7 pass. The top-level integration gate passed 148 service tests then failed solely on its deleted web REST suite path. Ticket 31 must replace `apps/web/lib/rest-api/events.db.test.ts` with `apps/api/src/domains/rest/events.db.test.ts` in `packages/services/scripts/run-integration-api-db-tests.ts` and rerun the command. No unowned runner edited.
- Restored non-production localhost/127.0.0.1/[::1] host admission without changing canonical API/mcp resource or token audience. Missing issuer now refuses protected-resource discovery safely. Existing post-expiry confirmation refusal remains intentional, as explained for L14.
- Status is blocked on ticket 31 correcting and rerunning the required top-level integration DB runner. The service suites and moved REST/MCP suite passed separately; no DB suite is waived.

- Orchestrator 2026-10-30: closed. Implementation committed and deployed from GitHub `dev`; review findings resolved (review-*.md); live verification recorded in cutover-log.md and the browser-verification reports.
