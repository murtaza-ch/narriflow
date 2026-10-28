# 08. Expose Project and library reads and commands

**What to build:** Project and library controls plus screen aggregates replace Project/folder actions and direct reads without changing workflow/usage ownership.

**Blocked by:** [04 - Wire API runtime and partition the catch-all](04-wire-api-runtime-and-partition-the-catch-all.md)

**Status:** done

**Suggested implementer:** Claude. The other pairing side reviews and returns findings to this owner.

Read [spec.md](../spec.md). It is the complete contract; the original brief/plan/reviews are not prerequisites. Claim this ticket before editing.

## Exact ownership

Paths are repo-relative. Every existing file below is exclusively assigned for this phase, including files that only need verification. A new `/**` directory includes its local tests/helpers, not adjacent directories. Read other files as evidence; do not edit them.

Existing files:

- `packages/services/src/workspace-library.service.ts`

New files/directories or reserved skeletons handed off by a blocker:

- `apps/api/src/domains/projects/**`
- `apps/api/src/types/projects.ts`
- `packages/api-client/src/projects/**`
- `packages/validators/src/api/projects.ts`
- `apps/api/src/domains/library/**`
- `apps/api/src/types/library.ts`
- `packages/api-client/src/library/**`
- `packages/validators/src/api/library.ts`
- `packages/services/src/projects-receipt-commands.ts`
- `packages/services/src/projects-commands.ts`
- `packages/services/src/projects-commands-runtime.ts`

project.service.ts belongs to 15, not this ticket. Record requested method changes in Comments for 15. The old projects/actions.ts is removed by 31 only after every caller changes; this ticket implements server semantics in API, not that old module.

The chosen new endpoints for this ticket are the matching owner row in spec.md, "Endpoint and screen contracts added by extraction". All current endpoints/actions below retain their semantics unless that row explicitly changes transport. Fill only this domain's receipt-command module; current native receipts remain native.

## Endpoints, actions, pages and refresh sites

Rows retain their section/ordinal or exact source-line identifier from the independent inventory. Abbreviated table filenames are accompanied by the literal ownership manifest and exact source occurrences below. All action/page/fetch/refresh rows in owned files are in scope, including no-refresh callers and media navigation. Baseline observations do not override the spec's selected origins, route style, guest Bearer or new endpoints.

### Inventory 1.4 function `createFolderAction(name)`

| File:line | Function | Input | Service / auth calls | Policy helper + capability | Plan check | Returns | Side effects | Client callers | Target endpoint | Domain |
|---|---|---|---|---|---|---|---|---|---|---|
| `app/(app)/projects/actions.ts:54` | `createFolderAction(name)` | `string` (validated in service) | `workspaceLibraryService.createFolder` | `executeWorkspaceAction("content.edit")` | none | `{ok:true, folder:{...,createdAt ISO}}` / `{ok:false, error, errorCode, requestId}` (double try/catch) | `revalidatePath("/projects")` | `app/(app)/projects/_components/projects-header-actions.tsx:32` (`router.refresh`:46) | `POST /api/library/folders` | projects |

### Inventory 1.4 function `deleteFolderAction(folderId)`

| File:line | Function | Input | Service / auth calls | Policy helper + capability | Plan check | Returns | Side effects | Client callers | Target endpoint | Domain |
|---|---|---|---|---|---|---|---|---|---|---|
| `:94` | `deleteFolderAction(folderId)` | `string` | `workspaceLibraryService.deleteFolder` | `executeWorkspaceAction("content.edit")` | none | `void` / failure | `revalidatePath("/projects")` | `projects/_components/folders-panel.tsx:67` (`router.refresh`:75) | `DELETE /api/library/folders/:folderId` | projects |

### Inventory 1.4 function `renameFolderAction(folderId, name)`

