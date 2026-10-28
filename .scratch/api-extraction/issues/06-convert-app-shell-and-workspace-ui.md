# 06. Convert app shell and Workspace UI

**What to build:** The shell, settings, auth continuation, Workspace switch, invite and new-Workspace screens use API queries/mutations and preserve recovery navigation.

**Blocked by:** [05 - Expose session and Workspace controls](05-expose-session-and-workspace-controls.md), [07 - Move billing API and convert billing UI](07-move-billing-api-and-convert-billing-ui.md)

**Status:** done

**Suggested implementer:** Claude. The other pairing side reviews and returns findings to this owner.

Read [spec.md](../spec.md). It is the complete contract; the original brief/plan/reviews are not prerequisites. Claim this ticket before editing.

## Exact ownership

Paths are repo-relative. Every existing file below is exclusively assigned for this phase, including files that only need verification. A new `/**` directory includes its local tests/helpers, not adjacent directories. Read other files as evidence; do not edit them.

Existing files:

- `apps/web/app/(app)/_actions/workspace.ts`
- `apps/web/app/(app)/_components/account-menu.tsx`
- `apps/web/app/(app)/_components/app-chrome.tsx`
- `apps/web/app/(app)/_components/censor-word-list-dialog.tsx`
- `apps/web/app/(app)/_components/feature-hero.tsx`
- `apps/web/app/(app)/_components/mobile-nav.tsx`
- `apps/web/app/(app)/_components/nav-items.ts`
- `apps/web/app/(app)/_components/project-workspace.module.css`
- `apps/web/app/(app)/_components/project-workspace.tsx`
- `apps/web/app/(app)/_components/settings-chrome.tsx`
- `apps/web/app/(app)/_components/shell-panel.tsx`
- `apps/web/app/(app)/_components/sidebar.tsx`
- `apps/web/app/(app)/_components/theme-toggle.tsx`
- `apps/web/app/(app)/_components/use-settings-return.ts`
- `apps/web/app/(app)/_components/workspace-status-notice.test.tsx`
- `apps/web/app/(app)/_components/workspace-status-notice.tsx`
- `apps/web/app/(app)/_components/workspace-switcher.tsx`
- `apps/web/app/(app)/_shared/caption-preset-backdrops.ts`
- `apps/web/app/(app)/_shared/caption-preset-gallery.tsx`
- `apps/web/app/(app)/_shared/caption-preset-preview.tsx`
- `apps/web/app/(app)/_shared/choice-chip.tsx`
- `apps/web/app/(app)/_shared/languages.ts`
- `apps/web/app/(app)/_shared/moment-suggestions.tsx`
- `apps/web/app/(app)/_shared/processing-timeline.tsx`
- `apps/web/app/(app)/_shared/settings-fields.tsx`
- `apps/web/app/(app)/_shared/style-thumb.tsx`
- `apps/web/app/(app)/_shared/tone-chips.tsx`
- `apps/web/app/(app)/error.tsx`
- `apps/web/app/(app)/layout.tsx`
- `apps/web/app/(app)/loading.tsx`
- `apps/web/app/(app)/not-found.tsx`
- `apps/web/app/(app)/settings/_components/access-note.test.tsx`
- `apps/web/app/(app)/settings/_components/access-note.tsx`
- `apps/web/app/(app)/settings/_components/settings-skeleton.tsx`
- `apps/web/app/(app)/settings/_components/settings-ui.tsx`
- `apps/web/app/(app)/settings/layout.tsx`
- `apps/web/app/(app)/settings/members/loading.tsx`
- `apps/web/app/(app)/settings/members/members-panel.test.tsx`
- `apps/web/app/(app)/settings/members/members-panel.tsx`
- `apps/web/app/(app)/settings/members/page.tsx`
- `apps/web/app/(app)/settings/page.tsx`
- `apps/web/app/(app)/settings/profile/loading.tsx`
- `apps/web/app/(app)/settings/profile/page.tsx`
- `apps/web/app/(app)/settings/profile/passkey-settings.tsx`
- `apps/web/app/(app)/settings/workspace/censor-words-actions.ts`
- `apps/web/app/(app)/settings/workspace/censor-words-card.tsx`
- `apps/web/app/(app)/settings/workspace/loading.tsx`
- `apps/web/app/(app)/settings/workspace/page.tsx`
- `apps/web/app/(app)/settings/workspace/performance-guidance-field.test.tsx`
- `apps/web/app/(app)/settings/workspace/performance-guidance-field.tsx`
- `apps/web/app/(app)/settings/workspace/workspace-avatar-control.tsx`
- `apps/web/app/_components/auth/auth-form.browser.fixture.tsx`
- `apps/web/app/_components/auth/auth-form.tsx`
- `apps/web/app/_components/auth/auth-modal.tsx`
- `apps/web/app/_components/auth/auth-mode-tabs.tsx`
- `apps/web/app/_components/auth/clerk-error.ts`
- `apps/web/app/_components/auth/form-error.tsx`
- `apps/web/app/_components/auth/password-input.tsx`
- `apps/web/app/_components/auth/resend-button.tsx`
- `apps/web/app/_components/auth/sign-in-methods.tsx`
- `apps/web/app/_components/authenticated-action-form.tsx`
- `apps/web/app/auth/continue/clerk-oauth-continuation.tsx`
- `apps/web/app/auth/continue/error.tsx`
- `apps/web/app/auth/continue/page.tsx`
- `apps/web/app/caption-fonts.test.ts`
- `apps/web/app/caption-fonts.ts`
- `apps/web/app/global-error.tsx`
- `apps/web/app/invite/[token]/actions.ts`
- `apps/web/app/invite/[token]/invite-view.tsx`
- `apps/web/app/invite/[token]/page.tsx`
- `apps/web/app/layout.tsx`
- `apps/web/app/opengraph-image.tsx`
- `apps/web/app/robots.ts`
- `apps/web/app/sso-callback/[[...sso-callback]]/page.tsx`
- `apps/web/app/workspace-unavailable/open-workspace-button.tsx`
- `apps/web/app/workspace-unavailable/page.tsx`
- `apps/web/app/workspace-unavailable/workspace-unavailable-view.tsx`
- `apps/web/app/workspaces/new/actions.ts`
- `apps/web/app/workspaces/new/checkout-request.test.ts`
- `apps/web/app/workspaces/new/checkout-request.ts`
- `apps/web/app/workspaces/new/create-workspace-form.tsx`
- `apps/web/app/workspaces/new/new-workspace-screen.tsx`
- `apps/web/app/workspaces/new/page.tsx`
- `apps/web/lib/account-display.ts`
- `apps/web/lib/auth-entry.ts`
- `apps/web/lib/auth-flow.test.ts`
- `apps/web/lib/auth-flow.ts`
- `apps/web/lib/auth-form.test.ts`
- `apps/web/lib/auth-server.contract.fixture.ts`
- `apps/web/lib/docs-url.ts`
- `apps/web/lib/format.test.ts`
- `apps/web/lib/format.ts`
- `apps/web/lib/motion-options.ts`
- `apps/web/lib/navigation-actions.test.ts`
- `apps/web/lib/navigation-actions.ts`
- `apps/web/lib/personal-workspace-auth.test.ts`
- `apps/web/lib/post-auth-redirect.test.ts`
- `apps/web/lib/post-auth-redirect.ts`
- `apps/web/lib/safe-redirect.test.ts`
- `apps/web/lib/safe-redirect.ts`
- `apps/web/lib/settings-return.test.ts`
- `apps/web/lib/settings-return.ts`
- `apps/web/lib/workspace-entry.db.fixture.ts`

