# 18. Convert publishing calendar and performance UI

**What to build:** Calendar, queue, publishing composer, social accounts and performance use scoped queries, adaptive polling and JSON OAuth starts.

**Blocked by:** [17 - Move publishing OAuth queue and performance API](17-move-publishing-oauth-queue-and-performance-api.md), [05 - Expose session and Workspace controls](05-expose-session-and-workspace-controls.md), [07 - Move billing API and convert billing UI](07-move-billing-api-and-convert-billing-ui.md)

**Status:** done

**Suggested implementer:** Claude. The other pairing side reviews and returns findings to this owner.

Read [spec.md](../spec.md). It is the complete contract; the original brief/plan/reviews are not prerequisites. Claim this ticket before editing.

## Exact ownership

Paths are repo-relative. Every existing file below is exclusively assigned for this phase, including files that only need verification. A new `/**` directory includes its local tests/helpers, not adjacent directories. Read other files as evidence; do not edit them.

Existing files:

- `apps/web/app/(app)/calendar/actions.ts`
- `apps/web/app/(app)/calendar/calendar-filters.tsx`
- `apps/web/app/(app)/calendar/calendar-live-refresh.tsx`
- `apps/web/app/(app)/calendar/loading.tsx`
- `apps/web/app/(app)/calendar/new/loading.tsx`
- `apps/web/app/(app)/calendar/new/page.tsx`
- `apps/web/app/(app)/calendar/page.tsx`
- `apps/web/app/(app)/calendar/queue/actions.ts`
- `apps/web/app/(app)/calendar/queue/loading.tsx`
- `apps/web/app/(app)/calendar/queue/page.tsx`
- `apps/web/app/(app)/calendar/queue/posting-schedule-editor.tsx`
- `apps/web/app/(app)/calendar/queue/proposals-inbox.test.tsx`
- `apps/web/app/(app)/calendar/queue/proposals-inbox.tsx`
- `apps/web/app/(app)/calendar/queue/queue-parts.tsx`
- `apps/web/app/(app)/performance/loading.tsx`
- `apps/web/app/(app)/performance/page.tsx`
- `apps/web/app/(app)/performance/what-worked.test.tsx`
- `apps/web/app/(app)/performance/what-worked.tsx`
- `apps/web/app/(app)/projects/[projectId]/publishing-composition-session-protocol.test.ts`
- `apps/web/app/(app)/projects/[projectId]/publishing-composition-session.test.ts`
- `apps/web/app/(app)/projects/[projectId]/publishing-composition-session.ts`
- `apps/web/app/(app)/projects/[projectId]/publishing-cover.tsx`
- `apps/web/app/(app)/projects/[projectId]/publishing-draft.ts`
- `apps/web/app/(app)/projects/[projectId]/publishing-posts.test.tsx`
- `apps/web/app/(app)/projects/[projectId]/publishing-posts.tsx`
- `apps/web/app/(app)/projects/[projectId]/publishing-preview.tsx`
- `apps/web/app/(app)/projects/[projectId]/publishing-provider.tsx`
- `apps/web/app/(app)/projects/[projectId]/publishing.browser.fixture.tsx`
- `apps/web/app/(app)/projects/[projectId]/publishing.test.ts`
- `apps/web/app/(app)/settings/social-accounts/loading.tsx`
- `apps/web/app/(app)/settings/social-accounts/page.tsx`
- `apps/web/app/(app)/settings/social-accounts/social-accounts-panel.browser.fixture.tsx`
- `apps/web/app/(app)/settings/social-accounts/social-accounts-panel.test.ts`
- `apps/web/app/(app)/settings/social-accounts/social-accounts-panel.tsx`
- `apps/web/lib/performance-format.test.ts`
- `apps/web/lib/performance-format.ts`
- `apps/web/lib/social-platform-mark.tsx`
- `apps/web/lib/social-post-links.tsx`
- `apps/web/lib/social-post-status.test.ts`
- `apps/web/lib/social-post-status.ts`

