# 13. Expose Studio bootstrap and persistence

**What to build:** One Studio aggregate and the six inline-action replacements preserve retained asset facts and canonical editor persistence/revisions.

**Blocked by:** [04 - Wire API runtime and partition the catch-all](04-wire-api-runtime-and-partition-the-catch-all.md)

**Status:** ready-for-agent

**Suggested implementer:** Claude. The other pairing side reviews and returns findings to this owner.

Read [spec.md](../spec.md). It is the complete contract; the original brief/plan/reviews are not prerequisites. Claim this ticket before editing.

## Exact ownership

Paths are repo-relative. Every existing file below is exclusively assigned for this phase, including files that only need verification. A new `/**` directory includes its local tests/helpers, not adjacent directories. Read other files as evidence; do not edit them.

Existing files:

- `apps/web/app/api/[[...route]]/clip-editor-http.test.ts`
- `apps/web/app/api/[[...route]]/clip-editor-http.ts`
- `packages/services/src/auto-censor.service.test.ts`
- `packages/services/src/auto-censor.service.ts`
- `packages/services/src/clip-preview-storage.test.ts`
- `packages/services/src/clip-preview-storage.ts`

New files/directories or reserved skeletons handed off by a blocker:

- `apps/api/src/domains/studio/**`
- `apps/api/src/types/studio.ts`
- `packages/api-client/src/studio/**`
- `packages/validators/src/api/studio.ts`
- `packages/validators/src/clip-preview-peaks.ts`

Own editor persistence adapters; 11 owns other clip controls. Use 19 asset service/client contracts without editing Brand files. Workspace censor settings calls use 05 contract, while Project terms remain here.

The chosen new endpoints for this ticket are the matching owner row in spec.md, "Endpoint and screen contracts added by extraction". All current endpoints/actions below retain their semantics unless that row explicitly changes transport. Fill only this domain's receipt-command module; current native receipts remain native.

## Endpoints, actions, pages and refresh sites

Rows retain their section/ordinal or exact source-line identifier from the independent inventory. Abbreviated table filenames are accompanied by the literal ownership manifest and exact source occurrences below. All action/page/fetch/refresh rows in owned files are in scope, including no-refresh callers and media navigation. Baseline observations do not override the spec's selected origins, route style, guest Bearer or new endpoints.

### Inventory 1.6 function `fetchPreviewStatus()`

| File:line | Function | Input | Service / auth calls | Policy helper + capability | Plan check | Returns | Side effects | Client callers | Target endpoint | Domain |
|---|---|---|---|---|---|---|---|---|---|---|
| `studio/page.tsx:224` | `fetchPreviewStatus()` | none (closure `projectId`, `clipId`) | `clipService.getClipPreviewSource` (same call the page SSR makes) | `executeProjectAction(projectId,"content.edit")` | none | preview source `{previewUrl, previewStartSec, previewDurationSec, waveformPeaksUrl, ...}` / failure | none (polling) | `studio-shell.tsx:808` prop, call at :952 via `unwrapStudioActionResult` | `GET /api/projects/:id/clips/:clipId/preview-source` (note existing `GET .../preview-peaks`, route.ts:647) | clips-studio |

### Inventory 1.6 function `fetchAutoLayoutAnalysis()`

| File:line | Function | Input | Service / auth calls | Policy helper + capability | Plan check | Returns | Side effects | Client callers | Target endpoint | Domain |
|---|---|---|---|---|---|---|---|---|---|---|
| `:237` | `fetchAutoLayoutAnalysis()` | none | `clipService.getClipAutoLayoutAnalysis` | same | none | `ClipAutoLayoutAnalysis \| null` / failure | none (polling) | `studio-shell.tsx:817`, call :958 | `GET /api/projects/:id/clips/:clipId/layout/auto` | clips-studio |

### Inventory 1.6 function `fetchSplitLayoutAnalysis()`

| File:line | Function | Input | Service / auth calls | Policy helper + capability | Plan check | Returns | Side effects | Client callers | Target endpoint | Domain |
|---|---|---|---|---|---|---|---|---|---|---|
| `:244` | `fetchSplitLayoutAnalysis()` | none | `clipService.getClipSplitLayoutOutcome` | same | none | `ClipSplitLayoutOutcome \| null` / failure | none (polling) | `studio-shell.tsx:818`, call :1081 (guard :1069) | `GET /api/projects/:id/clips/:clipId/layout/split` | clips-studio |

### Inventory 1.6 function `fetchScreenLayoutAnalysis()`

| File:line | Function | Input | Service / auth calls | Policy helper + capability | Plan check | Returns | Side effects | Client callers | Target endpoint | Domain |
|---|---|---|---|---|---|---|---|---|---|---|
| `:251` | `fetchScreenLayoutAnalysis()` | none | `clipService.getClipLayoutAnalysisOutcome` | same | none | `ClipLayoutAnalysisOutcome \| null` / failure | none (polling) | `studio-shell.tsx:819`, call :1026 (guard :1014) | `GET /api/projects/:id/clips/:clipId/layout/screen` | clips-studio |

### Inventory 1.6 function `updateProjectCensorTerms(terms: string[])`

