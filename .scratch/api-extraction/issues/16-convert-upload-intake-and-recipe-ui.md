# 16. Convert upload intake and recipe UI

**What to build:** Upload and Recipes use query/mutation state, direct presigned storage uploads and explicit resume outcomes without server actions.

**Blocked by:** [15 - Move intake Upload Sessions and recipes](15-move-intake-upload-sessions-and-recipes.md), [05 - Expose session and Workspace controls](05-expose-session-and-workspace-controls.md), [19 - Move Brand Kit and media controls](19-move-brand-kit-and-media-controls.md), [07 - Move billing API and convert billing UI](07-move-billing-api-and-convert-billing-ui.md)

**Status:** ready-for-agent

**Suggested implementer:** Claude. The other pairing side reviews and returns findings to this owner.

Read [spec.md](../spec.md). It is the complete contract; the original brief/plan/reviews are not prerequisites. Claim this ticket before editing.

## Exact ownership

Paths are repo-relative. Every existing file below is exclusively assigned for this phase, including files that only need verification. A new `/**` directory includes its local tests/helpers, not adjacent directories. Read other files as evidence; do not edit them.

Existing files:

- `apps/web/app/(app)/recipes/brand-profile-select.tsx`
- `apps/web/app/(app)/recipes/finishing-fields.tsx`
- `apps/web/app/(app)/recipes/finishing-form.test.ts`
- `apps/web/app/(app)/recipes/finishing-form.ts`
- `apps/web/app/(app)/recipes/loading.tsx`
- `apps/web/app/(app)/recipes/page.tsx`
- `apps/web/app/(app)/recipes/recipe-form.test.ts`
- `apps/web/app/(app)/recipes/recipe-form.ts`
- `apps/web/app/(app)/recipes/recipes-panel.test.tsx`
- `apps/web/app/(app)/recipes/recipes-panel.tsx`
- `apps/web/app/(app)/upload/_components/advanced-settings.tsx`
- `apps/web/app/(app)/upload/_components/brand-template-picker.test.tsx`
- `apps/web/app/(app)/upload/_components/brand-template-picker.tsx`
- `apps/web/app/(app)/upload/_components/clip-style-settings.tsx`
- `apps/web/app/(app)/upload/_components/commit-step.tsx`
- `apps/web/app/(app)/upload/_components/configure-step.tsx`
- `apps/web/app/(app)/upload/_components/format-settings.tsx`
- `apps/web/app/(app)/upload/_components/import-pill.tsx`
- `apps/web/app/(app)/upload/_components/language-select.tsx`
- `apps/web/app/(app)/upload/_components/link-import-flow.tsx`
- `apps/web/app/(app)/upload/_components/mode-tabs.tsx`
- `apps/web/app/(app)/upload/_components/recipe-picker.tsx`
- `apps/web/app/(app)/upload/_components/retry-import-band.tsx`
- `apps/web/app/(app)/upload/_components/source-pickers.tsx`
- `apps/web/app/(app)/upload/_components/source-setup-flow.test.tsx`
- `apps/web/app/(app)/upload/_components/source-setup-flow.tsx`
- `apps/web/app/(app)/upload/_components/upload-session-status.test.tsx`
- `apps/web/app/(app)/upload/_components/upload-session-status.tsx`
- `apps/web/app/(app)/upload/_components/upload-shell.tsx`
- `apps/web/app/(app)/upload/_components/video-preview.tsx`
- `apps/web/app/(app)/upload/_lib/content-pack-form.test.ts`
- `apps/web/app/(app)/upload/_lib/content-pack-form.ts`
- `apps/web/app/(app)/upload/_lib/dropbox-chooser.test.ts`
- `apps/web/app/(app)/upload/_lib/dropbox-chooser.ts`
- `apps/web/app/(app)/upload/_lib/google-drive-picker.test.ts`
- `apps/web/app/(app)/upload/_lib/google-drive-picker.ts`
- `apps/web/app/(app)/upload/_lib/link-content-pack.ts`
- `apps/web/app/(app)/upload/_lib/local-media-preview.test.ts`
- `apps/web/app/(app)/upload/_lib/local-media-preview.ts`
- `apps/web/app/(app)/upload/_lib/quota-refusal.test.ts`
- `apps/web/app/(app)/upload/_lib/quota-refusal.ts`
- `apps/web/app/(app)/upload/_lib/recipe-settings.test.ts`
- `apps/web/app/(app)/upload/_lib/recipe-settings.ts`
- `apps/web/app/(app)/upload/_lib/source-pickers.test.ts`
- `apps/web/app/(app)/upload/_lib/source-pickers.ts`
- `apps/web/app/(app)/upload/_lib/upload-resume.test.ts`
- `apps/web/app/(app)/upload/_lib/upload-resume.ts`
- `apps/web/app/(app)/upload/_lib/upload-session-browser.test.ts`
- `apps/web/app/(app)/upload/_lib/upload-session-browser.ts`
- `apps/web/app/(app)/upload/actions.ts`
- `apps/web/app/(app)/upload/loading.tsx`
- `apps/web/app/(app)/upload/page.tsx`