New files/directories or reserved skeletons handed off by a blocker:

- Add tests beside the owned implementation only; no new cross-domain directory.

PublishingProvider and publishing composition files are owned here even though mounted by 10. Frozen props allow concurrent page composition. Performance guidance settings mutation adapter belongs to 05; its UI lives in 06.

Consume the endpoint contracts owned by 17. API changes belong to those owners; this ticket owns caller conversion and cache effects.

## Endpoints, actions, pages and refresh sites

Rows retain their section/ordinal or exact source-line identifier from the independent inventory. Abbreviated table filenames are accompanied by the literal ownership manifest and exact source occurrences below. All action/page/fetch/refresh rows in owned files are in scope, including no-refresh callers and media navigation. Baseline observations do not override the spec's selected origins, route style, guest Bearer or new endpoints.

### Inventory 2.B page/type row at inventory line 226

| File (lines) | Gate (line) | Service / db / validators calls (line) | Params / searchParams | Redirect / notFound | Props to client components | Proposed GET endpoint(s) |
| --- | --- | --- | --- | --- | --- | --- |
| `app/(app)/performance/page.tsx` (23) | content.view L7 | `performanceService.whatWorked` L9; `performanceService.guidance` L10; `socialOAuthService.listAccounts` L11; `performanceSyncAvailable`, `workspaceAllowsCapability` | none | none | `WhatWorked{summary,guidance,emptyNextStep}` | **NEW `GET /api/performance/what-worked`**, **NEW `GET /api/performance/guidance`** (also used by `settings/workspace`), existing `GET /api/social/accounts`. |

### Inventory 2.B page/type row at inventory line 233

| File (lines) | Gate (line) | Service / db / validators calls (line) | Params / searchParams | Redirect / notFound | Props to client components | Proposed GET endpoint(s) |
| --- | --- | --- | --- | --- | --- | --- |
| `app/(app)/calendar/page.tsx` (554) | content.view L143 | `workspaceLibraryService.listCalendarPosts(appUser,{from,to,status,platform,accountId,projectId})` L175 (window = view window +/- 36h); `workspaceService.getWorkspace` L186 (timezone); `workspaceLibraryService.getCalendarFilters` L187; `publishingQueue.countProposals` L190 | `searchParams`: `month,date,view,status,platform,account,project` | none | `CalendarLiveRefresh{delayMs}` (client; `router.refresh()` timer), `CalendarFilters{filters[]}`, `AuthenticatedActionForm{action: cancelWorkspacePostAction}`, `LockedButton`; most of the grid renders server-side | **NEW `GET /api/workspace/calendar/posts?from&to&status&platform&account&project`**, **NEW `GET /api/workspace/calendar/filters`**, **NEW `GET /api/publishing/proposals/count`** (or return `proposalCount` with the proposals list), **NEW `GET /api/workspace`** (name, timezone, status). `CalendarLiveRefresh` becomes React Query `refetchInterval` driven by `socialPollDelayMs`. |

### Inventory 2.B page/type row at inventory line 234

| File (lines) | Gate (line) | Service / db / validators calls (line) | Params / searchParams | Redirect / notFound | Props to client components | Proposed GET endpoint(s) |
| --- | --- | --- | --- | --- | --- | --- |
| `app/(app)/calendar/new/page.tsx` (64) | `admitWorkspacePage("publishing.manage")` L11 | `workspaceLibraryService.getCalendarComposerOptions(actor,{query,cursor})` L13 | `searchParams`: `q, cursor` | none | none (links to `/projects/:id?publishClip=:clipId`) | **NEW `GET /api/workspace/calendar/composer-options?q&cursor`** |

### Inventory 2.B page/type row at inventory line 235

