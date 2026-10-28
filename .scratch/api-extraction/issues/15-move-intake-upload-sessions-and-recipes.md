# 15. Move intake Upload Sessions and recipes

**What to build:** Intake, direct uploads, generation draft/commit/resume and Recipe controls preserve native idempotency and processing admission.

**Blocked by:** [04 - Wire API runtime and partition the catch-all](04-wire-api-runtime-and-partition-the-catch-all.md)

**Status:** ready-for-agent

**Suggested implementer:** Claude. The other pairing side reviews and returns findings to this owner.

Read [spec.md](../spec.md). It is the complete contract; the original brief/plan/reviews are not prerequisites. Claim this ticket before editing.

## Exact ownership

Paths are repo-relative. Every existing file below is exclusively assigned for this phase, including files that only need verification. A new `/**` directory includes its local tests/helpers, not adjacent directories. Read other files as evidence; do not edit them.

Existing files:

- `apps/web/app/api/[[...route]]/upload-session-http.test.ts`
- `apps/web/app/api/[[...route]]/upload-session-http.ts`
- `packages/services/src/project.service.ts`
- `packages/services/src/recipe.service.ts`
- `packages/services/src/upload-session-module.test.ts`
- `packages/services/src/upload-session.db.test.ts`
- `packages/services/src/upload-session.service.ts`

New files/directories or reserved skeletons handed off by a blocker:

- `apps/api/src/domains/ingest/**`
- `apps/api/src/types/ingest.ts`
- `packages/api-client/src/ingest/**`
- `packages/validators/src/api/ingest.ts`
- `apps/api/src/domains/recipes/**`
- `apps/api/src/types/recipes.ts`
- `packages/api-client/src/recipes/**`
- `packages/validators/src/api/recipes.ts`
- `packages/services/src/ingest-receipt-commands.ts`
- `packages/services/src/ingest-commands.ts`
- `packages/services/src/ingest-commands-runtime.ts`
- `packages/services/src/recipes-receipt-commands.ts`
- `packages/services/src/recipes-commands.ts`
- `packages/services/src/recipes-commands-runtime.ts`

Entire project.service.ts and Upload Session implementation are reserved here. 08/24 request their minimal service changes through Comments; satisfy the MCP resume helper and any Project command acceptance seam before closing. Do not edit MCP auth/upload bridge files owned by 24.

The chosen new endpoints for this ticket are the matching owner row in spec.md, "Endpoint and screen contracts added by extraction". All current endpoints/actions below retain their semantics unless that row explicitly changes transport. Fill only this domain's receipt-command module; current native receipts remain native.

## Endpoints, actions, pages and refresh sites

Rows retain their section/ordinal or exact source-line identifier from the independent inventory. Abbreviated table filenames are accompanied by the literal ownership manifest and exact source occurrences below. All action/page/fetch/refresh rows in owned files are in scope, including no-refresh callers and media navigation. Baseline observations do not override the spec's selected origins, route style, guest Bearer or new endpoints.

### Inventory 1.4 function `retryIngestFormAction(formData)`

| File:line | Function | Input | Service / auth calls | Policy helper + capability | Plan check | Returns | Side effects | Client callers | Target endpoint | Domain |
|---|---|---|---|---|---|---|---|---|---|---|
| `:280` | `retryIngestFormAction(formData)` | `projectId` | `getIngestJobLifecycle().retry({projectId, workspaceId, actorUserId})`; catches `IngestRetryLimitExceededError`, `IngestNotFailedError`, `IngestReselectRequiredError` | `executeProjectAction(projectId,"processing.consume")` | retry limit in service | `{ok:boolean, error?}` (expected failures returned, not thrown, to survive Next error redaction) | `revalidatePath("/projects/:id")` | `projects/[projectId]/render-clips-button.tsx:484` (`router.refresh`:486), `upload/_components/retry-import-band.tsx:54` (`router.refresh`:56) | `POST /api/ingest/:projectId/retry` (route.ts:620 already has `GET /ingest/:projectId`) | upload |

### Inventory 1.5 function `commitLinkImportAction(input)`

