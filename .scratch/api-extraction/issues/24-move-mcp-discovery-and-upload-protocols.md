# 24. Move MCP discovery and upload protocols

**What to build:** MCP JSON-RPC/OAuth/API-key, discovery and five Upload Session POSTs work on the exact new resource origin with live continuation rechecks.

**Blocked by:** [04 - Wire API runtime and partition the catch-all](04-wire-api-runtime-and-partition-the-catch-all.md), [15 - Move intake Upload Sessions and recipes](15-move-intake-upload-sessions-and-recipes.md)

**Status:** ready-for-agent

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

- [ ] MCP transport, metadata/discovery, host/origin rules and exact API/mcp audience move without Clerk-session middleware wrapping independent protocols.
- [ ] OAuth/API-key scopes/roles/plan and current originating-principal checks survive both publication and upload continuations.
- [ ] All five upload POSTs share relocated Upload Session adapter; signed browser handoff only admits initial open while valid and can identify resume after expiry.
- [ ] Status/preparation/handoff/confirm JSON endpoints replace server reads/action with safe destinations; no raw web Prisma query remains.
- [ ] CLI/native upload defaults, stdio examples and E2E endpoints use API; mcp-core human handoffs and Apps CSP keep correct web/API meanings.
- [ ] No unowned files changed; paired review findings and verification evidence recorded under Comments.

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