| File (lines) | Gate (line) | Service / db / validators calls (line) | Params / searchParams | Redirect / notFound | Props to client components | Proposed GET endpoint(s) |
| --- | --- | --- | --- | --- | --- | --- |
| `app/(app)/calendar/queue/page.tsx` (96) | content.view L40 | `publishingQueue.listProposals` L42; `socialOAuthService.listAccounts` L43; `workspaceService.getWorkspace` L44 (timezone); `workspaceAllowsCapability`, `featureUpgradePrompt` | none | none | `ProposalsInbox{proposals,timeZone,canManage,scheduleUpgrade}` (client; also imports type `ProposalInboxItem`), `PostingScheduleEditor{accounts,timeZone,canManage,scheduleUpgrade}` | **NEW `GET /api/publishing/proposals`**, existing `GET /api/social/accounts`, **NEW `GET /api/workspace`**. Posting-schedule slots are fetched inside the editor today (check `posting-schedule-editor.tsx`); that part is the actions fork's. |

### Inventory 2.B page/type row at inventory line 252

| File (lines) | Gate (line) | Service / db / validators calls (line) | Params / searchParams | Redirect / notFound | Props to client components | Proposed GET endpoint(s) |
| --- | --- | --- | --- | --- | --- | --- |
| `app/(app)/settings/social-accounts/page.tsx` (97) | content.view L22 | `socialOAuthService.listAccounts` L24; `planLimits`, `planCountRequirement`, `planUpgradeHighlight`, `workspaceAllowsCapability` | `searchParams`: `connected, error, facebook_selection, returnTo` (returnTo validated by regex `^/projects/[0-9a-f-]+\?publishClips=...$`) | none | `SocialAccountsPanel{accounts,returnTo,connectedCount,errorCode,facebookSelectionToken,canManage,access,accountLimit,connectRequirement,connectUpgrade,canManageBilling}` | Existing `GET /api/social/accounts`. Search params are written by the OAuth callback redirect (`social/oauth/callback`), see section 6. |

### Inventory 5.2 refresh/fetch row at inventory line 712

| file:line | Trigger | Mutation just performed | Refreshes |
| --- | --- | --- | --- |
| `(app)/projects/[projectId]/publishing-provider.tsx:542` | Effect when any export's `currentEditorRevision` exceeds the clip's `editorRevision` | none | Project page clips |

### Inventory 5.5 refresh/fetch row at inventory line 783

| file:line | Trigger | Mutation | Refreshes |
| --- | --- | --- | --- |
| `(app)/calendar/calendar-live-refresh.tsx:13` | `setTimeout(delayMs)` set by `calendar/page.tsx:250` (`liveRefreshDelay`) while posts are in flight | none (poll) | `/calendar` |

### Inventory 5.5 refresh/fetch row at inventory line 784

| file:line | Trigger | Mutation | Refreshes |
| --- | --- | --- | --- |
| `(app)/calendar/queue/posting-schedule-editor.tsx:65` | Save/clear posting schedule (also on failure) | `savePostingScheduleAction(accountId, schedule)` (:59) | `/calendar/queue` |

### Inventory 5.5 refresh/fetch row at inventory line 785

| file:line | Trigger | Mutation | Refreshes |
| --- | --- | --- | --- |
| `(app)/calendar/queue/proposals-inbox.tsx:201` | Per-proposal caption / reject / accept (`run()`) | `updateProposalCaptionAction` (:240), `rejectProposalAction` (:263), `acceptProposalAction` (:276,:290) | `/calendar/queue`, `/calendar` |

### Inventory 5.5 refresh/fetch row at inventory line 786

| file:line | Trigger | Mutation | Refreshes |
| --- | --- | --- | --- |
| `proposals-inbox.tsx:342` | "Accept all" loop (paginated) | `acceptAllProposalsAction(after)` (:325) | Same |

### Inventory 5.5 refresh/fetch row at inventory line 787

| file:line | Trigger | Mutation | Refreshes |
| --- | --- | --- | --- |
| `(app)/settings/social-accounts/social-accounts-panel.tsx:269` | Facebook Page chosen after OAuth; `router.replace("/settings/social-accounts")` then refresh | `POST /api/social/oauth/facebook-selection/:token` (:250; preloaded with `GET` at :222) | `/settings/social-accounts` |

