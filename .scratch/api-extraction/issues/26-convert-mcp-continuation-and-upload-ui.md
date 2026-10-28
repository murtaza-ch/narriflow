# 26. Convert MCP continuation and upload UI

**What to build:** MCP setup, confirmation and upload handoff pages become client views of signed-in continuation APIs, preserving the signed Workspace and originating principal.

**Blocked by:** [24 - Move MCP discovery and upload protocols](24-move-mcp-discovery-and-upload-protocols.md), [05 - Expose session and Workspace controls](05-expose-session-and-workspace-controls.md), [07 - Move billing API and convert billing UI](07-move-billing-api-and-convert-billing-ui.md)

**Status:** ready-for-agent

**Suggested implementer:** Sol. The other pairing side reviews and returns findings to this owner.

Read [spec.md](../spec.md). It is the complete contract; the original brief/plan/reviews are not prerequisites. Claim this ticket before editing.

## Exact ownership

Paths are repo-relative. Every existing file below is exclusively assigned for this phase, including files that only need verification. A new `/**` directory includes its local tests/helpers, not adjacent directories. Read other files as evidence; do not edit them.

Existing files:

- `apps/web/app/(app)/integrations/mcp/assistant-setup.tsx`
- `apps/web/app/(app)/integrations/mcp/confirm/actions.ts`
- `apps/web/app/(app)/integrations/mcp/confirm/loading.tsx`
- `apps/web/app/(app)/integrations/mcp/confirm/page.tsx`
- `apps/web/app/(app)/integrations/mcp/connector-unavailable.test.tsx`
- `apps/web/app/(app)/integrations/mcp/connector-unavailable.tsx`
- `apps/web/app/(app)/integrations/mcp/loading.tsx`
- `apps/web/app/(app)/integrations/mcp/page.tsx`
- `apps/web/app/(app)/integrations/mcp/upload/loading.tsx`
- `apps/web/app/(app)/integrations/mcp/upload/page.tsx`
- `apps/web/app/(app)/integrations/mcp/upload/upload-picker.tsx`
- `apps/web/app/(app)/integrations/mcp/workspace-billing-link.tsx`

New files/directories or reserved skeletons handed off by a blocker:

- Add tests beside the owned implementation only; no new cross-domain directory.

Consume the endpoint contracts owned by 24. API changes belong to those owners; this ticket owns caller conversion and cache effects.

## Endpoints, actions, pages and refresh sites

Rows retain their section/ordinal or exact source-line identifier from the independent inventory. Abbreviated table filenames are accompanied by the literal ownership manifest and exact source occurrences below. All action/page/fetch/refresh rows in owned files are in scope, including no-refresh callers and media navigation. Baseline observations do not override the spec's selected origins, route style, guest Bearer or new endpoints.

### Inventory 2.B page/type row at inventory line 243

| File (lines) | Gate (line) | Service / db / validators calls (line) | Params / searchParams | Redirect / notFound | Props to client components | Proposed GET endpoint(s) |
| --- | --- | --- | --- | --- | --- | --- |
| `app/(app)/integrations/mcp/page.tsx` (166) | content.view L35 | `inspectMcpConfiguration` (`lib/mcp-configuration.ts`: fetches `<CLERK_OAUTH_ISSUER>/.well-known/oauth-authorization-server` with 3 s timeout, no-store) L37; `workspaceAllowsCapability` | none | none | `AssistantSetup{mcpUrl,status,notice}`, `PromptCards`, `LockedButton` | **NEW `GET /api/integrations/mcp/status`** returning `{mcpUrl, configuration{verified,label,description}}` (reads `NEXT_PUBLIC_APP_URL`, `CLERK_OAUTH_ISSUER`, `CLERK_SECRET_KEY`, `MCP_CONTINUATION_SECRET`: all API-side). |

### Inventory 2.B page/type row at inventory line 244

| File (lines) | Gate (line) | Service / db / validators calls (line) | Params / searchParams | Redirect / notFound | Props to client components | Proposed GET endpoint(s) |
| --- | --- | --- | --- | --- | --- | --- |
| `app/(app)/integrations/mcp/confirm/page.tsx` (40) | `admitSignedInPage("/integrations/mcp/confirm?token=...")` L16 | `verifyMcpPreparation(token,{actorUserId})` (`@narriflow/mcp-core`) L22; `workspaceService.findActor` L25; `workspaceService.requireActor(...,"publishing.manage")` L27; `socialOAuthService.listAccounts` L29; `workspaceService.getWorkspace` L29; `isExpectedDomainFailure` | `searchParams`: `token, declined, failure` | none (renders unavailable states inline) | plain server render + `<form action={confirmMcpPublication}>` (`confirm/actions.ts`, other fork) | **NEW `GET /api/integrations/mcp/preparations?token=` ** (verifies token for the signed-in user, returns intent facts + `destinationAccount` + `workspaceName` + `expiresAtMs`, typed errors for expired/unavailable/connector-unavailable). `export const dynamic = "force-dynamic"`. Uses HMAC secret `MCP_CONTINUATION_SECRET` (API-side). |

### Inventory 2.B page/type row at inventory line 245

| File (lines) | Gate (line) | Service / db / validators calls (line) | Params / searchParams | Redirect / notFound | Props to client components | Proposed GET endpoint(s) |
| --- | --- | --- | --- | --- | --- | --- |
| `app/(app)/integrations/mcp/upload/page.tsx` (43) | `admitSignedInPage("/integrations/mcp/upload?intent=...")` L17 | `verifyMcpUploadHandoff(token,{actorUserId,allowExpired:true})` L19; `workspaceService.findActor` L22; `requireActor(...,"processing.consume")` L24; **direct db**: `getPrismaClient().uploadSession.findFirst(...)` L29-31 with `integrationUploadSessionKey`; `recipeService.get` L36; `buildGenerationContext` | `searchParams.intent` | none (renders unavailable inline) | `McpUploadPicker{token,workspaceId,clientIdempotencyKey,title,brandProfileId,recipeId,resumeOnly,generationContext}` | **NEW `GET /api/integrations/mcp/upload-handoff?intent=`** (verify, resume-only decision, recipe name, generation context). The only page doing a raw Prisma query; move the `uploadSession.findFirst` into a service (`UploadSessionService.hasIntegrationSession` or similar). |

