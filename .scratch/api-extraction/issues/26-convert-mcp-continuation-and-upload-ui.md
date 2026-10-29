# 26. Convert MCP continuation and upload UI

**What to build:** MCP setup, confirmation and upload handoff pages become client views of signed-in continuation APIs, preserving the signed Workspace and originating principal.

**Blocked by:** [24 - Move MCP discovery and upload protocols](24-move-mcp-discovery-and-upload-protocols.md), [05 - Expose session and Workspace controls](05-expose-session-and-workspace-controls.md), [07 - Move billing API and convert billing UI](07-move-billing-api-and-convert-billing-ui.md)

**Status:** done

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

- [x] MCP setup/confirm/upload pages query status/preparation/handoff and mutation confirmation, preserving signed-in admission independent of active Workspace.
- [x] Upload picker targets API bridge with Bearer plus X-Narriflow-Upload-Intent; no same-origin-cookie assumption or raw web DB access.
- [x] Workspace billing link uses validated switch before destination; setup resource URL uses API while browser links remain web.
- [x] Expired/revoked/degraded connectors and OAuth consent destinations match current user states and never log signed tokens.
- [x] No unowned files changed; paired review findings and verification evidence recorded under Comments.

## Verification

Run these from the repository root after dependencies are installed. A command naming a new package script is implemented by the owning setup ticket, not silently skipped. PostgreSQL gates need a disposable schema; a skipped DB suite does not satisfy its gate. During the undeployed integration sequence, record any unrelated transitional compile failure with its owning blocker; this ticket's behavior tests must pass and the final integrated gates cannot be waived.

```sh
bun test "apps/web/app/(app)/integrations/mcp"
```

Verify the changed flow in the running Next app against the separate API origin. Follow the repo's runtime/browser verification guidance; record steps, result and origin pair. Do not treat compilation as browser evidence.

## Comments

Append claim, requested seam changes, paired review and evidence here.

- Claimed by GPT-6.1-Sol on 2026-10-29 for ticket 26 only.

### Request for shell owner 06 / cleanup 31

- `apps/web/app/(app)/_components/app-chrome.tsx:AppShell` always mounts `SessionGate > WorkspaceQueryGate` before rendering these pages. That blocks signed-in MCP continuations when the unrelated selected Workspace is restricted or unavailable. Exempt `/integrations/mcp/confirm` and `/integrations/mcp/upload` from selected-Workspace admission and render them through an identity-only continuation shell, preserving the existing presentation. Their API reads and controls already use identity scope and their signed Workspace. This file is unowned by 26; it will not be edited here.


### Implemented in ticket 26

- Setup is a client status query. It consumes the API's resource URL, configuration and admitted Workspace facts; no web environment/backend read remains. Existing assistant guides, links, cards, notices and `loading.tsx` stay in use.
- Confirmation and upload pages are data-free metadata/Suspense shells around local client screens. The screens hash signed inputs before constructing identity-only query options, preserve the existing frozen facts, captions, provider settings, Recipe/generation summary, picker and unavailable states, and consume typed connector recovery facts from `ApiError.code`/`details`. Tokens never enter query keys or mutation variables.
- Deleted `confirm/actions.ts`. Confirmation uses the integrations mutation factory with the original signed acceptance identity on explicit retry. A confirmed acceptance invalidates only publishing in the signed Workspace before navigating to the returned web destination. Decline follows its returned destination without publishing invalidation. No new idempotency wrapper or browser Workspace switch is added to a continuation.
- `upload-picker.tsx` passes `createMcpUploadControls` as `controls`, preserves the signed client key, and supplies neither a path-rewriting `fetcher` nor cookie credentials. Expired `open` becomes `status` through ticket 24's helper. Storage bytes retain the adapter's direct, uncredentialed XHR transport. Accepted intake invalidates the signed Workspace's ingest/projects/library/usage reads.
- Billing recovery uses `useWorkspaceSwitch()` and navigates only after membership validation succeeds. A refusal stays on the continuation and displays the existing safe failure wording.
- All edits are within this ticket's MCP directory and this tracker file. New local screen/helper/test files remain beside the owned implementations. No commits, dependency installs, environment changes, database calls or process termination.

### Verification evidence

