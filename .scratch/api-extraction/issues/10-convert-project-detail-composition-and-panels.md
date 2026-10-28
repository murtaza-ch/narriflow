# 10. Convert Project detail composition and panels

**What to build:** The 1,107-line Project page becomes a client composition that fetches the active tab in parallel with bootstrap and keeps child props stable.

**Blocked by:** [08 - Expose Project and library reads and commands](08-expose-project-and-library-reads-and-commands.md), [11 - Move clip and campaign controls](11-move-clip-and-campaign-controls.md), [13 - Expose Studio bootstrap and persistence](13-expose-studio-bootstrap-and-persistence.md), [17 - Move publishing OAuth queue and performance API](17-move-publishing-oauth-queue-and-performance-api.md), [19 - Move Brand Kit and media controls](19-move-brand-kit-and-media-controls.md), [27 - Move review guest share and opt-out API](27-move-review-guest-share-and-opt-out-api.md), [07 - Move billing API and convert billing UI](07-move-billing-api-and-convert-billing-ui.md)

**Status:** ready-for-agent

**Suggested implementer:** Claude. The other pairing side reviews and returns findings to this owner.

Read [spec.md](../spec.md). It is the complete contract; the original brief/plan/reviews are not prerequisites. Claim this ticket before editing.

## Exact ownership

Paths are repo-relative. Every existing file below is exclusively assigned for this phase, including files that only need verification. A new `/**` directory includes its local tests/helpers, not adjacent directories. Read other files as evidence; do not edit them.

Existing files:

- `apps/web/app/(app)/projects/[projectId]/analytics-panel.test.tsx`
- `apps/web/app/(app)/projects/[projectId]/analytics-panel.tsx`
- `apps/web/app/(app)/projects/[projectId]/content-suite-panel.tsx`
- `apps/web/app/(app)/projects/[projectId]/dubbing-panel.tsx`
- `apps/web/app/(app)/projects/[projectId]/error.tsx`
- `apps/web/app/(app)/projects/[projectId]/loading.tsx`
- `apps/web/app/(app)/projects/[projectId]/page.tsx`
- `apps/web/app/(app)/projects/[projectId]/panel-header.tsx`
- `apps/web/app/(app)/projects/[projectId]/pipeline-stepper.tsx`
- `apps/web/app/(app)/projects/[projectId]/processing-panel.tsx`
- `apps/web/app/(app)/projects/[projectId]/processing-timeframe-fields.tsx`
- `apps/web/app/(app)/projects/[projectId]/project-access.test.ts`
- `apps/web/app/(app)/projects/[projectId]/project-access.ts`
- `apps/web/app/(app)/projects/[projectId]/project-activity.test.ts`
- `apps/web/app/(app)/projects/[projectId]/project-activity.ts`
- `apps/web/app/(app)/projects/[projectId]/project-brand-picker.tsx`
- `apps/web/app/(app)/projects/[projectId]/project-events.tsx`
- `apps/web/app/(app)/projects/[projectId]/project-panels.test.tsx`
- `apps/web/app/(app)/projects/[projectId]/project-skeleton.tsx`
- `apps/web/app/(app)/projects/[projectId]/project-tab.test.ts`
- `apps/web/app/(app)/projects/[projectId]/project-tab.ts`
- `apps/web/app/(app)/projects/[projectId]/project-tabs.tsx`
- `apps/web/app/(app)/projects/[projectId]/soft-bar.tsx`
- `apps/web/app/(app)/projects/[projectId]/source-icon.tsx`
- `apps/web/app/(app)/projects/[projectId]/transcript-panel.tsx`
- `apps/web/app/(app)/projects/[projectId]/transcript-paragraphs.test.ts`
- `apps/web/app/(app)/projects/[projectId]/transcript-paragraphs.ts`
- `apps/web/lib/project-state.test.ts`
- `apps/web/lib/project-state.ts`

New files/directories or reserved skeletons handed off by a blocker:

- Add tests beside the owned implementation only; no new cross-domain directory.