| File:line | Function | Input | Service / auth calls | Policy helper + capability | Plan check | Returns | Side effects | Client callers | Target endpoint | Domain |
|---|---|---|---|---|---|---|---|---|---|---|
| `:104` | `renameFolderAction(folderId, name)` | `string, string` | `workspaceLibraryService.renameFolder` | `executeWorkspaceAction("content.edit")` | none | `{ok:true}` / `{ok:false,...}` | `revalidatePath("/projects")` | `folders-panel.tsx:42` (`router.refresh`:52) | `PATCH /api/library/folders/:folderId` | projects |

### Inventory 1.4 function `moveProjectToFolderAction(projectId, folderId\|null)`

| File:line | Function | Input | Service / auth calls | Policy helper + capability | Plan check | Returns | Side effects | Client callers | Target endpoint | Domain |
|---|---|---|---|---|---|---|---|---|---|---|
| `:142` | `moveProjectToFolderAction(projectId, folderId\|null)` | `string, string\|null` | `workspaceLibraryService.moveProject` | `executeProjectAction(projectId,"content.edit")` | none | `void` / failure | `revalidatePath("/projects")` | `projects/_components/projects-explorer.tsx:100` (`router.refresh`:113), `folders-panel.tsx:86` (`router.refresh`:94) | `PUT /api/projects/:projectId/folder` `{folderId}` | projects |

### Inventory 1.4 function `queueTranscriptionFormAction(formData)` (alias `queueGenerationFormAction` :187, no callers)

| File:line | Function | Input | Service / auth calls | Policy helper + capability | Plan check | Returns | Side effects | Client callers | Target endpoint | Domain |
|---|---|---|---|---|---|---|---|---|---|---|
| `:156` | `queueTranscriptionFormAction(formData)` (alias `queueGenerationFormAction` :187, no callers) | `formData`: `projectId`, `idempotencyKey` (default `randomUUID()`), content pack via `readContentPackFromForm`, `readLanguageCodeFromForm` (`app/(app)/upload/_lib/content-pack-form.ts`) | `projectService.triggerGeneration(appUser, projectId, {contentPack, forceRegenerate:false, languageCode}, idempotencyKey)` | `executeProjectAction(projectId,"processing.consume")` | credits/length via `ProcessingUsageError` from service; caught -> **`redirect("/projects/:id")`** (page shows limit + upgrade) | `void`; throws on missing `projectId` | `revalidatePath("/projects/:id")`; `redirect` on plan limit | `projects/[projectId]/processing-panel.tsx:487` and `projects/[projectId]/page.tsx:869` (`AuthenticatedActionForm action=`) | existing `POST /api/projects/:id/generate` (route.ts:448, verify parity: contentPack/languageCode/idempotency) ; plan-limit becomes a typed `ApiError` (`code`, `details`) the client renders instead of redirecting | projects |

### Inventory 1.4 function `applyProjectBrandProfileFormAction(formData)`

| File:line | Function | Input | Service / auth calls | Policy helper + capability | Plan check | Returns | Side effects | Client callers | Target endpoint | Domain |
|---|---|---|---|---|---|---|---|---|---|---|
| `:189` | `applyProjectBrandProfileFormAction(formData)` | `brandProfileProjectApplicationSchema` `{projectId, profileId, templateId\|null}` | `brandProfileService.applyToProject(actor, projectId, {profileId, templateId})` | `executeProjectActionWithInput(projectId,"content.edit")` | none | `void` / failure | `revalidatePath("/projects/:id")` | `projects/[projectId]/project-brand-picker.tsx:55` | `PUT /api/projects/:projectId/brand-profile` (or reuse `/projects/:id/campaign-operations/apply-brand-profile`, route.ts:930, which applies to selected clips; different semantics, verify) | brand-kit / projects |

### Inventory 1.4 function `regenerateClipsFormAction(formData)`

