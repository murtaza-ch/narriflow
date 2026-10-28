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

- [x] All 17 export routes and workspace retry/list/project-filter reads preserve permissions/native retries/share/timeline revision facts.
- [x] File/bundle/Workspace redirects become expiring grant JSON; bounded transcript/subtitle/ZIP attachments use authenticated fetch without media Blob inflation.
- [x] Both pages use client queries with existing filters/cursors and lastSeq; export-delivery-client.tsx is reserved to 29 and its props stay frozen.
- [x] Lost-response retry preserves acceptance; expired grants recover on resume; native export acceptance and credit gates pass.
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

Claimed and implemented by Claude (Sonnet 5.5), 2026-10-29. Paired review not run by the implementer (last acceptance box left open for the orchestrator). Signed-in browser pass NOT performed (ticket 32).

### What changed
- API (`apps/api/src/domains/exports`): new `GET /workspace/exports` (zod query: status ready|processing|failed, q, project uuid, ratio `ratio_*`, from/to `YYYY-MM-DD`, cursor), `GET /workspace/export-projects`, `POST /workspace/exports/:exportId/retry` (`processing.consume`, actor `clip-export-retry` 12/60, same as the project retry). Redirects became Download Grant JSON: `GET /workspace/exports/:exportId/download?variant=` -> `{exportId, variantId, fileName, sizeBytes, downloadUrl, expiresAt}` (via `issueDownloadGrants`, audited, 15 min) and `GET /projects/:id/export-bundles/:bundleId/download` -> `{downloadUrl}` (service TTL is 60 s: fetch on click, navigate at once). Export detail adds `lastSeq`. Subtitle and timeline routes unchanged (type, `Content-Disposition`, `X-Editor-Revision`). Native acceptance (create key, bundle keys, retry-of) untouched; `exports-receipt-commands`/`exports-commands*` stay as the empty slot (no new receipt command).
- Services (`clip-export.service.ts`): `issueWorkspaceDownloadGrant`, `retryWorkspaceExport` (missing export is now typed 404 `export_not_found`, was a 500 `Error`), `presentWorkspaceExports` (strips `storageKey`, adds `hasAsset` and a 15-minute `previewUrl` per finished file for the card thumbnails).
- Validators `api/exports.ts`; client `@narriflow/api-client/exports`: `createExportsClient`, `exportQueries` (workspaceList, workspaceProjects, detail, current, bundles, bundle), `exportCommands` (grants, retries, create, share links, bundles), `fetchTimelineArchive` / `fetchSubtitleFile` (Bearer fetch -> Blob, 25 MiB bound, status checked first, content type + name + revision kept), `invalidateAfterExportChange`, `invalidateWorkspaceExports`. Grants are deliberately not queries.
- Web: `exports/page.tsx` and delivery `page.tsx` are data-free Suspense shells (existing `loading.tsx` reused); new `exports/exports-screen.tsx` and `.../[exportId]/export-delivery-screen.tsx`. Filters/cursor stay in the URL (malformed values dropped, as before); list uses `keepPreviousData`. Download and Retry are buttons (grant fetch then `location.assign`; mutation with inline error); `retryWorkspaceExportAction`/`actions.ts` deleted. Delivery screen reads detail + workspace bootstrap concurrently, derives the frozen `ExportDeliveryClient` props from `usage.tier`/`capabilities`, calls `notFound()` on a missing export, and freezes the first read (`gcTime: 0`, no focus refetch) so props do not churn under the client's own state. `export-filters.tsx` and `export-preview.tsx` needed no change.

### Requests for other owners
- 29 (`export-delivery-client.tsx`): replace its raw `fetch` calls with `exportQueries.detail` (refetch on `refresh`, on resume: snapshot file URLs expire in 15 min), `exportCommands.retry|createShareLink|revokeShareLinks|timelineSourceGrant`, `fetchTimelineArchive`/`fetchSubtitleFile`, and `invalidateAfterExportChange`; the EventSource moves to the shared stream. `initialSeq` still comes from `lastSeq`.
- 31: remove the export rows from the baseline `authenticated-request-inventory.ts`; delete the unused `exports-commands*.ts`/`exports-receipt-commands.ts` slot only if no export command ever uses it (`create_clip_export` is there for integrations).
- 12: `campaign-command-bar.tsx` already calls the bundle grant through `api.exports`; its response is now `{downloadUrl}` as it expects.

### Deviations
- Workspace download error code for an unfinished file is now 409 `export_not_ready` (was `export_file_not_ready`), a foreign/unknown variant 404 `export_not_found`; unknown export id format 400.
- List response omits `storageKey` and gains `hasAsset`/`previewUrl`. Bad query values (`status=all`, bad dates) are 400 from the API; the page filters them out before calling.

### Evidence
- `bun test apps/api/src/domains/exports` 17 pass; `bun test packages/api-client/src/exports` 12 pass; `bun test packages/services/src/clip-export.service.test.ts packages/services/src/clip-export-download.test.ts` 20 pass.
- `.scratch/api-extraction/db-gate.sh bun run test:processing-usage:db` 31 pass (local Postgres).
- `bun run --cwd apps/api test:inventory` routes=268 problems=0; `bun test apps/api/src/admission-tables.test.ts` 53 pass.
- Typecheck (apps/api, packages/api-client, packages/services, packages/validators, apps/web via `tsc -p`): no error in any file of this ticket; remaining errors belong to others (rest/routes.ts, studio-shell.tsx, mcp pages, lib/authenticated-request-*).
- `bunx biome check` on all my paths: clean.
- NOT done: signed-in run against Next + API (list filters/cursor, grid preview playback from `previewUrl`, Download navigation, Retry, delivery page for ready/rendering/failed/foreign export, timeline ZIP/subtitle downloads once 29 adopts the helpers). Origin pair for ticket 32: web `http://localhost:3000` / API local `apps/api`.
