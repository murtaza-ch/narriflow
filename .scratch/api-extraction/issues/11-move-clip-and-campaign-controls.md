# 11. Move clip and campaign controls

**What to build:** Clip/campaign/thumbnail HTTP controls use the admitted actor and current native command guards; new duplicate/range creates have durable replay.

**Blocked by:** [04 - Wire API runtime and partition the catch-all](04-wire-api-runtime-and-partition-the-catch-all.md)

**Status:** done

**Suggested implementer:** Claude. The other pairing side reviews and returns findings to this owner.

Read [spec.md](../spec.md). It is the complete contract; the original brief/plan/reviews are not prerequisites. Claim this ticket before editing.

## Exact ownership

Paths are repo-relative. Every existing file below is exclusively assigned for this phase, including files that only need verification. A new `/**` directory includes its local tests/helpers, not adjacent directories. Read other files as evidence; do not edit them.

Existing files:

- `apps/web/app/api/[[...route]]/clip-generation-http.test.ts`
- `apps/web/app/api/[[...route]]/clip-generation-http.ts`
- `packages/services/src/campaign-operation.service.test.ts`
- `packages/services/src/campaign-operation.service.ts`
- `packages/services/src/clip.service.ts`
- `packages/services/src/thumbnail-frame-preparation-runtime.ts`

New files/directories or reserved skeletons handed off by a blocker:

- `apps/api/src/domains/clips/**`
- `apps/api/src/types/clips.ts`
- `packages/api-client/src/clips/**`
- `packages/validators/src/api/clips.ts`
- `packages/services/src/clips-receipt-commands.ts`
- `packages/services/src/clips-commands.ts`
- `packages/services/src/clips-commands-runtime.ts`

The chosen new endpoints for this ticket are the matching owner row in spec.md, "Endpoint and screen contracts added by extraction". All current endpoints/actions below retain their semantics unless that row explicitly changes transport. Fill only this domain's receipt-command module; current native receipts remain native.

## Endpoints, actions, pages and refresh sites

Rows retain their section/ordinal or exact source-line identifier from the independent inventory. Abbreviated table filenames are accompanied by the literal ownership manifest and exact source occurrences below. All action/page/fetch/refresh rows in owned files are in scope, including no-refresh callers and media navigation. Baseline observations do not override the spec's selected origins, route style, guest Bearer or new endpoints.

### Inventory 3.2 row 30

| # | Method | Path (under `/api`) | Source | Handler calls | Handler-level validation | Policy (cap / admission / input) | Rate limit | Flags | Style | Domain (9.4) |
|---|---|---|---|---|---|---|---|---|---|---|
| 30 | GET | `/projects/:id/clips` | route.ts:635 | `clipService.listClips` |  | browser-session: `content.view`, project(id) |  |  | plain Hono | D3 |

### Inventory 3.2 row 31

| # | Method | Path (under `/api`) | Source | Handler calls | Handler-level validation | Policy (cap / admission / input) | Rate limit | Flags | Style | Domain (9.4) |
|---|---|---|---|---|---|---|---|---|---|---|
| 31 | GET | `/projects/:id/clips/:clipId/preview-peaks` | route.ts:647 | `clipService.getClipPreviewPeaks` |  | browser-session: `content.view`, project(id) |  | binary/text body | plain Hono | D3 |

### Inventory 3.2 row 32

| # | Method | Path (under `/api`) | Source | Handler calls | Handler-level validation | Policy (cap / admission / input) | Rate limit | Flags | Style | Domain (9.4) |
|---|---|---|---|---|---|---|---|---|---|---|
| 32 | POST | `/projects/:id/clips/:clipId/title-suggestions` | route.ts:663 | `clipService.suggestClipTitles` |  | browser-session: `processing.consume`, project(id) | actor `clip-title-suggest` 30/60s |  | plain Hono | D3 |

### Inventory 3.2 row 33

| # | Method | Path (under `/api`) | Source | Handler calls | Handler-level validation | Policy (cap / admission / input) | Rate limit | Flags | Style | Domain (9.4) |
|---|---|---|---|---|---|---|---|---|---|---|
| 33 | POST | `/projects/:id/clips/:clipId/duplicate` | route.ts:677 | `clipService.duplicateClip` |  | browser-session: `content.edit`, project(id) | actor `clip-duplicate` 30/60s |  | plain Hono | D3 |

### Inventory 3.2 row 34

