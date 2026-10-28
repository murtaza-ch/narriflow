# 30. Move exports downloads and delivery pages

**What to build:** Exports list/delivery/download controls use grants or deliberate attachment fetches, preserving revisions/share/retry and Workspace filters.

**Blocked by:** [04 - Wire API runtime and partition the catch-all](04-wire-api-runtime-and-partition-the-catch-all.md), [11 - Move clip and campaign controls](11-move-clip-and-campaign-controls.md), [07 - Move billing API and convert billing UI](07-move-billing-api-and-convert-billing-ui.md)

**Status:** ready-for-agent

**Suggested implementer:** Claude. The other pairing side reviews and returns findings to this owner.

Read [spec.md](../spec.md). It is the complete contract; the original brief/plan/reviews are not prerequisites. Claim this ticket before editing.

## Exact ownership

Paths are repo-relative. Every existing file below is exclusively assigned for this phase, including files that only need verification. A new `/**` directory includes its local tests/helpers, not adjacent directories. Read other files as evidence; do not edit them.

Existing files:

- `apps/web/app/(app)/exports/actions.ts`
- `apps/web/app/(app)/exports/export-filters.tsx`
- `apps/web/app/(app)/exports/export-preview.tsx`
- `apps/web/app/(app)/exports/loading.tsx`
- `apps/web/app/(app)/exports/page.tsx`
- `apps/web/app/(app)/projects/[projectId]/clips/[clipId]/exports/[exportId]/loading.tsx`
- `apps/web/app/(app)/projects/[projectId]/clips/[clipId]/exports/[exportId]/page.tsx`
- `packages/services/src/clip-export.service.test.ts`
- `packages/services/src/clip-export.service.ts`

New files/directories or reserved skeletons handed off by a blocker:

- `apps/api/src/domains/exports/**`
- `apps/api/src/types/exports.ts`
- `packages/api-client/src/exports/**`
- `packages/validators/src/api/exports.ts`
- `packages/services/src/exports-receipt-commands.ts`
- `packages/services/src/exports-commands.ts`
- `packages/services/src/exports-commands-runtime.ts`

The chosen new endpoints for this ticket are the matching owner row in spec.md, "Endpoint and screen contracts added by extraction". All current endpoints/actions below retain their semantics unless that row explicitly changes transport. Fill only this domain's receipt-command module; current native receipts remain native.

## Endpoints, actions, pages and refresh sites

Rows retain their section/ordinal or exact source-line identifier from the independent inventory. Abbreviated table filenames are accompanied by the literal ownership manifest and exact source occurrences below. All action/page/fetch/refresh rows in owned files are in scope, including no-refresh callers and media navigation. Baseline observations do not override the spec's selected origins, route style, guest Bearer or new endpoints.

### Inventory 2.B page/type row at inventory line 230

| File (lines) | Gate (line) | Service / db / validators calls (line) | Params / searchParams | Redirect / notFound | Props to client components | Proposed GET endpoint(s) |
| --- | --- | --- | --- | --- | --- | --- |
| `app/(app)/projects/[projectId]/clips/[clipId]/exports/[exportId]/page.tsx` (32) | `admitProjectPage(projectId,"content.download")` L14 | `clipExportService.getOwned(appUser,projectId,clipId,exportId)` L16; `getLastWorkflowSeq(projectId)` L17; `planFeatureRequirement`, `featureUpgradePrompt` x3, `workspaceAllowsCapability` | params: `projectId, clipId, exportId` | `notFound()` L19 | `ExportDeliveryClient{initialExport,initialSeq,timelineRequirement,timelineUpgrade,canEdit,publishingUpgrade,canSendForReview,reviewUpgrade}` | Existing `GET /api/projects/:id/clips/:clipId/exports/:exportId` (route.ts L1305, 404 `export_not_found`). **NEW** `initialSeq`: add `lastSeq` to that response or use `GET /api/projects/:id` snapshot `lastSeq`. |

### Inventory 2.B page/type row at inventory line 232