| File:line | Function | Input | Service / auth calls | Policy helper + capability | Plan check | Returns | Side effects | Client callers | Target endpoint | Domain |
|---|---|---|---|---|---|---|---|---|---|---|
| `:222` | `regenerateClipsFormAction(formData)` | `projectId`, `idempotencyKey`, content pack | `clipService.regenerateClips(appUser, projectId, idempotencyKey, contentPack)` | `executeProjectAction(projectId,"processing.consume")` | `ProcessingUsageError` -> `redirect("/projects/:id")` | `void` | `revalidatePath`; `redirect` on plan limit | `processing-panel.tsx:449`, `projects/[projectId]/page.tsx:940` | existing `POST /api/projects/:id/clips/regenerate` (`clip-generation-http.ts:11`, verify parity) | projects |

### Inventory 1.4 function `renderClipsFormAction(formData)`

| File:line | Function | Input | Service / auth calls | Policy helper + capability | Plan check | Returns | Side effects | Client callers | Target endpoint | Domain |
|---|---|---|---|---|---|---|---|---|---|---|
| `:249` | `renderClipsFormAction(formData)` | `projectId`, `idempotencyKey`, `aspectRatios[]` | `clipService.triggerClipRendering(appUser, projectId, idempotencyKey, undefined, aspectRatios\|undefined, "1080p")` | `executeProjectAction(projectId,"processing.consume")` | none | `void` | `revalidatePath("/projects/:id")` | **none (dead)** | existing `POST /api/projects/:id/clips/render` (route.ts:752); delete the action | projects |

### Inventory 1.4 function `setNotifyPreferenceAction(projectId, notifyOnComplete)`

| File:line | Function | Input | Service / auth calls | Policy helper + capability | Plan check | Returns | Side effects | Client callers | Target endpoint | Domain |
|---|---|---|---|---|---|---|---|---|---|---|
| `:331` | `setNotifyPreferenceAction(projectId, notifyOnComplete)` | `string, boolean` | `projectService.setProjectNotifyPreference`; catches `ProjectNotFoundError` | `executeProjectAction(projectId,"content.edit")` | none | `{ok:boolean, error?}` | none (no revalidate) | `processing-panel.tsx:299` | `PUT /api/projects/:projectId/notify-preference` | projects |

### Inventory 1.4 function `deleteProjectFormAction(formData)`

| File:line | Function | Input | Service / auth calls | Policy helper + capability | Plan check | Returns | Side effects | Client callers | Target endpoint | Domain |
|---|---|---|---|---|---|---|---|---|---|---|
| `:365` | `deleteProjectFormAction(formData)` | `projectId` | `projectService.deleteProject`; maps `ProjectAccessDeniedError`, `ProjectHasActiveWorkflowError`, `ProjectHasActivePublicationError`, `ProjectDeletionIncompleteError`; `ProjectNotFoundError` = success | `executeProjectAction(projectId,"content.edit")` | none | `{ok:false, error}` on mapped failure; on success **`redirect("/projects")`** | `revalidatePath("/projects")`, `redirect("/projects")` | `projects/_components/delete-project-button.tsx:62` | `DELETE /api/projects/:projectId` (idempotent: 404 treated as success by client); client navigates to `/projects` | projects |

### Inventory 3.2 row 14

| # | Method | Path (under `/api`) | Source | Handler calls | Handler-level validation | Policy (cap / admission / input) | Rate limit | Flags | Style | Domain (9.4) |
|---|---|---|---|---|---|---|---|---|---|---|
| 14 | GET | `/projects` | route.ts:346 | `workspaceLibraryService.listProjects` |  | browser-session: `content.view`, workspace |  |  | plain Hono | D2 |

### Inventory 3.2 row 15

| # | Method | Path (under `/api`) | Source | Handler calls | Handler-level validation | Policy (cap / admission / input) | Rate limit | Flags | Style | Domain (9.4) |
|---|---|---|---|---|---|---|---|---|---|---|
| 15 | GET | `/workspace/search` | route.ts:377 | `workspaceLibraryService.search` |  | browser-session: `content.view`, workspace |  |  | plain Hono | D11 |

### Inventory 3.2 row 16