Own the Project page and listed panels only. PublishingProvider internals belong to 18, clips/campaign to 12, internal review to 28 and stream provider to 29. Preserve their existing props or coordinate a later serial transfer; never patch them concurrently.

Consume the endpoint contracts owned by 08. API changes belong to those owners; this ticket owns caller conversion and cache effects.

## Endpoints, actions, pages and refresh sites

Rows retain their section/ordinal or exact source-line identifier from the independent inventory. Abbreviated table filenames are accompanied by the literal ownership manifest and exact source occurrences below. All action/page/fetch/refresh rows in owned files are in scope, including no-refresh callers and media navigation. Baseline observations do not override the spec's selected origins, route style, guest Bearer or new endpoints.

### Inventory 2.B page/type row at inventory line 229

| File (lines) | Gate (line) | Service / db / validators calls (line) | Params / searchParams | Redirect / notFound | Props to client components | Proposed GET endpoint(s) |
| --- | --- | --- | --- | --- | --- | --- |
| `app/(app)/projects/[projectId]/page.tsx` (1107) | `admitProjectPage(projectId,"content.view")` L164 | `projectService.getProjectSnapshot` L182; Promise.all L205-244: `getTranscriptSnapshot` (tab=transcript) / `getTranscriptStatusSnapshot` (other tabs), `clipService.listClips`, `getLatestContentPack`, `analyticsService.getProjectAnalytics` (tab=analytics), `socialService.listProjectPosts` , `socialOAuthService.listAccounts` (tab posts/clips), `dubbingService.listProjectDubs` + `getDubbingAllowance` (tab=dubbing), `projectService.getWorkflowHistory`, `getUsageSummary`, `brandProfileService.list(brandScope)` (tab=clips), `reviewService.internalRoom(workspaceId,projectId,"manage"\|"view")` (tab=review), `workspaceService.getWorkspace` (tab posts/clips), `getProjectFinishing` (L239), `getProcessingUsage().projectCreditUsage(projectId)` (L244); `presignDownloadUrl` L319 (tab=clips, 3600s, errors swallowed); `isQuotaBlockedMidFlight`, `MAX_INGEST_RETRY_ATTEMPTS`; many `hasFeature`/`planFeatureRequirement`/`brandPlanRequirement`/`planUpgradeHighlight`/`creditsForSourceSeconds`; `randomUUID()` for hidden idempotency keys L875, L945 | `params.projectId`; `searchParams.tab`, `searchParams.reviewSelection` | `notFound()` L185 when no project (plus `admitProjectPage` notFound for missing/expired/purged project, mismatch redirect) | `ProjectEventsProvider{projectId,initialSeq=snapshot.lastSeq,initialEvents=workflowHistory}`, `ProjectShareButton{projectId,upgrade,actor{name,email,imageUrl,initials,role}}`, `DeleteProjectButton`, `PipelineStepper{steps,workflowRunId}`, `FinishingStatus{projectId,finishing}`, `RetryIngestButton`, `ProjectBrandPicker{projectId,brands[],currentBrandId,canEdit,upgrade,requirementMessage}`, `PublishingProvider{projectId,actorId,workspaceId,clips,accounts,initialPosts,initialPostsCursor,workspaceTimezone,can1080pExport,canOverrideReview,canPublish,publishingUpgrade,assistedCopy*,customThumbnails*,campaignSchedulingEnabled,canUploadVisualAssets}`, `ProcessingPanel{projectId,mediaWell,quotaUpgrade,advancedSettingsProps,defaultSourceLanguageCode,canEdit,...}`, `ClipsPanel{clips,projectId,mode,isFreeTier,can1080pExport,defaultAspectRatio,sourceVideoUrl,actionAvailability,upgradePrompts,canEdit}`, `TranscriptPanel{projectId,transcript}`, `ContentSuitePanel`, `DubbingPanel{projectId,clips,dubs,allowance,planRequirement,upgrade,canEdit}`, `ReviewPanel{projectId,initialData,canManage,preselection}`, `AnalyticsPanel{analytics,clips}`, `AuthenticatedActionForm` + server actions `queueTranscriptionFormAction`, `regenerateClipsFormAction` | Existing: `GET /api/projects/:id` (snapshot; L473, 404 on missing), `GET /api/projects/:id/clips` (L635), `GET /api/projects/:id/transcript` (L507, full snapshot only), `GET /api/projects/:id/analytics` (L1475), `GET /api/projects/:id/social-posts` (social-publication-http L60, paged), `GET /api/social/accounts`, `GET /api/projects/:id/dubs` (L1663), `GET /api/projects/:id/review-rounds` (L1110, same `internalRoom` call), `GET /api/brand-profiles`, `GET /api/ingest/:projectId` (L620), `GET /api/projects/:id/campaign-operations` (L823). **NEW**: `GET /api/projects/:id/transcript?view=status` (status snapshot), `GET /api/projects/:id/content-pack` (latest), `GET /api/projects/:id/workflow-history` (initial events; or `?afterSeq=` on the existing stream), `GET /api/projects/:id/finishing`, `GET /api/projects/:id/credit-usage` (or fold into snapshot: `projectCreditUsage` + `quotaBlockedMidFlight`), `GET /api/projects/:id/source-url` (presigned playback, tab=clips), `GET /api/projects/:id/dubs/allowance`, `GET /api/workspace` (timezone). Page must become a client composition using one query per tab to avoid a waterfall; `snapshot` first, tab queries in parallel. |

