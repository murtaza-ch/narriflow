# 22. Convert automation and grants UI

**What to build:** Autopilot, grant and source controls read safe availability flags and invalidate the relevant rules/grants/connections after mutations.

**Blocked by:** [21 - Move automation grants and state-based Zoom callback](21-move-automation-grants-and-state-based-zoom-callback.md), [15 - Move intake Upload Sessions and recipes](15-move-intake-upload-sessions-and-recipes.md), [17 - Move publishing OAuth queue and performance API](17-move-publishing-oauth-queue-and-performance-api.md), [07 - Move billing API and convert billing UI](07-move-billing-api-and-convert-billing-ui.md)

**Status:** done

**Suggested implementer:** Claude. The other pairing side reviews and returns findings to this owner.

Read [spec.md](../spec.md). It is the complete contract; the original brief/plan/reviews are not prerequisites. Claim this ticket before editing.

## Exact ownership

Paths are repo-relative. Every existing file below is exclusively assigned for this phase, including files that only need verification. A new `/**` directory includes its local tests/helpers, not adjacent directories. Read other files as evidence; do not edit them.

Existing files:

- `apps/web/app/(app)/autopilot/autopilot-panel.test.tsx`
- `apps/web/app/(app)/autopilot/autopilot-panel.tsx`
- `apps/web/app/(app)/autopilot/loading.tsx`
- `apps/web/app/(app)/autopilot/page.tsx`
- `apps/web/app/(app)/autopilot/zoom-connections.tsx`
- `apps/web/app/(app)/help/loading.tsx`
- `apps/web/app/(app)/help/page.tsx`
- `apps/web/app/(app)/settings/automation-grants/actions.ts`
- `apps/web/app/(app)/settings/automation-grants/grants-panel.test.tsx`
- `apps/web/app/(app)/settings/automation-grants/grants-panel.tsx`
- `apps/web/app/(app)/settings/automation-grants/loading.tsx`
- `apps/web/app/(app)/settings/automation-grants/page.tsx`
- `apps/web/app/(app)/settings/notifications/loading.tsx`
- `apps/web/app/(app)/settings/notifications/page.tsx`
- `apps/web/app/(app)/whats-new/loading.tsx`
- `apps/web/app/(app)/whats-new/page.tsx`

New files/directories or reserved skeletons handed off by a blocker:

- Add tests beside the owned implementation only; no new cross-domain directory.

Consume the endpoint contracts owned by 21. API changes belong to those owners; this ticket owns caller conversion and cache effects.

## Endpoints, actions, pages and refresh sites

Rows retain their section/ordinal or exact source-line identifier from the independent inventory. Abbreviated table filenames are accompanied by the literal ownership manifest and exact source occurrences below. All action/page/fetch/refresh rows in owned files are in scope, including no-refresh callers and media navigation. Baseline observations do not override the spec's selected origins, route style, guest Bearer or new endpoints.

### Inventory 2.B page/type row at inventory line 224

| File (lines) | Gate (line) | Service / db / validators calls (line) | Params / searchParams | Redirect / notFound | Props to client components | Proposed GET endpoint(s) |
| --- | --- | --- | --- | --- | --- | --- |
| `app/(app)/autopilot/page.tsx` (53) | content.view L7 | `zoomConfigured()` L8; `autopilotService.listRules` L10; `recipeService.list` L11; `standingGrants.list` L12; `zoomService.listConnections` L13 (only if zoom configured); `planCountRequirement`, `hasFeature`, `workspaceAllowsCapability` | `searchParams.zoom` (notice) | none | `AutopilotPanel{newRuleRequirement,newRuleUpgradeTier,autopilotIncluded,canManageBilling,initialRules,recipes,zoomEnabled,zoomConnections,zoomNotice,canConnectZoom,canEdit,canRun,workspaceStatus,canTakeOver,finishingAvailable,grants[]}` | Existing `GET /api/autopilot/rules`, `GET /api/recipes`, `GET /api/zoom/connections` (zoom-http.ts L23). **NEW `GET /api/automation/standing-grants`** (`standingGrants.list`). **NEW** `zoomEnabled` flag: expose `zoomConfigured()` via `GET /api/session` `features.zoom` or `GET /api/zoom/status`. `autopilot/loading.tsx` (67) also calls `zoomConfigured()` L11; it needs the same flag without a fetch (cached session). |

### Inventory 2.B page/type row at inventory line 253

