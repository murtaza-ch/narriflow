# 11. Move clip and campaign controls

**What to build:** Clip/campaign/thumbnail HTTP controls use the admitted actor and current native command guards; new duplicate/range creates have durable replay.

**Blocked by:** [04 - Wire API runtime and partition the catch-all](04-wire-api-runtime-and-partition-the-catch-all.md)

**Status:** ready-for-agent

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

- [ ] Every D3 route except four editor adapter registrations moves with exact admission/rate/input/error parity; clip-generation sibling and tests move too.
- [ ] Campaign fingerprint/retry-of/native rendering keys retained; duplicate/range creates receive atomic receipts, not response caches.
- [ ] Clip/campaign/thumbnail DTO/client types are inferred from returned chains and errors preserve revision/recovery facts.
- [ ] Thumbnail subprocess concurrency is bounded; expensive title/render/generation limits unchanged.
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

Append claim, requested seam changes, paired review and evidence here.