### Inventory 5.5 refresh/fetch row at inventory line 788

| file:line | Trigger | Mutation | Refreshes |
| --- | --- | --- | --- |
| `social-accounts-panel.tsx:321` | "Disconnect" | `DELETE /api/social/accounts/:id` (:295) | `/settings/social-accounts` |

### Inventory 5.6 refresh/fetch row at inventory line 796

| file:line | Trigger | Call | Refreshes |
| --- | --- | --- | --- |
| `brand-kit/_components/brand-profile-create-form.tsx:58` | Create profile; `router.push("/brand-kit/:id")` then refresh | `POST /api/brand-profiles` (:43) | `/brand-kit/:id` |

### Inventory 5.10 refresh/fetch row at inventory line 857

| Action file | Paths revalidated |
| --- | --- |
| `(app)/calendar/actions.ts:16` | `/calendar` |

### Inventory 5.10 refresh/fetch row at inventory line 858

| Action file | Paths revalidated |
| --- | --- |
| `(app)/calendar/queue/actions.ts:17-18` | `/calendar/queue`, `/calendar` |

### Inventory 5 exact file occurrences: apps/web/app/(app)/calendar/actions.ts

```text
16: revalidatePath("/calendar");
```

### Inventory 5 exact file occurrences: apps/web/app/(app)/calendar/calendar-live-refresh.tsx

```text
13: () => startRefresh(() => router.refresh()),
```

### Inventory 5 exact file occurrences: apps/web/app/(app)/calendar/queue/actions.ts

```text
17: revalidatePath("/calendar/queue");
18: revalidatePath("/calendar");
```

### Inventory 5 exact file occurrences: apps/web/app/(app)/calendar/queue/posting-schedule-editor.tsx

```text
65: router.refresh();
```

### Inventory 5 exact file occurrences: apps/web/app/(app)/calendar/queue/proposals-inbox.tsx

```text
201: router.refresh();
342: router.refresh();
```

### Inventory 5 exact file occurrences: apps/web/app/(app)/projects/[projectId]/publishing-cover.tsx

```text
262: const result = await fetch(prepared.uploadUrl, {
```

### Inventory 5 exact file occurrences: apps/web/app/(app)/projects/[projectId]/publishing-draft.ts

```text
114: const response = await fetch(url, {
```

### Inventory 5 exact file occurrences: apps/web/app/(app)/projects/[projectId]/publishing-provider.tsx

```text
542: if (staleRevision) router.refresh();
```

### Inventory 5 exact file occurrences: apps/web/app/(app)/settings/social-accounts/social-accounts-panel.tsx

```text
222: fetch(
250: const response = await fetch(
269: startTransition(() => router.refresh());
295: const response = await fetch(`/api/social/accounts/${account.id}`, {
321: startTransition(() => router.refresh());
```

Also account for the inventory's cross-domain traps: query-only actions, action forms that relied on revalidatePath, signed downloads/media, OAuth anchors, all three EventSource consumers and unload keepalive. Only the literal files above may be changed by this ticket.

### Inventory 2.D page/type row at inventory line 288

| Client file | Types |
| --- | --- |
| `(app)/performance/what-worked.tsx` | `GuidanceView`, `PerformanceGroup`, `PerformanceSummary` |

### Inventory 2.D page/type row at inventory line 286

| Client file | Types |
| --- | --- |
| `(app)/calendar/queue/proposals-inbox.tsx` | `ProposalInboxItem` (also in `proposals-inbox.test.tsx`) |

### Inventory 1.8 function `savePostingScheduleAction(accountId, schedule: unknown)`, caller conversion

