# 12. Convert clip and campaign UI

**What to build:** Clip list/actions/campaign/finishing UI use typed domain queries and narrow invalidation, with existing keys preserved through uncertain acceptance.

**Blocked by:** [11 - Move clip and campaign controls](11-move-clip-and-campaign-controls.md), [08 - Expose Project and library reads and commands](08-expose-project-and-library-reads-and-commands.md), [07 - Move billing API and convert billing UI](07-move-billing-api-and-convert-billing-ui.md)

**Status:** done

**Suggested implementer:** Claude. The other pairing side reviews and returns findings to this owner.

Read [spec.md](../spec.md). It is the complete contract; the original brief/plan/reviews are not prerequisites. Claim this ticket before editing.

## Exact ownership

Paths are repo-relative. Every existing file below is exclusively assigned for this phase, including files that only need verification. A new `/**` directory includes its local tests/helpers, not adjacent directories. Read other files as evidence; do not edit them.

Existing files:

- `apps/web/app/(app)/projects/[projectId]/advanced-clip-settings.tsx`
- `apps/web/app/(app)/projects/[projectId]/campaign-command-bar.tsx`
- `apps/web/app/(app)/projects/[projectId]/campaign-command-state.test.ts`
- `apps/web/app/(app)/projects/[projectId]/campaign-command-state.ts`
- `apps/web/app/(app)/projects/[projectId]/campaign-editor-action-preview.tsx`
- `apps/web/app/(app)/projects/[projectId]/campaign-selection.test.ts`
- `apps/web/app/(app)/projects/[projectId]/campaign-selection.ts`
- `apps/web/app/(app)/projects/[projectId]/clip-action-error-copy.test.ts`
- `apps/web/app/(app)/projects/[projectId]/clip-action-error-copy.ts`
- `apps/web/app/(app)/projects/[projectId]/clip-actions-menu.tsx`
- `apps/web/app/(app)/projects/[projectId]/clip-row.tsx`
- `apps/web/app/(app)/projects/[projectId]/clips-panel.tsx`
- `apps/web/app/(app)/projects/[projectId]/edit-clip-length-dialog.tsx`
- `apps/web/app/(app)/projects/[projectId]/finishing-auto-refresh.tsx`
- `apps/web/app/(app)/projects/[projectId]/finishing-status.test.tsx`
- `apps/web/app/(app)/projects/[projectId]/finishing-status.tsx`
- `apps/web/app/(app)/projects/[projectId]/render-clips-button.tsx`
- `apps/web/app/(app)/projects/[projectId]/source-hover-preview.tsx`
- `apps/web/lib/clip-media.test.ts`
- `apps/web/lib/clip-media.ts`

New files/directories or reserved skeletons handed off by a blocker:

- Add tests beside the owned implementation only; no new cross-domain directory.

Consume the endpoint contracts owned by 11. API changes belong to those owners; this ticket owns caller conversion and cache effects.

## Endpoints, actions, pages and refresh sites

Rows retain their section/ordinal or exact source-line identifier from the independent inventory. Abbreviated table filenames are accompanied by the literal ownership manifest and exact source occurrences below. All action/page/fetch/refresh rows in owned files are in scope, including no-refresh callers and media navigation. Baseline observations do not override the spec's selected origins, route style, guest Bearer or new endpoints.

### Inventory 5.2 refresh/fetch row at inventory line 711

| file:line | Trigger | Mutation just performed | Refreshes |
| --- | --- | --- | --- |
| `(app)/projects/[projectId]/finishing-auto-refresh.tsx:11` | `setInterval(15_000)`, mounted by `finishing-status.tsx:38` while finishing is "working" | none (finishing writes no Project events) | Project page finishing status |

### Inventory 5.2 refresh/fetch row at inventory line 713

| file:line | Trigger | Mutation just performed | Refreshes |
| --- | --- | --- | --- |
| `(app)/projects/[projectId]/render-clips-button.tsx:282` | "Render clips" button | `POST /api/projects/:id/clips/render` (:256, idempotency-key) | Project page clips + processing |