| # | Method | Path (under `/api`) | Source | Handler calls | Handler-level validation | Policy (cap / admission / input) | Rate limit | Flags | Style | Domain (9.4) |
|---|---|---|---|---|---|---|---|---|---|---|
| 34 | POST | `/projects/:id/clips/:clipId/create-from-selection` | route.ts:701 | `clipService.createClipFromSelection` | `createClipFromSelectionSchema` | browser-session: `content.edit`, project(id) |  |  | plain Hono | D3 |

### Inventory 3.2 row 35

| # | Method | Path (under `/api`) | Source | Handler calls | Handler-level validation | Policy (cap / admission / input) | Rate limit | Flags | Style | Domain (9.4) |
|---|---|---|---|---|---|---|---|---|---|---|
| 35 | POST | `/projects/:id/clips/create-from-range` | route.ts:732 | `clipService.createClipFromRange` |  | browser-session: `content.edit`, project(id); bodyInput(createClipFromSelectionSchema, ["id"]) |  |  | plain Hono | D3 |

### Inventory 3.2 row 36

| # | Method | Path (under `/api`) | Source | Handler calls | Handler-level validation | Policy (cap / admission / input) | Rate limit | Flags | Style | Domain (9.4) |
|---|---|---|---|---|---|---|---|---|---|---|
| 36 | DELETE | `/projects/:id/clips/:clipId` | route.ts:741 | `clipService.deleteClip` |  | browser-session: `content.edit`, project(id) |  |  | plain Hono | D3 |

### Inventory 3.2 row 37

| # | Method | Path (under `/api`) | Source | Handler calls | Handler-level validation | Policy (cap / admission / input) | Rate limit | Flags | Style | Domain (9.4) |
|---|---|---|---|---|---|---|---|---|---|---|
| 37 | POST | `/projects/:id/clips/render` | route.ts:752 | `clipService.triggerClipRendering`, `campaignOperationService.renderSelected` | `triggerClipRenderSchema` | browser-session: `processing.consume`, project(id) | actor `render` 20/60s | idempotency-key header | plain Hono | D3 |

### Inventory 3.2 row 41

| # | Method | Path (under `/api`) | Source | Handler calls | Handler-level validation | Policy (cap / admission / input) | Rate limit | Flags | Style | Domain (9.4) |
|---|---|---|---|---|---|---|---|---|---|---|
| 41 | GET | `/projects/:id/campaign-operations` | route.ts:823 | `campaignOperationService.listOperations` |  | browser-session: `content.view`, project(id) |  |  | plain Hono | D3 |

### Inventory 3.2 row 43

| # | Method | Path (under `/api`) | Source | Handler calls | Handler-level validation | Policy (cap / admission / input) | Rate limit | Flags | Style | Domain (9.4) |
|---|---|---|---|---|---|---|---|---|---|---|
| 43 | POST | `/projects/:id/thumbnail-frames` | route.ts:851 | `thumbnailFramePreparationService.request` | `type RequestThumbnailFrameInput` | browser-session: `publishing.manage`, project(id); bodyInput(requestThumbnailFrameSchema, ["id"]) | actor `thumbnail-frame` 30/60s |  | plain Hono | D3 |

### Inventory 3.2 row 44

| # | Method | Path (under `/api`) | Source | Handler calls | Handler-level validation | Policy (cap / admission / input) | Rate limit | Flags | Style | Domain (9.4) |
|---|---|---|---|---|---|---|---|---|---|---|
| 44 | GET | `/projects/:id/thumbnail-frames/:operationId` | route.ts:868 | `thumbnailFramePreparationService.get` |  | browser-session: `content.view`, project(id); paramsInput("id", "operationId") |  |  | plain Hono | D3 |

### Inventory 3.2 row 45

| # | Method | Path (under `/api`) | Source | Handler calls | Handler-level validation | Policy (cap / admission / input) | Rate limit | Flags | Style | Domain (9.4) |
|---|---|---|---|---|---|---|---|---|---|---|
| 45 | POST | `/projects/:id/thumbnail-frames/:operationId/retry` | route.ts:884 | `thumbnailFramePreparationService.retry` |  | browser-session: `publishing.manage`, project(id); paramsInput("id", "operationId") | actor `thumbnail-frame-retry` 20/60s |  | plain Hono | D3 |

### Inventory 3.2 row 46