New files/directories or reserved skeletons handed off by a blocker:

- Add tests beside the owned implementation only; no new cross-domain directory.

Consume the endpoint contracts owned by 15. API changes belong to those owners; this ticket owns caller conversion and cache effects.

## Endpoints, actions, pages and refresh sites

Rows retain their section/ordinal or exact source-line identifier from the independent inventory. Abbreviated table filenames are accompanied by the literal ownership manifest and exact source occurrences below. All action/page/fetch/refresh rows in owned files are in scope, including no-refresh callers and media navigation. Baseline observations do not override the spec's selected origins, route style, guest Bearer or new endpoints.

### Inventory 2.B page/type row at inventory line 225

| File (lines) | Gate (line) | Service / db / validators calls (line) | Params / searchParams | Redirect / notFound | Props to client components | Proposed GET endpoint(s) |
| --- | --- | --- | --- | --- | --- | --- |
| `app/(app)/recipes/page.tsx` (31) | content.view L7 | `recipeService.list` L9; `brandProfileService.listSummaries` L10; `brandProfileService.list` L12; `socialOAuthService.listAccounts` L13 | none | none | `RecipesPanel{initialRecipes,brandProfiles[{id,name,isDefault}],brandLooks{[id]:{colors,logoUrl}},canEdit,finishingAvailable,queueAccounts[]}` | Existing `GET /api/recipes`, `GET /api/social/accounts`, `GET /api/brand-profiles` (default `limit` 24 in the route vs unlimited on the page; needs `limit` param or a NEW `GET /api/brand-profiles?summary=1` for `listSummaries`). |

### Inventory 2.B page/type row at inventory line 241

| File (lines) | Gate (line) | Service / db / validators calls (line) | Params / searchParams | Redirect / notFound | Props to client components | Proposed GET endpoint(s) |
| --- | --- | --- | --- | --- | --- | --- |
| `app/(app)/upload/page.tsx` (158) | `admitWorkspacePage("processing.consume")` L92 | Promise.all L108-116: `brandTemplateService.list`, `brandProfileService.list(brandScope)`, `brandProfileService.getApplicableDefaultId`, `projectService.getUsageSummary`, `recipeService.list`; resume path `loadLinkResumeData` L38-79: `projectService.getProjectSnapshot` L42, `projectService.getLatestContentPack` L60; `parseStoredContentPack`; env: `NEXT_PUBLIC_GOOGLE_API_KEY`, `NEXT_PUBLIC_GOOGLE_CLIENT_ID`, `NEXT_PUBLIC_GOOGLE_APP_ID`, `NEXT_PUBLIC_DROPBOX_APP_KEY` passed to `sourcePickerConfig` | `searchParams`: `url, project, source, mode` | `redirect("/upload")` L48/57/65 (project missing, not link/youtube source, or no draft pack), `redirect("/projects/:id")` L51 (active run exists) | `UploadShell{recipes,brandTemplates,brandProfiles{items,defaultId},initialUrl,initialSource,initialMode,resumeData:LinkResumeData,usageSummary,sourcePickers}` | Existing `GET /api/recipes`, `GET /api/brand-templates`, `GET /api/brand-profiles`, `GET /api/projects/:id` (snapshot with `activeRun`, `ingestJobType`), `GET /api/ingest/:projectId`. **NEW**: `GET /api/projects/:id/content-pack`, `GET /api/brand-profiles/default?applicable=1`, usage summary (`GET /api/workspace/usage`). The resume redirect rules move to a client `useEffect`/loader. `sourcePickerConfig` stays in web (only `NEXT_PUBLIC_*`). |