New files/directories or reserved skeletons handed off by a blocker:

- `apps/web/app/_components/query-mutation-form.tsx`
- `apps/web/app/_components/workspace-query-gate.tsx`

settings/actions.ts remains owned by 25 until its final removal. Convert your seven workspace/member callers without editing that shared file. Consume 07 billing hooks in account-menu/shell. Other domains keep imported settings UI props frozen.

Consume the endpoint contracts owned by 05. API changes belong to those owners; this ticket owns caller conversion and cache effects.

## Endpoints, actions, pages and refresh sites

Rows retain their section/ordinal or exact source-line identifier from the independent inventory. Abbreviated table filenames are accompanied by the literal ownership manifest and exact source occurrences below. All action/page/fetch/refresh rows in owned files are in scope, including no-refresh callers and media navigation. Baseline observations do not override the spec's selected origins, route style, guest Bearer or new endpoints.

### Inventory 2.A page/type row at inventory line 210

| File (lines) | Data loaded (line) | Gate | Redirect / notFound | Props to client components | Proposed GET |
| --- | --- | --- | --- | --- | --- |
| `app/layout.tsx` (97) | `billingService.validateConfiguration({surface:"web"})` L63, `validateCoreEnv()` L62 (config assertions, no data) | none | none | `ClerkProvider`, `Provider`, `AuthModal` | none. Drop `billingService.validateConfiguration` from web (API validates Stripe config at boot). Keeps `process.env.NEXT_PUBLIC_APP_URL` for `metadataBase`. |

### Inventory 2.A page/type row at inventory line 211

| File (lines) | Data loaded (line) | Gate | Redirect / notFound | Props to client components | Proposed GET |
| --- | --- | --- | --- | --- | --- |
| `app/(app)/layout.tsx` (84) | `admitOptionalWorkspacePage("content.view")` L16; `getCachedUsageSummary` L23 (`projectService.getUsageSummary`); `listUserWorkspaces` (`@narriflow/auth`) L24; `billingService.readBillingState` L25; `workspaceService.getAvatarUrls` L27 | `admitOptionalWorkspacePage("content.view")`, `workspaceAllowsCapability(..."billing.manage"\|"api.manage"\|"members.invite")`, `hasFeature(..."workspace.members")` | signed out: `redirect("/?auth=sign-in")` L19 | `UpgradeProvider{currentTier,billingMode,canManageBilling}`; `AppChrome{email,firstName,lastName,imageUrl,remainingCredits,usedCredits,reservedCredits,limitCredits,creditsRenewAt,activeWorkspaceId,workspaceSelectionChanged,workspaceRole,workspaceStatus,workspaceTier,workspaces[{id,name,role,isPersonal,avatarUrl}],workspaceMenu{tier,canManageApi,canInvite,planAction}}` | **NEW `GET /api/session`** returning actor identity, active workspace (`id,name,role,status,pricingTier,isPersonal,workspaceSelectionChanged`), `workspaces[]` with avatar URLs, and `usage` summary. Billing view reuses existing `GET /api/billing/state` (`{view}`) so `billingMode` stays derived client-side via `lib/billing-view-model.ts`. Optional: fold `usage` into session since the shell and Billing/Usage/Upload/Project pages all need it (query key `["usage"]`). |

### Inventory 2.A page/type row at inventory line 212

| File (lines) | Data loaded (line) | Gate | Redirect / notFound | Props to client components | Proposed GET |
| --- | --- | --- | --- | --- | --- |
| `app/(app)/settings/layout.tsx` (6) | `admitWorkspacePage("content.view")` L4 | content.view | gate redirects only | `children` | covered by `GET /api/session` (no extra fetch; guard is the same admission) |

### Inventory 2.B page/type row at inventory line 246

| File (lines) | Gate (line) | Service / db / validators calls (line) | Params / searchParams | Redirect / notFound | Props to client components | Proposed GET endpoint(s) |
| --- | --- | --- | --- | --- | --- | --- |
| `app/(app)/settings/profile/page.tsx` (43) | content.view L12 | `workspaceService.getWorkspace` L13 | none | none | `PasskeySettings` (client, `@clerk/nextjs` `useUser`); name/initials from actor | Session (`/api/session`) + **NEW `GET /api/workspace`** (name). Passkeys stay Clerk-client-side. |

### Inventory 2.B page/type row at inventory line 247

| File (lines) | Gate (line) | Service / db / validators calls (line) | Params / searchParams | Redirect / notFound | Props to client components | Proposed GET endpoint(s) |
| --- | --- | --- | --- | --- | --- | --- |
| `app/(app)/settings/workspace/page.tsx` (94) | content.view L24 | `workspaceService.getWorkspace` L25; `performanceService.guidance` L29; `autoCensorService.getWorkspaceWords` L30; `workspaceService.getAvatarUrls` L32 | none | returns `null` if workspace missing (L27) | `WorkspaceAvatarControl{avatarUrl,workspaceName,canManage}`, `AuthenticatedActionForm{action: updateWorkspaceAction}` (name, timezone), `PerformanceGuidanceField{enabled,qualifies,minimumClips,canManage}`, `CensorWordsCard{initialWords,customized,canManage}` | **NEW `GET /api/workspace`** (id,name,timezone,status; avatar URL included), **NEW `GET /api/performance/guidance`**, **NEW `GET /api/workspace/censor-words`**. |