### Inventory 5.2 refresh/fetch row at inventory line 722

| file:line | Trigger | Mutation just performed | Refreshes |
| --- | --- | --- | --- |
| `(app)/projects/[projectId]/dubbing-panel.tsx:324` | "Create dub" | `POST /api/projects/:id/dubs` (:296, idempotency-key) | Project page Dubbing tab list |

### Inventory 5.3 refresh/fetch row at inventory line 752

| file:line | Trigger | Call | Notes |
| --- | --- | --- | --- |
| `transcript-panel.tsx:1227` | "Create clip from selection" | `POST .../clips/:c/create-from-selection` | Toast "Open" -> `router.push(studio)` |

### Inventory 5.3 refresh/fetch row at inventory line 753

| file:line | Trigger | Call | Notes |
| --- | --- | --- | --- |
| `tool-panels/transitions-panel.tsx:294` | Apply transition to all | `POST /api/projects/:p/clips/apply-studio-edits` | Local |

### Inventory 5.3 refresh/fetch row at inventory line 754

| file:line | Trigger | Call | Notes |
| --- | --- | --- | --- |
| `tool-panels/captions-panel.tsx:721` | Apply caption preset to all | `POST /api/projects/:p/clips/apply-caption-preset` | Local |

### Inventory 5.3 refresh/fetch row at inventory line 755

| file:line | Trigger | Call | Notes |
| --- | --- | --- | --- |
| `tool-panels/broll-panel.tsx:111` | Search stock | `GET /api/broll/search?query=&orientation=` | Local |

### Inventory 5.3 refresh/fetch row at inventory line 756

| file:line | Trigger | Call | Notes |
| --- | --- | --- | --- |
| `tool-panels/brand-template-panel.tsx:317` | Open panel | `GET /api/brand-templates` | Local |

### Inventory 5.3 refresh/fetch row at inventory line 757

| file:line | Trigger | Call | Notes |
| --- | --- | --- | --- |
| `tool-panels/audio-library.ts:56,110,125` | Browse / favorite / preview | `GET /api/audio-assets?...`, `POST|DELETE /api/audio-assets/:id/favorite`, `GET /api/audio-assets/:id/playback-url` | Local |

### Inventory 5.12 refresh/fetch row at inventory line 890

| Consumer | Connects when | What it does with events |
| --- | --- | --- |
| `pipeline-stepper.tsx:32`, `processing-panel.tsx:367`, `project-events.tsx:210` | via `useProjectEvents()` context | Read `latestByStage` (stepper, checklist) or `events` (Activity tab); no connection of their own |