### Inventory 5.2 refresh/fetch row at inventory line 714

| file:line | Trigger | Mutation just performed | Refreshes |
| --- | --- | --- | --- |
| `render-clips-button.tsx:486` | Retry ingest form | `retryIngestFormAction(formData)` (:484) | Project page ingest status |

### Inventory 5.2 refresh/fetch row at inventory line 715

| file:line | Trigger | Mutation just performed | Refreshes |
| --- | --- | --- | --- |
| `(app)/projects/[projectId]/clip-row.tsx:589` | Per-clip "Render" | `POST /api/projects/:id/clips/render` (:548) | Project page clip row |

### Inventory 5.2 refresh/fetch row at inventory line 716

| file:line | Trigger | Mutation just performed | Refreshes |
| --- | --- | --- | --- |
| `(app)/projects/[projectId]/clip-actions-menu.tsx:139` | Rename dialog save | `PATCH /api/projects/:id/clips/:clipId` (:106 `saveTitle`) | Project page clip list; also studio top bar title (`top-bar.tsx:21`) |

### Inventory 5.2 refresh/fetch row at inventory line 717

| file:line | Trigger | Mutation just performed | Refreshes |
| --- | --- | --- | --- |
| `clip-actions-menu.tsx:224` | Apply AI title suggestion | `saveTitle` after `POST .../title-suggestions` (:169) | Same |

### Inventory 5.2 refresh/fetch row at inventory line 718

| file:line | Trigger | Mutation just performed | Refreshes |
| --- | --- | --- | --- |
| `clip-actions-menu.tsx:264` | Duplicate (skipped when `onDuplicated` prop given) | `POST .../clips/:id/duplicate` (:238) | Same |

### Inventory 5.2 refresh/fetch row at inventory line 719

| file:line | Trigger | Mutation just performed | Refreshes |
| --- | --- | --- | --- |
| `clip-actions-menu.tsx:303` | Delete (skipped when `onDeleted` prop given) | `DELETE .../clips/:id` (:280) | Same |

### Inventory 5.2 refresh/fetch row at inventory line 720

| file:line | Trigger | Mutation just performed | Refreshes |
| --- | --- | --- | --- |
| `(app)/projects/[projectId]/edit-clip-length-dialog.tsx:732` | Trim saved but reframe render failed to queue | `PATCH .../clips/:id` (:686) then `POST .../clips/render` (:709) | Project page clip row |

### Inventory 5.2 refresh/fetch row at inventory line 721

| file:line | Trigger | Mutation just performed | Refreshes |
| --- | --- | --- | --- |
| `edit-clip-length-dialog.tsx:737` | Trim saved (dialog closes) | same | Project page clip row |

### Inventory 5.2 refresh/fetch row at inventory line 725

| file:line | Trigger | Mutation just performed | Refreshes |
| --- | --- | --- | --- |
| `(app)/projects/[projectId]/campaign-command-bar.tsx:724` | Apply editor action result (`receiveEditorActionResult`, :678) | `POST .../campaign-operations/apply-brand-profile`, `apply-style`, `apply-motion`, or `brand-profiles/:p/scene-templates/:t/apply` (endpoint helper :206-214; sent from `campaign-editor-action-preview.tsx:568`); list via `GET .../campaign-operations` (:684) | Project page clips / editor revisions plus campaign operations list |

### Inventory 5.2 refresh/fetch row at inventory line 726

| file:line | Trigger | Mutation just performed | Refreshes |
| --- | --- | --- | --- |
| `campaign-command-bar.tsx:812` | Apply selected motion | `POST .../campaign-operations/apply-motion` (:738, idempotency-key) then `GET .../campaign-operations` (:778) | Same |

### Inventory 5.2 refresh/fetch row at inventory line 727

| file:line | Trigger | Mutation just performed | Refreshes |
| --- | --- | --- | --- |
| `campaign-command-bar.tsx:886` | Retry editor action | `POST` retry endpoint (:825, `campaign-retry-of` header) then `GET` list (:853) | Same |