### Inventory 2.B page/type row at inventory line 248

| File (lines) | Gate (line) | Service / db / validators calls (line) | Params / searchParams | Redirect / notFound | Props to client components | Proposed GET endpoint(s) |
| --- | --- | --- | --- | --- | --- | --- |
| `app/(app)/settings/members/page.tsx` (28) | content.view L8 | `workspaceService.listMembers` L10; `billingService.readBillingState` L11; `hasFeature(billingView.plan,"workspace.members")` | none | none | `MembersPanel{actorRole,isBusiness,workspaceStatus,billingView,members[],invites[]}` (dates serialised to ISO) | **NEW `GET /api/workspace/members`** (`{members, invites}`), existing `GET /api/billing/state` |

### Inventory 2.B page/type row at inventory line 255

| File (lines) | Gate (line) | Service / db / validators calls (line) | Params / searchParams | Redirect / notFound | Props to client components | Proposed GET endpoint(s) |
| --- | --- | --- | --- | --- | --- | --- |
| `app/invite/[token]/page.tsx` (23) | `admitSignedInPage("/invite/:token")` L11 | `workspaceService.getInvitePreview(token)` L11 (parallel with admission) | params `token` | none (renders `InviteUnavailable` when null) | `InviteCard{workspaceName,role,email,expiresAt,action: acceptWorkspaceInviteAction.bind(null, token)}` | **NEW `GET /api/invites/:token`** (signed-in session, returns preview or 404). Accept is the actions fork's. |

### Inventory 2.B page/type row at inventory line 256

| File (lines) | Gate (line) | Service / db / validators calls (line) | Params / searchParams | Redirect / notFound | Props to client components | Proposed GET endpoint(s) |
| --- | --- | --- | --- | --- | --- | --- |
| `app/workspace-unavailable/page.tsx` (22) | `admitSignedInPage("/home")` L12 | `listUserWorkspaces(actor.actorUserId)` (`@narriflow/auth`) L13; `workspaceAllowsCapability` | none | none | `WorkspaceUnavailableView{workspaces[{id,name,paused,canOpen}]}` | `GET /api/session` (its `workspaces[]`) or **NEW `GET /api/workspaces`**. Must work when the *active* workspace is restricted (so this call is identity-only, `signedInAuthenticatedRequestPolicy`). |

### Inventory 2.B page/type row at inventory line 257

| File (lines) | Gate (line) | Service / db / validators calls (line) | Params / searchParams | Redirect / notFound | Props to client components | Proposed GET endpoint(s) |
| --- | --- | --- | --- | --- | --- | --- |
| `app/workspaces/new/page.tsx` (8) | `admitSignedInPage("/workspaces/new")` L5 | none | none | none | `NewWorkspaceScreen` | none (identity guard only; client checks session). |

### Inventory 2.B page/type row at inventory line 258

| File (lines) | Gate (line) | Service / db / validators calls (line) | Params / searchParams | Redirect / notFound | Props to client components | Proposed GET endpoint(s) |
| --- | --- | --- | --- | --- | --- | --- |
| `app/auth/continue/page.tsx` (22) | `admitSignedInPage(redirect_url ?? "/home")` L14 (this call provisions the personal workspace and syncs Clerk) | `headers()` (host, `x-forwarded-proto`), `resolvePostAuthRedirect(destination, origin, CLERK_OAUTH_ISSUER, CLERK_OAUTH_CONSENT_ORIGIN)` | `searchParams.redirect_url` | `redirect(target.href)` L21 when same-origin; otherwise renders `ClerkOAuthContinuation{href}` | `ClerkOAuthContinuation` (client, `@clerk/nextjs`) | **NEW `POST /api/session/bootstrap`** (identity admission + personal-workspace provisioning; returns 204/`{workspaceId}`). Web page keeps `resolvePostAuthRedirect` (pure) and does the final redirect client-side. Env `CLERK_OAUTH_ISSUER`, `CLERK_OAUTH_CONSENT_ORIGIN` read by both sides unless resolved API-side. |

### Inventory 2.B page/type row at inventory line 261

| File (lines) | Gate (line) | Service / db / validators calls (line) | Params / searchParams | Redirect / notFound | Props to client components | Proposed GET endpoint(s) |
| --- | --- | --- | --- | --- | --- | --- |
| `app/sso-callback/[[...sso-callback]]/page.tsx`, `app/(home)/page.tsx`, `(marketing)/**`, `(docs)/**`, `prototype/**` | none | no service/db/auth imports | n/a | n/a | n/a | stay in web unchanged |









### Inventory 5.0 refresh/fetch row at inventory line 657

| Metric | Count |
| --- | --- |
| Raw `router.refresh()` matches | 83 lines in 48 files |

### Inventory 5.0 refresh/fetch row at inventory line 659

| Metric | Count |
| --- | --- |
| **Real `router.refresh()` calls** | **75 calls in 45 files** |

### Inventory 5.0 refresh/fetch row at inventory line 661

| Metric | Count |
| --- | --- |
| Client `fetch(` call expressions (excl. docs, server code, tests, code snippets) | 102 in 50 files (includes presigned-storage PUTs and a few non-`/api` URLs) |

### Inventory 5.0 refresh/fetch row at inventory line 662

| Metric | Count |
| --- | --- |
| `new EventSource(` | 3 (`project-events-provider.tsx:143`, `export-delivery-client.tsx:155`, `upload/_lib/use-ingest-stream.ts:62`), all against `GET /api/stream/:projectId?sinceSeq=` |

### Inventory 5.0 refresh/fetch row at inventory line 663

| Metric | Count |
| --- | --- |
| `XMLHttpRequest` | 1 (`upload/_lib/upload-session-browser.ts:442`, PUT of upload parts to a presigned URL, for progress events) |

### Inventory 5.0 refresh/fetch row at inventory line 664

| Metric | Count |
| --- | --- |
| `navigator.sendBeacon` / `new Request(` | 0 / 0 (a `fetch(... keepalive: true)` stands in at `studio-editing-session-browser.ts:502`) |