| File (lines) | Gate (line) | Service / db / validators calls (line) | Params / searchParams | Redirect / notFound | Props to client components | Proposed GET endpoint(s) |
| --- | --- | --- | --- | --- | --- | --- |
| `app/(app)/exports/page.tsx` (290) | content.view L105 | `workspaceLibraryService.listExports(appUser,{status,query,projectId,aspectRatio,from,to,cursor})` L122; `workspaceLibraryService.listExportProjects(appUser)` L127 | `searchParams`: `status,q,project,ratio,from,to,view,cursor` (parsed/validated on the page: status filter list, 4 aspect ratios, ISO dates) | none | `ExportFilters{projects}`, `ExportPreview{src,ratio,status,progress,compact}` (src = `/api/workspace/exports/:id/download?variant=:id`, existing L401), `AuthenticatedActionForm{action: retryWorkspaceExportAction.bind(null, id)}` | **NEW `GET /api/workspace/exports`** (same filters, cursor), **NEW `GET /api/workspace/export-projects`**. Move the param validation into the route's zod query schema. |

### Inventory 3.2 row 17

| # | Method | Path (under `/api`) | Source | Handler calls | Handler-level validation | Policy (cap / admission / input) | Rate limit | Flags | Style | Domain (9.4) |
|---|---|---|---|---|---|---|---|---|---|---|
| 17 | GET | `/workspace/exports/:exportId/download` | route.ts:401 | `clipExportService.getWorkspaceOwned` |  | browser-session: `content.download`, workspace |  | redirect | plain Hono | D9 |

### Inventory 3.2 row 38

| # | Method | Path (under `/api`) | Source | Handler calls | Handler-level validation | Policy (cap / admission / input) | Rate limit | Flags | Style | Domain (9.4) |
|---|---|---|---|---|---|---|---|---|---|---|
| 38 | POST | `/projects/:id/export-bundles` | route.ts:781 | `campaignOperationService.createExportBundle` | `type CreateExportBundleInput` | browser-session: `content.download`, project(id); idempotentBodyInput(createExportBundleSchema, ["id"]); idempotency-key header | actor `export-bundle` 10/3600s | idempotency-key header | plain Hono | D9 |

### Inventory 3.2 row 39

| # | Method | Path (under `/api`) | Source | Handler calls | Handler-level validation | Policy (cap / admission / input) | Rate limit | Flags | Style | Domain (9.4) |
|---|---|---|---|---|---|---|---|---|---|---|
| 39 | POST | `/projects/:id/export-bundles/preview` | route.ts:797 | `campaignOperationService.previewExportBundle` | `type CreateExportBundleInput` | browser-session: `content.download`, project(id); bodyInput(createExportBundleSchema, ["id"]) | actor `export-bundle-preview` 60/60s |  | plain Hono | D9 |

### Inventory 3.2 row 40

| # | Method | Path (under `/api`) | Source | Handler calls | Handler-level validation | Policy (cap / admission / input) | Rate limit | Flags | Style | Domain (9.4) |
|---|---|---|---|---|---|---|---|---|---|---|
| 40 | GET | `/projects/:id/export-bundles` | route.ts:812 | `campaignOperationService.listExportBundles` |  | browser-session: `content.view`, project(id) |  |  | plain Hono | D9 |

### Inventory 3.2 row 51

| # | Method | Path (under `/api`) | Source | Handler calls | Handler-level validation | Policy (cap / admission / input) | Rate limit | Flags | Style | Domain (9.4) |
|---|---|---|---|---|---|---|---|---|---|---|
| 51 | GET | `/projects/:id/export-bundles/:bundleId` | route.ts:996 | `campaignOperationService.getExportBundle` |  | browser-session: `content.view`, project(id); paramsInput("id", "bundleId") |  |  | plain Hono | D9 |

### Inventory 3.2 row 52

| # | Method | Path (under `/api`) | Source | Handler calls | Handler-level validation | Policy (cap / admission / input) | Rate limit | Flags | Style | Domain (9.4) |
|---|---|---|---|---|---|---|---|---|---|---|
| 52 | POST | `/projects/:id/export-bundles/:bundleId/retry` | route.ts:1011 | `campaignOperationService.retryExportBundle` |  | browser-session: `content.download`, project(id); idempotentParamsInput("id", "bundleId"); idempotency-key header | actor `export-bundle-retry` 10/3600s | idempotency-key header | plain Hono | D9 |

### Inventory 3.2 row 53

| # | Method | Path (under `/api`) | Source | Handler calls | Handler-level validation | Policy (cap / admission / input) | Rate limit | Flags | Style | Domain (9.4) |
|---|---|---|---|---|---|---|---|---|---|---|
| 53 | POST | `/projects/:id/campaign-operations/:operationId/retry-export-bundle` | route.ts:1031 | `campaignOperationService.retryExportBundleOperation` |  | browser-session: `content.download`, project(id); idempotentParamsInput("id", "operationId"); idempotency-key header | actor `export-operation-retry` 10/3600s | idempotency-key header | plain Hono | D9 |