| File:line | Function | Input | Service / auth calls | Policy helper + capability | Plan check | Returns | Side effects | Client callers | Target endpoint | Domain |
|---|---|---|---|---|---|---|---|---|---|---|
| `:112` | `commitLinkImportAction(input)` | TS type `{url, title\|null, brandTemplateId, brandProfileId, commitToken, languageCode, mode: GenerationMode, processingStartSec, processingEndSec}` (**no zod parse in the action**) | `fetchYoutubeTitle` (oEmbed), `projectService.queueLinkIngest` | `executeWorkspaceAction("processing.consume")` | `ProcessingUsageError` (credits/length) returned as `{ok:false, code, message, details}` | `CommitLinkImportResult` `{ok:true, projectId, title}` / `{ok:false, code, message, details?}` | `revalidatePath("/projects/:id")` | `upload/_components/commit-step.tsx:309` | existing `POST /api/ingest/link` (route.ts:579, verify it takes commitToken/mode/brand ids/range); add a zod schema | upload |

### Inventory 1.5 function `commitDriveImportAction(input)`

| File:line | Function | Input | Service / auth calls | Policy helper + capability | Plan check | Returns | Side effects | Client callers | Target endpoint | Domain |
|---|---|---|---|---|---|---|---|---|---|---|
| `:155` | `commitDriveImportAction(input)` | `driveIngestSchema` (`fileId, accessToken` Drive `drive.file` token, + same commit fields) | `projectService.queueDriveIngest` | `executeWorkspaceActionWithInput("processing.consume")`, op `commit-drive-import`, **rate limit** `drive-import:${workspaceId}` 10/60s | same | `CommitLinkImportResult` | `revalidatePath("/projects/:id")` | `commit-step.tsx:304` | `POST /api/ingest/drive` (token never logged/returned; keep rate limit) | upload |

### Inventory 1.5 function `finalizeLinkConfigureAction(input)`

| File:line | Function | Input | Service / auth calls | Policy helper + capability | Plan check | Returns | Side effects | Client callers | Target endpoint | Domain |
|---|---|---|---|---|---|---|---|---|---|---|
| `:216` | `finalizeLinkConfigureAction(input)` | `linkConfigureActionInputSchema` `{projectId, contentPack, languageCode\|null}` strict | `projectService.finalizeGenerationSetup` | `executeProjectActionWithInput(projectId,"content.edit")` | `ProcessingUsageError` -> `{ok:false, code, message, details}` | `FinalizeLinkConfigureResult` `{ok:true, started, ingestStatus, workflowRunId?}` / `{ok:false,...}` | `revalidatePath("/projects/:id")` | `upload/_components/configure-step.tsx:185` (`router.push`:198) | `POST /api/projects/:projectId/generation/finalize` | upload |

### Inventory 1.5 function `saveGenerationDraftAction(input)`

| File:line | Function | Input | Service / auth calls | Policy helper + capability | Plan check | Returns | Side effects | Client callers | Target endpoint | Domain |
|---|---|---|---|---|---|---|---|---|---|---|
| `:257` | `saveGenerationDraftAction(input)` | `linkConfigureActionInputSchema` | `projectService.saveGenerationDraft` | `executeProjectActionWithInput(projectId,"content.edit")` | none | `{ok:true}` / failure | `revalidatePath("/projects/:id")` | `configure-step.tsx:165` (`router.push`:175) | `PUT /api/projects/:projectId/generation/draft` | upload |

### Inventory 1.5 function `fetchYoutubeMetadataAction(url)`

| File:line | Function | Input | Service / auth calls | Policy helper + capability | Plan check | Returns | Side effects | Client callers | Target endpoint | Domain |
|---|---|---|---|---|---|---|---|---|---|---|
| `:276` | `fetchYoutubeMetadataAction(url)` | `string` (no schema) | `fetchYoutubeTitle` only (outbound fetch, no service) | `executeWorkspaceAction("content.view")` | none | `{title: string\|null}` / failure | none | `configure-step.tsx:105`, `commit-step.tsx:205` | `GET /api/ingest/link/metadata?url=` (add SSRF guard: only `youtube.com` oEmbed host is fetched, URL is encoded, but validate `detectLinkProvider`) | upload |

### Inventory 1.5 function `generateFromRssAction(formData)`

| File:line | Function | Input | Service / auth calls | Policy helper + capability | Plan check | Returns | Side effects | Client callers | Target endpoint | Domain |
|---|---|---|---|---|---|---|---|---|---|---|
| `:284` | `generateFromRssAction(formData)` | `rssActionInputSchema` = `rssImportSchema.extend({contentPack, languageCode})` strict; form fields `rssUrl, titlePrefix, episodeIds` (JSON), `commitToken`, brand profile id, content pack | `projectService.importFromRss` | `executeWorkspaceActionWithInput("processing.consume")`, op `generate-from-rss`, **rate limit** `rss-import:${workspaceId}` 5/60s | `ProcessingUsageError` returned `{ok:false, error, message, details, retryAfterSeconds}` | `{ok:true, projectId}` / `{ok:false,...}`; throws if no project produced | `revalidatePath("/projects/:id")` | `upload/_components/upload-shell.tsx:702` (`router.push`:715 + `router.refresh`:716) | existing `POST /api/ingest/rss/import` (route.ts:606, verify contentPack/languageCode/rate limit parity) | upload |