### Inventory 5.0 refresh/fetch row at inventory line 666

| Metric | Count |
| --- | --- |
| Inline `"use server"` closures in `studio/page.tsx` called by the client | 6: `fetchPreviewStatus`, `fetchAutoLayoutAnalysis`, `fetchSplitLayoutAnalysis`, `fetchScreenLayoutAnalysis`, `updateProjectCensorTerms`, `recordAutoCensorEvent` (lines 225-266); consumed at `studio-shell.tsx:949-1123` and `censor-panel.tsx:97,317` |

### Inventory 5.0 refresh/fetch row at inventory line 667

| Metric | Count |
| --- | --- |
| `useRouter` importers | 68 files; `router.push|replace` call sites: 45 (navigation only) |

### Inventory 5.1 refresh/fetch row at inventory line 678

| file:line | Trigger | Mutation just performed | Refreshes |
| --- | --- | --- | --- |
| `app/_components/auth/auth-form.tsx:65` | Clerk sign-in/sign-up finished (`signInHook.setActive`) then `router.replace(completion)` | Clerk client SDK (not the Narriflow backend) | Root and `(app)` layout so server auth state is re-read; becomes session reset plus `queryClient.clear()` |

### Inventory 5.1 refresh/fetch row at inventory line 679

| file:line | Trigger | Mutation just performed | Refreshes |
| --- | --- | --- | --- |
| `(app)/_components/app-chrome.tsx:88` | Workspace banner "switch" button | `switchWorkspaceAction(workspaceId)` (:77) | Whole `(app)` tree: layout chip, usage, current page. Action also does `revalidatePath("/", "layout")` |

### Inventory 5.1 refresh/fetch row at inventory line 680

| file:line | Trigger | Mutation just performed | Refreshes |
| --- | --- | --- | --- |
| `(app)/_components/workspace-switcher.tsx:62` | Workspace switcher menu item | `switchWorkspaceAction` (:51) | Same |

### Inventory 5.1 refresh/fetch row at inventory line 682

| file:line | Trigger | Mutation just performed | Refreshes |
| --- | --- | --- | --- |
| `(app)/settings/members/members-panel.tsx:156` | Invite form submit | `inviteMemberAction({email, role})` (:143) | `/settings/members` (members, invites, seat counts) |

### Inventory 5.1 refresh/fetch row at inventory line 683

| file:line | Trigger | Mutation just performed | Refreshes |
| --- | --- | --- | --- |
| `members-panel.tsx:175` | "Resend" | `resendInviteAction(inviteId)` (:164) | `/settings/members` |

### Inventory 5.1 refresh/fetch row at inventory line 684

| file:line | Trigger | Mutation just performed | Refreshes |
| --- | --- | --- | --- |
| `members-panel.tsx:191` | "Revoke" invite | `revokeInviteAction(inviteId)` (:181) | `/settings/members` |

### Inventory 5.1 refresh/fetch row at inventory line 685

| file:line | Trigger | Mutation just performed | Refreshes |
| --- | --- | --- | --- |
| `members-panel.tsx:211` | Role select (refreshes even on failure) | `changeMemberRoleAction(memberId, role)` (:207) | `/settings/members` (+ seat billing line) |

### Inventory 5.1 refresh/fetch row at inventory line 686

| file:line | Trigger | Mutation just performed | Refreshes |
| --- | --- | --- | --- |
| `members-panel.tsx:223` | "Remove" member (refreshes even on failure) | `removeMemberAction(memberId)` (:219) | `/settings/members` |

### Inventory 5.1 refresh/fetch row at inventory line 687

| file:line | Trigger | Mutation just performed | Refreshes |
| --- | --- | --- | --- |
| `(app)/settings/workspace/workspace-avatar-control.tsx:43` | Avatar file chosen | `POST /api/workspace/avatar/presign` (:28), `PUT` presigned URL (:35), `PATCH /api/workspace/avatar {storageKey}` (:37) | `/settings/workspace` and layout workspace chip |

### Inventory 5.1 refresh/fetch row at inventory line 688

| file:line | Trigger | Mutation just performed | Refreshes |
| --- | --- | --- | --- |
| `workspace-avatar-control.tsx:55` | "Remove" avatar | `PATCH /api/workspace/avatar {storageKey:null}` (:53) | Same |

### Inventory 5.10 refresh/fetch row at inventory line 852

| Action file | Paths revalidated |
| --- | --- |
| `(app)/_actions/workspace.ts:16` | `/` (layout) |

### Inventory 5.10 refresh/fetch row at inventory line 853

| Action file | Paths revalidated |
| --- | --- |
| `(app)/settings/actions.ts:71-72,84-85,102,135,173,190,218,253,283,293,303` | `/` (layout), `/settings/workspace`, `/performance`, `/settings/members`, `/settings/api` |

### Inventory 5.10 refresh/fetch row at inventory line 855

| Action file | Paths revalidated |
| --- | --- |
| `(app)/settings/workspace/censor-words-actions.ts:14` | `/settings/workspace` |

### Inventory 5.10 refresh/fetch row at inventory line 863

| Action file | Paths revalidated |
| --- | --- |
| `invite/[token]/actions.ts:36` | `redirect("/home")` only |

### Inventory 5.12 refresh/fetch row at inventory line 889

| Consumer | Connects when | What it does with events |
| --- | --- | --- |
| `projects/[projectId]/project-events-provider.tsx:143` (`ProjectEventsProvider`, mounted once at `projects/[projectId]/page.tsx:500`) | Page mount; effect re-keys on `projectId`/`initialSeq` (a new `initialSeq` arrives with every `router.refresh()`) | Parses with `parseWorkflowEventMessage`, dedups by `workflowEventRowIdentity`, keeps `events` (cap `PROJECT_EVENT_ROW_LIMIT`) and `latestByStage` in context; terminal event -> immediate `router.refresh()` (once per terminal identity); other events -> `scheduleIncrementalRefresh` (5 s throttle with trailing call); `authorization.revoked` -> recover or `router.refresh()` |

### Inventory 5.13 refresh/fetch row at inventory line 904

| file:line | Behavior |
| --- | --- |
| `app/sso-callback/[[...sso-callback]]/page.tsx:25` | "Try again" `reload()` |

### Inventory 5.13 refresh/fetch row at inventory line 905