| # | Method | Path (under `/api`) | Source | Handler calls | Handler-level validation | Policy (cap / admission / input) | Rate limit | Flags | Style | Domain (9.4) |
|---|---|---|---|---|---|---|---|---|---|---|
| 46 | GET | `/projects/:id/campaign-operations/editor-action-catalog` | route.ts:900 | `campaignOperationService.getEditorActionCatalog` |  | browser-session: `content.view`, project(id); paramsInput("id") |  |  | plain Hono | D3 |

### Inventory 3.2 row 47

| # | Method | Path (under `/api`) | Source | Handler calls | Handler-level validation | Policy (cap / admission / input) | Rate limit | Flags | Style | Domain (9.4) |
|---|---|---|---|---|---|---|---|---|---|---|
| 47 | POST | `/projects/:id/campaign-operations/preview-editor-action` | route.ts:912 | `campaignOperationService.previewEditorAction` | `type PreviewCampaignEditorActionInput` | browser-session: `content.view`, project(id); bodyInput(previewCampaignEditorActionSchema, ["id"]) | actor `preview-campaign-editor-action` 60/60s |  | plain Hono | D3 |

### Inventory 3.2 row 48

| # | Method | Path (under `/api`) | Source | Handler calls | Handler-level validation | Policy (cap / admission / input) | Rate limit | Flags | Style | Domain (9.4) |
|---|---|---|---|---|---|---|---|---|---|---|
| 48 | POST | `/projects/:id/campaign-operations/apply-brand-profile` | route.ts:930 | `campaignOperationService.applyProjectBrandProfileSelected` | `type ApplyProjectBrandProfileSelectedInput` | browser-session: `content.edit`, project(id); campaignMutationInput(applyProjectBrandProfileSelectedSchema, [ "id", ]); idempotency-key header | actor `apply-brand-profile-selected` 20/3600s | idempotency-key header | plain Hono | D3 |

### Inventory 3.2 row 49

| # | Method | Path (under `/api`) | Source | Handler calls | Handler-level validation | Policy (cap / admission / input) | Rate limit | Flags | Style | Domain (9.4) |
|---|---|---|---|---|---|---|---|---|---|---|
| 49 | POST | `/projects/:id/campaign-operations/apply-style` | route.ts:952 | `campaignOperationService.applyStyleSelected` | `type ApplyStyleSelectedInput` | browser-session: `content.edit`, project(id); campaignMutationInput(applyStyleSelectedSchema, ["id"]); idempotency-key header | actor `apply-style-selected` 20/3600s | idempotency-key header | plain Hono | D3 |

### Inventory 3.2 row 50

| # | Method | Path (under `/api`) | Source | Handler calls | Handler-level validation | Policy (cap / admission / input) | Rate limit | Flags | Style | Domain (9.4) |
|---|---|---|---|---|---|---|---|---|---|---|
| 50 | POST | `/projects/:id/campaign-operations/apply-motion` | route.ts:974 | `campaignOperationService.applyMotionSelected` | `type ApplyMotionSelectedInput` | browser-session: `content.edit`, project(id); campaignMutationInput(applyMotionSelectedSchema, ["id"]); idempotency-key header | actor `apply-motion-selected` 20/3600s | idempotency-key header | plain Hono | D3 |

### Inventory 3.2 row 73

| # | Method | Path (under `/api`) | Source | Handler calls | Handler-level validation | Policy (cap / admission / input) | Rate limit | Flags | Style | Domain (9.4) |
|---|---|---|---|---|---|---|---|---|---|---|
| 73 | POST | `/projects/:id/clips/apply-caption-preset` | route.ts:1383 | `clipEditorDocumentPersistence.mutateProjectSelection` | `applyCaptionPresetToAllSchema` | browser-session: `content.edit`, project(id) |  |  | plain Hono | D3 |

### Inventory 3.2 row 74

| # | Method | Path (under `/api`) | Source | Handler calls | Handler-level validation | Policy (cap / admission / input) | Rate limit | Flags | Style | Domain (9.4) |
|---|---|---|---|---|---|---|---|---|---|---|
| 74 | POST | `/projects/:id/clips/apply-studio-edits` | route.ts:1405 | `clipEditorDocumentPersistence.mutateProjectSelection` | `applyStudioEditsToAllSchema` | browser-session: `content.edit`, project(id) |  |  | plain Hono | D3 |

### Inventory 3.2 row 88