### Inventory 3.2 row 54

| # | Method | Path (under `/api`) | Source | Handler calls | Handler-level validation | Policy (cap / admission / input) | Rate limit | Flags | Style | Domain (9.4) |
|---|---|---|---|---|---|---|---|---|---|---|
| 54 | GET | `/projects/:id/export-bundles/:bundleId/download` | route.ts:1054 | `campaignOperationService.getExportBundleDownload` |  | browser-session: `content.download`, project(id); paramsInput("id", "bundleId") |  | redirect | plain Hono | D9 |

### Inventory 3.2 row 64

| # | Method | Path (under `/api`) | Source | Handler calls | Handler-level validation | Policy (cap / admission / input) | Rate limit | Flags | Style | Domain (9.4) |
|---|---|---|---|---|---|---|---|---|---|---|
| 64 | POST | `/projects/:id/clips/:clipId/exports` | route.ts:1265 | `clipExportService.create` | `createClipExportSchema` | browser-session: `processing.consume`, project(id) | actor `clip-export` 20/60s | idempotency-key header | plain Hono | D9 |

### Inventory 3.2 row 65

| # | Method | Path (under `/api`) | Source | Handler calls | Handler-level validation | Policy (cap / admission / input) | Rate limit | Flags | Style | Domain (9.4) |
|---|---|---|---|---|---|---|---|---|---|---|
| 65 | GET | `/projects/:id/exports/current` | route.ts:1294 | `clipExportService.listCurrentProjectExports` |  | browser-session: `content.view`, project(id); paramsInput("id") |  |  | plain Hono | D9 |

### Inventory 3.2 row 66

| # | Method | Path (under `/api`) | Source | Handler calls | Handler-level validation | Policy (cap / admission / input) | Rate limit | Flags | Style | Domain (9.4) |
|---|---|---|---|---|---|---|---|---|---|---|
| 66 | GET | `/projects/:id/clips/:clipId/exports/:exportId` | route.ts:1305 | `clipExportService.getOwned` |  | browser-session: `content.download`, project(id) |  |  | plain Hono | D9 |

### Inventory 3.2 row 67

| # | Method | Path (under `/api`) | Source | Handler calls | Handler-level validation | Policy (cap / admission / input) | Rate limit | Flags | Style | Domain (9.4) |
|---|---|---|---|---|---|---|---|---|---|---|
| 67 | GET | `/projects/:id/clips/:clipId/exports/:exportId/subtitles/:format` | route.ts:1313 | `clipExportService.getSubtitles` |  | browser-session: `content.download`, project(id) |  | binary/text body | plain Hono | D9 |

### Inventory 3.2 row 68

| # | Method | Path (under `/api`) | Source | Handler calls | Handler-level validation | Policy (cap / admission / input) | Rate limit | Flags | Style | Domain (9.4) |
|---|---|---|---|---|---|---|---|---|---|---|
| 68 | GET | `/projects/:id/clips/:clipId/timeline/:format` | route.ts:1329 | `clipTimelineService.archive` | `timelineFormatSchema` | browser-session: `content.download`, project(id) |  | binary/text body | plain Hono | D9 |

### Inventory 3.2 row 69

| # | Method | Path (under `/api`) | Source | Handler calls | Handler-level validation | Policy (cap / admission / input) | Rate limit | Flags | Style | Domain (9.4) |
|---|---|---|---|---|---|---|---|---|---|---|
| 69 | GET | `/projects/:id/clips/:clipId/timeline-source` | route.ts:1344 | `clipTimelineService.issueSourceGrant` |  | browser-session: `content.download`, project(id) |  |  | plain Hono | D9 |

### Inventory 3.2 row 70

| # | Method | Path (under `/api`) | Source | Handler calls | Handler-level validation | Policy (cap / admission / input) | Rate limit | Flags | Style | Domain (9.4) |
|---|---|---|---|---|---|---|---|---|---|---|
| 70 | POST | `/projects/:id/clips/:clipId/exports/:exportId/retry` | route.ts:1350 | `clipExportService.retryFailed` |  | browser-session: `processing.consume`, project(id) | actor `clip-export-retry` 12/60s |  | plain Hono | D9 |