### Inventory 5.12 refresh/fetch row at inventory line 891

| Consumer | Connects when | What it does with events |
| --- | --- | --- |
| `projects/[projectId]/clips/[clipId]/exports/[exportId]/export-delivery-client.tsx:155` | While `data.status` is active (`ACTIVE_STATUSES`) | Only `clip_rendering` stage events trigger `refresh()` (GET export snapshot into local state); tracks `lastSeqRef`; `onerror` closes and falls back to 5 s polling; 10 s fallback interval always on while active; `authorization.revoked` -> recover |

### Inventory 5.12 refresh/fetch row at inventory line 892

| Consumer | Connects when | What it does with events |
| --- | --- | --- |
| `upload/_lib/use-ingest-stream.ts:62` (`useIngestStream`, used by `upload/_components/configure-step.tsx:66`) | Mount while `initial.ingestStatus` is not `ready`/`failed`; re-keys on `initial.ingestStatus`; closes on first terminal ingest event | Maps `ingest_queued/downloading/normalizing/ready` and `failed` to local `IngestStreamState`; `authorization.revoked` -> recover or `window.location.reload()` |

### Inventory 5 exact file occurrences: apps/web/app/(app)/projects/[projectId]/content-suite-panel.tsx

```text
417: const res = await fetch(`/api/projects/${projectId}/content-suite`);
449: const res = await fetch(`/api/projects/${projectId}/content-suite`, {
```

### Inventory 5 exact file occurrences: apps/web/app/(app)/projects/[projectId]/dubbing-panel.tsx

```text
296: const response = await fetch(`/api/projects/${projectId}/dubs`, {
324: startTransition(() => router.refresh());
340: const response = await fetch(
353: window.location.assign(downloadUrl);
```

### Inventory 5 exact file occurrences: apps/web/app/(app)/projects/[projectId]/page.tsx

```text
1097: (owned by ProjectEventsProvider above) drives router.refresh()
```

### Inventory 5 exact file occurrences: apps/web/app/(app)/projects/[projectId]/processing-panel.tsx

```text
363: * shows without a second EventSource or extra router.refresh() calls beyond
```

### Inventory 5 exact file occurrences: apps/web/app/(app)/projects/[projectId]/transcript-panel.tsx

```text
415: window.location.assign(
```

Also account for the inventory's cross-domain traps: query-only actions, action forms that relied on revalidatePath, signed downloads/media, OAuth anchors, all three EventSource consumers and unload keepalive. Only the literal files above may be changed by this ticket.

### Inventory 2.D page/type row at inventory line 289

| Client file | Types |
| --- | --- |
| `(app)/projects/[projectId]/dubbing-panel.tsx` | `DubUsageSummary` |

### Inventory 1.4 function `queueTranscriptionFormAction(formData)` (alias `queueGenerationFormAction` :187, no callers), caller conversion

| File:line | Function | Input | Service / auth calls | Policy helper + capability | Plan check | Returns | Side effects | Client callers | Target endpoint | Domain |
|---|---|---|---|---|---|---|---|---|---|---|
| `:156` | `queueTranscriptionFormAction(formData)` (alias `queueGenerationFormAction` :187, no callers) | `formData`: `projectId`, `idempotencyKey` (default `randomUUID()`), content pack via `readContentPackFromForm`, `readLanguageCodeFromForm` (`app/(app)/upload/_lib/content-pack-form.ts`) | `projectService.triggerGeneration(appUser, projectId, {contentPack, forceRegenerate:false, languageCode}, idempotencyKey)` | `executeProjectAction(projectId,"processing.consume")` | credits/length via `ProcessingUsageError` from service; caught -> **`redirect("/projects/:id")`** (page shows limit + upgrade) | `void`; throws on missing `projectId` | `revalidatePath("/projects/:id")`; `redirect` on plan limit | `projects/[projectId]/processing-panel.tsx:487` and `projects/[projectId]/page.tsx:869` (`AuthenticatedActionForm action=`) | existing `POST /api/projects/:id/generate` (route.ts:448, verify parity: contentPack/languageCode/idempotency) ; plan-limit becomes a typed `ApiError` (`code`, `details`) the client renders instead of redirecting | projects |