- `bun test "apps/web/app/(app)/integrations/mcp"`: **7 pass, 0 fail**, including an isolated launcher that executes **12 passing flow tests**. Those tests use the real API provider/runtime/transport/QueryClient and Chakra views against a controlled API. They cover API resource/degraded configuration, frozen facts, signed-Workspace invalidation, decline, lost-response retry with the same acceptance, expired/revoked preparation, plan recovery, validated/refused billing selection, expired upload preview and actual picker status controls with a typed refusal, and declined-link empty state.
- `bun test './apps/web/app/(app)/integrations/mcp/continuation.browser.fixture.tsx' packages/api-client/src/integrations 'apps/web/app/(app)/upload/_lib/upload-session-browser.test.ts'`: **48 pass, 0 fail** before the final declined-link test was added. Existing adapter coverage includes direct storage bytes, single/multipart grants, pause/resume/discard, retry, polling, and no credential forwarding.
- Ran `bunx tsc -p apps/web/tsconfig.json --noEmit` once. It exposed a mutation-variable type error in the new screen, which was fixed. The initial full-web failures outside this ticket were `apps/api/src/domains/rest/routes.ts:176` (**23**), `projects/[projectId]/review-panel.tsx:128` (**28**), `settings/actions.ts` and `settings/api/callback-secret-panel.tsx` (**25**), `app/api/stream/**` and `lib/workflow-stream-reauthorization.ts` (**29/31**), and obsolete `lib/authenticated-request-{action,page}.ts` (**31**). These files were not edited.
- After the fix, a targeted TypeScript compiler-API check using the web tsconfig reported **13 production files, 0 diagnostics**. A subsequent check also includes the three normally excluded test/fixture files with the already installed Bun type declarations; its final result is recorded below. This checks only owned roots, without repeating the full web typecheck or changing any tsconfig.
- `bunx biome check "apps/web/app/(app)/integrations/mcp"`: clean, **16 files**. `git diff --check -- 'apps/web/app/(app)/integrations/mcp'`: clean. Source scan: no backend imports, Server Action, raw fetch, same-origin-cookie control, `router.refresh`, `revalidatePath` or `useFormStatus` remains.
- Live signed-in browser verification was **not run**. Neither localhost **3000** nor **4000** had a listening service. The fixture origin pair is **http://localhost:3000 -> https://api.test**, with mocked Clerk identity/HTTP, not live Next/API browser evidence. Ticket **32** must run W -> A setup, signed confirmation/decline/revoked connector, owner billing recovery and single/multipart upload/resume against configured Clerk/API origins, including an unrelated restricted selected Workspace and direct R2 requests without session credentials.

### Close-out / paired review

- Owned implementation is complete. Status is **blocked** because the first acceptance criterion cannot be met end-to-end until **06/31** fixes the inherited `AppShell` gate described above. The continuation reads, mutation and upload controls themselves are identity-only and tested with an unrelated selected Workspace; a child page cannot bypass a parent gate within this ticket's ownership.
- Paired review remains with Claude/orchestrator. No review delegate was started by this implementation sub-agent. The last acceptance box stays open for that review; no paired findings have been received.
- No intentional deviation from the API contract and no disagreement with the spec. The unowned shell gate is an implementation defect against its explicit signed-in continuation requirement.

- Final targeted TypeScript result, including the normally excluded tests/DOM fixture with installed Bun types: **16 files, 0 diagnostics**. Final Biome check: **16 files clean**; owned `git diff --check`: clean.

### Selected-Workspace exemption (resolved by Claude, 2026-10-29)

- `/integrations/mcp/confirm` and `/integrations/mcp/upload` moved (`git mv`, URLs unchanged) from `(app)` to a new route group `apps/web/app/(continuation)/`. Its `layout.tsx` + `continuation-shell.tsx` render `SessionApiProvider > RequireSignIn > SessionGate` in the focused-flow frame (logo, theme toggle, panel): signed-in required (signed-out goes to sign-in and back to the same link), identity bootstrap only, no Workspace bootstrap, billing read, credits or paused-Workspace redirect. `(app)/layout.tsx`/`AppShell` are untouched, so every other app route (including the `/integrations/mcp` setup page) still goes through `WorkspaceQueryGate`.
- Shared helpers stay in `(app)/integrations/mcp/` (`continuation.tsx` etc.); the moved screens import them by `@/app/(app)/...` alias. `continuation.browser.fixture.tsx` imports the moved screens from the new group.
- New test `(continuation)/continuation-shell.test.ts` (+ `.browser.fixture.tsx`, 3 cases): confirmation renders with a restricted selected Workspace and never reads `/api/workspace/bootstrap`; signed-out visitor redirected to sign-in with the original link; `AppShell` with the same restricted Workspace still redirects to `/workspace-unavailable` without rendering the page.
- Evidence: `bun test "apps/web/app/(continuation)" "apps/web/app/(app)/integrations/mcp" apps/web/app/_components/workspace-query-gate.test.ts` pass; full-web `tsc` shows no diagnostics in these paths; biome clean on both directories. Live signed-in browser pass still belongs to ticket 32. The last acceptance box (paired review) remains with the orchestrator.

- Sol claimed the paired-review fixes on 2026-10-29. Scope includes M1-M3 and L1-L3; the user also authorized the matching integrations API change.

### Paired-review resolutions, 2026-10-29

- Fixed all six findings from `review-claude-26-28.md`; that file now records one `## Resolution (Sol)` per finding, the failing reproductions, fixes and command evidence. The user expressly extended ownership to the matching integrations API runtime/tests for M3. No disagreement or remaining implementation request.
- Final web regression command, including review/share/continuation/MCP and review preselection/share-model tests: 20 pass, 0 fail. Isolated fixture processes cover 24 review/share, 17 MCP and three continuation-shell scenarios. API integrations/reviews plus reviews client: 64 pass, 8 DB-hook/test skips, 0 fail. The skipped receipt suite was separately enabled only through `.scratch/api-extraction/db-gate.sh`: 6 pass, 0 fail on disposable local PostgreSQL.
- Full web tsc and API typecheck exit 0. Repository lint exits 0 with 11 existing warnings and one info outside these fixes; owned Biome and diff checks are clean. `bun scripts/check-web-backend-imports.ts` passes. No commits, env-file edits, installs, shared DB access or termination of other agents' processes. Live signed-in W -> A verification remains with ticket 32.