### Inventory 5 exact file occurrences: apps/web/app/(app)/projects/[projectId]/campaign-command-bar.tsx

```text
423: const response = await fetch(`/api/projects/${projectId}/campaign-operations`, {
450: void fetch(
494: void fetch(`/api/projects/${projectId}/export-bundles/preview`, {
534: const response = await fetch(`/api/projects/${projectId}/export-bundles`, {
610: const response = await fetch(
684: const response = await fetch(
724: router.refresh();
738: const response = await fetch(
778: const listResponse = await fetch(
812: router.refresh();
825: const response = await fetch(
853: const listResponse = await fetch(
886: router.refresh();
```

### Inventory 5 exact file occurrences: apps/web/app/(app)/projects/[projectId]/campaign-editor-action-preview.tsx

```text
362: void fetch(
472: void fetch(
568: const response = await fetch(endpoint, {
```

### Inventory 5 exact file occurrences: apps/web/app/(app)/projects/[projectId]/clip-actions-menu.tsx

```text
56: * rows are a client component driven by SSE refreshes, and `router.refresh()`
100: // router.refresh() after a delete unmounts these mid-request.
106: const response = await fetch(`/api/projects/${projectId}/clips/${clipId}`, {
139: startTransition(() => router.refresh());
169: const response = await fetch(
224: startTransition(() => router.refresh());
238: const response = await fetch(
264: startTransition(() => router.refresh());
280: const response = await fetch(
303: startTransition(() => router.refresh());
```

### Inventory 5 exact file occurrences: apps/web/app/(app)/projects/[projectId]/clip-row.tsx

```text
548: const response = await fetch(
589: startTransition(() => router.refresh());
630: const response = await fetch(`/api/projects/${clip.projectId}/exports/current`, { cache: "no-store" });
657: const created = await fetch(`/api/projects/${clip.projectId}/clips/${clip.id}/exports`, {
```

### Inventory 5 exact file occurrences: apps/web/app/(app)/projects/[projectId]/edit-clip-length-dialog.tsx

```text
82: pending = fetch(`/api/projects/${projectId}/transcript/utterances`)
686: const response = await fetch(
709: const renderResponse = await fetch(
732: startTransition(() => router.refresh());
737: startTransition(() => router.refresh());
```

### Inventory 5 exact file occurrences: apps/web/app/(app)/projects/[projectId]/finishing-auto-refresh.tsx

```text
11: const timer = setInterval(() => router.refresh(), everyMs);
```

### Inventory 5 exact file occurrences: apps/web/app/(app)/projects/[projectId]/render-clips-button.tsx

```text
256: const response = await fetch(`/api/projects/${projectId}/clips/render`, {
282: router.refresh();
486: router.refresh();
```

Also account for the inventory's cross-domain traps: query-only actions, action forms that relied on revalidatePath, signed downloads/media, OAuth anchors, all three EventSource consumers and unload keepalive. Only the literal files above may be changed by this ticket.

### Inventory 2.D page/type row at inventory line 296

| Client file | Types |
| --- | --- |
| `projects/[projectId]/campaign-command-state.test.ts` (test, value import `brandPlanRequirement`) | n/a |

### Inventory 2.D page/type row at inventory line 290

| Client file | Types |
| --- | --- |
| `(app)/projects/[projectId]/finishing-status.tsx` | `ProjectFinishingView` |

### Inventory 1.4 function `retryIngestFormAction(formData)`, caller conversion

| File:line | Function | Input | Service / auth calls | Policy helper + capability | Plan check | Returns | Side effects | Client callers | Target endpoint | Domain |
|---|---|---|---|---|---|---|---|---|---|---|
| `:280` | `retryIngestFormAction(formData)` | `projectId` | `getIngestJobLifecycle().retry({projectId, workspaceId, actorUserId})`; catches `IngestRetryLimitExceededError`, `IngestNotFailedError`, `IngestReselectRequiredError` | `executeProjectAction(projectId,"processing.consume")` | retry limit in service | `{ok:boolean, error?}` (expected failures returned, not thrown, to survive Next error redaction) | `revalidatePath("/projects/:id")` | `projects/[projectId]/render-clips-button.tsx:484` (`router.refresh`:486), `upload/_components/retry-import-band.tsx:54` (`router.refresh`:56) | `POST /api/ingest/:projectId/retry` (route.ts:620 already has `GET /ingest/:projectId`) | upload |