| File:line | Function | Input | Service / auth calls | Policy helper + capability | Plan check | Returns | Side effects | Client callers | Target endpoint | Domain |
|---|---|---|---|---|---|---|---|---|---|---|
| `:258` | `updateProjectCensorTerms(terms: string[])` | `string[]` (validated in service) | `autoCensorService.replaceProjectTerms(actor, projectId, terms)` | `executeProjectAction(projectId,"content.edit")` | none | `{terms}` / failure | none | `studio/_components/tool-panels/censor-panel.tsx:317` (prop type `studio-shell.tsx:710`) | `PUT /api/projects/:id/censor-terms` | clips-studio |

### Inventory 1.6 function `recordAutoCensorEvent(input: AutoCensorAnalyticsInput)`

| File:line | Function | Input | Service / auth calls | Policy helper + capability | Plan check | Returns | Side effects | Client callers | Target endpoint | Domain |
|---|---|---|---|---|---|---|---|---|---|---|
| `:265` | `recordAutoCensorEvent(input: AutoCensorAnalyticsInput)` | `AutoCensorAnalyticsInput` (validated in service) | `autoCensorService.recordEvent(actor, projectId, clipId, input)` | `executeProjectAction(projectId,"content.view")` | none | `{recorded:true}` / failure | none | `censor-panel.tsx:98` (fire-and-forget `recordEventBestEffort`), prop `studio-shell.tsx:714` | `POST /api/projects/:id/clips/:clipId/censor-events` (best effort; client swallows errors) | clips-studio |

### Inventory 3.2 row 146

| # | Method | Path (under `/api`) | Source | Handler calls | Handler-level validation | Policy (cap / admission / input) | Rate limit | Flags | Style | Domain (9.4) |
|---|---|---|---|---|---|---|---|---|---|---|
| 146 | PATCH | `/projects/:id/clips/:clipId` | clip-editor-http.ts:94 | `clipService.updateClipTitle`, `clipEditorDocumentPersistence.mutateDocument` | `updateClipTitleSchema`, `updateClipBoundariesSchema`, `updateClipCaptionPresetSchema`, `updateClipTranscriptSliceSchema`, `updateClipBrollSchema`, `updateClipStudioEditsSchema` | browser-session: `content.edit`, project(id) |  |  | plain Hono | D3 |

### Inventory 3.2 row 147

| # | Method | Path (under `/api`) | Source | Handler calls | Handler-level validation | Policy (cap / admission / input) | Rate limit | Flags | Style | Domain (9.4) |
|---|---|---|---|---|---|---|---|---|---|---|
| 147 | GET | `/projects/:id/clips/:clipId/editor` | clip-editor-http.ts:214 | `clipService.getClipEditorDocument` |  | browser-session: `content.edit`, project(id) |  |  | plain Hono | D3 |

### Inventory 3.2 row 148

| # | Method | Path (under `/api`) | Source | Handler calls | Handler-level validation | Policy (cap / admission / input) | Rate limit | Flags | Style | Domain (9.4) |
|---|---|---|---|---|---|---|---|---|---|---|
| 148 | PUT | `/projects/:id/clips/:clipId/editor` | clip-editor-http.ts:226 | `clipService.getClipEditorDocument`, `analyzeSceneDocumentMutation`, `clipEditorDocumentPersistence.mutateDocument`, `visualAssetService.recordGeneratedInsertionsBestEffort` | `saveEditorDocumentSchema` | browser-session: `content.edit`, project(id) |  |  | plain Hono | D3 |

### Inventory 3.2 row 149

| # | Method | Path (under `/api`) | Source | Handler calls | Handler-level validation | Policy (cap / admission / input) | Rate limit | Flags | Style | Domain (9.4) |
|---|---|---|---|---|---|---|---|---|---|---|
| 149 | POST | `/projects/:id/clips/:clipId/editor/reset` | clip-editor-http.ts:280 | `clipEditorDocumentPersistence.mutateDocument` | `resetEditorDocumentSchema` | browser-session: `content.edit`, project(id) |  |  | plain Hono | D3 |

## Acceptance criteria

- [ ] Four editor HTTP registrations plus Studio aggregate and six inline-action replacements are admitted and typed with correct content.edit/view distinction.
- [ ] Canonical document/revision/original, analysis outcomes, retained fonts/assets/source offsets/censor capabilities and missing-provider degradation preserved.
- [ ] Save/reset use 120/minute per actor+Workspace+clip plus 300/minute actor ceiling, skipping ordinary 60; existing expensive layout limits preserved.
- [ ] Waveform peaks type/guard moves to validators and service reuses it; no service value reaches client.
- [ ] Editor stale revisions/reset barriers/write identities remain authoritative and 40-save/minute trace plus bursts is accepted.
- [ ] No unowned files changed; paired review findings and verification evidence recorded under Comments.

## Verification

Run these from the repository root after dependencies are installed. A command naming a new package script is implemented by the owning setup ticket, not silently skipped. PostgreSQL gates need a disposable schema; a skipped DB suite does not satisfy its gate. During the undeployed integration sequence, record any unrelated transitional compile failure with its owning blocker; this ticket's behavior tests must pass and the final integrated gates cannot be waived.

```sh
bun test apps/api/src/domains/studio
bun run test:clip-editor-persistence:db
bun run --cwd apps/api typecheck
```

## Comments

Append claim, requested seam changes, paired review and evidence here.