| # | Method | Path (under `/api`) | Source | Handler calls | Handler-level validation | Policy (cap / admission / input) | Rate limit | Flags | Style | Domain (9.4) |
|---|---|---|---|---|---|---|---|---|---|---|
| 16 | GET | `/library/search` | route.ts:386 | `librarySearchService.search` |  | browser-session: `content.view`, workspace; custom zod (query) | actor `library-search` 30/60s |  | plain Hono | D11 |

### Inventory 3.2 row 20

| # | Method | Path (under `/api`) | Source | Handler calls | Handler-level validation | Policy (cap / admission / input) | Rate limit | Flags | Style | Domain (9.4) |
|---|---|---|---|---|---|---|---|---|---|---|
| 20 | POST | `/projects/:id/generate` | route.ts:448 | `projectService.triggerGeneration` | `generateProjectRequestSchema` | browser-session: `processing.consume`, project(id) | actor `gen` 20/60s | idempotency-key header | plain Hono | D2 |

### Inventory 3.2 row 21

| # | Method | Path (under `/api`) | Source | Handler calls | Handler-level validation | Policy (cap / admission / input) | Rate limit | Flags | Style | Domain (9.4) |
|---|---|---|---|---|---|---|---|---|---|---|
| 21 | GET | `/projects/:id` | route.ts:473 | `projectService.getProjectSnapshot` |  | browser-session: `content.view`, project(id) |  |  | plain Hono | D2 |

### Inventory 3.2 row 22

| # | Method | Path (under `/api`) | Source | Handler calls | Handler-level validation | Policy (cap / admission / input) | Rate limit | Flags | Style | Domain (9.4) |
|---|---|---|---|---|---|---|---|---|---|---|
| 22 | GET | `/projects/:id/runs/:workflowRunId` | route.ts:486 | `projectService.getWorkflowRun` |  | browser-session: `content.view`, project(id) |  |  | plain Hono | D2 |

### Inventory 3.2 row 23

| # | Method | Path (under `/api`) | Source | Handler calls | Handler-level validation | Policy (cap / admission / input) | Rate limit | Flags | Style | Domain (9.4) |
|---|---|---|---|---|---|---|---|---|---|---|
| 23 | GET | `/projects/:id/transcript` | route.ts:507 | `projectService.getTranscriptSnapshot` |  | browser-session: `content.view`, project(id) |  |  | plain Hono | D2 |

### Inventory 3.2 row 24

| # | Method | Path (under `/api`) | Source | Handler calls | Handler-level validation | Policy (cap / admission / input) | Rate limit | Flags | Style | Domain (9.4) |
|---|---|---|---|---|---|---|---|---|---|---|
| 24 | GET | `/projects/:id/transcript/utterances` | route.ts:526 | `projectService.getTranscriptUtterancesRaw` |  | browser-session: `content.view`, project(id) |  |  | plain Hono | D2 |

### Inventory 3.2 row 25

| # | Method | Path (under `/api`) | Source | Handler calls | Handler-level validation | Policy (cap / admission / input) | Rate limit | Flags | Style | Domain (9.4) |
|---|---|---|---|---|---|---|---|---|---|---|
| 25 | GET | `/projects/:id/transcript/export` | route.ts:543 | `projectService.getTranscriptExport` | `transcriptExportFormatSchema` | browser-session: `content.download`, project(id) |  | binary/text body | plain Hono | D2 |

### Inventory 3.2 row 75

| # | Method | Path (under `/api`) | Source | Handler calls | Handler-level validation | Policy (cap / admission / input) | Rate limit | Flags | Style | Domain (9.4) |
|---|---|---|---|---|---|---|---|---|---|---|
| 75 | GET | `/broll/search` | route.ts:1433 | `isPexelsConfigured`, `searchBrollVideos` | `brollSearchQuerySchema` | browser-session: `content.edit`, workspace | actor `broll-search` 60/60s |  | plain Hono | D11 |

### Inventory 3.2 row 76

