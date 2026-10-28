# 09. Convert explorer home and library search

**What to build:** Home, explorer, folders and library search use scoped queries with current filters, pagination and explicit Workspace mismatch recovery.

**Blocked by:** [08 - Expose Project and library reads and commands](08-expose-project-and-library-reads-and-commands.md), [05 - Expose session and Workspace controls](05-expose-session-and-workspace-controls.md), [07 - Move billing API and convert billing UI](07-move-billing-api-and-convert-billing-ui.md)

**Status:** ready-for-agent

**Suggested implementer:** Claude. The other pairing side reviews and returns findings to this owner.

Read [spec.md](../spec.md). It is the complete contract; the original brief/plan/reviews are not prerequisites. Claim this ticket before editing.

## Exact ownership

Paths are repo-relative. Every existing file below is exclusively assigned for this phase, including files that only need verification. A new `/**` directory includes its local tests/helpers, not adjacent directories. Read other files as evidence; do not edit them.

Existing files:

- `apps/web/app/(app)/_components/global-search.tsx`
- `apps/web/app/(app)/home/creation-tools.test.tsx`
- `apps/web/app/(app)/home/creation-tools.tsx`
- `apps/web/app/(app)/home/cut-artwork.module.css`
- `apps/web/app/(app)/home/cut-artwork.tsx`
- `apps/web/app/(app)/home/dashboard-client.tsx`
- `apps/web/app/(app)/home/dashboard-view.tsx`
- `apps/web/app/(app)/home/hero-experience.module.css`
- `apps/web/app/(app)/home/hero-experience.tsx`
- `apps/web/app/(app)/home/loading.tsx`
- `apps/web/app/(app)/home/page.tsx`
- `apps/web/app/(app)/home/recent-projects.tsx`
- `apps/web/app/(app)/projects/_components/delete-project-button.tsx`
- `apps/web/app/(app)/projects/_components/filter-toolbar.tsx`
- `apps/web/app/(app)/projects/_components/folders-panel.tsx`
- `apps/web/app/(app)/projects/_components/project-card.test.tsx`
- `apps/web/app/(app)/projects/_components/project-card.tsx`
- `apps/web/app/(app)/projects/_components/project-expiration.test.ts`
- `apps/web/app/(app)/projects/_components/project-expiration.tsx`
- `apps/web/app/(app)/projects/_components/project-row.tsx`
- `apps/web/app/(app)/projects/_components/project-thumbnail.tsx`
- `apps/web/app/(app)/projects/_components/projects-explorer.tsx`
- `apps/web/app/(app)/projects/_components/projects-header-actions.tsx`
- `apps/web/app/(app)/projects/_components/projects-skeleton.tsx`
- `apps/web/app/(app)/projects/_components/retention-banner.tsx`
- `apps/web/app/(app)/projects/_components/workspace-mismatch-notice.tsx`
- `apps/web/app/(app)/projects/_lib/gradient.ts`
- `apps/web/app/(app)/projects/_lib/status.ts`
- `apps/web/app/(app)/projects/_lib/youtube.ts`
- `apps/web/app/(app)/projects/loading.tsx`
- `apps/web/app/(app)/projects/page.tsx`
- `apps/web/app/(app)/search/library-search.tsx`
- `apps/web/app/(app)/search/loading.tsx`
- `apps/web/app/(app)/search/page.tsx`

New files/directories or reserved skeletons handed off by a blocker:

- Add tests beside the owned implementation only; no new cross-domain directory.

Consume the endpoint contracts owned by 08. API changes belong to those owners; this ticket owns caller conversion and cache effects.

## Endpoints, actions, pages and refresh sites

Rows retain their section/ordinal or exact source-line identifier from the independent inventory. Abbreviated table filenames are accompanied by the literal ownership manifest and exact source occurrences below. All action/page/fetch/refresh rows in owned files are in scope, including no-refresh callers and media navigation. Baseline observations do not override the spec's selected origins, route style, guest Bearer or new endpoints.

### Inventory 2.B page/type row at inventory line 223

| File (lines) | Gate (line) | Service / db / validators calls (line) | Params / searchParams | Redirect / notFound | Props to client components | Proposed GET endpoint(s) |
| --- | --- | --- | --- | --- | --- | --- |
| `app/(app)/home/page.tsx` (46) | `admitWorkspacePage("content.view")` L16 | `workspaceLibraryService.listProjects(appUser,{limit:8})` L19; `autopilotService.listRules` L21 (only if `content.edit`); `hasFeature`, `lowestTierWithFeature`, `planLimits` L37-42 | none | none | `DashboardView{greeting,items,canCreate,readOnlyReason,canManageBilling,autopilot{lockedTier,rules,activeRules},showRetentionBanner}` | Existing `GET /api/projects?limit=8` (route.ts L346) + existing `GET /api/autopilot/rules` (L242). Capability/tier flags derive client-side from `/api/session`. Greeting uses client clock (today server clock). |