### Inventory 3.2 row 71

| # | Method | Path (under `/api`) | Source | Handler calls | Handler-level validation | Policy (cap / admission / input) | Rate limit | Flags | Style | Domain (9.4) |
|---|---|---|---|---|---|---|---|---|---|---|
| 71 | POST | `/projects/:id/clips/:clipId/exports/:exportId/share-links` | route.ts:1356 | `clipExportService.createShareLink` | `createClipShareLinkSchema` | browser-session: `content.edit`, project(id) | actor `clip-share` 10/60s |  | plain Hono | D9 |

### Inventory 3.2 row 72

| # | Method | Path (under `/api`) | Source | Handler calls | Handler-level validation | Policy (cap / admission / input) | Rate limit | Flags | Style | Domain (9.4) |
|---|---|---|---|---|---|---|---|---|---|---|
| 72 | DELETE | `/projects/:id/clips/:clipId/exports/:exportId/share-links` | route.ts:1374 | `clipExportService.revokeShareLinks` |  | browser-session: `content.edit`, project(id) |  |  | plain Hono | D9 |

### Inventory 5.9 refresh/fetch row at inventory line 845

| file:line | Trigger | Call | Refreshes |
| --- | --- | --- | --- |
| `(app)/exports/page.tsx:146` | Retry on workspace exports list | `AuthenticatedActionForm` + `retryWorkspaceExportAction` (server `revalidatePath("/exports")`) | `/exports` |

### Inventory 5.10 refresh/fetch row at inventory line 859

| Action file | Paths revalidated |
| --- | --- |
| `(app)/exports/actions.ts:12` | `/exports` |

### Inventory 5 exact file occurrences: apps/web/app/(app)/exports/actions.ts

```text
12: revalidatePath("/exports");
```

Also account for the inventory's cross-domain traps: query-only actions, action forms that relied on revalidatePath, signed downloads/media, OAuth anchors, all three EventSource consumers and unload keepalive. Only the literal files above may be changed by this ticket.

### Inventory 1.8 function `retryWorkspaceExportAction(exportId)`

| File:line | Function | Input | Service / auth calls | Policy helper + capability | Plan check | Returns | Side effects | Client callers | Target endpoint | Domain |
|---|---|---|---|---|---|---|---|---|---|---|
| `app/(app)/exports/actions.ts:7` | `retryWorkspaceExportAction(exportId)` | `string` | `clipExportService.getWorkspaceOwned`, then `clipExportService.retryFailed(appUser, projectId, clipId, exportId)`; throws `Error("Export not found")` | `executeWorkspaceAction("processing.consume")` | credits in service | `void` / failure | `revalidatePath("/exports")` | `app/(app)/exports/page.tsx:146` (`AuthenticatedActionForm action={retryWorkspaceExportAction.bind(null, item.id)}`) | `POST /api/workspace/exports/:exportId/retry` (existing: `POST /api/projects/:id/clips/:clipId/exports/:exportId/retry`, route.ts:1350, needs ids the page already has) | exports |

## Acceptance criteria

- [ ] All 17 export routes and workspace retry/list/project-filter reads preserve permissions/native retries/share/timeline revision facts.
- [ ] File/bundle/Workspace redirects become expiring grant JSON; bounded transcript/subtitle/ZIP attachments use authenticated fetch without media Blob inflation.
- [ ] Both pages use client queries with existing filters/cursors and lastSeq; export-delivery-client.tsx is reserved to 29 and its props stay frozen.
- [ ] Lost-response retry preserves acceptance; expired grants recover on resume; native export acceptance and credit gates pass.
- [ ] No unowned files changed; paired review findings and verification evidence recorded under Comments.

## Verification

Run these from the repository root after dependencies are installed. A command naming a new package script is implemented by the owning setup ticket, not silently skipped. PostgreSQL gates need a disposable schema; a skipped DB suite does not satisfy its gate. During the undeployed integration sequence, record any unrelated transitional compile failure with its owning blocker; this ticket's behavior tests must pass and the final integrated gates cannot be waived.

```sh
bun test apps/api/src/domains/exports
bun run test:processing-usage:db
bun run --cwd apps/api typecheck
```

Verify the changed flow in the running Next app against the separate API origin. Follow the repo's runtime/browser verification guidance; record steps, result and origin pair. Do not treat compilation as browser evidence.

## Comments

Append claim, requested seam changes, paired review and evidence here.