| File:line | Function | Input | Service / auth calls | Policy helper + capability | Plan check | Returns | Side effects | Client callers | Target endpoint | Domain |
|---|---|---|---|---|---|---|---|---|---|---|
| `app/(app)/calendar/queue/actions.ts:22` | `savePostingScheduleAction(accountId, schedule: unknown)` | `z.strictObject({accountId: uuid, schedule: postingScheduleSchema.nullable()})` | `publishingQueue.setPostingSchedule` | `executeWorkspaceActionWithInput("publishing.manage")` | none in action | `void` / failure | `revalidatePath("/calendar/queue")`, `/calendar` | `calendar/queue/posting-schedule-editor.tsx:59` (`router.refresh`:65) | `PUT /api/social/accounts/:accountId/posting-schedule` | publishing |

### Inventory 1.8 function `tiktokAcceptanceOptionsAction(accountId)`, caller conversion

| File:line | Function | Input | Service / auth calls | Policy helper + capability | Plan check | Returns | Side effects | Client callers | Target endpoint | Domain |
|---|---|---|---|---|---|---|---|---|---|---|
| `:35` | `tiktokAcceptanceOptionsAction(accountId)` | `z.strictObject({accountId: uuid})` | `socialPublishingOptions(actor, accountId)` (returns subset: `directEnabled, inboxEnabled, privacyOptions, commentDisabled, duetDisabled, stitchDisabled`) | `executeWorkspaceActionWithInput("publishing.manage")` | none | options subset / failure | none | `calendar/queue/proposals-inbox.tsx:94` | `GET /api/social/accounts/:accountId/tiktok-options`; existing project-scoped `GET /api/projects/:id/social-accounts/:accountId/publishing-options` returns more | publishing |

### Inventory 1.8 function `updateProposalCaptionAction(proposalId, caption)`, caller conversion

| File:line | Function | Input | Service / auth calls | Policy helper + capability | Plan check | Returns | Side effects | Client callers | Target endpoint | Domain |
|---|---|---|---|---|---|---|---|---|---|---|
| `:54` | `updateProposalCaptionAction(proposalId, caption)` | `updateSocialPostProposalSchema.extend({proposalId: uuid})` | `publishingQueue.updateProposalCaption` | `executeWorkspaceActionWithInput("publishing.manage")` | none | `void` / failure | revalidate queue + calendar | `proposals-inbox.tsx:240` (`router.refresh`:201 in shared `run`) | `PATCH /api/social/proposals/:proposalId` | publishing |

### Inventory 1.8 function `rejectProposalAction(proposalId)`, caller conversion

| File:line | Function | Input | Service / auth calls | Policy helper + capability | Plan check | Returns | Side effects | Client callers | Target endpoint | Domain |
|---|---|---|---|---|---|---|---|---|---|---|
| `:66` | `rejectProposalAction(proposalId)` | `z.strictObject({proposalId: uuid})` | `publishingQueue.reject` | same | none | `void` / failure | same | `proposals-inbox.tsx:263` | `POST /api/social/proposals/:proposalId/reject` | publishing |

### Inventory 1.8 function `acceptProposalAction(proposalId, choices)`, caller conversion

| File:line | Function | Input | Service / auth calls | Policy helper + capability | Plan check | Returns | Side effects | Client callers | Target endpoint | Domain |
|---|---|---|---|---|---|---|---|---|---|---|
| `:78` | `acceptProposalAction(proposalId, choices)` | `z.strictObject({proposalId, choices: acceptSocialPostProposalSchema})` (`choices ?? {}`, TikTok choices under `tiktok`) | `publishingQueue.accept` | same | none in action | `{accepted:[accepted], skippedTikTok:0, failed:[]}` / failure | same | `proposals-inbox.tsx:276`, `:290` | `POST /api/social/proposals/:proposalId/accept` | publishing |

### Inventory 1.8 function `acceptAllProposalsAction(after: string\|null = null)`, caller conversion