### Inventory 5.3 refresh/fetch row at inventory line 758

| file:line | Trigger | Call | Notes |
| --- | --- | --- | --- |
| `video-preview.tsx:1418,1459` | Preview audio | `GET /api/audio-assets/:id/playback-url` | Local |

### Inventory 5.4 refresh/fetch row at inventory line 773

| file:line | Trigger | Call | Refreshes |
| --- | --- | --- | --- |
| `(app)/upload/_components/upload-shell.tsx:187` | Upload Session finished; the adapter's `navigate(projectId)` does `router.push("/projects/:id")` then refresh | `POST /api/upload-sessions/{open,status,grants,finalize,discard}` (`upload-session-browser.ts:578,741,883,1054,1308`) plus `PUT` parts (XHR :442, fetcher :506) | `/projects/:id` |

### Inventory 5.4 refresh/fetch row at inventory line 774

| file:line | Trigger | Call | Refreshes |
| --- | --- | --- | --- |
| `upload-shell.tsx:716,719` | RSS "Generate" success; `router.push(/projects/:id or /projects)` then refresh | `generateFromRssAction(formData)` (:702); preview `POST /api/ingest/rss/preview` (:641) | Project page or `/projects` list |

### Inventory 5.4 refresh/fetch row at inventory line 775

| file:line | Trigger | Call | Refreshes |
| --- | --- | --- | --- |
| `(app)/upload/_components/retry-import-band.tsx:56` | "Retry import" band | `retryIngestFormAction` (:54) | Project page ingest status (`useIngestStream` reconnects) |

### Inventory 5.8 refresh/fetch row at inventory line 835

| file:line | Trigger | Mutation | Refreshes |
| --- | --- | --- | --- |
| `(app)/recipes/recipes-panel.tsx:101` (`refresh` helper; invoked :115 after duplicate/delete, :286 after save) | Duplicate / delete / create / edit | `POST /api/recipes/:id/duplicate` (:107), `DELETE /api/recipes/:id` (:108), `PATCH /api/recipes/:id` (:369), `POST /api/recipes` (:379) | `/recipes` |

### Inventory 5.9 refresh/fetch row at inventory line 843

| file:line | Trigger | Call | Refreshes |
| --- | --- | --- | --- |
| `projects/[projectId]/clips/[clipId]/exports/[exportId]/export-delivery-client.tsx:138-195` (`refresh`, no `router.refresh`) | SSE `clip_rendering` stage events (:155), 10 s interval fallback, 5 s after SSE error, visibilitychange | `GET /api/projects/:p/clips/:c/exports/:id` (:138) | Local `data` snapshot |

### Inventory 5.10 refresh/fetch row at inventory line 861

| Action file | Paths revalidated |
| --- | --- |
| `(app)/upload/actions.ts:137,174,224,264,347` | `/projects/:id` |

### Inventory 5.14 refresh/fetch row at inventory line 919

| file:line | Call | Disposition |
| --- | --- | --- |
| `(app)/upload/actions.ts:94` | Server-side `fetch(oembedUrl)` | Moves with `fetchYoutubeMetadataAction` |

### Inventory 5 exact file occurrences: apps/web/app/(app)/recipes/recipes-panel.tsx

```text
35: const response = await fetch(url, init);
101: const refresh = () => startTransition(() => router.refresh());
```

### Inventory 5 exact file occurrences: apps/web/app/(app)/upload/_components/retry-import-band.tsx

```text
56: router.refresh();
```

### Inventory 5 exact file occurrences: apps/web/app/(app)/upload/_components/upload-shell.tsx

```text
187: router.refresh();
641: const response = await fetch("/api/ingest/rss/preview", {
716: router.refresh();
719: router.refresh();
```

### Inventory 5 exact file occurrences: apps/web/app/(app)/upload/_lib/local-media-preview.test.ts

```text
17: expect(await (await fetch(firstUrl)).text()).toBe("test video bytes");
21: expect(await (await fetch(media.src)).text()).toBe("test video bytes");
25: await expect(fetch(activeUrl)).rejects.toThrow();
```

### Inventory 5 exact file occurrences: apps/web/app/(app)/upload/actions.ts

