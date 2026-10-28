# 15. Move intake Upload Sessions and recipes

**What to build:** Intake, direct uploads, generation draft/commit/resume and Recipe controls preserve native idempotency and processing admission.

**Blocked by:** [04 - Wire API runtime and partition the catch-all](04-wire-api-runtime-and-partition-the-catch-all.md)

**Status:** done

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

- [x] All 14 intake/recipe routes, Upload Session sibling and six upload action semantics map to spec, with separate draft vs finalize acceptance.
- [x] Drive token remains server-only request data; metadata host/provider validated; Drive 10/minute, RSS 20 preview/5 import per Workspace preserved.
- [x] Upload Session five commands/native keys, processing reservations, multipart bounds/resume and direct storage grants preserved across browser/MCP/REST.
- [x] Provide service method for MCP integration-session resume lookup so 24 removes raw web Prisma query without owning this file.
- [x] Recipes keep resolution/replay/brand/account rules; project.service.ts remains solely owned here and consumer requests are resolved before their acceptance.
- [x] No unowned files changed; paired review findings and verification evidence recorded under Comments.

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



Claimed and implemented by Claude (Sonnet 5.5), 2026-10-29. Paired review not run by the implementer (the "paired review findings" part of the last acceptance box is left to the orchestrator).

### What changed
- **ingest domain** (`apps/api/src/domains/ingest`): `GET /ingest/configuration` (Styles, Brand Profiles with the default, Recipes, usage; parallel `Promise.all`; profiles read with `limit: 100`, not the 24 default), `GET /ingest/link/metadata?url=` (shared schema runs `detectLinkProvider`; only YouTube is fetched, fixed oEmbed host), `POST /ingest/link`, `POST /ingest/drive` (rate `drive-import` 10/60 per Workspace), RSS preview/import (20 / 5 per Workspace, import now carries `contentPack` + `languageCode`), `GET /ingest/:projectId`, `GET /ingest/:projectId/resume` (typed `resume | open_project | restart`), `POST /ingest/:projectId/retry` (domain refusals `ingest_retry_limit_exceeded|ingest_not_failed|drive_token_expired` flow through the common envelope), separate `PUT /projects/:id/generation/draft` and `POST /projects/:id/generation/finalize`, and the five `/upload-sessions/*` POSTs with the same actor limits (60/60/120/120/30) and 202 + `Retry-After` for reconciling/compensating. Literal paths are registered before `:projectId`; the inventory comparison reports no problem for these keys.
- **Native idempotency, no header**: link, Drive and RSS commits now REQUIRE the body `commitToken` (the intake's native identity; the UI already mints it), Upload Sessions keep `clientIdempotencyKey`. No `Idempotency-Key` header is accepted there, so nothing can disagree. Failure shapes of the old actions (`{ok:false, code, message, details}`) are the common envelope: `error` = the same code, `details` unchanged (`ProcessingUsageError`, `DriveSourceError`, `LinkUnsupportedSourceError`). `commitLinkImportAction`'s missing zod parse is replaced by `linkCommitRequestSchema`. Link commit still looks the title up when none was typed (server, `projectService.fetchLinkTitle`).
- **Shared Upload Session adapter** for 24: `apps/api/src/domains/ingest/upload-session-http.ts` exports `createUploadSessionHttpRoutes({ getActor, service })` (plain Hono, relocated unchanged with its test; it keeps the `validation_failed` body MCP clients already see). The web copy and its test were deleted; 24 must repoint `apps/web/lib/mcp-upload-http.ts` (it imported the deleted path) to this file.
- **MCP resume helper** for 24 (replaces the raw Prisma query in `apps/web/app/(app)/integrations/mcp/upload/page.tsx`): `uploadSessionService.hasOwnSessionByClientKey(actor, storedKey): Promise<boolean>`; pass `integrationUploadSessionKey(actor.actorUserId, state.intent.clientIdempotencyKey)`. It requires `processing.consume`, is a pure lookup (no reconciliation, no new upload authorization) and answers false for another actor's session.
- **recipes domain**: create and duplicate are now receipt-backed (`create_recipe`, `duplicate_recipe` in `recipes-receipt-commands.ts`; `recipesCommands` in `recipes-commands(-runtime).ts`): `Idempotency-Key` required, `Idempotent-Replayed: true` on replay, limiter refusal (429, or 503 `mutations_unavailable` when Redis is down) deferred past replay lookup via `deferRateRefusal` + `enforceRecordedRateLimit` in `beforeAccept`, plan/brand-default resolution only after the replay lookup (`RecipeService.planCreate/planDuplicate/insertPlanned`, with `create`/`duplicate` unchanged for other callers such as MCP/REST/tests). Update (guarded by `expectedRevision`) and delete stay native. A lost response now replays the saved Recipe instead of saving a second.
- **api-client**: `packages/api-client/src/ingest/**` and `recipes/**` (`createIngestActions`/`createRecipesActions`, query option factories `ingestConfiguration|linkResume|ingestSnapshot|linkMetadata`, `recipesList`, `invalidateAfterIntake`, `invalidateAfterRecipeChange`). Validators: `@narriflow/validators/api/ingest` (request schemas, `LinkResumeData/Result`) and `/api/recipes` (re-export).

### Deviations and notes
- Upload Session `grants` and `status` use `tier: "read"` (300/min baseline) instead of the 60/min mutation baseline: their own limit is 120/min, which the shared 60/min mutation bucket would otherwise make unreachable for multipart uploads and polling. Open/finalize/discard keep the mutation baseline plus their own limit.
- Resume is declared as a project-kind route (`processing.consume`), so a foreign or missing Project is the concealed 404 `project_not_found` (client: restart) and a Project of another Workspace is `active_workspace_mismatch`; the old page redirected to `/upload` in both cases.
- `retryIngestFormAction` returns `{ok:true, queuedJobId, attemptsUsed, maxAttempts}` now; expected refusals are typed 4xx failures rather than `{ok:false}` (UI 16 branches on `ApiError.code`; `userErrorMessage(code)` stays the copy source).
- `generateFromRssAction`'s "throws if no project produced" is unchanged server behavior (the service throws); the route returns the service result (`projects[0].project.id`).
- Source-picker keys (`NEXT_PUBLIC_*`) stay in web; the configuration aggregate does not carry them.
- Requests for others: **24** repoint the deleted web import and use `hasOwnSessionByClientKey` (above). **16** can build on `createIngestActions` / `ingestConfigurationQueryOptions` / `linkResumeQueryOptions`; mint one `commitToken` per import (as today) and one `runtime.createIntent()` key per Recipe create/duplicate. **08**: no `project.service.ts` change was requested; if one arrives it is still mine. Pre-existing and unrelated: `test:integration-api:db` fails in `completion-callback.db.test.ts` (2 tests, `worker.observe()` returns 0) before reaching the recipe suites; I ran the suites from that gate that touch my code (`recipe.db`, `recipe-migration.db`) separately: 15 + 2 pass.
- Not run here: `bun run --cwd apps/api test:inventory` (stops on `inviteTokenParamSchema` missing from `packages/validators/src/index.ts`, imported by `apps/api/src/domains/session/routes.ts`, ticket 05, in progress). I ran `checkRouteInventory` on a one-domain app for ingest and recipes: no problems for any of their keys. My route tests use a one-domain harness (`ingest/test-app.ts`) so they do not read other domains' modules.

### Evidence
- `bun test apps/api/src/domains/ingest apps/api/src/domains/recipes` -> 29 pass, 0 fail (route tests, relocated Upload Session adapter tests).
- `bun test packages/services/src/recipes-commands.test.ts` -> 5 pass (replay, changed-body conflict, limiter after replay, duplicate replays the first copy).
- `.scratch/api-extraction/db-gate.sh bun run test:upload-session:db` -> 15 pass, 0 fail, 0 skipped (adds the `hasOwnSessionByClientKey` case). `... test:processing-usage:db` -> 31 pass, 0 fail. `... test:workflow:db` -> 175 pass, 0 fail.
- `bunx biome check` on every owned path: clean.
- `tsc -p apps/api/tsconfig.json` and `tsc -p packages/api-client/tsconfig.json` (walk services, validators, ingest and recipes): no error in any file of this ticket. Remaining errors are other tickets' in-progress files: `packages/services/src/clips-commands.ts` (11), `apps/api/src/domains/brand/aggregates.ts` (19), `studio/bootstrap.ts` (13), `rest/routes.ts` (23), `workspace/routes.ts` (05), `reviews/guest-replay-child.ts` (27), `packages/api-client/src/clips/mutations.ts` (11).
- Web typecheck was not run: it has the transitional breakage ticket 04 recorded, and the deleted `upload-session-http` import in `apps/web/lib/mcp-upload-http.ts` belongs to 24.