## Acceptance criteria

- [x] All owned clips/campaign/finishing components and clip-media URLs use api-client; module-level request promise caches become scoped query state.
- [x] Every copied refresh/fetch/anchor site has a narrow invalidation/grant replacement, including no-refresh media src paths.
- [x] Keys survive retries; 409 and uncertain delivery recover through domain state, not new user intents.
- [x] No change to Studio session or publishing/review component props; imported helper props frozen.
- [x] No unowned files changed; paired review findings and verification evidence recorded under Comments (paired review itself is left to the orchestrator).

## Verification

Run these from the repository root after dependencies are installed. A command naming a new package script is implemented by the owning setup ticket, not silently skipped. PostgreSQL gates need a disposable schema; a skipped DB suite does not satisfy its gate. During the undeployed integration sequence, record any unrelated transitional compile failure with its owning blocker; this ticket's behavior tests must pass and the final integrated gates cannot be waived.

```sh
bun run --cwd apps/web typecheck
```

Verify the changed flow in the running Next app against the separate API origin. Follow the repo's runtime/browser verification guidance; record steps, result and origin pair. Do not treat compilation as browser evidence.

## Comments

Append claim, requested seam changes, paired review and evidence here.

Claimed and implemented by Claude (Sonnet 5.5), 2026-10-29. Paired review not run by the implementer. No signed-in browser pass (see Evidence).

### What changed (all inside the ownership list; `advanced-clip-settings.tsx`, `campaign-selection.ts(+test)`, `clips-panel.tsx`, `source-hover-preview.tsx` verified, no edit needed)
- `lib/clip-media.ts`: module-level preview promise cache and `clipFileDownloadPath` deleted. It now also holds the clip UI's access seam: `useClipApi()` (typed clips/studio/exports/projects clients + `brand` mutations, bound to the captured identity + Workspace), `requireClipApi`, `intentIn(ref, runtime)` (one `runtime.createIntent()` per user action, kept through failures, `complete()` on confirmed acceptance) and `playableMediaUrl` (http(s) only before any navigation).
- Reads: clip previews = `clipQueries.previews` (shared per format across rows, 5 min stale, no focus refetch so a playing video keeps its URL; refetched when that clip's render readiness changes; `clip_render_not_found|not_ready` = pending). Operation polling = `clipQueries.campaignOperations` with 2 s `refetchInterval` while a drawer operation runs. Editor-action catalog = `clipQueries.editorActionCatalog`. Trim/Extend transcript = shared query `[projects, transcript-utterances, id]` with a module-level `select` (flattened once, same identity between renders; the dialog's imperative-paint contract is untouched). Finishing = `projectQueries.finishing` polled every 15 s by `FinishingAutoRefresh({projectId, shown})`, which invalidates the Project only when the answer differs from what the page shows (`finishingSignature`).
- Writes (all `useMutation` with `clipMutationOptions`, scope captured at press time): render (row, bar, dialog reframe), duplicate, delete (`clip_not_found` after a retry = done), rename (`PATCH` via the studio client), title suggestions (abortable), export-bundle create/retry, share (current export lookup + export create), apply brand profile/style/motion/scene (`submitCampaignEditorAction` in `campaign-command-state.ts` dispatches to `clipCommands.apply*` or `brandMutations.applySceneTemplate`), ingest retry (`createIngestActions().retryIngest`).
- Keys: every retryable command takes its `Idempotency-Key` from an intent (render, duplicate, export create, bundle create/retry, motion, editor-action apply/retry, reframe). Campaign retries send `Campaign-Retry-Of = operation.id`; the retry intent is keyed by `{request, retryOfId}`, so the same failed items retried after a lost response replay, a different item set is a new key. 409/5xx/no-response (`failureNeedsStateRefetch`) refetch clip/Project state instead of asking the user to repeat.
- Downloads: clip "Download" and "Download ZIP" request a fresh grant (`clipQueries.downloadGrant` / `GET .../export-bundles/:id/download`) and `window.location.assign(downloadUrl)`; no Clerk token ever goes to the media origin. The deleted `/file` route has no remaining caller in my files.
- Invalidation: `invalidateAfterClipChange` (clips list/previews/operations, Project reads, project lists, usage) after render/duplicate/delete/apply; rename = clips list + Project + `studio`; campaign apply and trim add `invalidateScoped(..., "studio")` so a Studio opened next cannot read a cached older document; ingest retry = `invalidateAfterIntake`. No `router.refresh`, `revalidatePath`, server action or `useActionState` left in my files (`RetryIngestButton` is a plain button now, same props).
- `finishing-status.tsx`/test: `ProjectFinishingView` is now `NonNullable<ProjectDetail["finishing"]>` (no `@narriflow/services`); `campaign-command-state.test.ts` computes the brand requirement locally (policy mirror) instead of importing services. `clip-action-error-copy` now takes the thrown `ApiError` (known code -> product copy, otherwise the envelope message, no response -> caller fallback).