| File (lines) | Gate (line) | Service / db / validators calls (line) | Params / searchParams | Redirect / notFound | Props to client components | Proposed GET endpoint(s) |
| --- | --- | --- | --- | --- | --- | --- |
| `app/(app)/settings/automation-grants/page.tsx` (41) | content.view L10 | `standingGrants.list` L12; `autopilotService.listRules` L13; `socialOAuthService.listAccounts` L14; `hasFeature`, `workspaceAllowsCapability`, `featureUpgradePrompt` x2 | `searchParams.rule` | none | `GrantsPanel{grants,rules,accounts,canManage,reviewAvailable,autopilotUpgrade,reviewUpgrade,access,initialRuleId}` | **NEW `GET /api/automation/standing-grants`** (shared with autopilot), existing `GET /api/autopilot/rules`, `GET /api/social/accounts` |

### Inventory 2.B page/type row at inventory line 254

| File (lines) | Gate (line) | Service / db / validators calls (line) | Params / searchParams | Redirect / notFound | Props to client components | Proposed GET endpoint(s) |
| --- | --- | --- | --- | --- | --- | --- |
| `app/(app)/settings/notifications/page.tsx`, `settings/page.tsx`, `help/page.tsx`, `whats-new/page.tsx` | none (inherits `(app)` layout) | none | none | static; `settings/page.tsx` is `redirect("/settings/profile")` | none | none (stay in web). `help/page.tsx` imports `@/lib/docs-url`. |

### Inventory 5.8 refresh/fetch row at inventory line 827

| file:line | Trigger | Mutation | Refreshes |
| --- | --- | --- | --- |
| `grants-panel.tsx:364` (generic `run()`, also on failure) | Pause (:469) / revoke (:375) | `pauseStandingGrantAction`, `revokeStandingGrantAction` | Same |

### Inventory 5.8 refresh/fetch row at inventory line 828

| file:line | Trigger | Mutation | Refreshes |
| --- | --- | --- | --- |
| `(app)/autopilot/autopilot-panel.tsx:473` | Rule created | `POST /api/autopilot/rules` (:442) | `/autopilot` rules |

### Inventory 5.8 refresh/fetch row at inventory line 829

| file:line | Trigger | Mutation | Refreshes |
| --- | --- | --- | --- |
| `autopilot-panel.tsx:498` | Pause/resume | `PATCH /api/autopilot/rules/:id` (:479) | `/autopilot` |

### Inventory 5.8 refresh/fetch row at inventory line 830

| file:line | Trigger | Mutation | Refreshes |
| --- | --- | --- | --- |
| `autopilot-panel.tsx:522` | Take over | `POST .../rules/:id/take-over` (:505) | `/autopilot` |

### Inventory 5.8 refresh/fetch row at inventory line 831

| file:line | Trigger | Mutation | Refreshes |
| --- | --- | --- | --- |
| `autopilot-panel.tsx:546` | Run now | `POST .../rules/:id/run-now` (:529) | `/autopilot` |

### Inventory 5.8 refresh/fetch row at inventory line 832

| file:line | Trigger | Mutation | Refreshes |
| --- | --- | --- | --- |
| `autopilot-panel.tsx:577` | Delete rule | `DELETE .../rules/:id` (:560) | `/autopilot` |

### Inventory 5.8 refresh/fetch row at inventory line 833

| file:line | Trigger | Mutation | Refreshes |
| --- | --- | --- | --- |
| `autopilot-panel.tsx:1124` | Edit dialog saved | `PATCH .../rules/:id` (:1173) | `/autopilot` |

### Inventory 5.8 refresh/fetch row at inventory line 834

| file:line | Trigger | Mutation | Refreshes |
| --- | --- | --- | --- |
| `autopilot/zoom-connections.tsx:23` | Disconnect Zoom | `DELETE /api/zoom/connections/:id` (:21) | `/autopilot` (connections; rules pause) |

### Inventory 5.10 refresh/fetch row at inventory line 854

| Action file | Paths revalidated |
| --- | --- |
| `(app)/settings/automation-grants/actions.ts:10-11` | `/settings/automation-grants`, `/autopilot` |

### Inventory 5 exact file occurrences: apps/web/app/(app)/autopilot/autopilot-panel.tsx