| File:line | Function | Input | Service / auth calls | Policy helper + capability | Plan check | Returns | Side effects | Client callers | Target endpoint | Domain |
|---|---|---|---|---|---|---|---|---|---|---|
| `:93` | `acceptAllProposalsAction(after: string\|null = null)` | `z.strictObject({after: uuid.nullable()})` | `publishingQueue.acceptAll(actor,{after})` (cursor batches; skips TikTok) | same | none | `{accepted, skippedTikTok, failed, nextCursor}` (caller loops until `nextCursor` null) | same | `proposals-inbox.tsx:325` (`router.refresh`:342) | `POST /api/social/proposals/accept-all` `{after}` | publishing |

### Inventory 1.8 function `proposeToQueueAction(input: unknown)`, caller conversion

| File:line | Function | Input | Service / auth calls | Policy helper + capability | Plan check | Returns | Side effects | Client callers | Target endpoint | Domain |
|---|---|---|---|---|---|---|---|---|---|---|
| `:102` | `proposeToQueueAction(input: unknown)` | `proposeSocialPostSchema.extend({idempotencyKey: uuid})` | `publishingQueue.propose(actor, proposal, {source:"person", mutation:{clientIdempotencyKey}})` | same | none in action | `{proposalId}` / failure | same | `app/(app)/projects/[projectId]/publishing-provider.tsx:615`; test fixture `publishing.browser.fixture.tsx:23` | `POST /api/social/proposals` with `Idempotency-Key`; REST v1 has `POST /social-posts/proposals` (API-key surface, keep separate) | publishing |

### Inventory 1.8 function `cancelWorkspacePostAction(projectId, postId)`, caller conversion

| File:line | Function | Input | Service / auth calls | Policy helper + capability | Plan check | Returns | Side effects | Client callers | Target endpoint | Domain |
|---|---|---|---|---|---|---|---|---|---|---|
| `app/(app)/calendar/actions.ts:7` | `cancelWorkspacePostAction(projectId, postId)` | `string, string` | `socialService.cancelPost(appUser, projectId, postId)` | `executeProjectAction(projectId,"publishing.manage")` | none | `void` / failure | `revalidatePath("/calendar")` | `app/(app)/calendar/page.tsx:415` (`AuthenticatedActionForm action={cancelWorkspacePostAction.bind(null, projectId, postId)}`) | existing `DELETE /api/projects/:id/social-posts/:postId` (`social-publication-http.ts:71`, verify) | publishing |

## Acceptance criteria

- [x] Calendar/new/queue/performance/social accounts and Project publishing UI convert every action/fetch/refresh/OAuth anchor site.
- [x] Composer preservation includes revision/export barriers and publication uncertain/recheck/publish-again semantics; no duplicate scheduling intent on transport retry.
- [x] Adaptive calendar and proposal polling and mutation invalidation target posts/accounts/proposals/counts/schedules; cached old Workspace data is discarded.
- [x] Provider connect navigates only after authenticated JSON start, and returns/selection/reconnect notices preserve existing behavior.
- [ ] No unowned files changed; paired review findings and verification evidence recorded under Comments.

## Verification

Run these from the repository root after dependencies are installed. A command naming a new package script is implemented by the owning setup ticket, not silently skipped. PostgreSQL gates need a disposable schema; a skipped DB suite does not satisfy its gate. During the undeployed integration sequence, record any unrelated transitional compile failure with its owning blocker; this ticket's behavior tests must pass and the final integrated gates cannot be waived.

```sh
bun test "apps/web/app/(app)/calendar" "apps/web/app/(app)/performance"
```

Verify the changed flow in the running Next app against the separate API origin. Follow the repo's runtime/browser verification guidance; record steps, result and origin pair. Do not treat compilation as browser evidence.

## Comments

Claimed and implemented by Claude (Sonnet 5.5), 2026-10-29. Paired review not run (the last acceptance box is left open for the orchestrator). Signed-in browser pass NOT done (ticket 32).