### Inventory 2.B page/type row at inventory line 227

| File (lines) | Gate (line) | Service / db / validators calls (line) | Params / searchParams | Redirect / notFound | Props to client components | Proposed GET endpoint(s) |
| --- | --- | --- | --- | --- | --- | --- |
| `app/(app)/search/page.tsx` (18) | content.view L9 | none | `searchParams.q` (sliced to 300) | none | `LibrarySearch{initialQuery,canCreate}` | none beyond session; client already searches via `GET /api/library/search` (L386) and `GET /api/workspace/search` (L377). |

### Inventory 2.B page/type row at inventory line 228

| File (lines) | Gate (line) | Service / db / validators calls (line) | Params / searchParams | Redirect / notFound | Props to client components | Proposed GET endpoint(s) |
| --- | --- | --- | --- | --- | --- | --- |
| `app/(app)/projects/page.tsx` (246) | content.view L128 (header), L171 (data) | `workspaceLibraryService.listFolders` L135, L185; `workspaceLibraryService.listProjects(appUser,{folderId,query,status,source,sort})` L184; `planLimits`, `resolvePricingTier`, `workspaceAllowsCapability`. Type imports `ProjectListSort/SourceFilter/StatusFilter`. | `searchParams`: `q,status,source,sort,folder,requestFailure,workspaceId,workspaceName,returnTo,cursor?` | none (admission may redirect here with `requestFailure=active_workspace_mismatch`) | `ProjectsHeaderActions{canCreate,canEdit}`, `WorkspaceMismatchNotice{workspaceId,workspaceName,returnTo}`, `FoldersPanel{folders[{id,name,count}]}`, `RetentionBanner{canManageBilling}`, `ProjectsExplorer{initialProjects,initialNextCursor,totalCount,initialQuery,initialStatus,initialSource,initialSort,folderId,folderName,folders,canEdit,...}` | Existing `GET /api/projects?q&status&source&sort&folder&limit&cursor` (route.ts L346, already used by the explorer for paging). **NEW `GET /api/workspace/folders`** (`listFolders` with `_count.projects`). |

### Inventory 5.1 refresh/fetch row at inventory line 681

| file:line | Trigger | Mutation just performed | Refreshes |
| --- | --- | --- | --- |
| `(app)/projects/_components/workspace-mismatch-notice.tsx:64` | "Switch workspace" on a project in another workspace; `router.push(returnTo)` then refresh | `switchWorkspaceAction` (:49) | Whole tree, then project page for the new workspace |

### Inventory 5.2 refresh/fetch row at inventory line 702

| file:line | Trigger | Mutation just performed | Refreshes |
| --- | --- | --- | --- |
| `(app)/projects/_components/projects-header-actions.tsx:46` | "New folder" dialog | `createFolderAction(name)` (:32) | `/projects` folders list |

### Inventory 5.2 refresh/fetch row at inventory line 703

| file:line | Trigger | Mutation just performed | Refreshes |
| --- | --- | --- | --- |
| `(app)/projects/_components/folders-panel.tsx:52` | Inline rename | `renameFolderAction(folderId, name)` (:42) | `/projects` folders + counts |

### Inventory 5.2 refresh/fetch row at inventory line 704

| file:line | Trigger | Mutation just performed | Refreshes |
| --- | --- | --- | --- |
| `folders-panel.tsx:75` | Delete folder | `deleteFolderAction` (:67) | `/projects` |

### Inventory 5.2 refresh/fetch row at inventory line 705

| file:line | Trigger | Mutation just performed | Refreshes |
| --- | --- | --- | --- |
| `folders-panel.tsx:94` | Drop project onto folder | `moveProjectToFolderAction` (:86) | `/projects` |

### Inventory 5.2 refresh/fetch row at inventory line 706

| file:line | Trigger | Mutation just performed | Refreshes |
| --- | --- | --- | --- |
| `(app)/projects/_components/projects-explorer.tsx:113` | "Move to folder" dialog (bulk) | `moveProjectToFolderAction` per project (:100) | `/projects` list page 1 |

### Inventory 5.2 refresh/fetch row at inventory line 707

