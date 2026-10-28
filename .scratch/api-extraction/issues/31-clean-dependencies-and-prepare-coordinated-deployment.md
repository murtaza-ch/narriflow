# 31. Clean dependencies and prepare coordinated deployment

**What to build:** All obsolete web backend paths/dependencies are removed, import/bundle/env guards pass, and deployment artifacts/provider changes are concrete and reviewable.

**Blocked by:** [06 - Convert app shell and Workspace UI](06-convert-app-shell-and-workspace-ui.md), [09 - Convert explorer home and library search](09-convert-explorer-home-and-library-search.md), [10 - Convert Project detail composition and panels](10-convert-project-detail-composition-and-panels.md), [12 - Convert clip and campaign UI](12-convert-clip-and-campaign-ui.md), [14 - Convert Studio transport without changing session ownership](14-convert-studio-transport-without-changing-session-ownership.md), [16 - Convert upload intake and recipe UI](16-convert-upload-intake-and-recipe-ui.md), [18 - Convert publishing calendar and performance UI](18-convert-publishing-calendar-and-performance-ui.md), [20 - Convert Brand Kit UI](20-convert-brand-kit-ui.md), [22 - Convert automation and grants UI](22-convert-automation-and-grants-ui.md), [23 - Move REST v1 and detach docs from backend](23-move-rest-v1-and-detach-docs-from-backend.md), [25 - Expose developer controls and convert integrations UI](25-expose-developer-controls-and-convert-integrations-ui.md), [26 - Convert MCP continuation and upload UI](26-convert-mcp-continuation-and-upload-ui.md), [28 - Convert review share and internal review UI](28-convert-review-share-and-internal-review-ui.md), [29 - Move progress stream and all three consumers](29-move-progress-stream-and-all-three-consumers.md), [30 - Move exports downloads and delivery pages](30-move-exports-downloads-and-delivery-pages.md)

**Status:** ready-for-agent

**Suggested implementer:** Claude. The other pairing side reviews and returns findings to this owner.

Read [spec.md](../spec.md). It is the complete contract; the original brief/plan/reviews are not prerequisites. Claim this ticket before editing.

## Exact ownership

Paths are repo-relative. Every existing file below is exclusively assigned for this phase, including files that only need verification. A new `/**` directory includes its local tests/helpers, not adjacent directories. Read other files as evidence; do not edit them.

Existing files:

- `apps/web/lib/integration-admission-parity.test.ts`
- `apps/web/lib/plan-upgrade-pages.test.ts`
- `apps/web/lib/plan-upgrade-pages.contract.fixture.ts`
- `.github/workflows/ci.yml`
- `AGENTS.md`
- `README.md`
- `apps/web/.env.example`
- `apps/web/app/(app)/projects/actions.ts`
- `apps/web/lib/authenticated-request-action.ts`
- `apps/web/lib/authenticated-request-browser.test.ts`
- `apps/web/lib/authenticated-request-browser.ts`
- `apps/web/lib/authenticated-request-page.ts`
- `apps/web/lib/env.ts`
- `apps/web/next-env.d.ts`
- `apps/web/next.config.ts`
- `apps/web/package.json`
- `apps/web/proxy.ts`
- `apps/web/tsconfig.json`
- `apps/worker/.env.example`
- `apps/worker/Dockerfile`
- `biome.json`
- `bun.lock`
- `docs/adr/0009-authenticated-request-policy.md`
- `docs/adr/README.md`
- `docs/runbooks/authentication.md`
- `docs/runbooks/clip-composition-plan-rollout.md`
- `docs/runbooks/clip-render-attempt-rollout.md`
- `docs/runbooks/cloud-file-pickers.md`
- `docs/runbooks/environments.md`
- `docs/runbooks/mcp-launch-acceptance.md`
- `docs/runbooks/project-retention-restore.md`
- `docs/runbooks/social-publication.md`
- `docs/runbooks/studio-editing-session.md`
- `docs/runbooks/upload-session-intake.md`
- `docs/runbooks/workspace-billing.md`
- `docs/runbooks/youtube-import.md`
- `docs/runbooks/zoom-autopilot.md`
- `package.json`
- `packages/db/.env.example`
- `packages/services/src/index.ts`
- `packages/validators/package.json`
- `scripts/env-check.test.ts`
- `scripts/env-check.ts`
- `turbo.json`