```text
86: const response = await fetch(url, init);
473: startTransition(() => router.refresh());
498: startTransition(() => router.refresh());
522: startTransition(() => router.refresh());
546: startTransition(() => router.refresh());
577: startTransition(() => router.refresh());
1124: startTransition(() => router.refresh());
```

### Inventory 5 exact file occurrences: apps/web/app/(app)/autopilot/zoom-connections.tsx

```text
21: const response = await fetch(`/api/zoom/connections/${connection.id}`, { method: "DELETE" });
23: router.refresh();
```

### Inventory 5 exact file occurrences: apps/web/app/(app)/settings/automation-grants/actions.ts

```text
10: revalidatePath("/settings/automation-grants");
11: revalidatePath("/autopilot");
```

### Inventory 5 exact file occurrences: apps/web/app/(app)/settings/automation-grants/grants-panel.tsx

```text
202: router.refresh();
364: router.refresh();
```

Also account for the inventory's cross-domain traps: query-only actions, action forms that relied on revalidatePath, signed downloads/media, OAuth anchors, all three EventSource consumers and unload keepalive. Only the literal files above may be changed by this ticket.

### Inventory 1.3 function `createStandingGrantAction(input)`, caller conversion

| File:line | Function | Input | Service / auth calls | Policy helper + capability | Plan check | Returns | Side effects | Client callers | Target endpoint | Domain |
|---|---|---|---|---|---|---|---|---|---|---|
| `app/(app)/settings/automation-grants/actions.ts:14` | `createStandingGrantAction(input)` | `createStandingGrantSchema` | `standingGrants.create` | `executeWorkspaceActionWithInput("workspace.manage")` | none in action | `void` / failure | `revalidatePath("/settings/automation-grants")`, `/autopilot` | `settings/automation-grants/grants-panel.tsx:192` (`router.refresh`:202) | `POST /api/automation/standing-grants` | settings-integrations |

### Inventory 1.3 function `renewStandingGrantAction(input)`, caller conversion

| File:line | Function | Input | Service / auth calls | Policy helper + capability | Plan check | Returns | Side effects | Client callers | Target endpoint | Domain |
|---|---|---|---|---|---|---|---|---|---|---|
| `:22` | `renewStandingGrantAction(input)` | `renewStandingGrantSchema` | `standingGrants.renew` | same | none | same | same | `grants-panel.tsx:191` | `POST /api/automation/standing-grants/:grantId/renew` | settings-integrations |

### Inventory 1.3 function `pauseStandingGrantAction(grantId)`, caller conversion

| File:line | Function | Input | Service / auth calls | Policy helper + capability | Plan check | Returns | Side effects | Client callers | Target endpoint | Domain |
|---|---|---|---|---|---|---|---|---|---|---|
| `:29` | `pauseStandingGrantAction(grantId)` | `standingGrantReferenceSchema` | `standingGrants.pause` | same | none | same | same | `grants-panel.tsx:469` (`router.refresh`:364 in `run`) | `POST /api/automation/standing-grants/:grantId/pause` | settings-integrations |

### Inventory 1.3 function `revokeStandingGrantAction(grantId)`, caller conversion

| File:line | Function | Input | Service / auth calls | Policy helper + capability | Plan check | Returns | Side effects | Client callers | Target endpoint | Domain |
|---|---|---|---|---|---|---|---|---|---|---|
| `:36` | `revokeStandingGrantAction(grantId)` | `standingGrantReferenceSchema` | `standingGrants.revoke` | same | none | same | same | `grants-panel.tsx:375` | `POST /api/automation/standing-grants/:grantId/revoke` | settings-integrations |

## Acceptance criteria

- [x] Autopilot/grants pages/loading remove server reads and server actions, consume safe availability and parallel aggregate queries.
- [x] All owned rule/grant/Zoom refresh/action sites invalidate rules/grants/connections/recipes choices narrowly with existing recovery.
- [x] Status/role/plan and missing-Zoom UI states preserved; source connect uses authenticated JSON start and source disconnect exposes rule pause.
- [x] Static help/notifications/whats-new remain presentation-only under client shell; no invented data fetch.
- [ ] No unowned files changed; paired review findings and verification evidence recorded under Comments.

## Verification

Run these from the repository root after dependencies are installed. A command naming a new package script is implemented by the owning setup ticket, not silently skipped. PostgreSQL gates need a disposable schema; a skipped DB suite does not satisfy its gate. During the undeployed integration sequence, record any unrelated transitional compile failure with its owning blocker; this ticket's behavior tests must pass and the final integrated gates cannot be waived.

