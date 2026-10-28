# 13. Expose Studio bootstrap and persistence

**What to build:** One Studio aggregate and the six inline-action replacements preserve retained asset facts and canonical editor persistence/revisions.

**Blocked by:** [04 - Wire API runtime and partition the catch-all](04-wire-api-runtime-and-partition-the-catch-all.md)

**Status:** done

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

- [x] Four editor HTTP registrations plus Studio aggregate and six inline-action replacements are admitted and typed with correct content.edit/view distinction.
- [x] Canonical document/revision/original, analysis outcomes, retained fonts/assets/source offsets/censor capabilities and missing-provider degradation preserved.
- [x] Save/reset use 120/minute per actor+Workspace+clip plus 300/minute actor ceiling, skipping ordinary 60; existing expensive layout limits preserved.
- [x] Waveform peaks type/guard moves to validators and service reuses it; no service value reaches client.
- [x] Editor stale revisions/reset barriers/write identities remain authoritative and 40-save/minute trace plus bursts is accepted.
- [ ] No unowned files changed; paired review findings and verification evidence recorded under Comments.

## Verification

Run these from the repository root after dependencies are installed. A command naming a new package script is implemented by the owning setup ticket, not silently skipped. PostgreSQL gates need a disposable schema; a skipped DB suite does not satisfy its gate. During the undeployed integration sequence, record any unrelated transitional compile failure with its owning blocker; this ticket's behavior tests must pass and the final integrated gates cannot be waived.

```sh
bun test apps/api/src/domains/studio
bun run test:clip-editor-persistence:db
bun run --cwd apps/api typecheck
```

## Comments

Claimed and implemented by Claude (Sonnet 5.5), 2026-10-29.

### What shipped
- `apps/api/src/domains/studio/{admission,routes,runtime,bootstrap}.ts`: 15 routes through `createRouteApp`. Aggregate `GET .../clips/:clipId/studio`; polls `preview-source`, `layout/auto|split|screen` (payload wrapped as `{analysis}` / `{outcome}`); `editor-assets`, `PUT /projects/:id/censor-terms` (`{terms}` body), `POST .../censor-events`, `GET /projects/:id/auto-censor`, `GET /projects/:id/brand-snapshot` (`{snapshot, brandLogo, audio}`), `GET /generated-images/capability`; PATCH clip, GET/PUT editor, POST editor/reset.
- Capabilities: content.edit for Studio/polls/editor-assets/capability/terms/editor routes (as the page and inline actions did); content.view for auto-censor, brand-snapshot, censor-events (what the services gate on). PUT editor and reset use `tier: "editor"` (120/min per actor+Workspace+clip, 300/min actor ceiling, no ordinary bucket); PATCH stays in the ordinary mutation bucket; polls are ordinary 300/min reads. PATCH and PUT editor are `bodyClass("editor")` (8 MiB); reset is 1 MiB.
- Bootstrap = the page's reads in two overlapping waves (project, clip, preview source, brand snapshot/audio, censor policy, editor document, active assets/fonts first; then retained scene/b-roll/font refs, brand profile fonts, scene templates, source/logo presigns). It reads the single clip with `getClipSnapshot` instead of `listClips` + find. Presign failures stay non-fatal, a missing provider keeps listing existing images, retained deleted refs stay resolvable (`insertable:false`) and active assets override them. Returns `clipInfo`, effective `utterances`, `editor{revision,document,original,layout*}`, `source{videoUrl,previewId,purged}`, `preview`, `brandLogo`, `brandProfileId`, `brandAudio`, `visualAssets`, `sceneFonts`, `fonts`, `sceneTemplates`, `sceneWriteCapabilities`, `generatedImagesCapability`, `autoCensorPolicy`, `plan{pricingTier,scenesRequirement,fontRequirement,canManageBilling}`. The QA fixture stays web-only. Types `StudioBootstrap`/`StudioEditorAssets` are exported through `@narriflow/api/types/studio` and `@narriflow/api-client/studio`.
- `packages/validators/src/api/studio.ts`: `patchClipRequestSchema` (union of the five old schemas, same precedence, output tagged with the persistence intent kind; the studio-edits member requires the `studioEdits` key because every field defaults), censor-terms/event bodies, re-export of save/reset schemas.
- Peaks: service `clip-preview-storage.ts` now re-exports the guard/type from `@narriflow/validators/clip-preview-peaks` (copy deleted; validators test already existed from 04).
- `auto-censor.service.ts`: `recordEvent` now also requires the clip to belong to the project (the clip id is now a URL segment); tests added.
- Deleted from web: `clip-editor-http.ts` and its test (unmounted since 04); their assertions moved into `apps/api/src/domains/studio/routes.test.ts`.

### Error/contract differences to know about
- PATCH with an unsupported body is now the common 400 `invalid_input` with issues (was `unrecognized_clip_update`); malformed clip/project ids are 400 before any service call.
- Layout/preview polls: `{analysis}`/`{outcome}` wrappers instead of a bare nullable value.
- `preview-source.waveformPeaksUrl` is still the service's API-relative path (`/api/projects/:id/clips/:clipId/preview-peaks?v=`). Ticket 14 must prefix `API_ORIGIN` and fetch it with the Bearer transport (an `<img>`/plain fetch cannot carry Authorization). `preview-peaks` keeps `private, max-age=3600, immutable` in the clips domain (11).

### Requests for other owners
- 14: `waveform-peaks.ts` and `timeline.tsx` still import the peaks guard/type through `@narriflow/services`; point them at `@narriflow/validators/clip-preview-peaks`. Build timeline segments from `bootstrap.utterances` with `buildSegmentsFromUtterances`; derive `studioUpgradePrompts(plan.pricingTier, plan.scenesRequirement)` and the `BrandFontsProvider` upgrade from `plan.fontRequirement`/`plan.canManageBilling`.
- 05: Workspace censor words stay on `GET/PUT/DELETE /api/workspace/censor-words` (Studio's workspace-list props call that contract).
- 11: PATCH clip, GET/PUT editor and reset are registered here, not in the clips table; nothing to remove there.

### Evidence
- `bun test apps/api/src/domains/studio` -> 33 pass, 0 fail (admission/401/viewer-403 matrix, bootstrap reads/degradation/retained refs/parallelism, PATCH dispatch, replace/reset, stale-revision 409, editor rate keys, 40 saves + 3 bursts of 10 accepted then 429 at 121 on one clip while another clip is unaffected, 1.6 MB editor body accepted past the limiter vs reset 413).
- `bun test packages/services/src/auto-censor.service.test.ts packages/services/src/clip-preview-storage.test.ts` -> 12 pass.
- `.scratch/api-extraction/db-gate.sh bun run test:clip-editor-persistence:db` -> 7 pass, 0 fail, 0 skipped.
- `bun run --cwd apps/api typecheck`: no errors in studio files; remaining errors are other tickets' in-progress files (brand/aggregates.ts and rest/routes.ts, reviews/guest-replay-child.ts, workspace validators). `bunx biome check` on my paths is clean. `apps/api/src/route-inventory.test.ts` currently fails to load because `inviteTokenParamSchema` is missing from validators (ticket 05 in progress); `admission-tables.test.ts` passes, and my own test proves every declaration is mounted and nothing undeclared is.
- Paired review: not run by this implementer; to be done by the pairing side.