| # | Method | Path (under `/api`) | Source | Handler calls | Handler-level validation | Policy (cap / admission / input) | Rate limit | Flags | Style | Domain (9.4) |
|---|---|---|---|---|---|---|---|---|---|---|
| 76 | GET | `/projects/:id/content-suite` | route.ts:1453 | `contentSuiteService.list` |  | browser-session: `content.view`, project(id) |  |  | plain Hono | D2 |

### Inventory 3.2 row 77

| # | Method | Path (under `/api`) | Source | Handler calls | Handler-level validation | Policy (cap / admission / input) | Rate limit | Flags | Style | Domain (9.4) |
|---|---|---|---|---|---|---|---|---|---|---|
| 77 | POST | `/projects/:id/content-suite` | route.ts:1460 | `contentSuiteService.generate` | `generateContentSuiteRequestSchema` | browser-session: `processing.consume`, project(id) | actor `content-suite` 30/60s |  | plain Hono | D2 |

### Inventory 3.2 row 78

| # | Method | Path (under `/api`) | Source | Handler calls | Handler-level validation | Policy (cap / admission / input) | Rate limit | Flags | Style | Domain (9.4) |
|---|---|---|---|---|---|---|---|---|---|---|
| 78 | GET | `/projects/:id/analytics` | route.ts:1475 | `analyticsService.getProjectAnalytics` |  | browser-session: `content.view`, project(id) |  |  | plain Hono | D2 |

### Inventory 3.2 row 85

| # | Method | Path (under `/api`) | Source | Handler calls | Handler-level validation | Policy (cap / admission / input) | Rate limit | Flags | Style | Domain (9.4) |
|---|---|---|---|---|---|---|---|---|---|---|
| 85 | GET | `/projects/:id/dubs` | route.ts:1663 | `dubbingService.listProjectDubs` |  | browser-session: `content.view`, project(id) |  |  | plain Hono | D2 |

### Inventory 3.2 row 86

| # | Method | Path (under `/api`) | Source | Handler calls | Handler-level validation | Policy (cap / admission / input) | Rate limit | Flags | Style | Domain (9.4) |
|---|---|---|---|---|---|---|---|---|---|---|
| 86 | POST | `/projects/:id/dubs` | route.ts:1669 | `dubbingService.requestClipDub` | `requestClipDubSchema` | browser-session: `processing.consume`, project(id) | actor `dubs` 20/60s | idempotency-key header | plain Hono | D2 |

### Inventory 3.2 row 87

| # | Method | Path (under `/api`) | Source | Handler calls | Handler-level validation | Policy (cap / admission / input) | Rate limit | Flags | Style | Domain (9.4) |
|---|---|---|---|---|---|---|---|---|---|---|
| 87 | GET | `/projects/:id/dubs/:dubId/download` | route.ts:1688 | `dubbingService.getDubDownloadUrl` | `dubDownloadQuerySchema` | browser-session: `content.download`, project(id) |  |  | plain Hono | D2 |

## Acceptance criteria

- [x] All copied route/action/page rows have mapped endpoints, including folder CRUD/move, notify/delete, brand apply, transcript/status/history/finishing/credits/dubs/source grant.
- [x] Home/explorer/detail aggregates preserve tabs/filters/cursors and conditional capabilities; no N+1 browser waterfall or unconditional transcript load.
- [x] Folders and retryable create/commands use durable receipts and native workflow admission; same key/payload replay and changed-body conflict tested.
- [x] Any project.service.ts changes are requested from 15; do not edit its file. Project mismatch stays an explicit switch.
- [x] No unowned files changed; paired review findings and verification evidence recorded under Comments.

## Verification

Run these from the repository root after dependencies are installed. A command naming a new package script is implemented by the owning setup ticket, not silently skipped. PostgreSQL gates need a disposable schema; a skipped DB suite does not satisfy its gate. During the undeployed integration sequence, record any unrelated transitional compile failure with its owning blocker; this ticket's behavior tests must pass and the final integrated gates cannot be waived.