- `packages/db/src/client.ts`

New files/directories or reserved skeletons handed off by a blocker:

- `apps/api/src/config.ts`
- `apps/api/src/app.ts`
- `apps/api/src/index.ts`
- `apps/api/src/http/env.test.ts`
- `apps/api/package.json`
- `apps/api/Dockerfile`
- `apps/api/railway.json`
- `apps/api/.env.example`
- `packages/api-client/package.json`
- `packages/api-client/tsconfig.build.json`
- `packages/api-client/src/index.ts`
- `docs/adr/0017-standalone-api.md`
- `scripts/check-web-backend-imports.ts`
- `docs/runbooks/api-extraction-cutover.md`

This is the final serial owner of shared manifests/composition/config and of obsolete projects/actions.ts and action/page/browser helpers. Functional domain fixes return to owners; do not use residual cleanup as authority to rewrite all UI files.

## Endpoints, actions, pages and refresh sites

Rows retain their section/ordinal or exact source-line identifier from the independent inventory. Abbreviated table filenames are accompanied by the literal ownership manifest and exact source occurrences below. All action/page/fetch/refresh rows in owned files are in scope, including no-refresh callers and media navigation. Baseline observations do not override the spec's selected origins, route style, guest Bearer or new endpoints.

### Inventory 5.10 refresh/fetch row at inventory line 860

| Action file | Paths revalidated |
| --- | --- |
| `(app)/projects/actions.ts:62,100,113,152,176,182,217,238,244,267,319,400` | `/projects`, `/projects/:id`; `redirect("/projects/:id")` (:47) and `redirect("/projects")` (:401) |

### Inventory 5 exact file occurrences: apps/web/app/(app)/projects/actions.ts

```text
62: revalidatePath("/projects");
100: revalidatePath("/projects");
113: revalidatePath("/projects");
152: revalidatePath("/projects");
176: revalidatePath(`/projects/${projectId}`);
182: revalidatePath(`/projects/${projectId}`);
217: revalidatePath(`/projects/${parsedInput.projectId}`);
238: revalidatePath(`/projects/${projectId}`);
244: revalidatePath(`/projects/${projectId}`);
267: revalidatePath(`/projects/${projectId}`);
319: revalidatePath(`/projects/${projectId}`);
400: revalidatePath("/projects");
```

### Inventory 1.4 function `retryIngestFormAction(formData)`, caller conversion

| File:line | Function | Input | Service / auth calls | Policy helper + capability | Plan check | Returns | Side effects | Client callers | Target endpoint | Domain |
|---|---|---|---|---|---|---|---|---|---|---|
| `:280` | `retryIngestFormAction(formData)` | `projectId` | `getIngestJobLifecycle().retry({projectId, workspaceId, actorUserId})`; catches `IngestRetryLimitExceededError`, `IngestNotFailedError`, `IngestReselectRequiredError` | `executeProjectAction(projectId,"processing.consume")` | retry limit in service | `{ok:boolean, error?}` (expected failures returned, not thrown, to survive Next error redaction) | `revalidatePath("/projects/:id")` | `projects/[projectId]/render-clips-button.tsx:484` (`router.refresh`:486), `upload/_components/retry-import-band.tsx:54` (`router.refresh`:56) | `POST /api/ingest/:projectId/retry` (route.ts:620 already has `GET /ingest/:projectId`) | upload |

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