| file:line | Behavior |
| --- | --- |
| `workspaces/new/create-workspace-form.tsx:28` | `assign(checkoutUrl)` (Stripe) |

### Inventory 5.13 refresh/fetch row at inventory line 906

| file:line | Behavior |
| --- | --- |
| `(app)/_components/account-menu.tsx:97` | `assign(portal url)` |

### Inventory 5.13 refresh/fetch row at inventory line 907

| file:line | Behavior |
| --- | --- |
| `settings/billing/billing-plans.tsx:248,285,362,411` | `assign(checkout/portal/payment url)` |

### Inventory 5.13 refresh/fetch row at inventory line 908

| file:line | Behavior |
| --- | --- |
| `projects/[projectId]/transcript-panel.tsx:415` | `assign(/api/.../transcript/export?...)` download |

### Inventory 5.13 refresh/fetch row at inventory line 909

| file:line | Behavior |
| --- | --- |
| `projects/[projectId]/dubbing-panel.tsx:353` | `assign(downloadUrl)` |

### Inventory 5.14 refresh/fetch row at inventory line 915

| file:line | Call | Disposition |
| --- | --- | --- |
| `(docs)/_components/search/search-dialog.tsx:32` | `GET /api/docs/search?query=` | Docs; stays in web with `app/api/docs/search/route.ts` unless the owner moves docs search |

### Inventory 5.14 refresh/fetch row at inventory line 916

| file:line | Call | Disposition |
| --- | --- | --- |
| `(docs)/_components/page/copy-page-menu.tsx:45` | `GET <markdownPath>` (`/docs-markdown/...`) | Docs; stays in web |

### Inventory 5.14 refresh/fetch row at inventory line 917

| file:line | Call | Disposition |
| --- | --- | --- |
| `(docs)/_components/api/playground.tsx:86` | `fetch(request.url)` against the public REST API (user-supplied key) | Docs; needs the API's public base URL from config rather than same-origin `/api` |

### Inventory 5.14 refresh/fetch row at inventory line 918

| file:line | Call | Disposition |
| --- | --- | --- |
| `(docs)/_components/api/snippets.ts:164,216` | Generated code strings only | No runtime fetch |

### Inventory 5 exact file occurrences: apps/web/app/(app)/_actions/workspace.ts

```text
16: revalidatePath("/", "layout");
```

### Inventory 5 exact file occurrences: apps/web/app/(app)/_components/account-menu.tsx

```text
94: const response = await fetch("/api/billing/portal", { method: "POST" });
97: window.location.assign(body.url);
```

### Inventory 5 exact file occurrences: apps/web/app/(app)/_components/app-chrome.tsx

```text
88: router.refresh();
```

### Inventory 5 exact file occurrences: apps/web/app/(app)/_components/workspace-switcher.tsx

```text
62: router.refresh();
```

### Inventory 5 exact file occurrences: apps/web/app/(app)/settings/members/members-panel.tsx

```text
156: router.refresh();
175: router.refresh();
191: router.refresh();
211: router.refresh();
223: router.refresh();
```

### Inventory 5 exact file occurrences: apps/web/app/(app)/settings/workspace/censor-words-actions.ts

```text
14: revalidatePath("/settings/workspace");
```

### Inventory 5 exact file occurrences: apps/web/app/(app)/settings/workspace/workspace-avatar-control.tsx

```text
28: const presign = await fetch("/api/workspace/avatar/presign", {
35: const stored = await fetch(signed.uploadUrl, { method: "PUT", headers: { "Content-Type": signed.contentType }, body: file });
37: const saved = await fetch("/api/workspace/avatar", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ storageKey: signed.key }) });
43: router.refresh();
53: const response = await fetch("/api/workspace/avatar", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ storageKey: null }) });
55: router.refresh();
```

### Inventory 5 exact file occurrences: apps/web/app/_components/auth/auth-form.tsx

```text
65: router.refresh();
```

### Inventory 5 exact file occurrences: apps/web/app/sso-callback/[[...sso-callback]]/page.tsx

```text
25: <Button onClick={() => window.location.reload()}>Try again</Button>
```

### Inventory 5 exact file occurrences: apps/web/app/workspaces/new/create-workspace-form.tsx

```text
28: if (state.checkoutUrl) window.location.assign(state.checkoutUrl);
```

### Inventory 1.1 function `switchWorkspaceAction(workspaceId)`, caller conversion

| File:line | Function | Input | Service / auth calls | Policy helper + capability | Plan check | Returns | Side effects | Client callers | Target endpoint | Domain |
|---|---|---|---|---|---|---|---|---|---|---|
| `app/(app)/_actions/workspace.ts:13` | `switchWorkspaceAction(workspaceId)` | `workspaceSelectionActionSchema` `{workspaceId}` | `setActiveWorkspaceForActor` (`@narriflow/auth`; membership check + **sets cookie**) | `executeSignedInActionWithInput` (deliberately not workspace-scoped: a member of a paused workspace needs a way out) | none | `void` / `AuthenticatedActionFailure` | `revalidatePath("/", "layout")` | `app/workspace-unavailable/open-workspace-button.tsx:25` (then `router.push("/home")`), `app/(app)/projects/_components/workspace-mismatch-notice.tsx:49` (`router.push`+`router.refresh`), `app/(app)/integrations/mcp/workspace-billing-link.tsx:27` (`router.push`), `app/(app)/_components/workspace-switcher.tsx:51` (`router.refresh`:62), `app/(app)/_components/app-chrome.tsx:77` (`router.refresh`:88) | Client-only: store selected workspace id and send as header; optionally `POST /api/me/active-workspace` that validates membership and returns the workspace context. On success clients invalidate **all** queries. | workspace |

### Inventory 1.1 function `acceptWorkspaceInviteAction(token)`, caller conversion

| File:line | Function | Input | Service / auth calls | Policy helper + capability | Plan check | Returns | Side effects | Client callers | Target endpoint | Domain |
|---|---|---|---|---|---|---|---|---|---|---|
| `app/invite/[token]/actions.ts:12` | `acceptWorkspaceInviteAction(token)` | `workspaceInviteAcceptanceActionSchema` `{token}` | `workspaceMembershipService.acceptInvite`, `setActiveWorkspaceForActor` (cookie) | `executeSignedInActionWithInput` | none | on failure `{ok:false, error, code, message}`; on success **`redirect("/home")`** | `redirect("/home")`; sets active-workspace cookie | `app/invite/[token]/page.tsx:20` via `action={acceptWorkspaceInviteAction.bind(null, token)}` into `invite-view.tsx:102` `AuthenticatedActionForm` | `POST /api/invites/:token/accept` -> `{workspaceId}`; client then sets active workspace and navigates to `/home` | workspace |