### Inventory 3.2 row 9

| # | Method | Path (under `/api`) | Source | Handler calls | Handler-level validation | Policy (cap / admission / input) | Rate limit | Flags | Style | Domain (9.4) |
|---|---|---|---|---|---|---|---|---|---|---|
| 9 | GET | `/recipes` | route.ts:298 | `recipeService.list` |  | browser-session: `content.view`, workspace |  |  | plain Hono | D4 |

### Inventory 3.2 row 10

| # | Method | Path (under `/api`) | Source | Handler calls | Handler-level validation | Policy (cap / admission / input) | Rate limit | Flags | Style | Domain (9.4) |
|---|---|---|---|---|---|---|---|---|---|---|
| 10 | POST | `/recipes` | route.ts:305 | `recipeService.create` | `recipeInputSchema` | browser-session: `content.edit`, workspace | workspace `recipe-create` 30/3600s |  | plain Hono | D4 |

### Inventory 3.2 row 11

| # | Method | Path (under `/api`) | Source | Handler calls | Handler-level validation | Policy (cap / admission / input) | Rate limit | Flags | Style | Domain (9.4) |
|---|---|---|---|---|---|---|---|---|---|---|
| 11 | PATCH | `/recipes/:recipeId` | route.ts:318 | `recipeService.update` | `recipeUpdateSchema` | browser-session: `content.edit`, workspace |  |  | plain Hono | D4 |

### Inventory 3.2 row 12

| # | Method | Path (under `/api`) | Source | Handler calls | Handler-level validation | Policy (cap / admission / input) | Rate limit | Flags | Style | Domain (9.4) |
|---|---|---|---|---|---|---|---|---|---|---|
| 12 | POST | `/recipes/:recipeId/duplicate` | route.ts:332 | `recipeService.duplicate` |  | browser-session: `content.edit`, workspace | workspace `recipe-create` 30/3600s |  | plain Hono | D4 |

### Inventory 3.2 row 13

| # | Method | Path (under `/api`) | Source | Handler calls | Handler-level validation | Policy (cap / admission / input) | Rate limit | Flags | Style | Domain (9.4) |
|---|---|---|---|---|---|---|---|---|---|---|
| 13 | DELETE | `/recipes/:recipeId` | route.ts:339 | `recipeService.delete` |  | browser-session: `content.edit`, workspace |  |  | plain Hono | D4 |

### Inventory 3.2 row 26

| # | Method | Path (under `/api`) | Source | Handler calls | Handler-level validation | Policy (cap / admission / input) | Rate limit | Flags | Style | Domain (9.4) |
|---|---|---|---|---|---|---|---|---|---|---|
| 26 | POST | `/ingest/link` | route.ts:579 | `projectService.queueLinkIngest` | `linkIngestSchema` | browser-session: `processing.consume`, workspace |  |  | plain Hono | D4 |

### Inventory 3.2 row 27

| # | Method | Path (under `/api`) | Source | Handler calls | Handler-level validation | Policy (cap / admission / input) | Rate limit | Flags | Style | Domain (9.4) |
|---|---|---|---|---|---|---|---|---|---|---|
| 27 | POST | `/ingest/rss/preview` | route.ts:593 | `projectService.previewRssFeed` | `rssPreviewSchema` | browser-session: `processing.consume`, workspace | workspace `rss-preview` 20/60s |  | plain Hono | D4 |

### Inventory 3.2 row 28

| # | Method | Path (under `/api`) | Source | Handler calls | Handler-level validation | Policy (cap / admission / input) | Rate limit | Flags | Style | Domain (9.4) |
|---|---|---|---|---|---|---|---|---|---|---|
| 28 | POST | `/ingest/rss/import` | route.ts:606 | `projectService.importFromRss` | `rssImportSchema` | browser-session: `processing.consume`, workspace | workspace `rss-import` 5/60s |  | plain Hono | D4 |

### Inventory 3.2 row 29