| # | Method | Path (under `/api`) | Source | Handler calls | Handler-level validation | Policy (cap / admission / input) | Rate limit | Flags | Style | Domain (9.4) |
|---|---|---|---|---|---|---|---|---|---|---|
| 88 | GET | `/projects/:id/clips/previews` | route.ts:1700 | `clipService.getProjectClipPreviewUrls` | `clipDownloadQuerySchema` | browser-session: `content.view`, project(id) |  |  | plain Hono | D3 |

### Inventory 3.2 row 89

| # | Method | Path (under `/api`) | Source | Handler calls | Handler-level validation | Policy (cap / admission / input) | Rate limit | Flags | Style | Domain (9.4) |
|---|---|---|---|---|---|---|---|---|---|---|
| 89 | GET | `/projects/:id/clips/:clipId/download` | route.ts:1713 | `clipService.getClipDownloadUrl` | `clipDownloadQuerySchema` | browser-session: `content.download`, project(id) |  |  | plain Hono | D3 |

### Inventory 3.2 row 90

| # | Method | Path (under `/api`) | Source | Handler calls | Handler-level validation | Policy (cap / admission / input) | Rate limit | Flags | Style | Domain (9.4) |
|---|---|---|---|---|---|---|---|---|---|---|
| 90 | GET | `/projects/:id/clips/:clipId/file` | route.ts:1726 | `clipService.getClipDownloadUrl` | `clipDownloadQuerySchema` | browser-session: `content.download`, project(id) |  | redirect | plain Hono | D3 |

### Inventory 3.2 row 150

| # | Method | Path (under `/api`) | Source | Handler calls | Handler-level validation | Policy (cap / admission / input) | Rate limit | Flags | Style | Domain (9.4) |
|---|---|---|---|---|---|---|---|---|---|---|
| 150 | POST | `/projects/:id/clips/regenerate` | clip-generation-http.ts:11 | `clipService.regenerateClips` | `type RegenerateClipsRequest` | browser-session: `processing.consume`, project(id); idempotentBodyInput(regenerateClipsRequestSchema, ["id"]); idempotency-key header | actor `regenerate` 20/60s | idempotency-key header | plain Hono | D3 |

## Acceptance criteria

- [x] Every D3 route except four editor adapter registrations moves with exact admission/rate/input/error parity; clip-generation sibling and tests move too.
- [x] Campaign fingerprint/retry-of/native rendering keys retained; duplicate/range creates receive atomic receipts, not response caches.
- [x] Clip/campaign/thumbnail DTO/client types are inferred from returned chains and errors preserve revision/recovery facts.
- [x] Thumbnail subprocess concurrency is bounded; expensive title/render/generation limits unchanged.
- [ ] No unowned files changed; paired review findings and verification evidence recorded under Comments.

## Verification

Run these from the repository root after dependencies are installed. A command naming a new package script is implemented by the owning setup ticket, not silently skipped. PostgreSQL gates need a disposable schema; a skipped DB suite does not satisfy its gate. During the undeployed integration sequence, record any unrelated transitional compile failure with its owning blocker; this ticket's behavior tests must pass and the final integrated gates cannot be waived.

```sh
bun test apps/api/src/domains/clips
bun run test:vizard-expansion:db
bun run test:processing-usage:db
bun run --cwd apps/api typecheck
```

## Comments

Claimed and implemented by Claude (Sonnet 5.5), 2026-10-29. Paired review not run by the implementer (last acceptance box left open for the orchestrator).

### What changed
- API: `apps/api/src/domains/clips/{admission,routes,runtime}.ts` register through `createRouteApp`. Added `POST /projects/:id/clips/regenerate` (moved from `clip-generation-http.ts`; `requireIdempotencyKey` + `regenerateClipsRequestSchema`, actor `regenerate` 20/60 kept). Web `clip-generation-http.ts` and its test deleted; the adapter test moved to `routes.test.ts` (18 tests).
- Duplicate and create-from-range are receipt commands (`duplicate_clip`, `create_clip_from_range` in `clips-receipt-commands.ts`; `clips-commands.ts` + `-runtime.ts`). `Idempotency-Key` is required; the rows and the Operation Receipt commit in one transaction (`ClipService` takes an optional `ClipCreationAcceptance`; without it behaviour is unchanged). Order: authorize, replay lookup (`Idempotent-Replayed: true`, changed input -> 409 `operation_idempotency_conflict`), then the recorded limiter (`deferRateRefusal` + `enforceRecordedRateLimit` in `beforeAccept`, so 429 / 503 `mutations_unavailable` hit new work only, before any R2 copy), then copy + commit. A concurrent same-key request that loses the race releases its copied media (`ClipCreationReplayed`) and returns the accepted clip.
- Campaign fingerprint / `retryOfId` / render and generation admission keys untouched (`campaign-operation.service.ts` needed no change; header key and `Campaign-Retry-Of` still map once into the native fields).
- Thumbnail extraction (`thumbnail-frame-preparation-runtime.ts`): process-wide gate, `THUMBNAIL_EXTRACTION_CONCURRENCY` (default 2, max 4) around FFmpeg + sharp. The API only enqueues; extraction runs wherever `processPending` runs (the worker loop), so the gate bounds that process.
- `clip.service.ts` imports `isClipPreviewPeaks`/`ClipPreviewPeaks` from `@narriflow/validators/clip-preview-peaks` (ticket 04 request; 13 already removed the copy in `clip-preview-storage.ts`).
- Client: `packages/api-client/src/clips/{queries,mutations,index}.ts` (queryOptions factories for list, previews, download grant, peaks, campaign operations, action catalog, thumbnail frame; commands with intent keys and retry-of; invalidation helpers) + `clips.test.ts`. `packages/validators/src/api/clips.ts` gathers the route input schemas.