```sh
bun test apps/api/src/domains/library
bun test apps/api/src/domains/projects
bun run test:workflow:db
bun run test:library-search:db
bun run --cwd apps/api typecheck
```

## Comments


Claimed and implemented by Claude (Sonnet 5.5), 2026-10-29. Paired review not run by the implementer (left to the orchestrator); the last acceptance box is ticked for "no unowned files changed" only, review findings are still to be recorded.

### Endpoints (all through `createRouteApp`; declarations in `domains/{projects,library}/admission.ts`)
- projects: `GET /home`, `GET /projects/explorer` (registered before `/projects/:id`), `GET /projects/:id/detail?tab=`, `GET /projects/:id/{content-pack,workflow-history,finishing,credit-usage,source-url,dubs/allowance}`, `DELETE /projects/:id`, `PATCH /projects/:id/folder {folderId|null}`, `POST /projects/:id/brand-profile {profileId, templateId|null}`, `PUT /projects/:id/notify-preference {notifyOnComplete}`; `GET /projects/:id/transcript?view=full|status` (default `full` = unchanged snapshot; `status` = `{view:"status", transcript:{status,errorCode}|null}`). Every existing route kept (list gained the shared lenient query schema).
- library: `GET /workspace/folders`, `POST /library/folders` (retryable create), `PATCH|DELETE /library/folders/:folderId`; search routes kept, now with query validators so the client types them.
- Mutations answer `{ok:true}`; folder create answers `{folder:{id,name,createdAt}}` 201, replay 200 + `Idempotent-Replayed: true`.

