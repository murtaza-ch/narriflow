# 14. Convert Studio transport without changing session ownership

**What to build:** Studio gets its data and transport through api-client while the existing Editing Session retains drafts, history, ownership and cloud convergence.

**Blocked by:** [13 - Expose Studio bootstrap and persistence](13-expose-studio-bootstrap-and-persistence.md), [05 - Expose session and Workspace controls](05-expose-session-and-workspace-controls.md), [11 - Move clip and campaign controls](11-move-clip-and-campaign-controls.md), [19 - Move Brand Kit and media controls](19-move-brand-kit-and-media-controls.md), [07 - Move billing API and convert billing UI](07-move-billing-api-and-convert-billing-ui.md)

**Status:** ready-for-agent

**Suggested implementer:** Claude. The other pairing side reviews and returns findings to this owner.

Read [spec.md](../spec.md). It is the complete contract; the original brief/plan/reviews are not prerequisites. Claim this ticket before editing.

## Exact ownership

Paths are repo-relative. Every existing file below is exclusively assigned for this phase, including files that only need verification. A new `/**` directory includes its local tests/helpers, not adjacent directories. Read other files as evidence; do not edit them.

Existing files:

- `apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/auto-censor-review-drawer.tsx`
- `apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/auto-censor-review-model.test.ts`
- `apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/auto-censor-review-model.ts`
- `apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/auto-layout-preview.test.ts`
- `apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/auto-layout-preview.ts`
- `apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/broll-preview.test.ts`
- `apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/broll-preview.ts`
- `apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/caption-style-engine.test.ts`
- `apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/caption-style-engine.tsx`
- `apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/censor-beep-preview-track.tsx`
- `apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/composition-plan-qa-fixture.test.ts`
- `apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/composition-plan-qa-fixture.ts`
- `apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/composition-preview-adapter.test.ts`
- `apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/composition-preview-adapter.ts`
- `apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/draft-recovery-dialog.tsx`
- `apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/edited-timeline.test.ts`
- `apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/edited-timeline.ts`
- `apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/interactive-caption-overlay.tsx`
- `apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/interactive-speaker-layer.tsx`
- `apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/interactive-text-layer.tsx`
- `apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/keyboard-shortcuts-modal.tsx`
- `apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/local-editor-draft.test.ts`
- `apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/local-editor-draft.ts`
- `apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/normalized-crop.ts`
- `apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/playback-clock.ts`
- `apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/preview-audio-asset-resolution.test.ts`
- `apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/preview-audio-asset-resolution.ts`
- `apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/reset-confirm-dialog.tsx`
- `apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/ripple-playback.test.ts`
- `apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/ripple-playback.ts`
- `apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/save-issue-panel.tsx`
- `apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/save-issue.test.tsx`
- `apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/save-issue.ts`
- `apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/scene-fonts.test.ts`
- `apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/scene-fonts.ts`
- `apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/sfx-preview-track.tsx`
- `apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/snap-guides.ts`
- `apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/split-secondary-tile.tsx`
- `apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/studio-access.test.ts`
- `apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/studio-access.ts`
- `apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/studio-dead-ends.test.tsx`
- `apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/studio-editing-session-browser.test.ts`
- `apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/studio-editing-session-browser.ts`
- `apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/studio-editing-session-cloud.test.ts`
- `apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/studio-editing-session-durability.test.ts`
- `apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/studio-editing-session-lifecycle-browser.test.ts`
- `apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/studio-editing-session-lifecycle-browser.ts`
- `apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/studio-editing-session-media-browser.test.ts`
- `apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/studio-editing-session-media-browser.ts`
- `apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/studio-editing-session-playback.test.ts`
- `apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/studio-editing-session-preview.test.ts`
- `apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/studio-editing-session-react.test.ts`
- `apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/studio-editing-session-react.ts`
- `apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/studio-editing-session.test.ts`
- `apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/studio-editing-session.ts`
- `apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/studio-export-menu.tsx`
- `apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/studio-export-policy.test.ts`
- `apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/studio-export-policy.ts`
- `apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/studio-lock-gem.tsx`
- `apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/studio-shell.tsx`
- `apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/studio-types.ts`
- `apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/studio-upgrade.test.tsx`
- `apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/studio-upgrade.ts`
- `apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/subtitle-lines.test.ts`
- `apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/subtitle-lines.ts`
- `apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/timeline-preview-manager.test.ts`
- `apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/timeline-preview-manager.ts`
- `apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/timeline.tsx`
- `apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/tool-panels/audio-library-filter.test.ts`
- `apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/tool-panels/audio-library-filter.ts`
- `apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/tool-panels/audio-library.ts`
- `apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/tool-panels/audio-panels.browser.fixture.tsx`
- `apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/tool-panels/audio-panels.test.ts`
- `apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/tool-panels/audio-upload.ts`
- `apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/tool-panels/brand-template-panel.tsx`
- `apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/tool-panels/broll-panel.tsx`
- `apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/tool-panels/caption-presets.prototype.html`
- `apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/tool-panels/captions-panel.tsx`
- `apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/tool-panels/censor-panel.tsx`
- `apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/tool-panels/framing-preset-thumbnails.tsx`
- `apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/tool-panels/generated-images-browser.test.ts`
- `apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/tool-panels/generated-images-browser.ts`
- `apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/tool-panels/generated-images-panel.tsx`
- `apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/tool-panels/layout-panel-model.test.ts`
- `apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/tool-panels/layout-panel-model.ts`
- `apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/tool-panels/layout-panel.tsx`
- `apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/tool-panels/music-panel.tsx`
- `apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/tool-panels/music-tab.tsx`
- `apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/tool-panels/panel-ui.tsx`
- `apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/tool-panels/preset-card.tsx`
- `apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/tool-panels/scenes-panel.tsx`
- `apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/tool-panels/sfx-tab.tsx`
- `apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/tool-panels/text-panel.tsx`
- `apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/tool-panels/transitions-panel.tsx`
- `apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/tool-panels/uploads-tab.tsx`
- `apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/tool-sidebar.tsx`
- `apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/top-bar.tsx`
- `apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/transcript-highlight.test.ts`
- `apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/transcript-highlight.ts`
- `apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/transcript-panel.tsx`
- `apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/transcript-selection.test.ts`
- `apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/transcript-selection.ts`
- `apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/trim-control.test.ts`
- `apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/trim-control.ts`
- `apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/trim-transcript-cache.ts`
- `apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/unified-editor-history.ts`
- `apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/use-current-caption.test.ts`
- `apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/use-current-caption.ts`
- `apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/use-is-mac.ts`
- `apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/video-preview.tsx`
- `apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/waveform-peaks.test.ts`
- `apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/waveform-peaks.ts`
- `apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/word-chips.test.ts`
- `apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/word-chips.ts`
- `apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/error.tsx`
- `apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/layout.tsx`
- `apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/loading.tsx`
- `apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/page.tsx`