### Inventory 1.2 function `updateWorkspaceAction(formData)`, caller conversion

| File:line | Function | Input | Service / auth calls | Policy helper + capability | Plan check | Returns | Side effects | Client callers | Target endpoint | Domain |
|---|---|---|---|---|---|---|---|---|---|---|
| `app/(app)/settings/actions.ts:56` | `updateWorkspaceAction(formData)` | `workspaceSettingsActionSchema` `{name, timezone}` from `name`, `timezone` form fields | `workspaceService.updateWorkspace(actorUserId, workspaceId, {name,timezone})` | `executeWorkspaceActionWithInput("workspace.manage")` | none | `void` / failure | `revalidatePath("/", "layout")`, `/settings/workspace` | `app/(app)/settings/workspace/page.tsx:57` (`AuthenticatedActionForm action=`) | `PATCH /api/workspace` | settings-integrations |

### Inventory 1.2 function `updatePerformanceGuidanceAction(formData)`, caller conversion

| File:line | Function | Input | Service / auth calls | Policy helper + capability | Plan check | Returns | Side effects | Client callers | Target endpoint | Domain |
|---|---|---|---|---|---|---|---|---|---|---|
| `:77` | `updatePerformanceGuidanceAction(formData)` | `performanceGuidanceSettingActionSchema` `{enabled}` (`enabled === "on"`) | `performanceService.setGuidanceEnabled(appUser, enabled)` | `executeWorkspaceActionWithInput("workspace.manage")` | none | `void` / failure | `revalidatePath("/settings/workspace")`, `/performance` | `settings/workspace/page.tsx:77` | `PATCH /api/workspace/performance-guidance` | settings-integrations |

### Inventory 1.2 function `inviteMemberAction({email, role})`, caller conversion

| File:line | Function | Input | Service / auth calls | Policy helper + capability | Plan check | Returns | Side effects | Client callers | Target endpoint | Domain |
|---|---|---|---|---|---|---|---|---|---|---|
| `:90` | `inviteMemberAction({email, role})` | `workspaceInviteActionSchema` | `workspaceService.createInvite`, **`sendEmail` (`@narriflow/email`)** via local `deliverWorkspaceInvite`; invite URL built from `process.env.NEXT_PUBLIC_APP_URL` (fallback `http://localhost:3000`) + `/invite/:token`, email idempotency key `workspace-invite/${id}` | `executeWorkspaceActionWithInput("members.invite")` | none at action layer (seat limits inside service) | `{ok:true, inviteUrl, emailSent}` / `{ok:false, error, errorCode, requestId}` (double try/catch via `authenticatedActionResultError`) | `revalidatePath("/settings/members")` | `app/(app)/settings/members/members-panel.tsx:143` (`router.refresh`:156) | `POST /api/workspace/invites` | workspace |

### Inventory 1.2 function `resendInviteAction(inviteId)`, caller conversion

| File:line | Function | Input | Service / auth calls | Policy helper + capability | Plan check | Returns | Side effects | Client callers | Target endpoint | Domain |
|---|---|---|---|---|---|---|---|---|---|---|
| `:126` | `resendInviteAction(inviteId)` | `workspaceInviteReferenceActionSchema` `{inviteId}` | `workspaceService.resendInvite`, same email delivery | `executeWorkspaceActionWithInput("members.invite")` | none | same shape as invite | `revalidatePath("/settings/members")` | `members-panel.tsx:164` (`router.refresh`:175) | `POST /api/workspace/invites/:inviteId/resend` | workspace |

### Inventory 1.2 function `revokeInviteAction(inviteId)`, caller conversion

| File:line | Function | Input | Service / auth calls | Policy helper + capability | Plan check | Returns | Side effects | Client callers | Target endpoint | Domain |
|---|---|---|---|---|---|---|---|---|---|---|
| `:169` | `revokeInviteAction(inviteId)` | `workspaceInviteReferenceActionSchema` | `workspaceService.revokeInvite` | `executeWorkspaceActionWithInput("members.invite")` | none | `void` / failure | `revalidatePath("/settings/members")` | `members-panel.tsx:181` (`router.refresh`:191) | `DELETE /api/workspace/invites/:inviteId` | workspace |

### Inventory 1.2 function `changeMemberRoleAction(memberId, role)`, caller conversion

| File:line | Function | Input | Service / auth calls | Policy helper + capability | Plan check | Returns | Side effects | Client callers | Target endpoint | Domain |
|---|---|---|---|---|---|---|---|---|---|---|
| `:177` | `changeMemberRoleAction(memberId, role)` | `workspaceMemberRoleActionSchema` `{memberId, role}` | `workspaceMembershipService.changeRole` | `executeWorkspaceActionWithInput("members.invite")` | none | `{ok:true}` / `{ok:false, error, errorCode, requestId}` | `revalidatePath("/settings/members")` | `members-panel.tsx:207` (`router.refresh`:211) | `PATCH /api/workspace/members/:memberId` | workspace |

### Inventory 1.2 function `removeMemberAction(memberId)`, caller conversion

| File:line | Function | Input | Service / auth calls | Policy helper + capability | Plan check | Returns | Side effects | Client callers | Target endpoint | Domain |
|---|---|---|---|---|---|---|---|---|---|---|
| `:209` | `removeMemberAction(memberId)` | `workspaceMemberReferenceActionSchema` | `workspaceMembershipService.removeMember` | `executeWorkspaceActionWithInput("members.invite")` | none | `{ok:true}` / `{ok:false, ...}` | `revalidatePath("/settings/members")` | `members-panel.tsx:219` (`router.refresh`:223) | `DELETE /api/workspace/members/:memberId` | workspace |

### Inventory 1.3 function `replaceCensorWordsAction(input)`, caller conversion