### Requests for other owners
- 10: `ClipsPanel`/`ClipRow`/`FinishingStatus`/`RetryIngestButton`/`ClipActionsMenu` props are unchanged. The Project page must render them under the authenticated `ApiProvider` with a selected Workspace (they render inert, never throw, until one exists). Regenerate form: mint one `runtime.createIntent()` key per submit and call `clipCommands.regenerate(...)` (`advanced-clip-settings.tsx` stays a pure field set).
- 14: `ClipActionsMenu` (Studio top bar) invalidates `scopedKey(scope,"studio")` after rename/duplicate/delete; make the Studio bootstrap key live under domain `studio` (or subscribe to `clips` list invalidation) so the title refreshes without a reload. The menu now needs `ApiProvider` above the Studio.
- 11 (nit): `suggestTitles`, `previewEditorAction` and `GET .../transcript/utterances` helpers have no `signal` parameter; I call the typed clients directly for those (typed, no URL strings). Preview/catalog DTOs type `role` as `string` (scene role) rather than `"intro"|"outro"`.
- 16: `retry-import-band.tsx` still calls `retryIngestFormAction`; use `createIngestActions().retryIngest` like `RetryIngestButton`. 30: bundle/share/export-current calls use the exports client directly (no queries yet).
- 31: delete `/clips/:clipId/file` row and `retryIngestFormAction` once 16 lands; `lib/clip-media.ts` imports `@/app/_components/api-provider` (fine for the Biome backend-import rule).

### Evidence
- `bun test "apps/web/app/(app)/projects/[projectId]" apps/web/lib/clip-media.test.ts` (from `apps/web`): 517 pass, 0 fail across 56 files (new/changed: campaign-command-state 15 incl. the four editor actions sending key + `Campaign-Retry-Of`, clip-action-error-copy, finishing-status, finishing-auto-refresh, clip-media).
- `bun run --cwd apps/web typecheck`: no error in any file of this ticket (remaining errors are other tickets': recipes-panel, settings/*, `app/api/stream`, authenticated-request-policy modules).
- `bunx biome check` on all owned paths: clean.
- NOT done: signed-in browser pass against `next dev` + API (needs Clerk session). Ticket 32 should run: row preview playback and format switch, clip Download and ZIP download (grant -> R2), Render/retry (key replay on a dropped response), Share (existing and new export), Trim/Extend open/save with Auto reframe, rename/duplicate/delete from row and Studio top bar, campaign bar preflights, apply brand/style/scene/motion and retry-of, finishing poll to ready, Retry ingest at the limit.