New files/directories or reserved skeletons handed off by a blocker:

- Add tests beside the owned implementation only; no new cross-domain directory.

The long Studio directory is ownership, not a request to refactor every file. Change data bootstrap, transport injection and API call sites; keep session algorithm/state intact. Audio helpers imported by Brand Kit keep their exported interfaces.

Consume the endpoint contracts owned by 13. API changes belong to those owners; this ticket owns caller conversion and cache effects.

## Endpoints, actions, pages and refresh sites

Rows retain their section/ordinal or exact source-line identifier from the independent inventory. Abbreviated table filenames are accompanied by the literal ownership manifest and exact source occurrences below. All action/page/fetch/refresh rows in owned files are in scope, including no-refresh callers and media navigation. Baseline observations do not override the spec's selected origins, route style, guest Bearer or new endpoints.

### Inventory 2.A page/type row at inventory line 213

| File (lines) | Data loaded (line) | Gate | Redirect / notFound | Props to client components | Proposed GET |
| --- | --- | --- | --- | --- | --- |
| `app/(app)/projects/[projectId]/clips/[clipId]/studio/layout.tsx` (25) | none (`"use client"`) | inherited | none | n/a | none |

### Inventory 2.B page/type row at inventory line 231

| File (lines) | Gate (line) | Service / db / validators calls (line) | Params / searchParams | Redirect / notFound | Props to client components | Proposed GET endpoint(s) |
| --- | --- | --- | --- | --- | --- | --- |
| `app/(app)/projects/[projectId]/clips/[clipId]/studio/page.tsx` (327) | `admitProjectPage(projectId,"content.edit")` L40 | L46-57: `projectService.getProjectSnapshot`, `clipService.listClips`, `clipService.getClipPreviewSource`, `projectService.getProjectBrandSnapshot`, `projectService.getProjectBrandAudio`; L61 `autoCensorService.getPolicy`; L91-122: `presignDownloadUrl` (source video, 3600s), `clipService.getClipEditorDocument`, `presignDownloadUrl` (brand logo), `visualAssetService.list`, `sceneTemplateService.list`, `brandProfileService.get`; L123-129 `visualAssetService.resolveSceneReferences`, `resolveVisualBrollReferences`, `brandFontService.resolveSceneReferences`; L179-181 `brandFontService.list`, `brandFontService.resolveReferences`; `generatedImageCapability(appUser)` L68, `brandPlanRequirement`, `planFeatureRequirement`, `hasFeature`; pure: `getEffectiveClipTiming`, `compositionAssetRef` | params `projectId, clipId`; `searchParams.qaCompositionPlan` (dev-only fixture via `process.env.NODE_ENV`) | `notFound()` L59 (no project) and L80 (clip not in project) | `BrandFontsProvider{fonts,requirement,upgrade}`, `StudioShell{clipInfo,timelineSegments,initialEditorDocument,initialEditorRevision,initialEditorOriginal,sourceVideoUrl,sourcePreviewId,clipStartSec,clipEndSec,previewVideoUrl,previewStartSec,previewDurationSec,waveformPeaksUrl,sourcePurged,fetchPreviewStatus,fetchAutoLayoutAnalysis,fetchSplitLayoutAnalysis,fetchScreenLayoutAnalysis,brandLogo,layoutAnalysis,autoLayoutAnalysis,splitLayoutAnalysis,splitLayoutFailure,layoutAnalysisFailure,compositionPlanQaFixture,visualAssets,brandProfileId,brandAudio,sceneFonts,sceneTemplates,sceneWriteCapabilities,generatedImagesCapability,autoCensorPolicy,upgradePrompts,updateProjectCensorTerms,replaceWorkspaceCensorWords,resetWorkspaceCensorWords,recordAutoCensorEvent}`. **Six inline `"use server"` closures** at L224, 237, 244, 251, 258, 265 (`fetchPreviewStatus`, `fetchAutoLayoutAnalysis`, `fetchSplitLayoutAnalysis`, `fetchScreenLayoutAnalysis`, `updateProjectCensorTerms`, `recordAutoCensorEvent`) each wrapping `executeProjectAction(projectId, "content.edit"\|"content.view", ...)`; plus imported `replaceCensorWordsAction`/`resetCensorWordsAction` from `settings/workspace/censor-words-actions.ts` | Existing: `GET /api/projects/:id`, `GET /api/projects/:id/clips`, `GET /api/projects/:id/clips/:clipId/editor` (clip-editor-http L214, returns `{document,revision,original,layoutAnalysis,autoLayoutAnalysis,splitLayoutAnalysis,...}`), `GET /api/visual-assets`, `GET /api/brand-profiles/:id`, `GET /api/brand-profiles/:id/scene-templates`, `GET /api/brand-fonts`, `GET /api/projects/:id/generated-media/jobs` (carries `usage`), `GET /api/projects/:id/clips/:clipId/preview-peaks`. **NEW**: `GET /api/projects/:id/clips/:clipId/preview-source` (replaces `fetchPreviewStatus`, polled), `.../auto-layout-analysis`, `.../split-layout-outcome`, `.../layout-analysis-outcome` (replace the three polling actions), `GET /api/projects/:id/brand-snapshot` (snapshot + presigned logo + audio, replaces `getProjectBrandSnapshot`/`getProjectBrandAudio`/logo presign), `GET /api/projects/:id/source-url`, `GET /api/projects/:id/auto-censor` (policy; mutations are the other fork's), `POST /api/brand-fonts/resolve` or `GET /api/projects/:id/clips/:clipId/editor-assets` (retained scene/b-roll visual assets and fonts: `resolve*References`), `GET /api/generated-images/capability`. `qaCompositionPlan` fixture stays web-side. Biggest page: needs one aggregate client query keyed on `[project, clip]` plus polling queries. |

### Inventory 2.D page/type row at inventory line 292

| Client file | Types |
| --- | --- |
| `.../studio/_components/studio-shell.tsx` | `GeneratedImageCapability` |

### Inventory 2.D page/type row at inventory line 293

| Client file | Types |
| --- | --- |
| `.../studio/_components/timeline.tsx` | `ClipPreviewPeaks` |

### Inventory 2.D page/type row at inventory line 294

| Client file | Types |
| --- | --- |
| `.../studio/_components/tool-panels/audio-library.ts` | `AudioAssetListRow` |

### Inventory 2.D page/type row at inventory line 295

| Client file | Types |
| --- | --- |
| `.../studio/_components/tool-panels/generated-images-panel.tsx` | `GeneratedImageUsageSummary` |

### Inventory 5.3 refresh/fetch row at inventory line 746

| file:line | Trigger | Call | Notes |
| --- | --- | --- | --- |
| `studio-editing-session-browser.ts:453` | Session open | `GET /api/projects/:p/clips/:c/editor` | Loads editor doc + revision |

### Inventory 5.3 refresh/fetch row at inventory line 747

| file:line | Trigger | Call | Notes |
| --- | --- | --- | --- |
| `...:466` | Autosave | `PUT .../editor` `{baseRevision, document}` | 409 revision conflict handling |

### Inventory 5.3 refresh/fetch row at inventory line 748

| file:line | Trigger | Call | Notes |
| --- | --- | --- | --- |
| `...:481` | "Reset to original" | `POST .../editor/reset` | Followed by `window.location.reload()` (`studio-shell.tsx:2004`) |

### Inventory 5.3 refresh/fetch row at inventory line 749

| file:line | Trigger | Call | Notes |
| --- | --- | --- | --- |
| `...:502` | Page unload | `PUT .../editor` with `keepalive: true` | Replaces `sendBeacon`; must still work with a Bearer header cross-origin |

### Inventory 5.3 refresh/fetch row at inventory line 750

| file:line | Trigger | Call | Notes |
| --- | --- | --- | --- |
| `studio-shell.tsx:1930` | Export | `POST .../clips/:c/exports` (idempotency-key) then `router.push(.../exports/:id)` (:1960) | No refresh |

### Inventory 5.3 refresh/fetch row at inventory line 751

| file:line | Trigger | Call | Notes |
| --- | --- | --- | --- |
| `studio-shell.tsx:949-1123` | Mount + interval | Calls prop closures `fetchPreviewStatus`, `fetchAutoLayoutAnalysis`, `fetchScreenLayoutAnalysis`, `fetchSplitLayoutAnalysis` (inline `"use server"` in `studio/page.tsx:225-259`) | Polling loops, no router |

### Inventory 5.3 refresh/fetch row at inventory line 752

| file:line | Trigger | Call | Notes |
| --- | --- | --- | --- |
| `transcript-panel.tsx:1227` | "Create clip from selection" | `POST .../clips/:c/create-from-selection` | Toast "Open" -> `router.push(studio)` |

### Inventory 5.3 refresh/fetch row at inventory line 758

| file:line | Trigger | Call | Notes |
| --- | --- | --- | --- |
| `video-preview.tsx:1418,1459` | Preview audio | `GET /api/audio-assets/:id/playback-url` | Local |

### Inventory 5.3 refresh/fetch row at inventory line 759

| file:line | Trigger | Call | Notes |
| --- | --- | --- | --- |
| `tool-panels/uploads-tab.tsx:105` | Delete upload | `DELETE /api/audio-assets/:id` | Local |

### Inventory 5.3 refresh/fetch row at inventory line 760

| file:line | Trigger | Call | Notes |
| --- | --- | --- | --- |
| `tool-panels/audio-upload.ts:69,84,91` | Upload audio | `POST /api/audio-assets/presign-upload`, `PUT` presigned URL, `POST /api/audio-assets` (finalize) | Local |

### Inventory 5.3 refresh/fetch row at inventory line 761

| file:line | Trigger | Call | Notes |
| --- | --- | --- | --- |
| `tool-panels/generated-images-browser.ts:14-30` (`request` wrapper) | Generated media | `GET|POST .../generated-media/jobs?clipId=`, `POST .../jobs`, `POST .../jobs/:id/cancel`, `DELETE .../jobs/:id/result` | `generated-images-panel.tsx:207,215` polls every 2.5 s |

### Inventory 5.3 refresh/fetch row at inventory line 762

| file:line | Trigger | Call | Notes |
| --- | --- | --- | --- |
| `tool-panels/generated-images-panel.tsx:344` | Brand membership | `PUT /api/brand-profiles/:id/membership` | Local |

### Inventory 5.3 refresh/fetch row at inventory line 763

| file:line | Trigger | Call | Notes |
| --- | --- | --- | --- |
| `tool-panels/censor-panel.tsx:97,309-317` | Censor tool | `recordAutoCensorEvent`, `replaceWorkspaceCensorWords`, `resetWorkspaceCensorWords`, `updateProjectCensorTerms` (server actions passed as props from `studio/page.tsx:322-324`) | Local |

### Inventory 5.3 refresh/fetch row at inventory line 764

| file:line | Trigger | Call | Notes |
| --- | --- | --- | --- |
| `waveform-peaks.ts:51` | Waveform | `fetch(waveformPeaksUrl, {credentials:"same-origin"})`, a URL produced by the server page | Cookie-credentialed; breaks cross-origin unless the URL is signed |

### Inventory 5 exact file occurrences: apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/studio-editing-session-browser.ts

```text
453: const response = await fetch(editorUrl, { cache: "no-store" });
466: const response = await fetch(editorUrl, {
481: const response = await fetch(`${editorUrl}/reset`, {
501: keepalive: ({ baseRevision, document }) => {
502: void fetch(editorUrl, {
506: keepalive: true,
```

### Inventory 5 exact file occurrences: apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/studio-editing-session-cloud.test.ts

```text
179: keepalive: StudioSessionDependencies["cloud"]["keepalive"] = (input) => {
```

### Inventory 5 exact file occurrences: apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/studio-shell.tsx

```text
1930: const response = await fetch(
2004: window.location.reload();
```

### Inventory 5 exact file occurrences: apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/tool-panels/audio-library.ts

```text
56: const response = await fetch(`/api/audio-assets?${params.toString()}`);
110: const response = await fetch(`/api/audio-assets/${assetId}/favorite`, {
125: const response = await fetch(`/api/audio-assets/${assetId}/playback-url`);
```

### Inventory 5 exact file occurrences: apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/tool-panels/audio-upload.ts

```text
69: const presignRes = await fetch("/api/audio-assets/presign-upload", {
84: const putRes = await fetch(uploadUrl, {
91: const finalizeRes = await fetch("/api/audio-assets", {
```

### Inventory 5 exact file occurrences: apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/tool-panels/brand-template-panel.tsx

```text
317: const response = await fetch("/api/brand-templates");
```

### Inventory 5 exact file occurrences: apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/tool-panels/broll-panel.tsx

```text
111: const res = await fetch(
```

### Inventory 5 exact file occurrences: apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/tool-panels/captions-panel.tsx

```text
721: const res = await fetch(
```

### Inventory 5 exact file occurrences: apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/tool-panels/generated-images-panel.tsx

```text
344: const response = await fetch(`/api/brand-profiles/${brandProfileId}/membership`, {
```

### Inventory 5 exact file occurrences: apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/tool-panels/transitions-panel.tsx

```text
294: const response = await fetch(`/api/projects/${clipInfo.projectId}/clips/apply-studio-edits`, {
```

### Inventory 5 exact file occurrences: apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/tool-panels/uploads-tab.tsx

```text
105: const res = await fetch(`/api/audio-assets/${asset.id}`, { method: "DELETE" });
```

### Inventory 5 exact file occurrences: apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/transcript-panel.tsx

```text
1227: const response = await fetch(
```

### Inventory 5 exact file occurrences: apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/trim-transcript-cache.ts

```text
68: pending = fetch(`/api/projects/${projectId}/transcript/utterances`)
```

### Inventory 5 exact file occurrences: apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/video-preview.tsx

```text
1418: fetch(`/api/audio-assets/${assetId}/playback-url`)
1459: const res = await fetch(`/api/audio-assets/${id}/playback-url`);
```

### Inventory 5 exact file occurrences: apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/waveform-peaks.ts

```text
51: const request = fetch(url, { credentials: "same-origin" })
```

Also account for the inventory's cross-domain traps: query-only actions, action forms that relied on revalidatePath, signed downloads/media, OAuth anchors, all three EventSource consumers and unload keepalive. Only the literal files above may be changed by this ticket.

### Inventory 1.6 function `fetchPreviewStatus()`, caller conversion

| File:line | Function | Input | Service / auth calls | Policy helper + capability | Plan check | Returns | Side effects | Client callers | Target endpoint | Domain |
|---|---|---|---|---|---|---|---|---|---|---|
| `studio/page.tsx:224` | `fetchPreviewStatus()` | none (closure `projectId`, `clipId`) | `clipService.getClipPreviewSource` (same call the page SSR makes) | `executeProjectAction(projectId,"content.edit")` | none | preview source `{previewUrl, previewStartSec, previewDurationSec, waveformPeaksUrl, ...}` / failure | none (polling) | `studio-shell.tsx:808` prop, call at :952 via `unwrapStudioActionResult` | `GET /api/projects/:id/clips/:clipId/preview-source` (note existing `GET .../preview-peaks`, route.ts:647) | clips-studio |

### Inventory 1.6 function `fetchAutoLayoutAnalysis()`, caller conversion

| File:line | Function | Input | Service / auth calls | Policy helper + capability | Plan check | Returns | Side effects | Client callers | Target endpoint | Domain |
|---|---|---|---|---|---|---|---|---|---|---|
| `:237` | `fetchAutoLayoutAnalysis()` | none | `clipService.getClipAutoLayoutAnalysis` | same | none | `ClipAutoLayoutAnalysis \| null` / failure | none (polling) | `studio-shell.tsx:817`, call :958 | `GET /api/projects/:id/clips/:clipId/layout/auto` | clips-studio |

### Inventory 1.6 function `fetchSplitLayoutAnalysis()`, caller conversion

| File:line | Function | Input | Service / auth calls | Policy helper + capability | Plan check | Returns | Side effects | Client callers | Target endpoint | Domain |
|---|---|---|---|---|---|---|---|---|---|---|
| `:244` | `fetchSplitLayoutAnalysis()` | none | `clipService.getClipSplitLayoutOutcome` | same | none | `ClipSplitLayoutOutcome \| null` / failure | none (polling) | `studio-shell.tsx:818`, call :1081 (guard :1069) | `GET /api/projects/:id/clips/:clipId/layout/split` | clips-studio |

### Inventory 1.6 function `fetchScreenLayoutAnalysis()`, caller conversion

| File:line | Function | Input | Service / auth calls | Policy helper + capability | Plan check | Returns | Side effects | Client callers | Target endpoint | Domain |
|---|---|---|---|---|---|---|---|---|---|---|
| `:251` | `fetchScreenLayoutAnalysis()` | none | `clipService.getClipLayoutAnalysisOutcome` | same | none | `ClipLayoutAnalysisOutcome \| null` / failure | none (polling) | `studio-shell.tsx:819`, call :1026 (guard :1014) | `GET /api/projects/:id/clips/:clipId/layout/screen` | clips-studio |

### Inventory 1.6 function `updateProjectCensorTerms(terms: string[])`, caller conversion

| File:line | Function | Input | Service / auth calls | Policy helper + capability | Plan check | Returns | Side effects | Client callers | Target endpoint | Domain |
|---|---|---|---|---|---|---|---|---|---|---|
| `:258` | `updateProjectCensorTerms(terms: string[])` | `string[]` (validated in service) | `autoCensorService.replaceProjectTerms(actor, projectId, terms)` | `executeProjectAction(projectId,"content.edit")` | none | `{terms}` / failure | none | `studio/_components/tool-panels/censor-panel.tsx:317` (prop type `studio-shell.tsx:710`) | `PUT /api/projects/:id/censor-terms` | clips-studio |

### Inventory 1.6 function `recordAutoCensorEvent(input: AutoCensorAnalyticsInput)`, caller conversion

| File:line | Function | Input | Service / auth calls | Policy helper + capability | Plan check | Returns | Side effects | Client callers | Target endpoint | Domain |
|---|---|---|---|---|---|---|---|---|---|---|
| `:265` | `recordAutoCensorEvent(input: AutoCensorAnalyticsInput)` | `AutoCensorAnalyticsInput` (validated in service) | `autoCensorService.recordEvent(actor, projectId, clipId, input)` | `executeProjectAction(projectId,"content.view")` | none | `{recorded:true}` / failure | none | `censor-panel.tsx:98` (fire-and-forget `recordEventBestEffort`), prop `studio-shell.tsx:714` | `POST /api/projects/:id/clips/:clipId/censor-events` (best effort; client swallows errors) | clips-studio |

### Inventory 1.3 function `replaceCensorWordsAction(input)`, caller conversion

| File:line | Function | Input | Service / auth calls | Policy helper + capability | Plan check | Returns | Side effects | Client callers | Target endpoint | Domain |
|---|---|---|---|---|---|---|---|---|---|---|
| `app/(app)/settings/workspace/censor-words-actions.ts:17` | `replaceCensorWordsAction(input)` | `workspaceCensorWordsSchema` | `autoCensorService.replaceWorkspaceWords` | `executeWorkspaceActionWithInput("workspace.manage")` | none in action | `{ok:true, ...saved}` | `revalidatePath("/settings/workspace")` | `app/(app)/settings/workspace/censor-words-card.tsx:93` (`save:`); Studio page passes it as prop `replaceWorkspaceCensorWords` (`studio/page.tsx:322`) -> `studio-shell.tsx:712` -> `tool-panels/censor-panel.tsx:309` | `PUT /api/workspace/censor-words` | settings-integrations (shared with clips-studio) |

### Inventory 1.3 function `resetCensorWordsAction()`, caller conversion

| File:line | Function | Input | Service / auth calls | Policy helper + capability | Plan check | Returns | Side effects | Client callers | Target endpoint | Domain |
|---|---|---|---|---|---|---|---|---|---|---|
| `:30` | `resetCensorWordsAction()` | none | `autoCensorService.resetWorkspaceWords` | `executeWorkspaceAction("workspace.manage")` | none | `{ok:true, ...saved}` | same | `censor-words-card.tsx:94`; `studio/page.tsx:323` -> `censor-panel.tsx:310` | `DELETE /api/workspace/censor-words` (reset to default) | settings-integrations (shared with clips-studio) |

## Acceptance criteria

- [ ] Page and six closures use Studio client; retained assets/fonts and source/preview offsets match previous bootstrap; development QA fixture remains web-side.
- [ ] Inject transport into existing Editing Session; query refetch does not overwrite dirty drafts, redo history or create autosave effects.
- [ ] Unload uses current in-memory token snapshot with keepalive bounds and leaves Device Draft intact on best-effort failure; localStorage heartbeat stays local.
- [ ] Polling/cache promise helpers, audio direct uploads, waveform fetches, layout/censor operations and reset reload use correct typed transport.
- [ ] Conflict/reset/two-tab ownership/offline recovery and export barriers retain existing session tests and real runtime behavior.
- [ ] No unowned files changed; paired review findings and verification evidence recorded under Comments.

## Verification

Run these from the repository root after dependencies are installed. A command naming a new package script is implemented by the owning setup ticket, not silently skipped. PostgreSQL gates need a disposable schema; a skipped DB suite does not satisfy its gate. During the undeployed integration sequence, record any unrelated transitional compile failure with its owning blocker; this ticket's behavior tests must pass and the final integrated gates cannot be waived.

```sh
bun test "apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio"
bun run test:clip-editor-persistence:db
```

Verify the changed flow in the running Next app against the separate API origin. Follow the repo's runtime/browser verification guidance; record steps, result and origin pair. Do not treat compilation as browser evidence.

## Comments

Append claim, requested seam changes, paired review and evidence here.