### Contract for UI tickets (09, 10, 12, 16, 31)
- Detail DTO (`readProjectDetail`, `domains/projects/read-models.ts`): `{tab, access:{role,status,pricingTier,isPersonalWorkspace}, snapshot (project, progress, activeRun, lastSeq, ingestAttemptCount, ingestJobType), transcript:{view,data}, clips, contentPack, socialPosts:{items,nextCursor}, workflowHistory, usage, finishing, creditUsage, tabData:{analytics, socialAccounts, workspaceTimezone, dubs, dubAllowance, brandChoices[{id,name,colors,logoUrl}], reviewRoom, sourceVideo:{url,expiresAt}|null}}`. Every read starts together (`Promise.all`); `tabData` is filled only for the active tab (full transcript only on `transcript`; brand choices + source grant only on `clips`; accounts + timezone on `posts`/`clips`). Derived UI facts (upgrade prompts, can1080p, canEdit, quota messages, pipeline) are computed in the client from `access`/`usage`/validators helpers; none is computed server-side. Plan-limit refusals on generate are now `ApiError` (`code` + `details`) instead of `redirect()`.
- Home DTO: `{firstName, items, canCreate, readOnlyReason: "viewer"|"paused"|null, canManageBilling, autopilot:{lockedTier, rules, activeRules}, showRetentionBanner}`; the greeting hour is the client's. Explorer DTO: `{page:{items,nextCursor,totalCount,statusCounts}, folders[{id,name,createdAt,projectCount}], activeFolder, filters, access:{canEdit,canCreate,canManageBilling,showRetentionBanner}}`; next pages come from `projectQueries.list` (`GET /projects?cursor=`).
- `@narriflow/validators/api/projects` now holds `PROJECT_TABS`, `ProjectTab`, `projectTabFromSearchParam`, filter constants and the query/command schemas: 10 should make `app/(app)/projects/[projectId]/project-tab.ts` re-export these instead of keeping a copy.
- API-client: `projectQueries` (home, explorer, list (infinite), detail, snapshot, transcript/transcriptStatus, contentPack, workflowHistory, finishing, creditUsage, sourceUrl, dubsAllowance), `projectCommands`, `invalidateProject|AfterGeneration|AfterBrandApplied|AfterNotifyPreference|AfterProjectMoved|AfterProjectDeleted`, `libraryQueries` (folders, workspaceSearch, search, broll), `folderCommands`, `invalidateAfterFolderChange`. Detail key is `[...scopedKey(scope,'projects','detail',projectId), tab]` (a seventh element on purpose, so `invalidateScoped(..., 'projects','detail', projectId)`, which ticket 27's reviews client already calls, refreshes every opened tab). Folder create and generate take the intent's key as the `Idempotency-Key` header. Delete: treat a 404 `project_not_found` as success, then `invalidateAfterProjectDeleted` and navigate to the explorer.

### Decisions / deviations
- Move-to-folder is `PATCH /api/projects/:id/folder` (spec table) not the ticket's `PUT`. Brand apply is `POST /api/projects/:id/brand-profile` (spec table); the campaign-operations route stays selected-clip semantics (11).
- Folder creation is receipt-backed (`create_folder` in `projects-receipt-commands.ts`; `projects-commands.ts` `createFolder`; wiring in `-runtime.ts`): the folder row and receipt commit in one transaction, fingerprint = validated name, limiter enforced through `beforeAccept` only for new work (`deferRateRefusal`), authorization before replay. `workspace-library.service.ts` only gained the exported `validFolderName`/`folderCreateData`/`folderCreateSelect` that the command shares with `createFolder`.
- Source grant keeps `content.view` (what the Clips tab used); a reclaimed or unsignable source gives `{url:null, expiresAt:null}`. The Brand picker reads up to 100 profiles (was the default 24) and returns only id/name/colors/logo.
- Delete maps nothing by hand: `ProjectAccessDeniedError`, `ProjectHasActiveWorkflowError`, `ProjectHasActivePublicationError`, `ProjectDeletionIncompleteError` are expected domain failures and reach the client with their codes; only a Project already gone is success.
- Not mine, still to do: `retryIngestFormAction` (ingest, 15), `regenerateClipsFormAction` and `renderClipsFormAction` (existing clips endpoints, 11; render action is dead and is deleted with `projects/actions.ts` by 31). `readContentPackFromForm`/`readLanguageCodeFromForm` become client-side input builders for `generateProjectRequestSchema`; the schema already matches the old action (`forceRegenerate` false by default).
- No `project.service.ts` change was needed, so nothing is requested from 15.

### Observations (not changed, outside my brief)
- Creating or renaming a folder to an existing name still raises Prisma `P2002` (generic 500), as before; a typed `workspace_folder_name_taken` conflict would be the natural fix in `workspace-library.service.ts`'s catalog if the owner wants it.
- `apps/api/src/admission-tables.test.ts` currently fails on `GET /social/accounts` (publishing 17's in-progress admission edit) and `route-inventory.test.ts` cannot load until 05's validators exports (`inviteTokenParamSchema` etc.) land; neither is mine.

### Evidence
- `bun test apps/api/src/domains/projects apps/api/src/domains/library` -> 30 pass, 0 fail (includes a registration check that both domains register exactly their declarations, `/projects/explorer` not swallowed by `:id`, fail-closed guard intact). `bun test packages/services/src/projects-commands.test.ts` -> 6 pass (create once, replay, changed-name conflict, concurrent same key, limiter only for new work, invalid name records nothing).
- `.scratch/api-extraction/db-gate.sh bun run test:library-search:db` -> 23 pass, 0 fail. `.scratch/api-extraction/db-gate.sh bun run test:workflow:db` -> 175 pass, 0 fail.
- `bun run --cwd apps/api typecheck`: no errors in projects, library or services files I own; remaining errors are other tickets' in-progress files (brand/aggregates.ts 19, reviews/guest-replay-child.ts 27, session/* and workspace/routes.ts 05, studio/bootstrap.ts 13, services/clips-commands.ts 11).
- `bun run typecheck` in `packages/api-client` (my queries/mutations and `rpc-types.check.ts` compile) and `packages/validators` (exit 0): no errors in my files; api-client's remaining errors are `clips/mutations.ts` (11), `rest/routes.ts` (23), `workspace/routes.ts` (05) and `services/clips-commands.ts` (11).
- `bunx biome check` on all owned paths: clean.