| file:line | Trigger | Mutation just performed | Refreshes |
| --- | --- | --- | --- |
| `projects-explorer.tsx:334` (inside `refresh` effect-event, called :356 and :360) | `setInterval(LIVE_REFRESH_INTERVAL_MS)` and `visibilitychange`, only while `hasActiveProjects` | none (poll) plus re-fetch of already-loaded extra pages with `GET /api/projects?cursor=` (:340); "load more" at :418 | `/projects` page 1 (server props) and "load more" pages (client state) |

### Inventory 5.3 refresh/fetch row at inventory line 765

| file:line | Trigger | Call | Notes |
| --- | --- | --- | --- |
| `(app)/search/library-search.tsx:94` | "Make clip" from a passage | `POST /api/projects/:p/clips/create-from-range` then `router.push(studio)` | No refresh |

### Inventory 5 exact file occurrences: apps/web/app/(app)/_components/global-search.tsx

```text
187: const response = await fetch(`/api/workspace/search?q=${encodeURIComponent(normalized)}`, {
```

### Inventory 5 exact file occurrences: apps/web/app/(app)/projects/_components/folders-panel.tsx

```text
52: router.refresh();
75: router.refresh();
94: router.refresh();
```

### Inventory 5 exact file occurrences: apps/web/app/(app)/projects/_components/projects-explorer.tsx

```text
113: router.refresh();
253: // `router.refresh()` to a single render pass ,  the old effect re-ran on
334: startTransition(() => router.refresh());
340: const response = await fetch(`/api/projects?${apiParams(cursor)}`);
418: const response = await fetch(`/api/projects?${params.toString()}`);
```

### Inventory 5 exact file occurrences: apps/web/app/(app)/projects/_components/projects-header-actions.tsx

```text
46: router.refresh();
```

### Inventory 5 exact file occurrences: apps/web/app/(app)/projects/_components/workspace-mismatch-notice.tsx

```text
64: router.refresh();
```

### Inventory 5 exact file occurrences: apps/web/app/(app)/search/library-search.tsx

```text
66: const response = await fetch(`/api/library/search?q=${encodeURIComponent(normalized)}`);
94: const response = await fetch(`/api/projects/${passage.projectId}/clips/create-from-range`, {
```

### Inventory 2.D page/type row at inventory line 291

| Client file | Types |
| --- | --- |
| `(app)/projects/_components/project-card.tsx`, `project-row.tsx`, `project-thumbnail.tsx`, `projects-explorer.tsx` | `ProjectListItem` (+ list filter types in explorer) |

### Inventory 2.D page/type row at inventory line 287

| Client file | Types |
| --- | --- |
| `(app)/home/creation-tools.tsx`, `home/dashboard-view.tsx`, `home/recent-projects.tsx` | `ProjectListItem` |

### Inventory 1.4 function `createFolderAction(name)`, caller conversion

| File:line | Function | Input | Service / auth calls | Policy helper + capability | Plan check | Returns | Side effects | Client callers | Target endpoint | Domain |
|---|---|---|---|---|---|---|---|---|---|---|
| `app/(app)/projects/actions.ts:54` | `createFolderAction(name)` | `string` (validated in service) | `workspaceLibraryService.createFolder` | `executeWorkspaceAction("content.edit")` | none | `{ok:true, folder:{...,createdAt ISO}}` / `{ok:false, error, errorCode, requestId}` (double try/catch) | `revalidatePath("/projects")` | `app/(app)/projects/_components/projects-header-actions.tsx:32` (`router.refresh`:46) | `POST /api/library/folders` | projects |

### Inventory 1.4 function `deleteFolderAction(folderId)`, caller conversion

| File:line | Function | Input | Service / auth calls | Policy helper + capability | Plan check | Returns | Side effects | Client callers | Target endpoint | Domain |
|---|---|---|---|---|---|---|---|---|---|---|
| `:94` | `deleteFolderAction(folderId)` | `string` | `workspaceLibraryService.deleteFolder` | `executeWorkspaceAction("content.edit")` | none | `void` / failure | `revalidatePath("/projects")` | `projects/_components/folders-panel.tsx:67` (`router.refresh`:75) | `DELETE /api/library/folders/:folderId` | projects |

### Inventory 1.4 function `renameFolderAction(folderId, name)`, caller conversion

| File:line | Function | Input | Service / auth calls | Policy helper + capability | Plan check | Returns | Side effects | Client callers | Target endpoint | Domain |
|---|---|---|---|---|---|---|---|---|---|---|
| `:104` | `renameFolderAction(folderId, name)` | `string, string` | `workspaceLibraryService.renameFolder` | `executeWorkspaceAction("content.edit")` | none | `{ok:true}` / `{ok:false,...}` | `revalidatePath("/projects")` | `folders-panel.tsx:42` (`router.refresh`:52) | `PATCH /api/library/folders/:folderId` | projects |