### Deviations from the inventory/spec (deliberate)
- `GET /projects/:id/clips/:clipId/file` (302 redirect) is deleted, not converted: `GET .../download` already returns the identical JSON Download Grant from the same service call. Ticket 12 (owner of `apps/web/lib/clip-media.ts` `clipFileDownloadPath`, `clip-row.tsx`) must use `clipQueries.downloadGrant` / `/download` and navigate to `downloadUrl`.
- `preview-peaks` no longer sets `Cache-Control: private, max-age=3600, immutable` (ticket 04 left it to 13, but the route is in this domain): the URL does not name the preview attempt, so a browser-cached artifact would outlive a regenerated proxy; default `no-store` applies and React Query dedupes.
- `create-from-selection` stays without a receipt (spec names only duplicate and range creates).

### Requests for other owners
- Runner owner of `test:clip-editor-persistence:db` (`packages/services/scripts/run-clip-editor-persistence-db-tests.ts`): add `packages/services/src/clips-commands.db.test.ts` to its file list (I ran it with the file added to a temporary copy of the runner: 3 pass).
- 12: switch `/file` consumers to the download grant (above). 31: delete the `/clips/:clipId/file` row from the baseline `authenticated-request-inventory.ts` with the file.
- Optional: document `THUMBNAIL_EXTRACTION_CONCURRENCY` in `apps/api/.env.example` / worker env example (not my files).

### Evidence
- `bun test apps/api/src/domains/clips` 18 pass; `bun test packages/api-client/src/clips` 4 pass; `bun test packages/services/src/clips-commands.test.ts` 10 pass (atomic receipt, replay before work/limiter, conflict, rollback, simultaneous same key, lost commit response); `thumbnail-frame-preparation-runtime.test.ts` + existing thumbnail/campaign/clip unit tests pass.
- `db-gate.sh bun run test:workflow:db`: 175 pass, 0 fail. `db-gate.sh bun run test:library-search:db` (range creates): 23 pass. `test:clip-editor-persistence:db` (duplicate media, with `clips-commands.db.test.ts` added to a temp runner copy): 28 + 7 + 3 pass.
- `db-gate.sh bun run test:vizard-expansion:db` (second run): generation-usage 17, review-access 4, workspace-membership 3 pass; the vizard-expansion/autopilot/zoom process has 67 pass, 2 FAIL (`revokes replayed guest sessions...` and `allocates concurrent review revisions...`: `reviews-commands.ts` throws `idempotency_key_required` for the review service calls those tests make), which are ticket 27's in-progress files, not clips. The first run had 3 `review-access.db.test.ts` 5 s timeouts under load average ~30 that passed on rerun. `test:processing-usage:db` not run: the clips path does not touch it.
- `bunx biome check` on all my paths clean. `tsc` clean for packages/services and packages/validators; `apps/api` and `packages/api-client` have no error in a clips file (remaining errors are other domains: rest/routes.ts, reviews/guest-replay-child.ts, studio/bootstrap.ts, workspace/routes.ts, brand/queries.ts).
- `bun run --cwd apps/api test:inventory`: 250 routes, 0 problems. `apps/api/src/route-inventory.test.ts` (hard-coded 108 count) and `admission-tables.test.ts` (`GET /social/accounts` capability) currently fail from other tickets' additions, not from this one.