```text
94: const response = await fetch(oembedUrl, {
137: revalidatePath(`/projects/${ingest.project.id}`);
174: revalidatePath(`/projects/${ingest.project.id}`);
224: revalidatePath(`/projects/${parsedInput.projectId}`);
264: revalidatePath(`/projects/${parsedInput.projectId}`);
347: revalidatePath(`/projects/${created.project.id}`);
```

Also account for the inventory's cross-domain traps: query-only actions, action forms that relied on revalidatePath, signed downloads/media, OAuth anchors, all three EventSource consumers and unload keepalive. Only the literal files above may be changed by this ticket.

### Inventory 1.4 function `retryIngestFormAction(formData)`, caller conversion

| File:line | Function | Input | Service / auth calls | Policy helper + capability | Plan check | Returns | Side effects | Client callers | Target endpoint | Domain |
|---|---|---|---|---|---|---|---|---|---|---|
| `:280` | `retryIngestFormAction(formData)` | `projectId` | `getIngestJobLifecycle().retry({projectId, workspaceId, actorUserId})`; catches `IngestRetryLimitExceededError`, `IngestNotFailedError`, `IngestReselectRequiredError` | `executeProjectAction(projectId,"processing.consume")` | retry limit in service | `{ok:boolean, error?}` (expected failures returned, not thrown, to survive Next error redaction) | `revalidatePath("/projects/:id")` | `projects/[projectId]/render-clips-button.tsx:484` (`router.refresh`:486), `upload/_components/retry-import-band.tsx:54` (`router.refresh`:56) | `POST /api/ingest/:projectId/retry` (route.ts:620 already has `GET /ingest/:projectId`) | upload |

### Inventory 1.5 function `commitLinkImportAction(input)`, caller conversion

| File:line | Function | Input | Service / auth calls | Policy helper + capability | Plan check | Returns | Side effects | Client callers | Target endpoint | Domain |
|---|---|---|---|---|---|---|---|---|---|---|
| `:112` | `commitLinkImportAction(input)` | TS type `{url, title\|null, brandTemplateId, brandProfileId, commitToken, languageCode, mode: GenerationMode, processingStartSec, processingEndSec}` (**no zod parse in the action**) | `fetchYoutubeTitle` (oEmbed), `projectService.queueLinkIngest` | `executeWorkspaceAction("processing.consume")` | `ProcessingUsageError` (credits/length) returned as `{ok:false, code, message, details}` | `CommitLinkImportResult` `{ok:true, projectId, title}` / `{ok:false, code, message, details?}` | `revalidatePath("/projects/:id")` | `upload/_components/commit-step.tsx:309` | existing `POST /api/ingest/link` (route.ts:579, verify it takes commitToken/mode/brand ids/range); add a zod schema | upload |

### Inventory 1.5 function `commitDriveImportAction(input)`, caller conversion

| File:line | Function | Input | Service / auth calls | Policy helper + capability | Plan check | Returns | Side effects | Client callers | Target endpoint | Domain |
|---|---|---|---|---|---|---|---|---|---|---|
| `:155` | `commitDriveImportAction(input)` | `driveIngestSchema` (`fileId, accessToken` Drive `drive.file` token, + same commit fields) | `projectService.queueDriveIngest` | `executeWorkspaceActionWithInput("processing.consume")`, op `commit-drive-import`, **rate limit** `drive-import:${workspaceId}` 10/60s | same | `CommitLinkImportResult` | `revalidatePath("/projects/:id")` | `commit-step.tsx:304` | `POST /api/ingest/drive` (token never logged/returned; keep rate limit) | upload |

### Inventory 1.5 function `finalizeLinkConfigureAction(input)`, caller conversion

| File:line | Function | Input | Service / auth calls | Policy helper + capability | Plan check | Returns | Side effects | Client callers | Target endpoint | Domain |
|---|---|---|---|---|---|---|---|---|---|---|
| `:216` | `finalizeLinkConfigureAction(input)` | `linkConfigureActionInputSchema` `{projectId, contentPack, languageCode\|null}` strict | `projectService.finalizeGenerationSetup` | `executeProjectActionWithInput(projectId,"content.edit")` | `ProcessingUsageError` -> `{ok:false, code, message, details}` | `FinalizeLinkConfigureResult` `{ok:true, started, ingestStatus, workflowRunId?}` / `{ok:false,...}` | `revalidatePath("/projects/:id")` | `upload/_components/configure-step.tsx:185` (`router.push`:198) | `POST /api/projects/:projectId/generation/finalize` | upload |