### Inventory 1.4 function `queueTranscriptionFormAction(formData)` (alias `queueGenerationFormAction` :187, no callers), caller conversion

| File:line | Function | Input | Service / auth calls | Policy helper + capability | Plan check | Returns | Side effects | Client callers | Target endpoint | Domain |
|---|---|---|---|---|---|---|---|---|---|---|
| `:156` | `queueTranscriptionFormAction(formData)` (alias `queueGenerationFormAction` :187, no callers) | `formData`: `projectId`, `idempotencyKey` (default `randomUUID()`), content pack via `readContentPackFromForm`, `readLanguageCodeFromForm` (`app/(app)/upload/_lib/content-pack-form.ts`) | `projectService.triggerGeneration(appUser, projectId, {contentPack, forceRegenerate:false, languageCode}, idempotencyKey)` | `executeProjectAction(projectId,"processing.consume")` | credits/length via `ProcessingUsageError` from service; caught -> **`redirect("/projects/:id")`** (page shows limit + upgrade) | `void`; throws on missing `projectId` | `revalidatePath("/projects/:id")`; `redirect` on plan limit | `projects/[projectId]/processing-panel.tsx:487` and `projects/[projectId]/page.tsx:869` (`AuthenticatedActionForm action=`) | existing `POST /api/projects/:id/generate` (route.ts:448, verify parity: contentPack/languageCode/idempotency) ; plan-limit becomes a typed `ApiError` (`code`, `details`) the client renders instead of redirecting | projects |

### Inventory 1.4 function `applyProjectBrandProfileFormAction(formData)`, caller conversion

| File:line | Function | Input | Service / auth calls | Policy helper + capability | Plan check | Returns | Side effects | Client callers | Target endpoint | Domain |
|---|---|---|---|---|---|---|---|---|---|---|
| `:189` | `applyProjectBrandProfileFormAction(formData)` | `brandProfileProjectApplicationSchema` `{projectId, profileId, templateId\|null}` | `brandProfileService.applyToProject(actor, projectId, {profileId, templateId})` | `executeProjectActionWithInput(projectId,"content.edit")` | none | `void` / failure | `revalidatePath("/projects/:id")` | `projects/[projectId]/project-brand-picker.tsx:55` | `PUT /api/projects/:projectId/brand-profile` (or reuse `/projects/:id/campaign-operations/apply-brand-profile`, route.ts:930, which applies to selected clips; different semantics, verify) | brand-kit / projects |

### Inventory 1.4 function `regenerateClipsFormAction(formData)`, caller conversion

| File:line | Function | Input | Service / auth calls | Policy helper + capability | Plan check | Returns | Side effects | Client callers | Target endpoint | Domain |
|---|---|---|---|---|---|---|---|---|---|---|
| `:222` | `regenerateClipsFormAction(formData)` | `projectId`, `idempotencyKey`, content pack | `clipService.regenerateClips(appUser, projectId, idempotencyKey, contentPack)` | `executeProjectAction(projectId,"processing.consume")` | `ProcessingUsageError` -> `redirect("/projects/:id")` | `void` | `revalidatePath`; `redirect` on plan limit | `processing-panel.tsx:449`, `projects/[projectId]/page.tsx:940` | existing `POST /api/projects/:id/clips/regenerate` (`clip-generation-http.ts:11`, verify parity) | projects |

### Inventory 1.4 function `renderClipsFormAction(formData)`, caller conversion

| File:line | Function | Input | Service / auth calls | Policy helper + capability | Plan check | Returns | Side effects | Client callers | Target endpoint | Domain |
|---|---|---|---|---|---|---|---|---|---|---|
| `:249` | `renderClipsFormAction(formData)` | `projectId`, `idempotencyKey`, `aspectRatios[]` | `clipService.triggerClipRendering(appUser, projectId, idempotencyKey, undefined, aspectRatios\|undefined, "1080p")` | `executeProjectAction(projectId,"processing.consume")` | none | `void` | `revalidatePath("/projects/:id")` | **none (dead)** | existing `POST /api/projects/:id/clips/render` (route.ts:752); delete the action | projects |