### Inventory 1.4 function `applyProjectBrandProfileFormAction(formData)`, caller conversion

| File:line | Function | Input | Service / auth calls | Policy helper + capability | Plan check | Returns | Side effects | Client callers | Target endpoint | Domain |
|---|---|---|---|---|---|---|---|---|---|---|
| `:189` | `applyProjectBrandProfileFormAction(formData)` | `brandProfileProjectApplicationSchema` `{projectId, profileId, templateId\|null}` | `brandProfileService.applyToProject(actor, projectId, {profileId, templateId})` | `executeProjectActionWithInput(projectId,"content.edit")` | none | `void` / failure | `revalidatePath("/projects/:id")` | `projects/[projectId]/project-brand-picker.tsx:55` | `PUT /api/projects/:projectId/brand-profile` (or reuse `/projects/:id/campaign-operations/apply-brand-profile`, route.ts:930, which applies to selected clips; different semantics, verify) | brand-kit / projects |

### Inventory 1.4 function `regenerateClipsFormAction(formData)`, caller conversion

| File:line | Function | Input | Service / auth calls | Policy helper + capability | Plan check | Returns | Side effects | Client callers | Target endpoint | Domain |
|---|---|---|---|---|---|---|---|---|---|---|
| `:222` | `regenerateClipsFormAction(formData)` | `projectId`, `idempotencyKey`, content pack | `clipService.regenerateClips(appUser, projectId, idempotencyKey, contentPack)` | `executeProjectAction(projectId,"processing.consume")` | `ProcessingUsageError` -> `redirect("/projects/:id")` | `void` | `revalidatePath`; `redirect` on plan limit | `processing-panel.tsx:449`, `projects/[projectId]/page.tsx:940` | existing `POST /api/projects/:id/clips/regenerate` (`clip-generation-http.ts:11`, verify parity) | projects |

### Inventory 1.4 function `setNotifyPreferenceAction(projectId, notifyOnComplete)`, caller conversion

| File:line | Function | Input | Service / auth calls | Policy helper + capability | Plan check | Returns | Side effects | Client callers | Target endpoint | Domain |
|---|---|---|---|---|---|---|---|---|---|---|
| `:331` | `setNotifyPreferenceAction(projectId, notifyOnComplete)` | `string, boolean` | `projectService.setProjectNotifyPreference`; catches `ProjectNotFoundError` | `executeProjectAction(projectId,"content.edit")` | none | `{ok:boolean, error?}` | none (no revalidate) | `processing-panel.tsx:299` | `PUT /api/projects/:projectId/notify-preference` | projects |

## Acceptance criteria

- [ ] Project page uses an active-tab aggregate and keeps child component interfaces frozen; all server action forms and direct services reads removed.
- [ ] Workflow initial lastSeq/history, share actor data, conditional post/accounts/dubs/review/brand/credit facts and existing plan prompts preserved.
- [ ] Transcript attachment uses Bearer fetch/Blob and source playback uses expiring grants; media receives no Clerk token.
- [ ] Analytics/content/dubbing/processing/brand panels use captured scope and command invalidation; delegate no file edits to another UI owner.
- [ ] No unowned files changed; paired review findings and verification evidence recorded under Comments.

## Verification

Run these from the repository root after dependencies are installed. A command naming a new package script is implemented by the owning setup ticket, not silently skipped. PostgreSQL gates need a disposable schema; a skipped DB suite does not satisfy its gate. During the undeployed integration sequence, record any unrelated transitional compile failure with its owning blocker; this ticket's behavior tests must pass and the final integrated gates cannot be waived.

```sh
bun run --cwd apps/web typecheck
```

Verify the changed flow in the running Next app against the separate API origin. Follow the repo's runtime/browser verification guidance; record steps, result and origin pair. Do not treat compilation as browser evidence.

## Comments

Append claim, requested seam changes, paired review and evidence here.