### Inventory 1.5 function `saveGenerationDraftAction(input)`, caller conversion

| File:line | Function | Input | Service / auth calls | Policy helper + capability | Plan check | Returns | Side effects | Client callers | Target endpoint | Domain |
|---|---|---|---|---|---|---|---|---|---|---|
| `:257` | `saveGenerationDraftAction(input)` | `linkConfigureActionInputSchema` | `projectService.saveGenerationDraft` | `executeProjectActionWithInput(projectId,"content.edit")` | none | `{ok:true}` / failure | `revalidatePath("/projects/:id")` | `configure-step.tsx:165` (`router.push`:175) | `PUT /api/projects/:projectId/generation/draft` | upload |

### Inventory 1.5 function `fetchYoutubeMetadataAction(url)`, caller conversion

| File:line | Function | Input | Service / auth calls | Policy helper + capability | Plan check | Returns | Side effects | Client callers | Target endpoint | Domain |
|---|---|---|---|---|---|---|---|---|---|---|
| `:276` | `fetchYoutubeMetadataAction(url)` | `string` (no schema) | `fetchYoutubeTitle` only (outbound fetch, no service) | `executeWorkspaceAction("content.view")` | none | `{title: string\|null}` / failure | none | `configure-step.tsx:105`, `commit-step.tsx:205` | `GET /api/ingest/link/metadata?url=` (add SSRF guard: only `youtube.com` oEmbed host is fetched, URL is encoded, but validate `detectLinkProvider`) | upload |

### Inventory 1.5 function `generateFromRssAction(formData)`, caller conversion

| File:line | Function | Input | Service / auth calls | Policy helper + capability | Plan check | Returns | Side effects | Client callers | Target endpoint | Domain |
|---|---|---|---|---|---|---|---|---|---|---|
| `:284` | `generateFromRssAction(formData)` | `rssActionInputSchema` = `rssImportSchema.extend({contentPack, languageCode})` strict; form fields `rssUrl, titlePrefix, episodeIds` (JSON), `commitToken`, brand profile id, content pack | `projectService.importFromRss` | `executeWorkspaceActionWithInput("processing.consume")`, op `generate-from-rss`, **rate limit** `rss-import:${workspaceId}` 5/60s | `ProcessingUsageError` returned `{ok:false, error, message, details, retryAfterSeconds}` | `{ok:true, projectId}` / `{ok:false,...}`; throws if no project produced | `revalidatePath("/projects/:id")` | `upload/_components/upload-shell.tsx:702` (`router.push`:715 + `router.refresh`:716) | existing `POST /api/ingest/rss/import` (route.ts:606, verify contentPack/languageCode/rate limit parity) | upload |

## Acceptance criteria

- [ ] Upload/Recipes pages read aggregate configuration/resume through queries; every action/fetch/revalidate caller converted.
- [ ] Resume outcomes preserve redirect destinations, cached commit keys, source/mode/language/brand/range/contentPack and no duplicate charge on lost finalize.
- [ ] Presigned XHR/PUT stays direct and uncredentialed; query abort/reconnect does not discard resumable multipart state.
- [ ] Cloud picker public config remains in web; safe token-bearing inputs never enter keys/cache/logs; props shared with Project/Studio stay frozen.
- [ ] No unowned files changed; paired review findings and verification evidence recorded under Comments.

## Verification

Run these from the repository root after dependencies are installed. A command naming a new package script is implemented by the owning setup ticket, not silently skipped. PostgreSQL gates need a disposable schema; a skipped DB suite does not satisfy its gate. During the undeployed integration sequence, record any unrelated transitional compile failure with its owning blocker; this ticket's behavior tests must pass and the final integrated gates cannot be waived.

```sh
bun test "apps/web/app/(app)/upload" "apps/web/app/(app)/recipes"
```

Verify the changed flow in the running Next app against the separate API origin. Follow the repo's runtime/browser verification guidance; record steps, result and origin pair. Do not treat compilation as browser evidence.

## Comments

Append claim, requested seam changes, paired review and evidence here.