| # | Method | Path (under `/api`) | Source | Handler calls | Handler-level validation | Policy (cap / admission / input) | Rate limit | Flags | Style | Domain (9.4) |
|---|---|---|---|---|---|---|---|---|---|---|
| 29 | GET | `/ingest/:projectId` | route.ts:620 | `projectService.getIngestSnapshot` |  | browser-session: `content.view`, project(projectId) |  |  | plain Hono | D4 |

### Inventory 3.2 row 107

| # | Method | Path (under `/api`) | Source | Handler calls | Handler-level validation | Policy (cap / admission / input) | Rate limit | Flags | Style | Domain (9.4) |
|---|---|---|---|---|---|---|---|---|---|---|
| 107 | POST | `/upload-sessions/open` | upload-session-http.ts:24 | `uploadSessionService.open` | `openUploadSessionSchema` | browser-session: `processing.consume`, workspace | actor `upload-session-open` 60/60s | Retry-After | plain Hono | D4 |

### Inventory 3.2 row 108

| # | Method | Path (under `/api`) | Source | Handler calls | Handler-level validation | Policy (cap / admission / input) | Rate limit | Flags | Style | Domain (9.4) |
|---|---|---|---|---|---|---|---|---|---|---|
| 108 | POST | `/upload-sessions/finalize` | upload-session-http.ts:47 | `uploadSessionService.finalize` | `finalizeUploadSessionSchema` | browser-session: `processing.consume`, workspace | actor `upload-session-finalize` 60/60s | Retry-After | plain Hono | D4 |

### Inventory 3.2 row 109

| # | Method | Path (under `/api`) | Source | Handler calls | Handler-level validation | Policy (cap / admission / input) | Rate limit | Flags | Style | Domain (9.4) |
|---|---|---|---|---|---|---|---|---|---|---|
| 109 | POST | `/upload-sessions/grants` | upload-session-http.ts:70 | `uploadSessionService.grant` | `grantUploadPartsSchema` | browser-session: `processing.consume`, workspace | actor `upload-session-grants` 120/60s |  | plain Hono | D4 |

### Inventory 3.2 row 110

| # | Method | Path (under `/api`) | Source | Handler calls | Handler-level validation | Policy (cap / admission / input) | Rate limit | Flags | Style | Domain (9.4) |
|---|---|---|---|---|---|---|---|---|---|---|
| 110 | POST | `/upload-sessions/status` | upload-session-http.ts:91 | `uploadSessionService.status` | `readUploadSessionSchema` | browser-session: `processing.consume`, workspace | actor `upload-session-status` 120/60s | Retry-After | plain Hono | D4 |

### Inventory 3.2 row 111

| # | Method | Path (under `/api`) | Source | Handler calls | Handler-level validation | Policy (cap / admission / input) | Rate limit | Flags | Style | Domain (9.4) |
|---|---|---|---|---|---|---|---|---|---|---|
| 111 | POST | `/upload-sessions/discard` | upload-session-http.ts:112 | `uploadSessionService.discard` | `discardUploadSessionSchema` | browser-session: `processing.consume`, workspace | actor `upload-session-discard` 30/60s | Retry-After | plain Hono | D4 |

## Acceptance criteria

- [ ] All 14 intake/recipe routes, Upload Session sibling and six upload action semantics map to spec, with separate draft vs finalize acceptance.
- [ ] Drive token remains server-only request data; metadata host/provider validated; Drive 10/minute, RSS 20 preview/5 import per Workspace preserved.
- [ ] Upload Session five commands/native keys, processing reservations, multipart bounds/resume and direct storage grants preserved across browser/MCP/REST.
- [ ] Provide service method for MCP integration-session resume lookup so 24 removes raw web Prisma query without owning this file.
- [ ] Recipes keep resolution/replay/brand/account rules; project.service.ts remains solely owned here and consumer requests are resolved before their acceptance.
- [ ] No unowned files changed; paired review findings and verification evidence recorded under Comments.

## Verification

Run these from the repository root after dependencies are installed. A command naming a new package script is implemented by the owning setup ticket, not silently skipped. PostgreSQL gates need a disposable schema; a skipped DB suite does not satisfy its gate. During the undeployed integration sequence, record any unrelated transitional compile failure with its owning blocker; this ticket's behavior tests must pass and the final integrated gates cannot be waived.

```sh
bun test apps/api/src/domains/recipes
bun test apps/api/src/domains/ingest
bun run test:upload-session:db
bun run test:processing-usage:db
bun run test:workflow:db
bun run --cwd apps/api typecheck
```

## Comments

Append claim, requested seam changes, paired review and evidence here.