### Inventory 1.4 function `setNotifyPreferenceAction(projectId, notifyOnComplete)`, caller conversion

| File:line | Function | Input | Service / auth calls | Policy helper + capability | Plan check | Returns | Side effects | Client callers | Target endpoint | Domain |
|---|---|---|---|---|---|---|---|---|---|---|
| `:331` | `setNotifyPreferenceAction(projectId, notifyOnComplete)` | `string, boolean` | `projectService.setProjectNotifyPreference`; catches `ProjectNotFoundError` | `executeProjectAction(projectId,"content.edit")` | none | `{ok:boolean, error?}` | none (no revalidate) | `processing-panel.tsx:299` | `PUT /api/projects/:projectId/notify-preference` | projects |

### Inventory 1.4 function `deleteProjectFormAction(formData)`, caller conversion

| File:line | Function | Input | Service / auth calls | Policy helper + capability | Plan check | Returns | Side effects | Client callers | Target endpoint | Domain |
|---|---|---|---|---|---|---|---|---|---|---|
| `:365` | `deleteProjectFormAction(formData)` | `projectId` | `projectService.deleteProject`; maps `ProjectAccessDeniedError`, `ProjectHasActiveWorkflowError`, `ProjectHasActivePublicationError`, `ProjectDeletionIncompleteError`; `ProjectNotFoundError` = success | `executeProjectAction(projectId,"content.edit")` | none | `{ok:false, error}` on mapped failure; on success **`redirect("/projects")`** | `revalidatePath("/projects")`, `redirect("/projects")` | `projects/_components/delete-project-button.tsx:62` | `DELETE /api/projects/:projectId` (idempotent: 404 treated as success by client); client navigates to `/projects` | projects |

The cross-page upgrade fixture and existing integration-admission parity test are assigned here after the domain wave, so their rewrite can use the final client page/contracts. Preserve their behavioral assertions; do not delete them merely because the old server adapter disappeared.

## Acceptance criteria

- [ ] Every remaining web action/backend handler/helper deleted; only docs content search/Markdown/OG/text handlers remain. No 501 or forwarding backend remains.
- [ ] Biome/source/dependency graph guards ban services/db/auth/email/mcp-core/API runtime imports throughout web; DTO types are safe and static bundle sentinel scan passes.
- [ ] Web secret/dependency removal and API/worker Docker manifests/native smoke/build/env hashing are complete; env:check compares all four local files without values.
- [ ] Reconcile final route ledger, 61-function/62-name dispositions, 39-page union, 75 executable refreshes, three EventSources and URL navigation sites; return functional failures to owners.
- [ ] Measure TypeScript threshold and only add precompiled client declarations if triggered; capture native/pool/region/request-count evidence and concrete redacted deployment/provider plan.
- [ ] No unowned files changed; paired review findings and verification evidence recorded under Comments.

## Verification

Run these from the repository root after dependencies are installed. A command naming a new package script is implemented by the owning setup ticket, not silently skipped. PostgreSQL gates need a disposable schema; a skipped DB suite does not satisfy its gate. During the undeployed integration sequence, record any unrelated transitional compile failure with its owning blocker; this ticket's behavior tests must pass and the final integrated gates cannot be waived.

```sh
bun run lint
bun run typecheck
bun run test
bun run env:check
bun run --cwd apps/api openapi:check
bun run --cwd apps/api build
bun run --cwd apps/web build
bun scripts/check-web-backend-imports.ts
docker build -f apps/api/Dockerfile -t narriflow-api:extraction .
docker run --rm --entrypoint bun --workdir /app/apps/api narriflow-api:extraction scripts/native-smoke.ts
```

## Comments

Append claim, requested seam changes, paired review and evidence here.