| File:line | Function | Input | Service / auth calls | Policy helper + capability | Plan check | Returns | Side effects | Client callers | Target endpoint | Domain |
|---|---|---|---|---|---|---|---|---|---|---|
| `app/(app)/settings/workspace/censor-words-actions.ts:17` | `replaceCensorWordsAction(input)` | `workspaceCensorWordsSchema` | `autoCensorService.replaceWorkspaceWords` | `executeWorkspaceActionWithInput("workspace.manage")` | none in action | `{ok:true, ...saved}` | `revalidatePath("/settings/workspace")` | `app/(app)/settings/workspace/censor-words-card.tsx:93` (`save:`); Studio page passes it as prop `replaceWorkspaceCensorWords` (`studio/page.tsx:322`) -> `studio-shell.tsx:712` -> `tool-panels/censor-panel.tsx:309` | `PUT /api/workspace/censor-words` | settings-integrations (shared with clips-studio) |

### Inventory 1.3 function `resetCensorWordsAction()`, caller conversion

| File:line | Function | Input | Service / auth calls | Policy helper + capability | Plan check | Returns | Side effects | Client callers | Target endpoint | Domain |
|---|---|---|---|---|---|---|---|---|---|---|
| `:30` | `resetCensorWordsAction()` | none | `autoCensorService.resetWorkspaceWords` | `executeWorkspaceAction("workspace.manage")` | none | `{ok:true, ...saved}` | same | `censor-words-card.tsx:94`; `studio/page.tsx:323` -> `censor-panel.tsx:310` | `DELETE /api/workspace/censor-words` (reset to default) | settings-integrations (shared with clips-studio) |

### Inventory 1.1 function `createBusinessWorkspaceAction(previous, formData)` (`useActionState`), caller conversion

| File:line | Function | Input | Service / auth calls | Policy helper + capability | Plan check | Returns | Side effects | Client callers | Target endpoint | Domain |
|---|---|---|---|---|---|---|---|---|---|---|
| `app/workspaces/new/actions.ts:42` | `createBusinessWorkspaceAction(previous, formData)` (`useActionState`) | `businessWorkspaceCheckoutActionSchema` built by `./checkout-request.ts` (`buildBusinessWorkspaceCheckoutRequest`, `recoverBusinessWorkspaceCheckoutFields`): `{name?, workspaceId?, interval, checkoutIdempotencyKey?}` | `billingService.isCheckoutConfigured`, `workspaceService.requireActor(..., "billing.manage")`, `workspaceService.createPendingBusinessWorkspace`, `billingService.startCheckout` (returnDestination `${origin}/settings/billing`, origin from `resolveCanonicalAppOrigin({configuredOrigin: NEXT_PUBLIC_APP_URL, environment: NODE_ENV})`), `setActiveWorkspaceForActor` | `executeSignedInActionWithInput` | `billingService.isCheckoutConfigured("business", interval)`; pending-workspace owner + status check (`workspace_checkout_state_invalid`) | `CreateWorkspaceState {error?, errorCode?, requestId?, checkoutUrl?, workspaceId?, workspaceName?, interval?, checkoutIdempotencyKey?}` (never throws; policy failure remapped to state) | sets active-workspace cookie | `app/workspaces/new/create-workspace-form.tsx:25` `useActionState`; effect does `window.location.assign(state.checkoutUrl)` (:28) | `POST /api/workspaces/business-checkout` (idempotency key in body; return-origin must come from API config `APP_URL`, not request) | billing (workspace create) |

## Acceptance criteria

- [x] Every owned page/layout direct read and Server Action caller is converted; root no longer validates DB/Stripe and no data gate wraps identity/billing recovery.
- [x] Scope switching validates membership, cancels/discards old responses, persists only a user-keyed hint and handles other-tab storage events.
- [x] Auth continuation provisions through bootstrap before validated destination/Clerk consent navigation; invite and checkout forms use mutation state.
- [x] Shell usage/billing/avatars use shared scoped queries; errors retain Support ID and owner/member recovery; all owned refresh/revalidate assumptions removed.
- [ ] No unowned files changed; paired review findings and verification evidence recorded under Comments.

## Verification

Run these from the repository root after dependencies are installed. A command naming a new package script is implemented by the owning setup ticket, not silently skipped. PostgreSQL gates need a disposable schema; a skipped DB suite does not satisfy its gate. During the undeployed integration sequence, record any unrelated transitional compile failure with its owning blocker; this ticket's behavior tests must pass and the final integrated gates cannot be waived.

```sh
bun test apps/web/lib/auth-flow.test.ts apps/web/lib/post-auth-redirect.test.ts
bun run --cwd apps/web typecheck
```

Verify the changed flow in the running Next app against the separate API origin. Follow the repo's runtime/browser verification guidance; record steps, result and origin pair. Do not treat compilation as browser evidence.

## Comments

Claimed and implemented by Claude (Sonnet 5.5), 2026-10-29. Paired review not run by the implementer (last acceptance box left open for the orchestrator). Signed-in browser pass NOT done (ticket 32).