```sh
bun test "apps/web/app/(app)/autopilot" "apps/web/app/(app)/settings/automation-grants"
```

Verify the changed flow in the running Next app against the separate API origin. Follow the repo's runtime/browser verification guidance; record steps, result and origin pair. Do not treat compilation as browser evidence.

## Comments

Append claim, requested seam changes, paired review and evidence here.

Claimed and implemented by Claude (Sonnet 5.5), 2026-10-29. The last acceptance box ("No unowned files changed; paired review ...") stays open for the orchestrator: no unowned file was edited, no paired review ran, and no signed-in browser pass was done (ticket 32).

### What changed
- `/autopilot` and `/settings/automation-grants` pages are data-free `Suspense` shells. New client screens `autopilot/autopilot-screen.tsx` and `settings/automation-grants/grants-screen.tsx` read `GET /automation` (`automationOverviewQueryOptions`) and `GET /automation/standing-grants` (`standingGrantsQueryOptions`) with `useQuery`; the grants screen reads `workspace/bootstrap` in parallel (role and status for `AccessNote`). The existing `loading.tsx` skeletons are the pending state; failures show a retry state (offline wording, like Recipes/Billing).
- Panels take `api: {actions, createIntent?, changed}` (the Recipes pattern) instead of server actions/`fetch`/`router.refresh()`. `AutopilotPanel` props: `initialRules` renamed `rules`; `access.*` flags and `zoomEnabled` come from the aggregate; `?zoom=` notice from `useSearchParams`. Grants page builds both upgrade prompts with `featureUpgradePrompt(pricingTier, ...)`; `?rule=` is checked against the returned rules.
- Mutations are `useMutation`: rule create (one `runtime.createIntent()` per form, `complete()` on success), run-now (one key per rule, kept through failures, dropped on success), update, take-over, delete, grant create/renew/pause/revoke, Zoom disconnect. All invalidate through `invalidateAfterAutomationChange` (all `automation` keys + `projects/home`). Grant pause/revoke/create/renew refetch on failure too (the old `run()` refreshed on failure; a 409 duplicate/stale grant refetches).
- Zoom connect: `useConnectZoom` (exported from `zoom-connections.tsx`) calls `startZoomOAuth()` then `window.location.assign(authorizationUrl)`; used by the strip button and the "Connect Zoom first" link in the new-rule dialog (now a button). Disconnect awaits the DELETE then `changed()` (rules pause server-side and reappear paused).
- Deleted `settings/automation-grants/actions.ts`. `help`, `whats-new`, `settings/notifications` pages and loadings are static and import no backend module: unchanged. `autopilot/loading.tsx` no longer imports `zoomConfigured`.

### Deviations
- New files `autopilot-screen.tsx` and `grants-screen.tsx` (the shell needs a client entry; same as Billing/Recipes). The ticket's ownership list does not name them.
- `autopilot/loading.tsx` cannot know whether Zoom is configured without the data (no session flag exists; the spec makes it an aggregate flag). The skeleton now omits the Zoom strip and uses the non-Zoom header wording; with Zoom on, the strip and wording appear when data arrives.
- Messages shown for failed commands are now `ApiError.message` (network error keeps its fixed text), replacing the old `payload.message ?? payload.error`.

### Evidence
- `bun test "apps/web/app/(app)/autopilot" "apps/web/app/(app)/settings/automation-grants"` -> 20 pass (panels render with a stub `api`; Connect Zoom is a button, no `/api/zoom/oauth/start` link).
- `bunx biome check` on all owned directories (autopilot, automation-grants, help, whats-new, settings/notifications): clean.
- `bun run --cwd apps/web typecheck`: no error in any owned file (28 errors remain, all in other tickets' files).
- NOT done: no interaction tests (click flows need the happy-dom fixture) and no browser run. Ticket 32 must cover: rule create/pause/resume/take-over/run-now/edit/delete with a lost-response retry (same key), Zoom connect (JSON start -> Zoom -> `/autopilot?zoom=connected|...`), Zoom disconnect pausing rules, grant create/renew/pause/revoke, restricted-owner and viewer states, Zoom-disabled deployment.

### Requests for other owners
- 31: `apps/web/lib/authenticated-request-inventory.ts` still lists `settings/automation-grants/actions.ts` and the Zoom GET start rows.