### Inventory 1.4 function `moveProjectToFolderAction(projectId, folderId\|null)`, caller conversion

| File:line | Function | Input | Service / auth calls | Policy helper + capability | Plan check | Returns | Side effects | Client callers | Target endpoint | Domain |
|---|---|---|---|---|---|---|---|---|---|---|
| `:142` | `moveProjectToFolderAction(projectId, folderId\|null)` | `string, string\|null` | `workspaceLibraryService.moveProject` | `executeProjectAction(projectId,"content.edit")` | none | `void` / failure | `revalidatePath("/projects")` | `projects/_components/projects-explorer.tsx:100` (`router.refresh`:113), `folders-panel.tsx:86` (`router.refresh`:94) | `PUT /api/projects/:projectId/folder` `{folderId}` | projects |

### Inventory 1.4 function `deleteProjectFormAction(formData)`, caller conversion

| File:line | Function | Input | Service / auth calls | Policy helper + capability | Plan check | Returns | Side effects | Client callers | Target endpoint | Domain |
|---|---|---|---|---|---|---|---|---|---|---|
| `:365` | `deleteProjectFormAction(formData)` | `projectId` | `projectService.deleteProject`; maps `ProjectAccessDeniedError`, `ProjectHasActiveWorkflowError`, `ProjectHasActivePublicationError`, `ProjectDeletionIncompleteError`; `ProjectNotFoundError` = success | `executeProjectAction(projectId,"content.edit")` | none | `{ok:false, error}` on mapped failure; on success **`redirect("/projects")`** | `revalidatePath("/projects")`, `redirect("/projects")` | `projects/_components/delete-project-button.tsx:62` | `DELETE /api/projects/:projectId` (idempotent: 404 treated as success by client); client navigates to `/projects` | projects |

### Inventory 1.1 function `switchWorkspaceAction(workspaceId)`, caller conversion

| File:line | Function | Input | Service / auth calls | Policy helper + capability | Plan check | Returns | Side effects | Client callers | Target endpoint | Domain |
|---|---|---|---|---|---|---|---|---|---|---|
| `app/(app)/_actions/workspace.ts:13` | `switchWorkspaceAction(workspaceId)` | `workspaceSelectionActionSchema` `{workspaceId}` | `setActiveWorkspaceForActor` (`@narriflow/auth`; membership check + **sets cookie**) | `executeSignedInActionWithInput` (deliberately not workspace-scoped: a member of a paused workspace needs a way out) | none | `void` / `AuthenticatedActionFailure` | `revalidatePath("/", "layout")` | `app/workspace-unavailable/open-workspace-button.tsx:25` (then `router.push("/home")`), `app/(app)/projects/_components/workspace-mismatch-notice.tsx:49` (`router.push`+`router.refresh`), `app/(app)/integrations/mcp/workspace-billing-link.tsx:27` (`router.push`), `app/(app)/_components/workspace-switcher.tsx:51` (`router.refresh`:62), `app/(app)/_components/app-chrome.tsx:77` (`router.refresh`:88) | Client-only: store selected workspace id and send as header; optionally `POST /api/me/active-workspace` that validates membership and returns the workspace context. On success clients invalidate **all** queries. | workspace |

## Acceptance criteria

- [ ] Home/explorer/search pages and every owned fetch/action/refresh site use domain factories; loaded extra pages retain paging/filter behavior and visible-only polling.
- [ ] Workspace mismatch calls selection command and changes scope before navigation; old mutations never replay in the new Workspace.
- [ ] Folder changes invalidate folders/project lists/home; no invalidate-all or blanket reload.
- [ ] Type-only service imports move to safe DTOs; intentional navigation prefetch and request counts recorded.
- [ ] No unowned files changed; paired review findings and verification evidence recorded under Comments.

## Verification

Run these from the repository root after dependencies are installed. A command naming a new package script is implemented by the owning setup ticket, not silently skipped. PostgreSQL gates need a disposable schema; a skipped DB suite does not satisfy its gate. During the undeployed integration sequence, record any unrelated transitional compile failure with its owning blocker; this ticket's behavior tests must pass and the final integrated gates cannot be waived.

```sh
bun run --cwd apps/web typecheck
```

Verify the changed flow in the running Next app against the separate API origin. Follow the repo's runtime/browser verification guidance; record steps, result and origin pair. Do not treat compilation as browser evidence.

## Comments

Append claim, requested seam changes, paired review and evidence here.