### What changed
- **Gates** (`app/_components/workspace-query-gate.tsx`, new): `SessionGate` runs the identity bootstrap and adopts `selection.workspaceId` with `runtime.selectWorkspace` BEFORE any scoped query can start (children render only afterwards); it re-bootstraps and re-adopts whenever the transport reports 409 `workspace_selection_changed` (`SessionApiProvider` wires the transport callback to the gate; the refused request is never retried). `WorkspaceQueryGate` reads the Workspace bootstrap for the selected Workspace, remounts its children per Workspace, sends a member who lacks `content.view` (derived from the identity bootstrap's role and status, no content probing) or a late `workspace_restricted` to `/workspace-unavailable` (owner who can resolve: `/settings/billing`), and shows `GateFailure` (Support ID, retry) for other failures. `useWorkspaceSwitch()` = `selectWorkspaceMutation` (membership-only, works from a restricted Workspace; runtime cancels/clears the old scope).
- **Shell**: `(app)/layout.tsx` is a data-free server shell around `SessionApiProvider` + `AppShell` (in `app-chrome.tsx`: `SessionGate` > `WorkspaceQueryGate` > `UpgradeProvider` > `AppChrome`). Shell data = Workspace bootstrap (profile, memberships with avatars, capabilities, usage) + billing state (`retry:false`, only words upgrade links). `AppChrome` props unchanged. Account menu/mobile nav: portal through `createBillingActions(...).openPortal()`, sign-out aborts and clears the API session first (`runtime.setIdentity(null)`; restored if Clerk's sign-out fails). `AccountMenu` takes an optional `AccountSession` because the marketing header renders it with no API session.
- **Root layout**: `validateCoreEnv` and billing validation removed.
- **Settings**: layout is a pass-through; profile, workspace (profile, bootstrap, guidance, censor words fetched concurrently) and members (members, billing state, bootstrap concurrently) pages are client data views reusing their `loading.tsx`. Mutations with `useMutation`: update workspace, guidance, avatar (presign, direct PUT with `credentials: "omit"`, set/remove), invite/resend (one idempotency intent per form/row), revoke, role change, remove (role change and removal re-read the lists on failure too), censor words. `MembersPanel` gained a `scope` prop; `CensorWordsCard` and `WorkspaceAvatarControl` gained `scope` and read/write the shared query keys.
- **Auth/continuations**: `/auth/continue` is a client flow (`AuthContinuation`): identity bootstrap provisions and adopts, then `resolveAuthContinuation` (new pure function in `lib/post-auth-redirect.ts`, validated against the API's `authContinuation` issuer/consent origin, never `process.env`) either `router.replace`s an app path or hands off to Clerk. A rejected token ends in a retry, not another sign-in round trip. `auth-form` no longer calls `router.refresh()` (the next page mounts its own session). `error.tsx` now uses Next's `reset`.
- **Invite / New Workspace / unavailable**: invite page = `inviteQuery` + `acceptInviteMutation` then `router.push(destination)`; `workspaces/new` = `startBusinessWorkspaceCheckout` (identity scope), `details.recovery` feeds the preserved fields, adopts `selection.workspaceId` then `window.location.assign(checkoutUrl)`; workspace-unavailable reads memberships from the identity bootstrap and Open uses `useWorkspaceSwitch`.
- **Deleted**: `(app)/_actions/workspace.ts`, `settings/workspace/censor-words-actions.ts`, `invite/[token]/actions.ts`, `workspaces/new/actions.ts`.
- **Tests/fixtures**: `workspace-entry.db.fixture.ts` rewritten on `getAppUserForClerkIdentity` (a directory outage is now `ClerkDirectoryUnavailableError`); `auth-server.contract.fixture.ts` keeps the proxy page contracts, drops the API-401 cases (proxy API branch belongs to 31) and the server continuation page; `post-auth-redirect.test.ts` covers `resolveAuthContinuation`; new `workspace-query-gate.browser.fixture.tsx` (+ `.test.ts` launcher; real ApiProvider/runtime/transport against a fake API: stale hint, paused Workspace, switch, mid-session removal without replay) and `query-mutation-form.test.tsx`; `members-panel.test.tsx` updated.

### Requests for other owners
- **31**: `app/_components/authenticated-action-form.tsx` is still imported by `projects/[projectId]/{page,processing-panel}.tsx` (10) and `lib/plan-upgrade-pages.contract.fixture.ts`; delete it (and `lib/authenticated-request-browser.ts` only after nothing imports it: the new `query-mutation-form.tsx` still uses its failure wording) when those convert. `lib/authenticated-request-inventory.ts` still lists the deleted actions (its 4 tests fail). `(app)/_components/usage.ts` (07) can switch to `workspaceBootstrapQuery` from `@narriflow/api-client/workspace` (same key). `NEXT_PUBLIC_API_URL` must exist at web build time: `ApiProvider` reads it while prerendering.
- **26**: `integrations/mcp/workspace-billing-link.tsx` imports the deleted `_actions/workspace`; use `useWorkspaceSwitch()` from `@/app/_components/workspace-query-gate` (or `selectWorkspaceMutation`). 10/09: same for `workspace-mismatch-notice.tsx` if still on the action.
- **02/31**: wire `apps/web/lib/workspace-entry.db.fixture.ts` into `apps/api/scripts/run-authenticated-request-policy-db-tests.ts` (needs `AUTHENTICATED_REQUEST_POLICY_TEST_DATABASE_URL`/`_SCHEMA`, run with `bun test ./apps/web/lib/workspace-entry.db.fixture.ts`; the runner does not execute it).
- **Other screens mounting `ApiProvider` outside `(app)`** (review, share, MCP continuation pages outside the shell) should use `ApiProvider` directly; use `SessionApiProvider` + `SessionGate` only when they need the adopted Workspace.

### Evidence
- `bun test apps/web/lib/auth-flow.test.ts apps/web/lib/post-auth-redirect.test.ts` 37 pass (incl. 4 new `resolveAuthContinuation`).
- `cd apps/web && bun test lib/auth-form.test.ts lib/auth-flow.test.ts lib/post-auth-redirect.test.ts lib/safe-redirect.test.ts lib/settings-return.test.ts lib/navigation-actions.test.ts lib/format.test.ts lib/personal-workspace-auth.test.ts app/caption-fonts.test.ts app/workspaces app/_components "app/(app)/_components/workspace-status-notice.test.tsx" "app/(app)/settings/_components" "app/(app)/settings/members" "app/(app)/settings/workspace"` 107 pass, 0 fail; `bun test "app/(app)/_components"` 23 pass.
- `bun test ./apps/web/app/_components/workspace-query-gate.browser.fixture.tsx` 5 pass.
- `.scratch/api-extraction/db-gate.sh` + a disposable `authenticated_request_policy_test_*` schema (all migrations): `bun test ./apps/web/lib/workspace-entry.db.fixture.ts` 7 pass.
- `bunx tsc --noEmit -p apps/web/tsconfig.json`: no error in any file of this ticket. Remaining errors belong to others: `integrations/mcp/{confirm/actions,page,upload/upload-picker,workspace-billing-link}` (26), `recipes/recipes-panel` (16), `settings/actions.ts` and `settings/api/callback-secret-panel` (25), Studio audio/music tool panels (14), `app/api/stream` (29), `lib/authenticated-request-{action,page}`, `workflow-stream-reauthorization` (31), `apps/api/.../rest/routes.ts` (23).
- `bunx biome check` on every owned/created path: clean.
- NOT done: signed-in browser run against `next dev` + the API (shell load, stale-hint fallback banner, switch, sign-out clearing, restricted member redirect, invite accept, New Workspace to Stripe, `/auth/continue` with a Clerk OAuth `redirect_url`). Ticket 32 must run these.