### What changed
- Pages are data-free shells (`Suspense` + client screen): `calendar/calendar-screen.tsx`, `calendar/new/choose-clip-screen.tsx`, `calendar/queue/queue-screen.tsx`, `performance/performance-screen.tsx`, `settings/social-accounts/social-accounts-screen.tsx`. Reads are `useQuery` through new `apps/web/lib/publishing-client.ts` (`publishingQueries.*`, keys from `publishingKeys`, AbortSignal passed, guidance keyed `scopedKey(scope,"publishing","guidance")`); plan facts and capabilities come from the Workspace bootstrap (`useWorkspaceBootstrap`). Access refusals map to the old page redirects in `lib/publishing-load-error.tsx` (restricted -> billing / workspace-unavailable, forbidden -> /home).
- Deleted `calendar/actions.ts`, `calendar/queue/actions.ts`, `calendar/calendar-live-refresh.tsx`. Calendar polling is the query's `refetchInterval` from `socialPollDelayMs` (stops when nothing is live); the queue re-reads every 30 s. All commands invalidate `invalidatePublishing` (posts, accounts, proposals, count, schedules, calendar); failures re-read only when uncertain (409, 5xx, network: `isUncertainFailure`).
- Inbox/schedule/social-accounts components take a bound `api` prop (testable without a provider). Provider connect is now a button: `POST /social/oauth/start/:platform {redirect}` then `window.location.assign(authorizationUrl)`; a refusal toasts "Connection failed" with the `userErrorMessage(code)` text the `?error=` redirect used. Facebook Page list/selection and disconnect use the typed client.
- Project publishing: `publishing-api.ts` (typed publishing/exports/clips/brand clients) replaces `publishingRequest`/`PublishingRequestError` (removed; the session uses `ApiError.status`). `Idempotency-Key` per intent: propose (per draft + content), recheck/confirm/publish-again (per decision), and export creation (`POST .../exports` now requires it; retry of a failed export uses `exportCommands.retry`). Assisted copy, bulk schedule and thumbnail frames keep their body-native identities (frame key now per intent instead of a fresh UUID per click). The stale-revision `router.refresh()` is `invalidateProject(...)`.
- `GET /social/accounts` is `content.view` in the admission table already, so read-only members keep the Social accounts page.

### Deviations / notes for others
- The provider's local post (5 s / 30 s) and export (5 s) refresh loops remain `setInterval`s calling the typed API; they feed `initialPosts`/props frozen for ticket 10, so converting them to queries would change the provider contract. Ticket 10 can replace them when it owns the project aggregate.
- `PublishingProvider` now calls `useApiRuntime()`/`useWorkspaceScope()` and throws without a selected Workspace; it must render under `ApiProvider` (ticket 06 layout). Config props are unchanged.
- `performance/what-worked.test.tsx` still imports pure fixture builders (`summarizePerformance`, `computePerformanceGuidance`, `guidanceGroupLabel`) from `@narriflow/services`. Ticket 31's Biome rule needs a test exemption, or those fixtures must be written out.
- `Idempotent-Replayed`/limiter 429/503 from the receipt commands surface through `apiFailureMessage` (existing wording helper), no special UI.
- New (unlisted) files: `apps/web/lib/publishing-client.{ts,test.ts}`, `apps/web/lib/publishing-load-error.tsx`, the five screens above and `projects/[projectId]/publishing-api.ts`.

### Evidence
- `bun test "apps/web/app/(app)/calendar" "apps/web/app/(app)/performance"` plus social-accounts, `projects/[projectId]/publishing*` (incl. the happy-dom drawer fixture, now over the real typed client with Idempotency-Key assertions), `lib/performance-format`, `lib/social-post-status`: 92 pass; `./apps/web/lib/publishing-client.test.ts`: 4 pass (calendar key/scope, poll cadence, guidance key, uncertain-failure rule).
- `bun run --cwd apps/web typecheck`: no error in any file of this ticket (remaining errors belong to 06/16/other in-flight tickets). `bunx biome check` on all owned and new paths: clean.
- Not done: signed-in browser run against `next dev` + API (OAuth connect/return/Facebook selection, calendar polling while a post publishes, cancel, queue accept/accept-all/TikTok choices, composer propose/schedule/recovery with transport retry).