### Inventory 5.10 refresh/fetch row at inventory line 862

| Action file | Paths revalidated |
| --- | --- |
| `(app)/integrations/mcp/confirm/actions.ts:27-29` | `redirect(...)` only |

### Inventory 5 exact file occurrences: apps/web/app/(app)/integrations/mcp/upload/upload-picker.tsx

```text
27: if (!path.startsWith("/api/upload-sessions/")) return fetch(input, init);
37: return fetch(`/mcp/integrations/${props.workspaceId}/upload-sessions/${action}`, { ...init, body, headers, credentials: "same-origin", redirect: "error" });
```

Also account for the inventory's cross-domain traps: query-only actions, action forms that relied on revalidatePath, signed downloads/media, OAuth anchors, all three EventSource consumers and unload keepalive. Only the literal files above may be changed by this ticket.

### Inventory 1.8 function `confirmMcpPublication(form: FormData)`, caller conversion

| File:line | Function | Input | Service / auth calls | Policy helper + capability | Plan check | Returns | Side effects | Client callers | Target endpoint | Domain |
|---|---|---|---|---|---|---|---|---|---|---|
| `app/(app)/integrations/mcp/confirm/actions.ts:10` | `confirmMcpPublication(form: FormData)` | `token`, `decision` (`confirm`/other) | `verifyMcpPreparation`, `acceptMcpConfirmation` (`@narriflow/mcp-core`), `workspaceService.requireActor(..., "publishing.manage")`, `getMcpMutationGuard` + `admitMcpContinuation` (`lib/mcp-auth.ts`, `lib/mcp-continuation-principal.ts`), `socialPublicationScheduling.schedule` | `executeSignedInAction` (the signed continuation token selects the workspace, never the browser's active workspace) | `hasFeature(tier, "integrations.mcp")` and `actor.status === "active"` | never returns: **`redirect()`** to `/integrations/mcp`, `/integrations/mcp/confirm?declined=1`, `/projects/:id?publicationId=...`, `/sign-in?redirect_url=...` (auth required), or `/integrations/mcp/confirm?failure=<code>` | `redirect` only | `app/(app)/integrations/mcp/confirm/page.tsx:39` (`<form action={confirmMcpPublication}>`) | `POST /api/mcp/confirmations` `{token, decision}` -> `{destination}`; client navigates. Auth is browser session + token (signed link); uses `lib/mcp-*` files that import `next/*` (see Section 7) | settings-integrations |

### Inventory 1.1 function `switchWorkspaceAction(workspaceId)`, caller conversion

| File:line | Function | Input | Service / auth calls | Policy helper + capability | Plan check | Returns | Side effects | Client callers | Target endpoint | Domain |
|---|---|---|---|---|---|---|---|---|---|---|
| `app/(app)/_actions/workspace.ts:13` | `switchWorkspaceAction(workspaceId)` | `workspaceSelectionActionSchema` `{workspaceId}` | `setActiveWorkspaceForActor` (`@narriflow/auth`; membership check + **sets cookie**) | `executeSignedInActionWithInput` (deliberately not workspace-scoped: a member of a paused workspace needs a way out) | none | `void` / `AuthenticatedActionFailure` | `revalidatePath("/", "layout")` | `app/workspace-unavailable/open-workspace-button.tsx:25` (then `router.push("/home")`), `app/(app)/projects/_components/workspace-mismatch-notice.tsx:49` (`router.push`+`router.refresh`), `app/(app)/integrations/mcp/workspace-billing-link.tsx:27` (`router.push`), `app/(app)/_components/workspace-switcher.tsx:51` (`router.refresh`:62), `app/(app)/_components/app-chrome.tsx:77` (`router.refresh`:88) | Client-only: store selected workspace id and send as header; optionally `POST /api/me/active-workspace` that validates membership and returns the workspace context. On success clients invalidate **all** queries. | workspace |

## Acceptance criteria

- [ ] MCP setup/confirm/upload pages query status/preparation/handoff and mutation confirmation, preserving signed-in admission independent of active Workspace.
- [ ] Upload picker targets API bridge with Bearer plus X-Narriflow-Upload-Intent; no same-origin-cookie assumption or raw web DB access.
- [ ] Workspace billing link uses validated switch before destination; setup resource URL uses API while browser links remain web.
- [ ] Expired/revoked/degraded connectors and OAuth consent destinations match current user states and never log signed tokens.
- [ ] No unowned files changed; paired review findings and verification evidence recorded under Comments.

## Verification

Run these from the repository root after dependencies are installed. A command naming a new package script is implemented by the owning setup ticket, not silently skipped. PostgreSQL gates need a disposable schema; a skipped DB suite does not satisfy its gate. During the undeployed integration sequence, record any unrelated transitional compile failure with its owning blocker; this ticket's behavior tests must pass and the final integrated gates cannot be waived.

```sh
bun test "apps/web/app/(app)/integrations/mcp"
```

Verify the changed flow in the running Next app against the separate API origin. Follow the repo's runtime/browser verification guidance; record steps, result and origin pair. Do not treat compilation as browser evidence.

## Comments

Append claim, requested seam changes, paired review and evidence here.
