# API extraction: inventory of web backend surfaces (2026-10-29)

Read-only survey of `apps/web` (branch `dev`) for the move to a standalone Hono API (see `brief.md`). Paths are relative to `apps/web/` unless prefixed (`packages/`, `apps/`). Line numbers were taken from the working tree on 2026-10-29 and will drift as soon as implementers start editing; re-grep before relying on one. Section-level counts were verified with `grep`/`find`.

Headline counts: 14 files with `"use server"` (13 module-level + inline in `studio/page.tsx`), 55 exported server-action functions (+1 alias, +6 inline = 61 distinct callable functions); 52 `page.tsx` + 6 `layout.tsx` (39 pages/layouts do a server read); 165 internal Hono routes (160 browser-session, 5 independent-trust) + 31 REST v1 routes; 16 `route.ts` files (14 outside the Hono catch-alls, 9 move, 5 stay); 48 files / 83 lines with `router.refresh()`; 102 client `fetch(` expressions + 3 `EventSource` consumers.

Grep notes: `grep -rl '"use server"'` also matches `lib/authenticated-request-inventory.test.ts` (string only). Files importing `@narriflow/(services|db|auth)` under `app lib proxy.ts`: 110 (93 non-test, 17 tests/fixtures); Section 2 counts a slightly different scope (107), see its own table.


## 1. Server actions

**Counts (match `grep`).** 13 files carry a top-of-file `"use server"` (`grep -rl '"use server"' apps/web --include=*.ts*` also lists `studio/page.tsx`, which has 6 inline actions, plus `lib/authenticated-request-inventory.test.ts`, which only mentions the string). 56 `export (async function|const)` statements in the 13 files = **55 exported action functions + 1 alias** (`queueGenerationFormAction = queueTranscriptionFormAction`). Plus **6 inline actions** in `studio/page.tsx` = **61 distinct server-callable functions**.

| File | Exports |
|---|---|
| `app/(app)/_actions/workspace.ts` | 1 |
| `app/(app)/brand-kit/style-actions.ts` | 5 |
| `app/(app)/calendar/actions.ts` | 1 |
| `app/(app)/calendar/queue/actions.ts` | 7 |
| `app/(app)/exports/actions.ts` | 1 |
| `app/(app)/integrations/mcp/confirm/actions.ts` | 1 |
| `app/(app)/projects/actions.ts` | 12 (11 functions + alias) |
| `app/(app)/settings/actions.ts` | 14 |
| `app/(app)/settings/automation-grants/actions.ts` | 4 |
| `app/(app)/settings/workspace/censor-words-actions.ts` | 2 |
| `app/(app)/upload/actions.ts` | 6 |
| `app/invite/[token]/actions.ts` | 1 |
| `app/workspaces/new/actions.ts` | 1 |
| `studio/page.tsx` (inline `"use server"`) | 6 |

All paths below are relative to `apps/web/`. Studio = `app/(app)/projects/[projectId]/clips/[clipId]/studio`.

### Conventions that apply to every row

- **Policy wrapper.** Every action runs through `lib/authenticated-request-action.ts` (`adapter: "server_action"`). `executeWorkspaceAction*` = admission `{kind:"workspace", capability}`; `executeProjectAction*` = `{kind:"project", capability, projectId}`; `executeSignedInAction*` = `{kind:"signed_in"}` (no workspace; actor = `BrowserSignedInActorScope`). The `*WithInput` variants zod-parse the untrusted input first. Capability names are listed per row. Refusals come back as a serialized value `AuthenticatedActionFailure {ok:false, error, code, message, requestId, issues?, details?, retryAfterSeconds?}`, never thrown (except `AuthenticatedRequestUnexpectedError` and Next control flow). Client side that value is read through `lib/authenticated-request-browser.ts` (`isAuthenticatedActionFailure`, `authenticatedRequestFailureMessage`). So the API needs the same failure envelope as the HTTP error body.
- **Actor resolution is cookie based.** `lib/authenticated-request-policy.server.ts` -> `getCurrentAppUser()` + `getWorkspaceContextForUser()` (`packages/auth/src/index.ts`) read Clerk session and the **httpOnly cookie `narriflow_active_workspace`** (`ACTIVE_WORKSPACE_COOKIE`, index.ts:20/556). `setActiveWorkspaceForActor` (index.ts:647) **writes that cookie**. Three actions call it (`switchWorkspaceAction`, `acceptWorkspaceInviteAction`, `createBusinessWorkspaceAction`). With a Bearer-token API there is no cookie jar, so the API needs an explicit workspace selector (header such as `X-Workspace-Id`, or a server-persisted preference) and those three actions must change shape (see "Surprises").
- **`revalidatePath` rows** become React Query invalidations in the target design (the "Refresh" column lists what each revalidated).
- **Client callers** that also do `router.refresh()` / `router.push()` are noted; Section 5 holds the full list.
- **`lib/authenticated-request-inventory.ts`** (lines 955-1260) is a declarative list of every server action (`browserSessionServerActions`, with `module`, `exportName`, `admission`, `capability`) and a Hono surface table; `lib/authenticated-request-inventory.test.ts` asserts it against the `"use server"` files. It must be rewritten with the extraction (shared file).
- **Dead exports**: `renderClipsFormAction` and `queueGenerationFormAction` have **no caller** besides the inventory (grep `app lib`). Candidates to delete instead of port.
- Existing Hono routes referenced below live in `app/api/[[...route]]/route.ts` (and sibling `*-http.ts`/`*-routes.ts`); "verify parity" means the route exists but its body/side effects were not compared to the action.

### 1.1 Workspace switching / onboarding / invites

| File:line | Function | Input | Service / auth calls | Policy helper + capability | Plan check | Returns | Side effects | Client callers | Target endpoint | Domain |
|---|---|---|---|---|---|---|---|---|---|---|
| `app/(app)/_actions/workspace.ts:13` | `switchWorkspaceAction(workspaceId)` | `workspaceSelectionActionSchema` `{workspaceId}` | `setActiveWorkspaceForActor` (`@narriflow/auth`; membership check + **sets cookie**) | `executeSignedInActionWithInput` (deliberately not workspace-scoped: a member of a paused workspace needs a way out) | none | `void` / `AuthenticatedActionFailure` | `revalidatePath("/", "layout")` | `app/workspace-unavailable/open-workspace-button.tsx:25` (then `router.push("/home")`), `app/(app)/projects/_components/workspace-mismatch-notice.tsx:49` (`router.push`+`router.refresh`), `app/(app)/integrations/mcp/workspace-billing-link.tsx:27` (`router.push`), `app/(app)/_components/workspace-switcher.tsx:51` (`router.refresh`:62), `app/(app)/_components/app-chrome.tsx:77` (`router.refresh`:88) | Client-only: store selected workspace id and send as header; optionally `POST /api/me/active-workspace` that validates membership and returns the workspace context. On success clients invalidate **all** queries. | workspace |
| `app/invite/[token]/actions.ts:12` | `acceptWorkspaceInviteAction(token)` | `workspaceInviteAcceptanceActionSchema` `{token}` | `workspaceMembershipService.acceptInvite`, `setActiveWorkspaceForActor` (cookie) | `executeSignedInActionWithInput` | none | on failure `{ok:false, error, code, message}`; on success **`redirect("/home")`** | `redirect("/home")`; sets active-workspace cookie | `app/invite/[token]/page.tsx:20` via `action={acceptWorkspaceInviteAction.bind(null, token)}` into `invite-view.tsx:102` `AuthenticatedActionForm` | `POST /api/invites/:token/accept` -> `{workspaceId}`; client then sets active workspace and navigates to `/home` | workspace |
| `app/workspaces/new/actions.ts:42` | `createBusinessWorkspaceAction(previous, formData)` (`useActionState`) | `businessWorkspaceCheckoutActionSchema` built by `./checkout-request.ts` (`buildBusinessWorkspaceCheckoutRequest`, `recoverBusinessWorkspaceCheckoutFields`): `{name?, workspaceId?, interval, checkoutIdempotencyKey?}` | `billingService.isCheckoutConfigured`, `workspaceService.requireActor(..., "billing.manage")`, `workspaceService.createPendingBusinessWorkspace`, `billingService.startCheckout` (returnDestination `${origin}/settings/billing`, origin from `resolveCanonicalAppOrigin({configuredOrigin: NEXT_PUBLIC_APP_URL, environment: NODE_ENV})`), `setActiveWorkspaceForActor` | `executeSignedInActionWithInput` | `billingService.isCheckoutConfigured("business", interval)`; pending-workspace owner + status check (`workspace_checkout_state_invalid`) | `CreateWorkspaceState {error?, errorCode?, requestId?, checkoutUrl?, workspaceId?, workspaceName?, interval?, checkoutIdempotencyKey?}` (never throws; policy failure remapped to state) | sets active-workspace cookie | `app/workspaces/new/create-workspace-form.tsx:25` `useActionState`; effect does `window.location.assign(state.checkoutUrl)` (:28) | `POST /api/workspaces/business-checkout` (idempotency key in body; return-origin must come from API config `APP_URL`, not request) | billing (workspace create) |

### 1.2 Settings: workspace, members, invites

| File:line | Function | Input | Service / auth calls | Policy helper + capability | Plan check | Returns | Side effects | Client callers | Target endpoint | Domain |
|---|---|---|---|---|---|---|---|---|---|---|
| `app/(app)/settings/actions.ts:56` | `updateWorkspaceAction(formData)` | `workspaceSettingsActionSchema` `{name, timezone}` from `name`, `timezone` form fields | `workspaceService.updateWorkspace(actorUserId, workspaceId, {name,timezone})` | `executeWorkspaceActionWithInput("workspace.manage")` | none | `void` / failure | `revalidatePath("/", "layout")`, `/settings/workspace` | `app/(app)/settings/workspace/page.tsx:57` (`AuthenticatedActionForm action=`) | `PATCH /api/workspace` | settings-integrations |
| `:77` | `updatePerformanceGuidanceAction(formData)` | `performanceGuidanceSettingActionSchema` `{enabled}` (`enabled === "on"`) | `performanceService.setGuidanceEnabled(appUser, enabled)` | `executeWorkspaceActionWithInput("workspace.manage")` | none | `void` / failure | `revalidatePath("/settings/workspace")`, `/performance` | `settings/workspace/page.tsx:77` | `PATCH /api/workspace/performance-guidance` | settings-integrations |
| `:90` | `inviteMemberAction({email, role})` | `workspaceInviteActionSchema` | `workspaceService.createInvite`, **`sendEmail` (`@narriflow/email`)** via local `deliverWorkspaceInvite`; invite URL built from `process.env.NEXT_PUBLIC_APP_URL` (fallback `http://localhost:3000`) + `/invite/:token`, email idempotency key `workspace-invite/${id}` | `executeWorkspaceActionWithInput("members.invite")` | none at action layer (seat limits inside service) | `{ok:true, inviteUrl, emailSent}` / `{ok:false, error, errorCode, requestId}` (double try/catch via `authenticatedActionResultError`) | `revalidatePath("/settings/members")` | `app/(app)/settings/members/members-panel.tsx:143` (`router.refresh`:156) | `POST /api/workspace/invites` | workspace |
| `:126` | `resendInviteAction(inviteId)` | `workspaceInviteReferenceActionSchema` `{inviteId}` | `workspaceService.resendInvite`, same email delivery | `executeWorkspaceActionWithInput("members.invite")` | none | same shape as invite | `revalidatePath("/settings/members")` | `members-panel.tsx:164` (`router.refresh`:175) | `POST /api/workspace/invites/:inviteId/resend` | workspace |
| `:169` | `revokeInviteAction(inviteId)` | `workspaceInviteReferenceActionSchema` | `workspaceService.revokeInvite` | `executeWorkspaceActionWithInput("members.invite")` | none | `void` / failure | `revalidatePath("/settings/members")` | `members-panel.tsx:181` (`router.refresh`:191) | `DELETE /api/workspace/invites/:inviteId` | workspace |
| `:177` | `changeMemberRoleAction(memberId, role)` | `workspaceMemberRoleActionSchema` `{memberId, role}` | `workspaceMembershipService.changeRole` | `executeWorkspaceActionWithInput("members.invite")` | none | `{ok:true}` / `{ok:false, error, errorCode, requestId}` | `revalidatePath("/settings/members")` | `members-panel.tsx:207` (`router.refresh`:211) | `PATCH /api/workspace/members/:memberId` | workspace |
| `:209` | `removeMemberAction(memberId)` | `workspaceMemberReferenceActionSchema` | `workspaceMembershipService.removeMember` | `executeWorkspaceActionWithInput("members.invite")` | none | `{ok:true}` / `{ok:false, ...}` | `revalidatePath("/settings/members")` | `members-panel.tsx:219` (`router.refresh`:223) | `DELETE /api/workspace/members/:memberId` | workspace |

### 1.3 Settings: API keys, callback secret, webhooks, automation grants, censor words

| File:line | Function | Input | Service / auth calls | Policy helper + capability | Plan check | Returns | Side effects | Client callers | Target endpoint | Domain |
|---|---|---|---|---|---|---|---|---|---|---|
| `app/(app)/settings/actions.ts:243` | `createApiKeyAction({name, scopes?})` | `workspaceApiKeyActionSchema` | `workspaceService.createApiKey` | `executeWorkspaceActionWithInput("api.manage")` | none in action (service enforces) | `{ok:true, key:{...key, createdAt ISO}}` (secret shown once) / `{ok:false,...}` | `revalidatePath("/settings/api")` | `app/(app)/settings/api/create-key-dialog.tsx:49` (`router.refresh`:55) | `POST /api/workspace/api-keys` | settings-integrations |
| `:279` | `revokeApiKeyAction(keyId)` | `workspaceApiKeyReferenceActionSchema` | `workspaceService.revokeApiKey` | `executeWorkspaceActionWithInput("api.manage")` | none | `void` / failure | `revalidatePath("/settings/api")` | `settings/api/api-keys-panel.tsx:63` (`router.refresh`:68) | `DELETE /api/workspace/api-keys/:keyId` | settings-integrations |
| `:289` | `rotateCallbackSigningSecretAction()` | none | `callbackSigningSecrets.rotate(workspaceId)` | `executeWorkspaceAction("api.manage")` | `requirePlanFeature(tier, "integrations.api")` | `{ok:true, secret, createdAt}` (secret returned once; previous signs 24h) | `revalidatePath("/settings/api")` | `settings/api/callback-secret-panel.tsx:30` (`router.refresh`:36) | `POST /api/workspace/callback-signing-secret/rotate` | settings-integrations |
| `:311` | `createWebhookAction({url, types})` | `createWebhookRequestSchema` | `assertCompletionCallbackUrl`, `webhookSubscriptions.create` (via `webhookOperation` helper :299) | `executeWorkspaceActionWithInput("api.manage")` | `requirePlanFeature(tier, "integrations.api")` | `{ok:true, webhook}` / `{ok:false, error, errorCode}` | `revalidatePath("/settings/api")` | `settings/api/add-webhook-dialog.tsx:43` (`router.refresh`:50) | `POST /api/workspace/webhooks` (may share logic with `/api/v1/webhooks`; that one is API-key auth, keep separate adapter) | settings-integrations |
| `:318` | `deleteWebhookAction(webhookId)` | `webhookReferenceActionSchema` | `webhookSubscriptions.delete` | same + `integrations.api` | yes | `{ok:true, ...result}` / `{ok:false,...}` | `revalidatePath("/settings/api")` | `settings/api/webhooks-panel.tsx:82` (`router.refresh`:71 in shared `run`) | `DELETE /api/workspace/webhooks/:webhookId` | settings-integrations |
| `:323` | `enableWebhookAction(webhookId)` | `webhookReferenceActionSchema` | `webhookSubscriptions.enable` | same | yes | `{ok:true, webhook}` / failure | same | `webhooks-panel.tsx:150` | `POST /api/workspace/webhooks/:webhookId/enable` | settings-integrations |
| `:331` | `testWebhookAction(webhookId)` | `webhookReferenceActionSchema` | `webhookSubscriptions.test` | same | yes | `{ok:true, delivered, status}` | same | `webhooks-panel.tsx:159` | `POST /api/workspace/webhooks/:webhookId/test` | settings-integrations |
| `app/(app)/settings/automation-grants/actions.ts:14` | `createStandingGrantAction(input)` | `createStandingGrantSchema` | `standingGrants.create` | `executeWorkspaceActionWithInput("workspace.manage")` | none in action | `void` / failure | `revalidatePath("/settings/automation-grants")`, `/autopilot` | `settings/automation-grants/grants-panel.tsx:192` (`router.refresh`:202) | `POST /api/automation/standing-grants` | settings-integrations |
| `:22` | `renewStandingGrantAction(input)` | `renewStandingGrantSchema` | `standingGrants.renew` | same | none | same | same | `grants-panel.tsx:191` | `POST /api/automation/standing-grants/:grantId/renew` | settings-integrations |
| `:29` | `pauseStandingGrantAction(grantId)` | `standingGrantReferenceSchema` | `standingGrants.pause` | same | none | same | same | `grants-panel.tsx:469` (`router.refresh`:364 in `run`) | `POST /api/automation/standing-grants/:grantId/pause` | settings-integrations |
| `:36` | `revokeStandingGrantAction(grantId)` | `standingGrantReferenceSchema` | `standingGrants.revoke` | same | none | same | same | `grants-panel.tsx:375` | `POST /api/automation/standing-grants/:grantId/revoke` | settings-integrations |
| `app/(app)/settings/workspace/censor-words-actions.ts:17` | `replaceCensorWordsAction(input)` | `workspaceCensorWordsSchema` | `autoCensorService.replaceWorkspaceWords` | `executeWorkspaceActionWithInput("workspace.manage")` | none in action | `{ok:true, ...saved}` | `revalidatePath("/settings/workspace")` | `app/(app)/settings/workspace/censor-words-card.tsx:93` (`save:`); Studio page passes it as prop `replaceWorkspaceCensorWords` (`studio/page.tsx:322`) -> `studio-shell.tsx:712` -> `tool-panels/censor-panel.tsx:309` | `PUT /api/workspace/censor-words` | settings-integrations (shared with clips-studio) |
| `:30` | `resetCensorWordsAction()` | none | `autoCensorService.resetWorkspaceWords` | `executeWorkspaceAction("workspace.manage")` | none | `{ok:true, ...saved}` | same | `censor-words-card.tsx:94`; `studio/page.tsx:323` -> `censor-panel.tsx:310` | `DELETE /api/workspace/censor-words` (reset to default) | settings-integrations (shared with clips-studio) |

### 1.4 Projects, folders, generation

| File:line | Function | Input | Service / auth calls | Policy helper + capability | Plan check | Returns | Side effects | Client callers | Target endpoint | Domain |
|---|---|---|---|---|---|---|---|---|---|---|
| `app/(app)/projects/actions.ts:54` | `createFolderAction(name)` | `string` (validated in service) | `workspaceLibraryService.createFolder` | `executeWorkspaceAction("content.edit")` | none | `{ok:true, folder:{...,createdAt ISO}}` / `{ok:false, error, errorCode, requestId}` (double try/catch) | `revalidatePath("/projects")` | `app/(app)/projects/_components/projects-header-actions.tsx:32` (`router.refresh`:46) | `POST /api/library/folders` | projects |
| `:94` | `deleteFolderAction(folderId)` | `string` | `workspaceLibraryService.deleteFolder` | `executeWorkspaceAction("content.edit")` | none | `void` / failure | `revalidatePath("/projects")` | `projects/_components/folders-panel.tsx:67` (`router.refresh`:75) | `DELETE /api/library/folders/:folderId` | projects |
| `:104` | `renameFolderAction(folderId, name)` | `string, string` | `workspaceLibraryService.renameFolder` | `executeWorkspaceAction("content.edit")` | none | `{ok:true}` / `{ok:false,...}` | `revalidatePath("/projects")` | `folders-panel.tsx:42` (`router.refresh`:52) | `PATCH /api/library/folders/:folderId` | projects |
| `:142` | `moveProjectToFolderAction(projectId, folderId\|null)` | `string, string\|null` | `workspaceLibraryService.moveProject` | `executeProjectAction(projectId,"content.edit")` | none | `void` / failure | `revalidatePath("/projects")` | `projects/_components/projects-explorer.tsx:100` (`router.refresh`:113), `folders-panel.tsx:86` (`router.refresh`:94) | `PUT /api/projects/:projectId/folder` `{folderId}` | projects |
| `:156` | `queueTranscriptionFormAction(formData)` (alias `queueGenerationFormAction` :187, no callers) | `formData`: `projectId`, `idempotencyKey` (default `randomUUID()`), content pack via `readContentPackFromForm`, `readLanguageCodeFromForm` (`app/(app)/upload/_lib/content-pack-form.ts`) | `projectService.triggerGeneration(appUser, projectId, {contentPack, forceRegenerate:false, languageCode}, idempotencyKey)` | `executeProjectAction(projectId,"processing.consume")` | credits/length via `ProcessingUsageError` from service; caught -> **`redirect("/projects/:id")`** (page shows limit + upgrade) | `void`; throws on missing `projectId` | `revalidatePath("/projects/:id")`; `redirect` on plan limit | `projects/[projectId]/processing-panel.tsx:487` and `projects/[projectId]/page.tsx:869` (`AuthenticatedActionForm action=`) | existing `POST /api/projects/:id/generate` (route.ts:448, verify parity: contentPack/languageCode/idempotency) ; plan-limit becomes a typed `ApiError` (`code`, `details`) the client renders instead of redirecting | projects |
| `:189` | `applyProjectBrandProfileFormAction(formData)` | `brandProfileProjectApplicationSchema` `{projectId, profileId, templateId\|null}` | `brandProfileService.applyToProject(actor, projectId, {profileId, templateId})` | `executeProjectActionWithInput(projectId,"content.edit")` | none | `void` / failure | `revalidatePath("/projects/:id")` | `projects/[projectId]/project-brand-picker.tsx:55` | `PUT /api/projects/:projectId/brand-profile` (or reuse `/projects/:id/campaign-operations/apply-brand-profile`, route.ts:930, which applies to selected clips; different semantics, verify) | brand-kit / projects |
| `:222` | `regenerateClipsFormAction(formData)` | `projectId`, `idempotencyKey`, content pack | `clipService.regenerateClips(appUser, projectId, idempotencyKey, contentPack)` | `executeProjectAction(projectId,"processing.consume")` | `ProcessingUsageError` -> `redirect("/projects/:id")` | `void` | `revalidatePath`; `redirect` on plan limit | `processing-panel.tsx:449`, `projects/[projectId]/page.tsx:940` | existing `POST /api/projects/:id/clips/regenerate` (`clip-generation-http.ts:11`, verify parity) | projects |
| `:249` | `renderClipsFormAction(formData)` | `projectId`, `idempotencyKey`, `aspectRatios[]` | `clipService.triggerClipRendering(appUser, projectId, idempotencyKey, undefined, aspectRatios\|undefined, "1080p")` | `executeProjectAction(projectId,"processing.consume")` | none | `void` | `revalidatePath("/projects/:id")` | **none (dead)** | existing `POST /api/projects/:id/clips/render` (route.ts:752); delete the action | projects |
| `:280` | `retryIngestFormAction(formData)` | `projectId` | `getIngestJobLifecycle().retry({projectId, workspaceId, actorUserId})`; catches `IngestRetryLimitExceededError`, `IngestNotFailedError`, `IngestReselectRequiredError` | `executeProjectAction(projectId,"processing.consume")` | retry limit in service | `{ok:boolean, error?}` (expected failures returned, not thrown, to survive Next error redaction) | `revalidatePath("/projects/:id")` | `projects/[projectId]/render-clips-button.tsx:484` (`router.refresh`:486), `upload/_components/retry-import-band.tsx:54` (`router.refresh`:56) | `POST /api/ingest/:projectId/retry` (route.ts:620 already has `GET /ingest/:projectId`) | upload |
| `:331` | `setNotifyPreferenceAction(projectId, notifyOnComplete)` | `string, boolean` | `projectService.setProjectNotifyPreference`; catches `ProjectNotFoundError` | `executeProjectAction(projectId,"content.edit")` | none | `{ok:boolean, error?}` | none (no revalidate) | `processing-panel.tsx:299` | `PUT /api/projects/:projectId/notify-preference` | projects |
| `:365` | `deleteProjectFormAction(formData)` | `projectId` | `projectService.deleteProject`; maps `ProjectAccessDeniedError`, `ProjectHasActiveWorkflowError`, `ProjectHasActivePublicationError`, `ProjectDeletionIncompleteError`; `ProjectNotFoundError` = success | `executeProjectAction(projectId,"content.edit")` | none | `{ok:false, error}` on mapped failure; on success **`redirect("/projects")`** | `revalidatePath("/projects")`, `redirect("/projects")` | `projects/_components/delete-project-button.tsx:62` | `DELETE /api/projects/:projectId` (idempotent: 404 treated as success by client); client navigates to `/projects` | projects |

### 1.5 Upload / intake (all in `app/(app)/upload/actions.ts`)

Shared module code: `commitFailure`/`commitErrorCode` (:51-78) turn `ProcessingUsageError`, `DriveSourceError`, `LinkUnsupportedSourceError` into `{ok:false, code, message, details?}` using `boundedExpectedDomainFailureDetails`; `fetchYoutubeTitle` (:89) does a 3s `fetch` to `https://www.youtube.com/oembed`; form readers in `upload/_lib/content-pack-form.ts`.

| File:line | Function | Input | Service / auth calls | Policy helper + capability | Plan check | Returns | Side effects | Client callers | Target endpoint | Domain |
|---|---|---|---|---|---|---|---|---|---|---|
| `:112` | `commitLinkImportAction(input)` | TS type `{url, title\|null, brandTemplateId, brandProfileId, commitToken, languageCode, mode: GenerationMode, processingStartSec, processingEndSec}` (**no zod parse in the action**) | `fetchYoutubeTitle` (oEmbed), `projectService.queueLinkIngest` | `executeWorkspaceAction("processing.consume")` | `ProcessingUsageError` (credits/length) returned as `{ok:false, code, message, details}` | `CommitLinkImportResult` `{ok:true, projectId, title}` / `{ok:false, code, message, details?}` | `revalidatePath("/projects/:id")` | `upload/_components/commit-step.tsx:309` | existing `POST /api/ingest/link` (route.ts:579, verify it takes commitToken/mode/brand ids/range); add a zod schema | upload |
| `:155` | `commitDriveImportAction(input)` | `driveIngestSchema` (`fileId, accessToken` Drive `drive.file` token, + same commit fields) | `projectService.queueDriveIngest` | `executeWorkspaceActionWithInput("processing.consume")`, op `commit-drive-import`, **rate limit** `drive-import:${workspaceId}` 10/60s | same | `CommitLinkImportResult` | `revalidatePath("/projects/:id")` | `commit-step.tsx:304` | `POST /api/ingest/drive` (token never logged/returned; keep rate limit) | upload |
| `:216` | `finalizeLinkConfigureAction(input)` | `linkConfigureActionInputSchema` `{projectId, contentPack, languageCode\|null}` strict | `projectService.finalizeGenerationSetup` | `executeProjectActionWithInput(projectId,"content.edit")` | `ProcessingUsageError` -> `{ok:false, code, message, details}` | `FinalizeLinkConfigureResult` `{ok:true, started, ingestStatus, workflowRunId?}` / `{ok:false,...}` | `revalidatePath("/projects/:id")` | `upload/_components/configure-step.tsx:185` (`router.push`:198) | `POST /api/projects/:projectId/generation/finalize` | upload |
| `:257` | `saveGenerationDraftAction(input)` | `linkConfigureActionInputSchema` | `projectService.saveGenerationDraft` | `executeProjectActionWithInput(projectId,"content.edit")` | none | `{ok:true}` / failure | `revalidatePath("/projects/:id")` | `configure-step.tsx:165` (`router.push`:175) | `PUT /api/projects/:projectId/generation/draft` | upload |
| `:276` | `fetchYoutubeMetadataAction(url)` | `string` (no schema) | `fetchYoutubeTitle` only (outbound fetch, no service) | `executeWorkspaceAction("content.view")` | none | `{title: string\|null}` / failure | none | `configure-step.tsx:105`, `commit-step.tsx:205` | `GET /api/ingest/link/metadata?url=` (add SSRF guard: only `youtube.com` oEmbed host is fetched, URL is encoded, but validate `detectLinkProvider`) | upload |
| `:284` | `generateFromRssAction(formData)` | `rssActionInputSchema` = `rssImportSchema.extend({contentPack, languageCode})` strict; form fields `rssUrl, titlePrefix, episodeIds` (JSON), `commitToken`, brand profile id, content pack | `projectService.importFromRss` | `executeWorkspaceActionWithInput("processing.consume")`, op `generate-from-rss`, **rate limit** `rss-import:${workspaceId}` 5/60s | `ProcessingUsageError` returned `{ok:false, error, message, details, retryAfterSeconds}` | `{ok:true, projectId}` / `{ok:false,...}`; throws if no project produced | `revalidatePath("/projects/:id")` | `upload/_components/upload-shell.tsx:702` (`router.push`:715 + `router.refresh`:716) | existing `POST /api/ingest/rss/import` (route.ts:606, verify contentPack/languageCode/rate limit parity) | upload |

### 1.6 Clips / studio (inline actions) and censor

`studio/page.tsx` defines these inside the async Server Component as closure-bound actions (projectId, clipId come from route params, not from the client) and passes them as props to `StudioShell` (`studio/_components/studio-shell.tsx`). In the new model they become plain `GET`/`PUT` endpoints keyed by the URL params.

| File:line | Function | Input | Service / auth calls | Policy helper + capability | Plan check | Returns | Side effects | Client callers | Target endpoint | Domain |
|---|---|---|---|---|---|---|---|---|---|---|
| `studio/page.tsx:224` | `fetchPreviewStatus()` | none (closure `projectId`, `clipId`) | `clipService.getClipPreviewSource` (same call the page SSR makes) | `executeProjectAction(projectId,"content.edit")` | none | preview source `{previewUrl, previewStartSec, previewDurationSec, waveformPeaksUrl, ...}` / failure | none (polling) | `studio-shell.tsx:808` prop, call at :952 via `unwrapStudioActionResult` | `GET /api/projects/:id/clips/:clipId/preview-source` (note existing `GET .../preview-peaks`, route.ts:647) | clips-studio |
| `:237` | `fetchAutoLayoutAnalysis()` | none | `clipService.getClipAutoLayoutAnalysis` | same | none | `ClipAutoLayoutAnalysis \| null` / failure | none (polling) | `studio-shell.tsx:817`, call :958 | `GET /api/projects/:id/clips/:clipId/layout/auto` | clips-studio |
| `:244` | `fetchSplitLayoutAnalysis()` | none | `clipService.getClipSplitLayoutOutcome` | same | none | `ClipSplitLayoutOutcome \| null` / failure | none (polling) | `studio-shell.tsx:818`, call :1081 (guard :1069) | `GET /api/projects/:id/clips/:clipId/layout/split` | clips-studio |
| `:251` | `fetchScreenLayoutAnalysis()` | none | `clipService.getClipLayoutAnalysisOutcome` | same | none | `ClipLayoutAnalysisOutcome \| null` / failure | none (polling) | `studio-shell.tsx:819`, call :1026 (guard :1014) | `GET /api/projects/:id/clips/:clipId/layout/screen` | clips-studio |
| `:258` | `updateProjectCensorTerms(terms: string[])` | `string[]` (validated in service) | `autoCensorService.replaceProjectTerms(actor, projectId, terms)` | `executeProjectAction(projectId,"content.edit")` | none | `{terms}` / failure | none | `studio/_components/tool-panels/censor-panel.tsx:317` (prop type `studio-shell.tsx:710`) | `PUT /api/projects/:id/censor-terms` | clips-studio |
| `:265` | `recordAutoCensorEvent(input: AutoCensorAnalyticsInput)` | `AutoCensorAnalyticsInput` (validated in service) | `autoCensorService.recordEvent(actor, projectId, clipId, input)` | `executeProjectAction(projectId,"content.view")` | none | `{recorded:true}` / failure | none | `censor-panel.tsx:98` (fire-and-forget `recordEventBestEffort`), prop `studio-shell.tsx:714` | `POST /api/projects/:id/clips/:clipId/censor-events` (best effort; client swallows errors) | clips-studio |

(`replaceCensorWordsAction`/`resetCensorWordsAction` are also passed into Studio as props from this page; see 1.3.)

### 1.7 Brand kit (`app/(app)/brand-kit/style-actions.ts`)

All five already have equivalent Hono routes (`route.ts:1758-1792`), so the extraction may drop the actions and call them; verify the routes' policy capabilities match.

| File:line | Function | Input | Service / auth calls | Policy helper + capability | Plan check | Returns | Side effects | Client callers | Target endpoint | Domain |
|---|---|---|---|---|---|---|---|---|---|---|
| `:17` | `createBrandTemplateAction(input)` | `brandTemplateInputSchema` (`BrandTemplateInput`) | `brandTemplateService.create` | `executeWorkspaceActionWithInput("brand.manage")` | in service | created template / failure | `revalidatePath("/brand-kit","layout")` | `brand-kit/_components/template-form.tsx:270` (then `router.push("/brand-kit/styles/:id")`:284) | existing `POST /api/brand-templates` (route.ts:1758) | brand-kit |
| `:25` | `updateBrandTemplateAction(id, input)` | `brandTemplateUpdateSchema` (`BrandTemplateUpdate`) | `brandTemplateService.update` | `executeWorkspaceActionWithInput("brand.manage")` | in service | updated template / failure | same | `template-form.tsx:286` (`router.refresh`:300) | existing `PATCH /api/brand-templates/:id` (:1769) | brand-kit |
| `:36` | `deleteBrandTemplateAction(id)` | `string` | `brandTemplateService.softDelete` | `executeWorkspaceAction("brand.manage")` | none | `void` / failure | same | `brand-kit/_components/template-gallery.tsx:246` | existing `DELETE /api/brand-templates/:id` (:1780) | brand-kit |
| `:43` | `setDefaultBrandTemplateAction(id)` | `string` | `brandTemplateService.setDefault` | `executeWorkspaceAction("workspace.manage")` (note: `workspace.manage`, not `brand.manage`) | none | `void` / failure | same | `template-gallery.tsx:177` | existing `POST /api/brand-templates/:id/set-default` (:1786) | brand-kit |
| `:50` | `duplicateBrandTemplateAction(id, newName?)` | `string, string?` | `brandTemplateService.duplicate` | `executeWorkspaceAction("brand.manage")` | none | never returns on success: **`redirect("/brand-kit/styles/:newId")`** | `revalidatePath`, `redirect` | `template-gallery.tsx:211` | existing `POST /api/brand-templates/:id/duplicate` (:1792) returning the new id; client navigates | brand-kit |

### 1.8 Publishing / calendar / exports / MCP confirm

| File:line | Function | Input | Service / auth calls | Policy helper + capability | Plan check | Returns | Side effects | Client callers | Target endpoint | Domain |
|---|---|---|---|---|---|---|---|---|---|---|
| `app/(app)/calendar/actions.ts:7` | `cancelWorkspacePostAction(projectId, postId)` | `string, string` | `socialService.cancelPost(appUser, projectId, postId)` | `executeProjectAction(projectId,"publishing.manage")` | none | `void` / failure | `revalidatePath("/calendar")` | `app/(app)/calendar/page.tsx:415` (`AuthenticatedActionForm action={cancelWorkspacePostAction.bind(null, projectId, postId)}`) | existing `DELETE /api/projects/:id/social-posts/:postId` (`social-publication-http.ts:71`, verify) | publishing |
| `app/(app)/calendar/queue/actions.ts:22` | `savePostingScheduleAction(accountId, schedule: unknown)` | `z.strictObject({accountId: uuid, schedule: postingScheduleSchema.nullable()})` | `publishingQueue.setPostingSchedule` | `executeWorkspaceActionWithInput("publishing.manage")` | none in action | `void` / failure | `revalidatePath("/calendar/queue")`, `/calendar` | `calendar/queue/posting-schedule-editor.tsx:59` (`router.refresh`:65) | `PUT /api/social/accounts/:accountId/posting-schedule` | publishing |
| `:35` | `tiktokAcceptanceOptionsAction(accountId)` | `z.strictObject({accountId: uuid})` | `socialPublishingOptions(actor, accountId)` (returns subset: `directEnabled, inboxEnabled, privacyOptions, commentDisabled, duetDisabled, stitchDisabled`) | `executeWorkspaceActionWithInput("publishing.manage")` | none | options subset / failure | none | `calendar/queue/proposals-inbox.tsx:94` | `GET /api/social/accounts/:accountId/tiktok-options`; existing project-scoped `GET /api/projects/:id/social-accounts/:accountId/publishing-options` returns more | publishing |
| `:54` | `updateProposalCaptionAction(proposalId, caption)` | `updateSocialPostProposalSchema.extend({proposalId: uuid})` | `publishingQueue.updateProposalCaption` | `executeWorkspaceActionWithInput("publishing.manage")` | none | `void` / failure | revalidate queue + calendar | `proposals-inbox.tsx:240` (`router.refresh`:201 in shared `run`) | `PATCH /api/social/proposals/:proposalId` | publishing |
| `:66` | `rejectProposalAction(proposalId)` | `z.strictObject({proposalId: uuid})` | `publishingQueue.reject` | same | none | `void` / failure | same | `proposals-inbox.tsx:263` | `POST /api/social/proposals/:proposalId/reject` | publishing |
| `:78` | `acceptProposalAction(proposalId, choices)` | `z.strictObject({proposalId, choices: acceptSocialPostProposalSchema})` (`choices ?? {}`, TikTok choices under `tiktok`) | `publishingQueue.accept` | same | none in action | `{accepted:[accepted], skippedTikTok:0, failed:[]}` / failure | same | `proposals-inbox.tsx:276`, `:290` | `POST /api/social/proposals/:proposalId/accept` | publishing |
| `:93` | `acceptAllProposalsAction(after: string\|null = null)` | `z.strictObject({after: uuid.nullable()})` | `publishingQueue.acceptAll(actor,{after})` (cursor batches; skips TikTok) | same | none | `{accepted, skippedTikTok, failed, nextCursor}` (caller loops until `nextCursor` null) | same | `proposals-inbox.tsx:325` (`router.refresh`:342) | `POST /api/social/proposals/accept-all` `{after}` | publishing |
| `:102` | `proposeToQueueAction(input: unknown)` | `proposeSocialPostSchema.extend({idempotencyKey: uuid})` | `publishingQueue.propose(actor, proposal, {source:"person", mutation:{clientIdempotencyKey}})` | same | none in action | `{proposalId}` / failure | same | `app/(app)/projects/[projectId]/publishing-provider.tsx:615`; test fixture `publishing.browser.fixture.tsx:23` | `POST /api/social/proposals` with `Idempotency-Key`; REST v1 has `POST /social-posts/proposals` (API-key surface, keep separate) | publishing |
| `app/(app)/exports/actions.ts:7` | `retryWorkspaceExportAction(exportId)` | `string` | `clipExportService.getWorkspaceOwned`, then `clipExportService.retryFailed(appUser, projectId, clipId, exportId)`; throws `Error("Export not found")` | `executeWorkspaceAction("processing.consume")` | credits in service | `void` / failure | `revalidatePath("/exports")` | `app/(app)/exports/page.tsx:146` (`AuthenticatedActionForm action={retryWorkspaceExportAction.bind(null, item.id)}`) | `POST /api/workspace/exports/:exportId/retry` (existing: `POST /api/projects/:id/clips/:clipId/exports/:exportId/retry`, route.ts:1350, needs ids the page already has) | exports |
| `app/(app)/integrations/mcp/confirm/actions.ts:10` | `confirmMcpPublication(form: FormData)` | `token`, `decision` (`confirm`/other) | `verifyMcpPreparation`, `acceptMcpConfirmation` (`@narriflow/mcp-core`), `workspaceService.requireActor(..., "publishing.manage")`, `getMcpMutationGuard` + `admitMcpContinuation` (`lib/mcp-auth.ts`, `lib/mcp-continuation-principal.ts`), `socialPublicationScheduling.schedule` | `executeSignedInAction` (the signed continuation token selects the workspace, never the browser's active workspace) | `hasFeature(tier, "integrations.mcp")` and `actor.status === "active"` | never returns: **`redirect()`** to `/integrations/mcp`, `/integrations/mcp/confirm?declined=1`, `/projects/:id?publicationId=...`, `/sign-in?redirect_url=...` (auth required), or `/integrations/mcp/confirm?failure=<code>` | `redirect` only | `app/(app)/integrations/mcp/confirm/page.tsx:39` (`<form action={confirmMcpPublication}>`) | `POST /api/mcp/confirmations` `{token, decision}` -> `{destination}`; client navigates. Auth is browser session + token (signed link); uses `lib/mcp-*` files that import `next/*` (see Section 7) | settings-integrations |

### 1.9 Shared helpers used by actions

| File | Role | API-side fate |
|---|---|---|
| `lib/authenticated-request-action.ts` (`import "server-only"`) | All `execute*Action[WithInput]` wrappers, `AuthenticatedActionFailure`, `authenticatedActionResultError`, `authenticatedActionErrorMessage`. Adapter name `"server_action"`. | Replace with the Hono adapter (`lib/authenticated-request-hono.ts` already exists) |
| `lib/authenticated-request-policy.server.ts` (`server-only`, React `cache`, `unstable_rethrow`) | `resolveBrowserActorScope` (cached), `resolveBrowserSignedInActorScope`, `authenticatedRequestPolicy`, `signedInAuthenticatedRequestPolicy`, `freshAuthenticatedRequestPolicy`; uses `getCurrentAppUser`, `getWorkspaceContextForUser` (cookie), `checkRateLimit`, `getPrismaClient` | Move policy deps to `@clerk/backend` + header-selected workspace; drop `cache`/`unstable_rethrow` |
| `lib/authenticated-request-policy.ts` | Pure policy (`createAuthenticatedRequestPolicy`, `AuthenticatedRequestUnexpectedError`, adapters `"hono"\|"server_action"\|"page"\|"stream"`) | Reuse as is; `server_action` and `page` adapters die |
| `lib/authenticated-request-browser.ts` | Client-side failure reader (`isAuthenticatedActionFailure`, `authenticatedRequestFailureMessage`) | Becomes `ApiError` handling in `packages/api-client` |
| `lib/authenticated-request-inventory.ts` (+ `.test.ts`) | Declares every server action (`browserSessionServerActions`, lines ~955-1260) and every Hono surface; test checks against `"use server"` files | Rewrite as Hono-route inventory |
| `app/_components/authenticated-action-form.tsx` | Client `<form action>` using `useActionState`; renders failure text + `Support ID`. Used by `settings/workspace/page.tsx`, `calendar/page.tsx`, `projects/[projectId]/page.tsx`, `processing-panel.tsx`, `exports/page.tsx`, `invite/[token]/invite-view.tsx` | Replace with a mutation-form helper (React Query `useMutation`) |
| `app/(app)/upload/_lib/content-pack-form.ts` | `readContentPackFromForm`, `readLanguageCodeFromForm`, `readBrandProfileIdFromForm` (parse FormData into a `ContentPack`; used by projects + upload actions) | Client-side only; send JSON to the API |
| `app/workspaces/new/checkout-request.ts` | `buildBusinessWorkspaceCheckoutRequest`, `recoverBusinessWorkspaceCheckoutFields` | Client / validators |
| `lib/safe-redirect.ts` | `resolveCanonicalAppOrigin({configuredOrigin, environment, requestUrl})` (used by `createBusinessWorkspaceAction`) | API needs the same canonical-origin config (`APP_URL`) |
| `lib/mcp-auth.ts`, `lib/mcp-continuation-principal.ts` | MCP confirm guard / continuation principal (used by `confirmMcpPublication`) | move with MCP routes |

### 1.10 Surprises in Section 1

1. **Active workspace is an httpOnly cookie** (`narriflow_active_workspace`) read by actor resolution and written by `setActiveWorkspaceForActor` in three actions. A Bearer/Expo API cannot rely on it; it needs an explicit workspace selector.
2. **Three actions end in `redirect()`** and never return on success (`duplicateBrandTemplateAction`, `deleteProjectFormAction`, `acceptWorkspaceInviteAction`), plus `confirmMcpPublication` (always redirects). Plan-limit refusals in `queueTranscriptionFormAction` and `regenerateClipsFormAction` also `redirect` to the project page. The API must return data (new id / destination / typed error) and the client navigates.
3. **Two dead actions** (`renderClipsFormAction`, `queueGenerationFormAction`) and `commitLinkImportAction` has no zod parse. Studio's polling actions are closure-bound to route params.
4. Several actions already have equivalent Hono routes (brand templates 5/5, `cancelPost`, `regenerate`, `render`, `ingest/link`, `ingest/rss/import`, export retry, `projects/:id/generate`); verify capability and body parity before reusing them instead of porting.
5. `setDefaultBrandTemplateAction` needs `workspace.manage`, the other brand actions `brand.manage`.
6. Settings actions build invite URLs from `process.env.NEXT_PUBLIC_APP_URL` and call `sendEmail`; the API needs `APP_URL` and email env.

## 2. Server-side data reads

Scope: `apps/web` files that import `@narriflow/services`, `@narriflow/db` or `@narriflow/auth` as a value, plus pages that only reach data through the page admission helper. Excludes `"use server"` files, `route.ts` files, tests.

Counts (verified with `find`/`rg` and a classifier script over `apps/web/**/*.{ts,tsx}`):

| Measure | Count |
| --- | --- |
| `page.tsx` files under `apps/web/app` | 52 |
| `layout.tsx` files | 6 |
| `loading.tsx` files | 35 (only `autopilot/loading.tsx` imports a service value) |
| Files in `apps/web` importing `@narriflow/(services\|db\|auth)` at all | 107 |
| ...of which pages/layouts importing a **value** | 35 (33 pages + `app/layout.tsx` + `app/(app)/layout.tsx`) |
| Pages/layouts with **no direct import** but a server read via `admit*Page` (identity or capability gate) | 4: `(app)/settings/layout.tsx`, `(app)/search/page.tsx`, `auth/continue/page.tsx`, `workspaces/new/page.tsx` |
| Pages/layouts calling `admit*Page` in total | 37 (`rg -l authenticated-request-page` over app+lib = 37 files, all pages/layouts) |
| Non-page modules importing a service/db/auth **value** and rendering on the server | `(app)/_components/usage.ts`, `(app)/autopilot/loading.tsx`, `lib/review-preselection.ts` (also client-bundled via `review-panel.tsx`), `.../studio/_components/waveform-peaks.ts` (client-bundled, imports `@narriflow/services/clip-preview-storage`) |
| Non-test, non-API files with **type-only** imports from `@narriflow/services` | 16 (listed in 2.D; `home/dashboard-view.tsx`, `home/recent-projects.tsx`, `finishing-status.tsx` are not `"use client"`) |

Admission helpers (all in `apps/web/lib/authenticated-request-page.ts`, 121 lines): `admitSignedInPage(returnTo)` (identity only, `signedInAuthenticatedRequestPolicy`), `admitWorkspacePage(capability)`, `admitProjectPage(projectId, capability)`, `admitOptionalWorkspacePage(capability)` (returns `null` when signed out; used only by `(app)/layout.tsx`). On failure they `redirect()` or `notFound()`:

| Failure code | Page behavior (lines 17-47) |
| --- | --- |
| `authentication_required` | `redirect(authEntryHref("sign-in", returnTo))` (returnTo = given value, else `/projects/:id`, else `/home`) |
| `project_not_found` | `notFound()` |
| `active_workspace_mismatch` | `redirect("/projects?requestFailure=active_workspace_mismatch&workspaceId=..&workspaceName=..&returnTo=..")` |
| `workspace_restricted` | owner: `redirect("/settings/billing?requestFailure=..&requestId=..")`; others: `redirect("/workspace-unavailable?...")` |
| any other | `redirect("/home?requestFailure=<code>&requestId=<id>")` |

In the API these become typed errors (`code` + `details`), and the client route/loader performs the redirect. The three redirect destinations above must be reimplemented in the client (suggest one `useAdmissionRedirect`/error-boundary mapper in `packages/api-client` or web).

### 2.A Layouts

| File (lines) | Data loaded (line) | Gate | Redirect / notFound | Props to client components | Proposed GET |
| --- | --- | --- | --- | --- | --- |
| `app/layout.tsx` (97) | `billingService.validateConfiguration({surface:"web"})` L63, `validateCoreEnv()` L62 (config assertions, no data) | none | none | `ClerkProvider`, `Provider`, `AuthModal` | none. Drop `billingService.validateConfiguration` from web (API validates Stripe config at boot). Keeps `process.env.NEXT_PUBLIC_APP_URL` for `metadataBase`. |
| `app/(app)/layout.tsx` (84) | `admitOptionalWorkspacePage("content.view")` L16; `getCachedUsageSummary` L23 (`projectService.getUsageSummary`); `listUserWorkspaces` (`@narriflow/auth`) L24; `billingService.readBillingState` L25; `workspaceService.getAvatarUrls` L27 | `admitOptionalWorkspacePage("content.view")`, `workspaceAllowsCapability(..."billing.manage"\|"api.manage"\|"members.invite")`, `hasFeature(..."workspace.members")` | signed out: `redirect("/?auth=sign-in")` L19 | `UpgradeProvider{currentTier,billingMode,canManageBilling}`; `AppChrome{email,firstName,lastName,imageUrl,remainingCredits,usedCredits,reservedCredits,limitCredits,creditsRenewAt,activeWorkspaceId,workspaceSelectionChanged,workspaceRole,workspaceStatus,workspaceTier,workspaces[{id,name,role,isPersonal,avatarUrl}],workspaceMenu{tier,canManageApi,canInvite,planAction}}` | **NEW `GET /api/session`** returning actor identity, active workspace (`id,name,role,status,pricingTier,isPersonal,workspaceSelectionChanged`), `workspaces[]` with avatar URLs, and `usage` summary. Billing view reuses existing `GET /api/billing/state` (`{view}`) so `billingMode` stays derived client-side via `lib/billing-view-model.ts`. Optional: fold `usage` into session since the shell and Billing/Usage/Upload/Project pages all need it (query key `["usage"]`). |
| `app/(app)/settings/layout.tsx` (6) | `admitWorkspacePage("content.view")` L4 | content.view | gate redirects only | `children` | covered by `GET /api/session` (no extra fetch; guard is the same admission) |
| `app/(app)/projects/[projectId]/clips/[clipId]/studio/layout.tsx` (25) | none (`"use client"`) | inherited | none | n/a | none |

`getCachedUsageSummary` (`(app)/_components/usage.ts`, 7 lines) is `react.cache(projectService.getUsageSummary({actorUserId, workspaceId}))`, imported only by `(app)/layout.tsx`. Disappears with the layout read.

### 2.B Pages

`Gate` = argument to `admit*Page`. All `(app)` pages also inherit `(app)/layout.tsx` admission (`content.view`). Line numbers are exact for the admit call and the service calls.

| File (lines) | Gate (line) | Service / db / validators calls (line) | Params / searchParams | Redirect / notFound | Props to client components | Proposed GET endpoint(s) |
| --- | --- | --- | --- | --- | --- | --- |
| `app/(app)/home/page.tsx` (46) | `admitWorkspacePage("content.view")` L16 | `workspaceLibraryService.listProjects(appUser,{limit:8})` L19; `autopilotService.listRules` L21 (only if `content.edit`); `hasFeature`, `lowestTierWithFeature`, `planLimits` L37-42 | none | none | `DashboardView{greeting,items,canCreate,readOnlyReason,canManageBilling,autopilot{lockedTier,rules,activeRules},showRetentionBanner}` | Existing `GET /api/projects?limit=8` (route.ts L346) + existing `GET /api/autopilot/rules` (L242). Capability/tier flags derive client-side from `/api/session`. Greeting uses client clock (today server clock). |
| `app/(app)/autopilot/page.tsx` (53) | content.view L7 | `zoomConfigured()` L8; `autopilotService.listRules` L10; `recipeService.list` L11; `standingGrants.list` L12; `zoomService.listConnections` L13 (only if zoom configured); `planCountRequirement`, `hasFeature`, `workspaceAllowsCapability` | `searchParams.zoom` (notice) | none | `AutopilotPanel{newRuleRequirement,newRuleUpgradeTier,autopilotIncluded,canManageBilling,initialRules,recipes,zoomEnabled,zoomConnections,zoomNotice,canConnectZoom,canEdit,canRun,workspaceStatus,canTakeOver,finishingAvailable,grants[]}` | Existing `GET /api/autopilot/rules`, `GET /api/recipes`, `GET /api/zoom/connections` (zoom-http.ts L23). **NEW `GET /api/automation/standing-grants`** (`standingGrants.list`). **NEW** `zoomEnabled` flag: expose `zoomConfigured()` via `GET /api/session` `features.zoom` or `GET /api/zoom/status`. `autopilot/loading.tsx` (67) also calls `zoomConfigured()` L11; it needs the same flag without a fetch (cached session). |
| `app/(app)/recipes/page.tsx` (31) | content.view L7 | `recipeService.list` L9; `brandProfileService.listSummaries` L10; `brandProfileService.list` L12; `socialOAuthService.listAccounts` L13 | none | none | `RecipesPanel{initialRecipes,brandProfiles[{id,name,isDefault}],brandLooks{[id]:{colors,logoUrl}},canEdit,finishingAvailable,queueAccounts[]}` | Existing `GET /api/recipes`, `GET /api/social/accounts`, `GET /api/brand-profiles` (default `limit` 24 in the route vs unlimited on the page; needs `limit` param or a NEW `GET /api/brand-profiles?summary=1` for `listSummaries`). |
| `app/(app)/performance/page.tsx` (23) | content.view L7 | `performanceService.whatWorked` L9; `performanceService.guidance` L10; `socialOAuthService.listAccounts` L11; `performanceSyncAvailable`, `workspaceAllowsCapability` | none | none | `WhatWorked{summary,guidance,emptyNextStep}` | **NEW `GET /api/performance/what-worked`**, **NEW `GET /api/performance/guidance`** (also used by `settings/workspace`), existing `GET /api/social/accounts`. |
| `app/(app)/search/page.tsx` (18) | content.view L9 | none | `searchParams.q` (sliced to 300) | none | `LibrarySearch{initialQuery,canCreate}` | none beyond session; client already searches via `GET /api/library/search` (L386) and `GET /api/workspace/search` (L377). |
| `app/(app)/projects/page.tsx` (246) | content.view L128 (header), L171 (data) | `workspaceLibraryService.listFolders` L135, L185; `workspaceLibraryService.listProjects(appUser,{folderId,query,status,source,sort})` L184; `planLimits`, `resolvePricingTier`, `workspaceAllowsCapability`. Type imports `ProjectListSort/SourceFilter/StatusFilter`. | `searchParams`: `q,status,source,sort,folder,requestFailure,workspaceId,workspaceName,returnTo,cursor?` | none (admission may redirect here with `requestFailure=active_workspace_mismatch`) | `ProjectsHeaderActions{canCreate,canEdit}`, `WorkspaceMismatchNotice{workspaceId,workspaceName,returnTo}`, `FoldersPanel{folders[{id,name,count}]}`, `RetentionBanner{canManageBilling}`, `ProjectsExplorer{initialProjects,initialNextCursor,totalCount,initialQuery,initialStatus,initialSource,initialSort,folderId,folderName,folders,canEdit,...}` | Existing `GET /api/projects?q&status&source&sort&folder&limit&cursor` (route.ts L346, already used by the explorer for paging). **NEW `GET /api/workspace/folders`** (`listFolders` with `_count.projects`). |
| `app/(app)/projects/[projectId]/page.tsx` (1107) | `admitProjectPage(projectId,"content.view")` L164 | `projectService.getProjectSnapshot` L182; Promise.all L205-244: `getTranscriptSnapshot` (tab=transcript) / `getTranscriptStatusSnapshot` (other tabs), `clipService.listClips`, `getLatestContentPack`, `analyticsService.getProjectAnalytics` (tab=analytics), `socialService.listProjectPosts` , `socialOAuthService.listAccounts` (tab posts/clips), `dubbingService.listProjectDubs` + `getDubbingAllowance` (tab=dubbing), `projectService.getWorkflowHistory`, `getUsageSummary`, `brandProfileService.list(brandScope)` (tab=clips), `reviewService.internalRoom(workspaceId,projectId,"manage"\|"view")` (tab=review), `workspaceService.getWorkspace` (tab posts/clips), `getProjectFinishing` (L239), `getProcessingUsage().projectCreditUsage(projectId)` (L244); `presignDownloadUrl` L319 (tab=clips, 3600s, errors swallowed); `isQuotaBlockedMidFlight`, `MAX_INGEST_RETRY_ATTEMPTS`; many `hasFeature`/`planFeatureRequirement`/`brandPlanRequirement`/`planUpgradeHighlight`/`creditsForSourceSeconds`; `randomUUID()` for hidden idempotency keys L875, L945 | `params.projectId`; `searchParams.tab`, `searchParams.reviewSelection` | `notFound()` L185 when no project (plus `admitProjectPage` notFound for missing/expired/purged project, mismatch redirect) | `ProjectEventsProvider{projectId,initialSeq=snapshot.lastSeq,initialEvents=workflowHistory}`, `ProjectShareButton{projectId,upgrade,actor{name,email,imageUrl,initials,role}}`, `DeleteProjectButton`, `PipelineStepper{steps,workflowRunId}`, `FinishingStatus{projectId,finishing}`, `RetryIngestButton`, `ProjectBrandPicker{projectId,brands[],currentBrandId,canEdit,upgrade,requirementMessage}`, `PublishingProvider{projectId,actorId,workspaceId,clips,accounts,initialPosts,initialPostsCursor,workspaceTimezone,can1080pExport,canOverrideReview,canPublish,publishingUpgrade,assistedCopy*,customThumbnails*,campaignSchedulingEnabled,canUploadVisualAssets}`, `ProcessingPanel{projectId,mediaWell,quotaUpgrade,advancedSettingsProps,defaultSourceLanguageCode,canEdit,...}`, `ClipsPanel{clips,projectId,mode,isFreeTier,can1080pExport,defaultAspectRatio,sourceVideoUrl,actionAvailability,upgradePrompts,canEdit}`, `TranscriptPanel{projectId,transcript}`, `ContentSuitePanel`, `DubbingPanel{projectId,clips,dubs,allowance,planRequirement,upgrade,canEdit}`, `ReviewPanel{projectId,initialData,canManage,preselection}`, `AnalyticsPanel{analytics,clips}`, `AuthenticatedActionForm` + server actions `queueTranscriptionFormAction`, `regenerateClipsFormAction` | Existing: `GET /api/projects/:id` (snapshot; L473, 404 on missing), `GET /api/projects/:id/clips` (L635), `GET /api/projects/:id/transcript` (L507, full snapshot only), `GET /api/projects/:id/analytics` (L1475), `GET /api/projects/:id/social-posts` (social-publication-http L60, paged), `GET /api/social/accounts`, `GET /api/projects/:id/dubs` (L1663), `GET /api/projects/:id/review-rounds` (L1110, same `internalRoom` call), `GET /api/brand-profiles`, `GET /api/ingest/:projectId` (L620), `GET /api/projects/:id/campaign-operations` (L823). **NEW**: `GET /api/projects/:id/transcript?view=status` (status snapshot), `GET /api/projects/:id/content-pack` (latest), `GET /api/projects/:id/workflow-history` (initial events; or `?afterSeq=` on the existing stream), `GET /api/projects/:id/finishing`, `GET /api/projects/:id/credit-usage` (or fold into snapshot: `projectCreditUsage` + `quotaBlockedMidFlight`), `GET /api/projects/:id/source-url` (presigned playback, tab=clips), `GET /api/projects/:id/dubs/allowance`, `GET /api/workspace` (timezone). Page must become a client composition using one query per tab to avoid a waterfall; `snapshot` first, tab queries in parallel. |
| `app/(app)/projects/[projectId]/clips/[clipId]/exports/[exportId]/page.tsx` (32) | `admitProjectPage(projectId,"content.download")` L14 | `clipExportService.getOwned(appUser,projectId,clipId,exportId)` L16; `getLastWorkflowSeq(projectId)` L17; `planFeatureRequirement`, `featureUpgradePrompt` x3, `workspaceAllowsCapability` | params: `projectId, clipId, exportId` | `notFound()` L19 | `ExportDeliveryClient{initialExport,initialSeq,timelineRequirement,timelineUpgrade,canEdit,publishingUpgrade,canSendForReview,reviewUpgrade}` | Existing `GET /api/projects/:id/clips/:clipId/exports/:exportId` (route.ts L1305, 404 `export_not_found`). **NEW** `initialSeq`: add `lastSeq` to that response or use `GET /api/projects/:id` snapshot `lastSeq`. |
| `app/(app)/projects/[projectId]/clips/[clipId]/studio/page.tsx` (327) | `admitProjectPage(projectId,"content.edit")` L40 | L46-57: `projectService.getProjectSnapshot`, `clipService.listClips`, `clipService.getClipPreviewSource`, `projectService.getProjectBrandSnapshot`, `projectService.getProjectBrandAudio`; L61 `autoCensorService.getPolicy`; L91-122: `presignDownloadUrl` (source video, 3600s), `clipService.getClipEditorDocument`, `presignDownloadUrl` (brand logo), `visualAssetService.list`, `sceneTemplateService.list`, `brandProfileService.get`; L123-129 `visualAssetService.resolveSceneReferences`, `resolveVisualBrollReferences`, `brandFontService.resolveSceneReferences`; L179-181 `brandFontService.list`, `brandFontService.resolveReferences`; `generatedImageCapability(appUser)` L68, `brandPlanRequirement`, `planFeatureRequirement`, `hasFeature`; pure: `getEffectiveClipTiming`, `compositionAssetRef` | params `projectId, clipId`; `searchParams.qaCompositionPlan` (dev-only fixture via `process.env.NODE_ENV`) | `notFound()` L59 (no project) and L80 (clip not in project) | `BrandFontsProvider{fonts,requirement,upgrade}`, `StudioShell{clipInfo,timelineSegments,initialEditorDocument,initialEditorRevision,initialEditorOriginal,sourceVideoUrl,sourcePreviewId,clipStartSec,clipEndSec,previewVideoUrl,previewStartSec,previewDurationSec,waveformPeaksUrl,sourcePurged,fetchPreviewStatus,fetchAutoLayoutAnalysis,fetchSplitLayoutAnalysis,fetchScreenLayoutAnalysis,brandLogo,layoutAnalysis,autoLayoutAnalysis,splitLayoutAnalysis,splitLayoutFailure,layoutAnalysisFailure,compositionPlanQaFixture,visualAssets,brandProfileId,brandAudio,sceneFonts,sceneTemplates,sceneWriteCapabilities,generatedImagesCapability,autoCensorPolicy,upgradePrompts,updateProjectCensorTerms,replaceWorkspaceCensorWords,resetWorkspaceCensorWords,recordAutoCensorEvent}`. **Six inline `"use server"` closures** at L224, 237, 244, 251, 258, 265 (`fetchPreviewStatus`, `fetchAutoLayoutAnalysis`, `fetchSplitLayoutAnalysis`, `fetchScreenLayoutAnalysis`, `updateProjectCensorTerms`, `recordAutoCensorEvent`) each wrapping `executeProjectAction(projectId, "content.edit"\|"content.view", ...)`; plus imported `replaceCensorWordsAction`/`resetCensorWordsAction` from `settings/workspace/censor-words-actions.ts` | Existing: `GET /api/projects/:id`, `GET /api/projects/:id/clips`, `GET /api/projects/:id/clips/:clipId/editor` (clip-editor-http L214, returns `{document,revision,original,layoutAnalysis,autoLayoutAnalysis,splitLayoutAnalysis,...}`), `GET /api/visual-assets`, `GET /api/brand-profiles/:id`, `GET /api/brand-profiles/:id/scene-templates`, `GET /api/brand-fonts`, `GET /api/projects/:id/generated-media/jobs` (carries `usage`), `GET /api/projects/:id/clips/:clipId/preview-peaks`. **NEW**: `GET /api/projects/:id/clips/:clipId/preview-source` (replaces `fetchPreviewStatus`, polled), `.../auto-layout-analysis`, `.../split-layout-outcome`, `.../layout-analysis-outcome` (replace the three polling actions), `GET /api/projects/:id/brand-snapshot` (snapshot + presigned logo + audio, replaces `getProjectBrandSnapshot`/`getProjectBrandAudio`/logo presign), `GET /api/projects/:id/source-url`, `GET /api/projects/:id/auto-censor` (policy; mutations are the other fork's), `POST /api/brand-fonts/resolve` or `GET /api/projects/:id/clips/:clipId/editor-assets` (retained scene/b-roll visual assets and fonts: `resolve*References`), `GET /api/generated-images/capability`. `qaCompositionPlan` fixture stays web-side. Biggest page: needs one aggregate client query keyed on `[project, clip]` plus polling queries. |
| `app/(app)/exports/page.tsx` (290) | content.view L105 | `workspaceLibraryService.listExports(appUser,{status,query,projectId,aspectRatio,from,to,cursor})` L122; `workspaceLibraryService.listExportProjects(appUser)` L127 | `searchParams`: `status,q,project,ratio,from,to,view,cursor` (parsed/validated on the page: status filter list, 4 aspect ratios, ISO dates) | none | `ExportFilters{projects}`, `ExportPreview{src,ratio,status,progress,compact}` (src = `/api/workspace/exports/:id/download?variant=:id`, existing L401), `AuthenticatedActionForm{action: retryWorkspaceExportAction.bind(null, id)}` | **NEW `GET /api/workspace/exports`** (same filters, cursor), **NEW `GET /api/workspace/export-projects`**. Move the param validation into the route's zod query schema. |
| `app/(app)/calendar/page.tsx` (554) | content.view L143 | `workspaceLibraryService.listCalendarPosts(appUser,{from,to,status,platform,accountId,projectId})` L175 (window = view window +/- 36h); `workspaceService.getWorkspace` L186 (timezone); `workspaceLibraryService.getCalendarFilters` L187; `publishingQueue.countProposals` L190 | `searchParams`: `month,date,view,status,platform,account,project` | none | `CalendarLiveRefresh{delayMs}` (client; `router.refresh()` timer), `CalendarFilters{filters[]}`, `AuthenticatedActionForm{action: cancelWorkspacePostAction}`, `LockedButton`; most of the grid renders server-side | **NEW `GET /api/workspace/calendar/posts?from&to&status&platform&account&project`**, **NEW `GET /api/workspace/calendar/filters`**, **NEW `GET /api/publishing/proposals/count`** (or return `proposalCount` with the proposals list), **NEW `GET /api/workspace`** (name, timezone, status). `CalendarLiveRefresh` becomes React Query `refetchInterval` driven by `socialPollDelayMs`. |
| `app/(app)/calendar/new/page.tsx` (64) | `admitWorkspacePage("publishing.manage")` L11 | `workspaceLibraryService.getCalendarComposerOptions(actor,{query,cursor})` L13 | `searchParams`: `q, cursor` | none | none (links to `/projects/:id?publishClip=:clipId`) | **NEW `GET /api/workspace/calendar/composer-options?q&cursor`** |
| `app/(app)/calendar/queue/page.tsx` (96) | content.view L40 | `publishingQueue.listProposals` L42; `socialOAuthService.listAccounts` L43; `workspaceService.getWorkspace` L44 (timezone); `workspaceAllowsCapability`, `featureUpgradePrompt` | none | none | `ProposalsInbox{proposals,timeZone,canManage,scheduleUpgrade}` (client; also imports type `ProposalInboxItem`), `PostingScheduleEditor{accounts,timeZone,canManage,scheduleUpgrade}` | **NEW `GET /api/publishing/proposals`**, existing `GET /api/social/accounts`, **NEW `GET /api/workspace`**. Posting-schedule slots are fetched inside the editor today (check `posting-schedule-editor.tsx`); that part is the actions fork's. |
| `app/(app)/brand-kit/page.tsx` (298) | content.view L31 | `brandProfileService.list(scope)` L43; `brandProfileService.getDefaultId` L44; `brandTemplateService.list` L45; `brandFontService.list` L46; `brandPlanRequirement`, `brandCountRequirement`, `planCountRequirement`, `planFeatureRequirement`, `featureUpgradePrompt` | `searchParams.tab` (`profiles\|styles\|fonts`) | none | `BrandTabs`, `ProfileCard` (name, colors, logoUrl, preset, isDefault, approvalRequired, subtitle, stats), `FontLibrary{fonts,canManage}`, `FontUploadButton`, `LockedButton`, `PlanLimitNotice`, template gallery | Existing `GET /api/brand-profiles` (limit 24 default; page wants all), `GET /api/brand-templates` (`{mine,builtIn,...}`), `GET /api/brand-fonts`. **NEW**: default id (`GET /api/brand-profiles/default` or include `defaultId` in list response). |
| `app/(app)/brand-kit/new/page.tsx` (58) | `admitWorkspacePage("brand.manage")` L12 | `brandProfileService.list(scope)` L13; `brandCountRequirement`, `planFeatureRequirement`, `planUpgradeHighlight` | none | none | `BrandProfileCreateForm{governance}` or `PlanLimitNotice` | Existing `GET /api/brand-profiles` (count only). Plan messages derive client-side from `/api/session` tier + count. |
| `app/(app)/brand-kit/[id]/page.tsx` (294) | content.view L33 | `brandProfileService.get` L45; `getDefaultId` L63; `brandProfileService.usage` L64 (manage only); `brandProfileService.list` L65 (manage only, for "move to"); sections: `brandFontService.list` L139, `brandTemplateService.list` + `brandProfileService.list` L177, `sceneTemplateService.list` L247; `brandPlanRequirement` x4 | params `id`; `searchParams`: `section, template` | `notFound()` on `BrandProfileNotFoundError` L47 | `ProfileEditorProvider{profileId,revision}`, `ProfileColorsPanel`, `ProfilePublishingPanel`, `ProfileFontRoles`, `ProfileStyleGrid`, `StyleAdder`, `ProfileAudioPicker`, `ProfileAudioList`, `SceneTemplateManager`, `BrandProfileDefaultButton`, `BrandProfileDeleteButton{usage,otherProfiles}`, `ProfileVoicePanel` | Existing `GET /api/brand-profiles/:id`, `GET /api/brand-profiles/:id/scene-templates`, `GET /api/brand-templates`, `GET /api/brand-fonts`, `GET /api/brand-profiles`. **NEW** `GET /api/brand-profiles/:id/usage` and default id. Each section is a separate query (only the active section fetches). |
| `app/(app)/brand-kit/styles/new/page.tsx` (52) | `admitWorkspacePage("brand.manage")` L13 | `brandTemplateService.list` L14; `brandFontService.list` L27; `brandPlanRequirement`, `planCountRequirement`, `planFeatureRequirement` | none | none | `BrandFontsProvider{fonts,requirement,upgrade}` > `TemplateForm{mode:"create",cancelHref}` or `PlanLimitNotice` | Existing `GET /api/brand-templates`, `GET /api/brand-fonts` |
| `app/(app)/brand-kit/styles/[id]/page.tsx` (96) | content.view L26 | `brandTemplateService.get` L29; `brandProfileService.resolveProfileForTemplate` L37; `brandFontService.list` L62; `brandFontService.resolveReferences` L63; `brandPlanRequirement`, `planFeatureRequirement` | params `id` | `notFound()` on `BrandTemplateNotFoundError` L32 | `BrandFontsProvider` > `TemplateForm{mode:"edit",initialTemplate,cancelHref}`, `PlanLimitNotice`, `AccessNote` | Existing `GET /api/brand-templates/:id` (L1752), `GET /api/brand-fonts`. **NEW** `resolveProfileForTemplate` (`GET /api/brand-templates/:id/profile`, or add `profileId` to the template response) and `resolveReferences` (retained fonts; same helper as Studio). |
| `app/(app)/upload/page.tsx` (158) | `admitWorkspacePage("processing.consume")` L92 | Promise.all L108-116: `brandTemplateService.list`, `brandProfileService.list(brandScope)`, `brandProfileService.getApplicableDefaultId`, `projectService.getUsageSummary`, `recipeService.list`; resume path `loadLinkResumeData` L38-79: `projectService.getProjectSnapshot` L42, `projectService.getLatestContentPack` L60; `parseStoredContentPack`; env: `NEXT_PUBLIC_GOOGLE_API_KEY`, `NEXT_PUBLIC_GOOGLE_CLIENT_ID`, `NEXT_PUBLIC_GOOGLE_APP_ID`, `NEXT_PUBLIC_DROPBOX_APP_KEY` passed to `sourcePickerConfig` | `searchParams`: `url, project, source, mode` | `redirect("/upload")` L48/57/65 (project missing, not link/youtube source, or no draft pack), `redirect("/projects/:id")` L51 (active run exists) | `UploadShell{recipes,brandTemplates,brandProfiles{items,defaultId},initialUrl,initialSource,initialMode,resumeData:LinkResumeData,usageSummary,sourcePickers}` | Existing `GET /api/recipes`, `GET /api/brand-templates`, `GET /api/brand-profiles`, `GET /api/projects/:id` (snapshot with `activeRun`, `ingestJobType`), `GET /api/ingest/:projectId`. **NEW**: `GET /api/projects/:id/content-pack`, `GET /api/brand-profiles/default?applicable=1`, usage summary (`GET /api/workspace/usage`). The resume redirect rules move to a client `useEffect`/loader. `sourcePickerConfig` stays in web (only `NEXT_PUBLIC_*`). |
| `app/(app)/integrations/page.tsx` (306) | content.view L162 | `socialOAuthService.listAccounts` L171; `workspaceService.listApiKeys` L172 (if `api.manage`); `callbackSigningSecrets.status` L173 (if `api.manage`); `workspaceAllowsCapability`, `hasFeature`, `planCountRequirement`, `featureUpgradePrompt` | none | none | tiles: `IntegrationTile`, `LockedButton`, `UpgradeTileButton`; no data-bearing client props beyond hrefs. Connect link `/api/social/oauth/start/:platform?redirect=/settings/social-accounts` | Existing `GET /api/social/accounts`. **NEW** `GET /api/workspace/api-keys`, `GET /api/workspace/callback-signing-secret` (status only). Count-only usage for keys; both are `api.manage` gated. |
| `app/(app)/integrations/mcp/page.tsx` (166) | content.view L35 | `inspectMcpConfiguration` (`lib/mcp-configuration.ts`: fetches `<CLERK_OAUTH_ISSUER>/.well-known/oauth-authorization-server` with 3 s timeout, no-store) L37; `workspaceAllowsCapability` | none | none | `AssistantSetup{mcpUrl,status,notice}`, `PromptCards`, `LockedButton` | **NEW `GET /api/integrations/mcp/status`** returning `{mcpUrl, configuration{verified,label,description}}` (reads `NEXT_PUBLIC_APP_URL`, `CLERK_OAUTH_ISSUER`, `CLERK_SECRET_KEY`, `MCP_CONTINUATION_SECRET`: all API-side). |
| `app/(app)/integrations/mcp/confirm/page.tsx` (40) | `admitSignedInPage("/integrations/mcp/confirm?token=...")` L16 | `verifyMcpPreparation(token,{actorUserId})` (`@narriflow/mcp-core`) L22; `workspaceService.findActor` L25; `workspaceService.requireActor(...,"publishing.manage")` L27; `socialOAuthService.listAccounts` L29; `workspaceService.getWorkspace` L29; `isExpectedDomainFailure` | `searchParams`: `token, declined, failure` | none (renders unavailable states inline) | plain server render + `<form action={confirmMcpPublication}>` (`confirm/actions.ts`, other fork) | **NEW `GET /api/integrations/mcp/preparations?token=` ** (verifies token for the signed-in user, returns intent facts + `destinationAccount` + `workspaceName` + `expiresAtMs`, typed errors for expired/unavailable/connector-unavailable). `export const dynamic = "force-dynamic"`. Uses HMAC secret `MCP_CONTINUATION_SECRET` (API-side). |
| `app/(app)/integrations/mcp/upload/page.tsx` (43) | `admitSignedInPage("/integrations/mcp/upload?intent=...")` L17 | `verifyMcpUploadHandoff(token,{actorUserId,allowExpired:true})` L19; `workspaceService.findActor` L22; `requireActor(...,"processing.consume")` L24; **direct db**: `getPrismaClient().uploadSession.findFirst(...)` L29-31 with `integrationUploadSessionKey`; `recipeService.get` L36; `buildGenerationContext` | `searchParams.intent` | none (renders unavailable inline) | `McpUploadPicker{token,workspaceId,clientIdempotencyKey,title,brandProfileId,recipeId,resumeOnly,generationContext}` | **NEW `GET /api/integrations/mcp/upload-handoff?intent=`** (verify, resume-only decision, recipe name, generation context). The only page doing a raw Prisma query; move the `uploadSession.findFirst` into a service (`UploadSessionService.hasIntegrationSession` or similar). |
| `app/(app)/settings/profile/page.tsx` (43) | content.view L12 | `workspaceService.getWorkspace` L13 | none | none | `PasskeySettings` (client, `@clerk/nextjs` `useUser`); name/initials from actor | Session (`/api/session`) + **NEW `GET /api/workspace`** (name). Passkeys stay Clerk-client-side. |
| `app/(app)/settings/workspace/page.tsx` (94) | content.view L24 | `workspaceService.getWorkspace` L25; `performanceService.guidance` L29; `autoCensorService.getWorkspaceWords` L30; `workspaceService.getAvatarUrls` L32 | none | returns `null` if workspace missing (L27) | `WorkspaceAvatarControl{avatarUrl,workspaceName,canManage}`, `AuthenticatedActionForm{action: updateWorkspaceAction}` (name, timezone), `PerformanceGuidanceField{enabled,qualifies,minimumClips,canManage}`, `CensorWordsCard{initialWords,customized,canManage}` | **NEW `GET /api/workspace`** (id,name,timezone,status; avatar URL included), **NEW `GET /api/performance/guidance`**, **NEW `GET /api/workspace/censor-words`**. |
| `app/(app)/settings/members/page.tsx` (28) | content.view L8 | `workspaceService.listMembers` L10; `billingService.readBillingState` L11; `hasFeature(billingView.plan,"workspace.members")` | none | none | `MembersPanel{actorRole,isBusiness,workspaceStatus,billingView,members[],invites[]}` (dates serialised to ISO) | **NEW `GET /api/workspace/members`** (`{members, invites}`), existing `GET /api/billing/state` |
| `app/(app)/settings/billing/page.tsx` (88) | content.view L23 | `billingService.readBillingState` L25; `projectService.getUsageSummary` L26; `billingService.configuredTiers()` L75, `billingService.isConfigured()` L76 (sync config reads on the server) | `searchParams`: `checkout (return\|cancelled), session_id, plan, interval` | none | `BillingPlans{initialView,availableTiers,isConfigured,checkoutReturnSessionId,checkoutCancelled,canManageBilling,focusTier,requestedInterval}` | Existing `GET /api/billing/state`. **NEW**: `availableTiers`/`isConfigured` added to that response (or `GET /api/billing/config`); usage via `GET /api/workspace/usage`. `checkout/return` handled by existing `POST /api/billing/checkout/return`. |
| `app/(app)/settings/usage/page.tsx` (52) | content.view L17 | `projectService.getUsageSummary` L18 | none | none | static server render (`StatTile`) | **NEW `GET /api/workspace/usage`** (shared with layout, billing, upload). |
| `app/(app)/settings/api/page.tsx` (114) | `admitWorkspacePage("api.manage")` L40 | `workspaceService.listApiKeys` L44; `callbackSigningSecrets.status` L45; `webhookSubscriptions.list` L46 (only if plan has `integrations.api`); env `NEXT_PUBLIC_APP_URL` -> `apiBase` L48 | none | none | `UpgradeHero`, `CreateKeyDialog`, `ApiKeysPanel{keys}`, `ApiQuickstart{apiBase}`, `CallbackSecretPanel{status}`, `AddWebhookDialog{disabledReason}`, `WebhooksPanel{webhooks}` | **NEW** `GET /api/workspace/api-keys`, `GET /api/workspace/callback-signing-secret`, `GET /api/workspace/webhooks` (browser-session twins of REST v1 `GET /api/v1/webhooks`, which is API-key auth). `apiBase` becomes the API service's public URL (`NEXT_PUBLIC_API_URL`). |
| `app/(app)/settings/social-accounts/page.tsx` (97) | content.view L22 | `socialOAuthService.listAccounts` L24; `planLimits`, `planCountRequirement`, `planUpgradeHighlight`, `workspaceAllowsCapability` | `searchParams`: `connected, error, facebook_selection, returnTo` (returnTo validated by regex `^/projects/[0-9a-f-]+\?publishClips=...$`) | none | `SocialAccountsPanel{accounts,returnTo,connectedCount,errorCode,facebookSelectionToken,canManage,access,accountLimit,connectRequirement,connectUpgrade,canManageBilling}` | Existing `GET /api/social/accounts`. Search params are written by the OAuth callback redirect (`social/oauth/callback`), see section 6. |
| `app/(app)/settings/automation-grants/page.tsx` (41) | content.view L10 | `standingGrants.list` L12; `autopilotService.listRules` L13; `socialOAuthService.listAccounts` L14; `hasFeature`, `workspaceAllowsCapability`, `featureUpgradePrompt` x2 | `searchParams.rule` | none | `GrantsPanel{grants,rules,accounts,canManage,reviewAvailable,autopilotUpgrade,reviewUpgrade,access,initialRuleId}` | **NEW `GET /api/automation/standing-grants`** (shared with autopilot), existing `GET /api/autopilot/rules`, `GET /api/social/accounts` |
| `app/(app)/settings/notifications/page.tsx`, `settings/page.tsx`, `help/page.tsx`, `whats-new/page.tsx` | none (inherits `(app)` layout) | none | none | static; `settings/page.tsx` is `redirect("/settings/profile")` | none | none (stay in web). `help/page.tsx` imports `@/lib/docs-url`. |
| `app/invite/[token]/page.tsx` (23) | `admitSignedInPage("/invite/:token")` L11 | `workspaceService.getInvitePreview(token)` L11 (parallel with admission) | params `token` | none (renders `InviteUnavailable` when null) | `InviteCard{workspaceName,role,email,expiresAt,action: acceptWorkspaceInviteAction.bind(null, token)}` | **NEW `GET /api/invites/:token`** (signed-in session, returns preview or 404). Accept is the actions fork's. |
| `app/workspace-unavailable/page.tsx` (22) | `admitSignedInPage("/home")` L12 | `listUserWorkspaces(actor.actorUserId)` (`@narriflow/auth`) L13; `workspaceAllowsCapability` | none | none | `WorkspaceUnavailableView{workspaces[{id,name,paused,canOpen}]}` | `GET /api/session` (its `workspaces[]`) or **NEW `GET /api/workspaces`**. Must work when the *active* workspace is restricted (so this call is identity-only, `signedInAuthenticatedRequestPolicy`). |
| `app/workspaces/new/page.tsx` (8) | `admitSignedInPage("/workspaces/new")` L5 | none | none | none | `NewWorkspaceScreen` | none (identity guard only; client checks session). |
| `app/auth/continue/page.tsx` (22) | `admitSignedInPage(redirect_url ?? "/home")` L14 (this call provisions the personal workspace and syncs Clerk) | `headers()` (host, `x-forwarded-proto`), `resolvePostAuthRedirect(destination, origin, CLERK_OAUTH_ISSUER, CLERK_OAUTH_CONSENT_ORIGIN)` | `searchParams.redirect_url` | `redirect(target.href)` L21 when same-origin; otherwise renders `ClerkOAuthContinuation{href}` | `ClerkOAuthContinuation` (client, `@clerk/nextjs`) | **NEW `POST /api/session/bootstrap`** (identity admission + personal-workspace provisioning; returns 204/`{workspaceId}`). Web page keeps `resolvePostAuthRedirect` (pure) and does the final redirect client-side. Env `CLERK_OAUTH_ISSUER`, `CLERK_OAUTH_CONSENT_ORIGIN` read by both sides unless resolved API-side. |
| `app/share/[token]/page.tsx` (20) | none (public token; inventory `public_share_token`) | `clipExportService.getShared(token)` L14 | params `token`; `dynamic="force-dynamic"`, `revalidate=0` | `notFound()` when missing or no downloadable variant (L15/L17) | `SharedExportClient{exported}` | **NEW public `GET /api/share/:token`** (independent-trust; no session; CORS open for `GET`). |
| `app/review/[token]/page.tsx` (16) | none | none (already client-driven: `ReviewClient{token}` calls `/api/review/:token/**`) | params `token` | none | `ReviewClient{token}` | none; the review routes already exist as `app/api/review/[token]/[[...review]]/route.ts` (section 4) |
| `app/sso-callback/[[...sso-callback]]/page.tsx`, `app/(home)/page.tsx`, `(marketing)/**`, `(docs)/**`, `prototype/**` | none | no service/db/auth imports | n/a | n/a | n/a | stay in web unchanged |

### 2.C Helper modules (non-page code that touches services/db/auth on the web server)

| Module (lines) | What it does | Imported by | Fate |
| --- | --- | --- | --- |
| `lib/authenticated-request-page.ts` (121) | `admit*Page` + `recoveryDestination` (`next/navigation` `redirect`/`notFound`, `server-only`) | 37 files: every `(app)` page/layout above + `auth/continue`, `invite/[token]`, `workspace-unavailable`, `workspaces/new` | Delete; replaced by API error codes + client redirect mapper |
| `lib/authenticated-request-policy.server.ts` (109) | Builds three policies (`authenticatedRequestPolicy`, `freshAuthenticatedRequestPolicy`, `signedInAuthenticatedRequestPolicy`) over `getCurrentAppUser` / `getWorkspaceContextForUser` (`@narriflow/auth`), `getPrismaClient` (`@narriflow/db/client`), `checkRateLimit` (`@narriflow/services`); uses `react.cache` and `next/navigation` `unstable_rethrow` | `lib/authenticated-request-page.ts`, `lib/authenticated-request-action.ts`, `lib/authenticated-request-hono.ts`, `(app)/settings/actions.ts`, `app/api/[[...route]]/zoom-http.ts`, `app/api/stream/[projectId]/route.ts` | Moves to `apps/api` (rewritten on `@clerk/backend`, no `react.cache`, no `unstable_rethrow`) |
| `lib/authenticated-request-project.ts` (45) | `resolveAuthenticatedProject(prisma, {actor, projectId})` project admission query (type-only `@prisma/client`) | `authenticated-request-policy.server.ts`, `authenticated-request-policy.db.test.ts` | Moves with the policy |
| `lib/authenticated-request-action.ts` (326) | `executeAction`/`executeProjectAction`; imports `boundedExpectedDomainFailureDetails` | 13 `"use server"` files + `studio/page.tsx` (inline actions) | Delete with server actions |
| `lib/authenticated-request-hono.ts` (259), `lib/authenticated-request-http.ts` (166) | Hono middleware/error handler/`authenticatedHonoActor`/`authenticatedHonoInput`; `isExpectedDomainFailure` | `app/api/[[...route]]/route.ts`, `brand-profile-routes.ts`; `lib/rest-api/app.ts` | Move to `apps/api` |
| `lib/authenticated-request-inventory.ts` (1437) + `.test.ts` | Static inventory of every action/page/Hono route/long-lived stream/independent-trust module with capability + rate-limit; test globs `app/(app)/**/{page,layout}.tsx` (L480) and asserts the page list (L1283-1349) | tests only (`authenticated-request-inventory.test.ts`, `authenticated-request-policy.test.ts`, `billing-view-model.test.ts`, `integration-admission-parity.test.ts`) | Must be rewritten: pages no longer admit; the inventory shrinks to API routes. Note: `brand-kit/[id]`, `brand-kit/new`, `brand-kit/page.tsx`, `brand-kit/styles/new` are listed as "inherited" although they call `admitWorkspacePage` |
| `(app)/_components/usage.ts` (7) | `react.cache` wrapper over `projectService.getUsageSummary` | `(app)/layout.tsx` | Delete |
| `lib/review-preselection.ts` (21) | `decodeReviewSelection` (value import from services, pure) | `projects/[projectId]/page.tsx`, `projects/[projectId]/review-panel.tsx` (client) | Keep if `decodeReviewSelection` is exported from a client-safe module (services bundle must not enter web); otherwise move to `validators` or call API |
| `.../studio/_components/waveform-peaks.ts` (57) | re-exports `isClipPreviewPeaks` from `@narriflow/services/clip-preview-storage` (client-bundled) | `studio/_components/timeline.tsx`, `waveform-peaks.test.ts` | Needs a services-free home (move the guard to `@narriflow/validators`) before the Biome ban lands |
| `lib/mcp-configuration.ts` (not an importer) | `inspectMcpConfiguration` fetches Clerk issuer metadata | `integrations/mcp/page.tsx` | Moves to API |
| `lib/mcp-auth.ts`, `mcp-continuation-principal.ts`, `mcp-integration-admission.ts`, `mcp-upload-handoff.ts`, `mcp-upload-http.ts` | MCP OAuth/upload plumbing (`@narriflow/db/client`, services) | `app/mcp/route.ts`, `app/mcp/integrations/[workspaceId]/[...upload]/route.ts`, `(app)/integrations/mcp/confirm/actions.ts` | Move to API (section 4) |
| `lib/rest-api/app.ts` (537) | `/api/v1` OpenAPI app | `app/api/v1/[[...route]]/route.ts` | Move to API (section 3) |
| `lib/billing-view-model.ts`, `lib/feature-upgrade-prompt.ts`, `lib/project-state.ts`, `lib/authenticated-request-browser.ts` | Pure/client helpers (no services/db/auth values); `feature-upgrade-prompt.ts` is imported by 15 pages/client files and computes prompts from `pricingTier` | many | Stay in web; they depend on the tier from `/api/session` instead of the server actor |

### 2.D Type-only imports from `@narriflow/services` in client components (must switch to `@narriflow/validators` or `packages/api-client` types before the Biome ban; `import type` is likely allowed, confirm the rule)

| Client file | Types |
| --- | --- |
| `(app)/brand-kit/_components/brand-profile-delete-button.tsx` | `BrandProfileUsage` |
| `(app)/calendar/queue/proposals-inbox.tsx` | `ProposalInboxItem` (also in `proposals-inbox.test.tsx`) |
| `(app)/home/creation-tools.tsx`, `home/dashboard-view.tsx`, `home/recent-projects.tsx` | `ProjectListItem` |
| `(app)/performance/what-worked.tsx` | `GuidanceView`, `PerformanceGroup`, `PerformanceSummary` |
| `(app)/projects/[projectId]/dubbing-panel.tsx` | `DubUsageSummary` |
| `(app)/projects/[projectId]/finishing-status.tsx` | `ProjectFinishingView` |
| `(app)/projects/_components/project-card.tsx`, `project-row.tsx`, `project-thumbnail.tsx`, `projects-explorer.tsx` | `ProjectListItem` (+ list filter types in explorer) |
| `.../studio/_components/studio-shell.tsx` | `GeneratedImageCapability` |
| `.../studio/_components/timeline.tsx` | `ClipPreviewPeaks` |
| `.../studio/_components/tool-panels/audio-library.ts` | `AudioAssetListRow` |
| `.../studio/_components/tool-panels/generated-images-panel.tsx` | `GeneratedImageUsageSummary` |
| `projects/[projectId]/campaign-command-state.test.ts` (test, value import `brandPlanRequirement`) | n/a |

Also `@prisma/client` types are imported directly by `exports/page.tsx` (`ClipAspectRatio`, `ClipExportStatus`), `calendar/page.tsx` (`SocialPlatform`, `SocialPostStatus`), and `lib/authenticated-request-project.ts`; not covered by the services/db ban but `@prisma/client` must not leak into the web bundle either.

Tests that exercise these server reads (will need rewriting): `lib/plan-upgrade-pages.contract.fixture.ts` (executes `brand-kit/page`, `brand-kit/styles/new/page`, `projects/[projectId]/page` with mocked services, spawned by `plan-upgrade-pages.test.ts`), `lib/auth-server.contract.fixture.ts` (`auth/continue/page`), `lib/workspace-entry.db.fixture.ts`, `lib/authenticated-request-inventory.test.ts`, `lib/authenticated-request-policy.test.ts`, `lib/authenticated-request-policy.db.test.ts`, `(app)/performance/what-worked.test.tsx`, `(app)/calendar/queue/proposals-inbox.test.tsx`, `projects/[projectId]/campaign-command-state.test.ts`, `finishing-status.test.tsx`, `projects/_components/project-card.test.tsx`, `studio/_components/waveform-peaks.test.ts`.

### 2.E New GET endpoints implied by section 2 (deduplicated, for the API owner)

| New endpoint | Service call(s) | Used by pages |
| --- | --- | --- |
| `GET /api/session` | `getCurrentAppUser`, `getWorkspaceContextForUser`, `listUserWorkspaces`, `workspaceService.getAvatarUrls`, (+ usage) | `(app)/layout`, `workspace-unavailable`, every `canX`/tier derivation |
| `POST /api/session/bootstrap` | identity admission/provisioning | `auth/continue` |
| `GET /api/workspace` | `workspaceService.getWorkspace` | calendar, calendar/queue, settings/profile, settings/workspace, project page (timezone) |
| `GET /api/workspace/usage` | `projectService.getUsageSummary` | layout, billing, usage, upload, project page |
| `GET /api/workspace/members` | `workspaceService.listMembers` | settings/members |
| `GET /api/workspace/api-keys`, `/callback-signing-secret`, `/webhooks` | `listApiKeys`, `callbackSigningSecrets.status`, `webhookSubscriptions.list` | settings/api, integrations |
| `GET /api/workspace/censor-words` | `autoCensorService.getWorkspaceWords` | settings/workspace |
| `GET /api/workspace/folders` | `workspaceLibraryService.listFolders` | projects |
| `GET /api/workspace/exports`, `/export-projects` | `listExports`, `listExportProjects` | exports |
| `GET /api/workspace/calendar/posts`, `/filters`, `/composer-options` | `listCalendarPosts`, `getCalendarFilters`, `getCalendarComposerOptions` | calendar, calendar/new |
| `GET /api/publishing/proposals`, `/count` | `publishingQueue.listProposals`, `countProposals` | calendar, calendar/queue |
| `GET /api/performance/what-worked`, `/guidance` | `performanceService.whatWorked`, `guidance` | performance, settings/workspace |
| `GET /api/automation/standing-grants` | `standingGrants.list` | autopilot, settings/automation-grants |
| `GET /api/zoom/status` (or session feature flag) | `zoomConfigured()` | autopilot page + loading |
| `GET /api/invites/:token` | `workspaceService.getInvitePreview` | invite |
| `GET /api/share/:token` (public) | `clipExportService.getShared` | share |
| `GET /api/integrations/mcp/status`, `/preparations`, `/upload-handoff` | `inspectMcpConfiguration`, `verifyMcpPreparation`, `verifyMcpUploadHandoff` | integrations/mcp, confirm, upload |
| `GET /api/brand-profiles/default`, `/:id/usage`; list without 24-row cap | `getDefaultId`, `getApplicableDefaultId`, `usage`, `list` | brand-kit, brand-kit/[id], upload |
| `GET /api/brand-templates/:id/profile`; retained-reference resolve for fonts/visual assets | `resolveProfileForTemplate`, `brandFontService.resolveReferences`, `visualAssetService.resolve*References` | brand-kit/styles/[id], studio |
| `GET /api/projects/:id/{content-pack,workflow-history,finishing,credit-usage,source-url,brand-snapshot,auto-censor}`, `?view=status` on transcript, `GET /api/projects/:id/dubs/allowance` | `getLatestContentPack`, `getWorkflowHistory`, `getProjectFinishing`, `getProcessingUsage().projectCreditUsage`, `presignDownloadUrl`, `getProjectBrandSnapshot`/`getProjectBrandAudio`, `autoCensorService.getPolicy`, `getTranscriptStatusSnapshot`, `getDubbingAllowance` | project page, studio, upload |
| `GET /api/projects/:id/clips/:clipId/{preview-source,auto-layout-analysis,split-layout-outcome,layout-analysis-outcome}` | `getClipPreviewSource`, `getClipAutoLayoutAnalysis`, `getClipSplitLayoutOutcome`, `getClipLayoutAnalysisOutcome` | studio (replace 4 polling inline actions) |

Existing GET routes confirmed reusable as-is: `GET /api/projects` (L346), `/api/projects/:id` (L473), `/projects/:id/clips` (L635), `/projects/:id/transcript` (L507), `/projects/:id/analytics` (L1475), `/projects/:id/social-posts`, `/projects/:id/dubs` (L1663), `/projects/:id/review-rounds` (L1110), `/projects/:id/clips/:clipId/editor`, `/projects/:id/clips/:clipId/exports/:exportId` (L1305), `/ingest/:projectId` (L620), `/social/accounts` (L1483), `/autopilot/rules` (L242), `/recipes` (L298), `/zoom/connections`, `/brand-profiles` (+`/:id`, `/:id/scene-templates`), `/brand-templates` (+`/:id`), `/brand-fonts`, `/visual-assets`, `/billing/state`, `/library/search`, `/workspace/search`.

Surprises found while building 2:
1. `studio/page.tsx` defines six inline `"use server"` functions, four of them are GET-style polling reads (`fetchPreviewStatus`, `fetchAutoLayoutAnalysis`, `fetchSplitLayoutAnalysis`, `fetchScreenLayoutAnalysis`) passed as props to `StudioShell`.
2. `integrations/mcp/upload/page.tsx` is the only page that calls `getPrismaClient()` directly (raw `uploadSession.findFirst`).
3. `app/layout.tsx` runs `billingService.validateConfiguration({surface:"web"})` on every render, and `app/api/[[...route]]/route.ts` L121 does it at import: the web app must stop needing Stripe secrets.
4. Two client-bundled modules import service values: `lib/review-preselection.ts` (via `review-panel.tsx`) and `studio/_components/waveform-peaks.ts` (via `timeline.tsx`).
5. `GET /api/brand-profiles` caps at 24 and has no default id, so brand-kit/upload/recipes pages cannot reuse it unchanged.
6. `proxy.ts` (Clerk middleware) protects `/api/*` prefixes and page prefixes; its matcher excludes `mcp`, `api/v1`, `.well-known/oauth-*`, `api/health`. It does not list `/invite`, `/integrations`, `/search`, `/recipes`, `/workspace-unavailable`: those rely only on `admit*Page`, so removing `admit*Page` makes the API the sole guard for them (client route guards must be added).
7. The page admission helper's `workspace_restricted` redirect sends owners to `/settings/billing` and everyone else to `/workspace-unavailable`; this loop-avoidance rule must be kept in the client error mapper.


Generated from the code on 2026-10-29 (branch `dev`). Route tables were produced by scanning the source files and joining them with `browserSessionHonoSurfaces` / `independentTrustHonoSurfaces` exported from `apps/web/lib/authenticated-request-inventory.ts`; the two sets match exactly (165 registered = 160 declared browser-session + 5 declared independent-trust, no undeclared or phantom routes).

## 3. Existing Hono routes

### 3.0 Counts

| Item | Count |
|---|---|
| Routes on the internal browser API (`apps/web/app/api/[[...route]]/**`, mounted at `/api`) | **165** |
| ... of which `browser-session` (Authenticated Request Policy via `authenticatedRequestHonoMiddleware`) | 160 |
| ... of which `independent-trust` (`independentTrustHonoSurfaces`) | 5: `POST /webhooks/stripe` (stripe_signature), `POST /webhooks/tiktok/publication` (provider_signature), `POST /webhooks/zoom` (zoom_signature), `GET /social/oauth/callback` (oauth_callback), `GET /health` (public_health) |
| ... by method | GET 59, POST 81, PATCH 7, PUT 3, DELETE 15 |
| ... with a declared rate limit | 50 (44 `actor` scope, 6 `workspace` scope) |
| ... with `Idempotency-Key` header required | 12 (8 via policy `input.headers.idempotencyKey`: regenerate, export-bundles create + retry, retry-export-bundle op, apply-brand-profile, apply-style, apply-motion, apply scene-template; 4 read in-handler: `generate`, `clips/render`, `clips/:clipId/exports`, `dubs`). `POST /billing/checkout` uses a `clientIdempotencyKey` body field instead |
| ... defined in `route.ts` itself | 106 |
| ... defined in mounted sibling modules | 59: brand-profile-routes 24, social-publication-http 10, workspace-billing-routes 9, upload-session-http 5, zoom-http 5, clip-editor-http 4, stripe-webhook-http 1, clip-generation-http 1 |
| ... route style | **All plain `Hono`** (`new Hono().basePath("/api")`, manual `safeParse`, no OpenAPI) |
| Public REST API v1 (`apps/web/lib/rest-api/app.ts`, mounted at `/api/v1`) | **31** `.openapi()` routes + `GET /openapi.json` (served by `app.doc31`); **only `@hono/zod-openapi` (`OpenAPIHono`) code in the repo** |
| Other Hono consumers | `apps/web/lib/mcp-upload-http.ts` builds a throwaway `Hono` app per request and mounts `createUploadSessionHttpRoutes` (imported from `app/api/[[...route]]/upload-session-http`) under `/mcp/integrations/:workspaceId`: 5 more POST routes (`upload-sessions/{open,finalize,grants,status,discard}`), API-key/OAuth bearer (see section 4) |
| Vercel adapter | `hono/vercel` `handle(app)` in 2 files: `app/api/[[...route]]/route.ts:1963` region (exports GET/POST/PUT/PATCH/DELETE/OPTIONS) and `app/api/v1/[[...route]]/route.ts` (GET/POST/DELETE) |
| Route segment config | `[[...route]]/route.ts`: `runtime="nodejs"`, `maxDuration=60` (comment: content-suite LLM call ~30s); `v1`: `runtime=nodejs, dynamic=force-dynamic, maxDuration=60` |

### 3.1 Wiring in `route.ts` (what the API app must reproduce)

- `route.ts:118-121`: `new Hono().basePath("/api")`, `app.onError(authenticatedRequestHonoErrorHandler)`, `app.use("*", authenticatedRequestHonoMiddleware)`.
- `route.ts:122`: `billingService.validateConfiguration({ surface: "web" })` runs at module load (Stripe env check; see section 8).
- Mount order and prefixes (`app.route`): stripe webhook `/` (:124), billing `/billing` (:171), brand-profile `/` (:191), clip-editor `/` (:198), social-publication `/` (:210), clip-generation `/` (:222), zoom `/` (:238), upload-session `/` (:571). All other routes are registered inline.
- The middleware (`lib/authenticated-request-hono.ts`): strips `/api`, skips `isIndependentTrustHonoSurface(method, path)`, otherwise requires a `matchBrowserSessionHonoSurface` declaration (missing declaration fails closed with 500 `request_policy_missing`, unmatched path with no handler returns 404), then runs `authenticatedRequestPolicy.execute({ adapter: "hono", operationName, admission, rateLimit, input })`. The declaration supplies capability, optional project param (`id` or `projectId`), per-route rate limit, and an optional zod `input` schema over `params`, `query`, `headers` (idempotency-key to `idempotencyKey`, `campaign-retry-of` to `retryOfId`) and `body` (parsed by `parseAuthenticatedJsonBody`). Handlers read `authenticatedHonoActor(c)` / `authenticatedHonoInput<T>(c)`. Sets `X-Request-ID`, maps domain failures through `authenticatedRequestHttpFailure` (status + `Retry-After`).
- The policy module (`lib/authenticated-request-policy.server.ts`) imports `server-only`, React `cache`, `unstable_rethrow` from `next/navigation`, `@narriflow/db/client`, `checkRateLimit` (Clerk session resolved through `@narriflow/auth`, which uses `@clerk/nextjs`; see section 7 for the full list).
- Shared origin helper: `getOAuthOrigin` (route.ts:228) = `resolveCanonicalAppOrigin({ configuredOrigin: NEXT_PUBLIC_APP_URL, environment: NODE_ENV, requestUrl })` from `lib/safe-redirect`; used by billing (checkout/portal return URLs), social OAuth, zoom OAuth.
- No CORS, no `secure-headers`, no body-limit (only `/webhooks/zoom` uses `bodyLimit` with `ZOOM_WEBHOOK_MAX_BYTES`), no request-id middleware beyond the policy header. Browser clients are same-origin today.

Non-JSON responses (need explicit handling in the API client): redirects (7): `GET /workspace/exports/:exportId/download` (302 to presigned URL), `GET /projects/:id/export-bundles/:bundleId/download` (307), `GET /projects/:id/clips/:clipId/file` (302), `GET /social/oauth/start/:platform` (302 to provider, errors redirect to `redirect` path with `?error=`), `GET /social/oauth/callback` (302 to web `/settings/social-accounts` or the saved redirect path), `GET /zoom/oauth/start` (302), `GET /zoom/oauth/callback` (302 to `/autopilot?zoom=`). Attachments (4): `GET /projects/:id/transcript/export` (text, `Content-Disposition`), `.../exports/:exportId/subtitles/:format` (srt/vtt), `.../clips/:clipId/timeline/:format` (ZIP, `X-Editor-Revision` header), `GET .../clips/:clipId/preview-peaks` (JSON or 204 with `Cache-Control: private, max-age=3600, immutable`).

### 3.2 Route table (165 rows)

Columns: **Handler calls** = service functions invoked by the handler (injected deps resolved to their service name); **Handler-level validation** = zod schemas parsed inside the handler (`type X` = input type consumed from the policy-validated input); **Policy** = capability, admission (`project(id)` means project membership via the `id` or `projectId` param; `workspace` means workspace only), policy-level input schema helper; **Rate limit** = `scope prefix limit/window`.

| # | Method | Path (under `/api`) | Source | Handler calls | Handler-level validation | Policy (cap / admission / input) | Rate limit | Flags | Style | Domain (9.4) |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | POST | `/webhooks/tiktok/publication` | route.ts:132 | `acceptTikTokPublicationWebhook` |  | independent-trust: `provider_signature` |  |  | plain Hono | P0 |
| 2 | GET | `/health` | route.ts:236 |  |  | independent-trust: `public_health` |  |  | plain Hono | P0 |
| 3 | GET | `/autopilot/rules` | route.ts:242 | `autopilotService.listRules` |  | browser-session: `content.view`, workspace |  |  | plain Hono | D8 |
| 4 | POST | `/autopilot/rules` | route.ts:249 | `autopilotService.createRule` | `autopilotRuleInputSchema` | browser-session: `content.edit`, workspace | workspace `autopilot-create` 5/3600s |  | plain Hono | D8 |
| 5 | PATCH | `/autopilot/rules/:ruleId` | route.ts:262 | `autopilotService.updateRule` | `autopilotRuleUpdateSchema` | browser-session: `content.edit`, workspace |  |  | plain Hono | D8 |
| 6 | DELETE | `/autopilot/rules/:ruleId` | route.ts:275 | `autopilotService.deleteRule` |  | browser-session: `content.edit`, workspace |  |  | plain Hono | D8 |
| 7 | POST | `/autopilot/rules/:ruleId/take-over` | route.ts:282 | `autopilotService.takeOver` |  | browser-session: `workspace.manage`, workspace |  |  | plain Hono | D8 |
| 8 | POST | `/autopilot/rules/:ruleId/run-now` | route.ts:289 | `autopilotService.triggerRuleNow` |  | browser-session: `processing.consume`, workspace | workspace `autopilot-run` 10/3600s |  | plain Hono | D8 |
| 9 | GET | `/recipes` | route.ts:298 | `recipeService.list` |  | browser-session: `content.view`, workspace |  |  | plain Hono | D4 |
| 10 | POST | `/recipes` | route.ts:305 | `recipeService.create` | `recipeInputSchema` | browser-session: `content.edit`, workspace | workspace `recipe-create` 30/3600s |  | plain Hono | D4 |
| 11 | PATCH | `/recipes/:recipeId` | route.ts:318 | `recipeService.update` | `recipeUpdateSchema` | browser-session: `content.edit`, workspace |  |  | plain Hono | D4 |
| 12 | POST | `/recipes/:recipeId/duplicate` | route.ts:332 | `recipeService.duplicate` |  | browser-session: `content.edit`, workspace | workspace `recipe-create` 30/3600s |  | plain Hono | D4 |
| 13 | DELETE | `/recipes/:recipeId` | route.ts:339 | `recipeService.delete` |  | browser-session: `content.edit`, workspace |  |  | plain Hono | D4 |
| 14 | GET | `/projects` | route.ts:346 | `workspaceLibraryService.listProjects` |  | browser-session: `content.view`, workspace |  |  | plain Hono | D2 |
| 15 | GET | `/workspace/search` | route.ts:377 | `workspaceLibraryService.search` |  | browser-session: `content.view`, workspace |  |  | plain Hono | D11 |
| 16 | GET | `/library/search` | route.ts:386 | `librarySearchService.search` |  | browser-session: `content.view`, workspace; custom zod (query) | actor `library-search` 30/60s |  | plain Hono | D11 |
| 17 | GET | `/workspace/exports/:exportId/download` | route.ts:401 | `clipExportService.getWorkspaceOwned` |  | browser-session: `content.download`, workspace |  | redirect | plain Hono | D9 |
| 18 | POST | `/workspace/avatar/presign` | route.ts:421 | `workspaceService.presignAvatarUpload` |  | browser-session: `workspace.manage`, workspace |  |  | plain Hono | D1 |
| 19 | PATCH | `/workspace/avatar` | route.ts:435 | `workspaceService.setAvatar` |  | browser-session: `workspace.manage`, workspace |  |  | plain Hono | D1 |
| 20 | POST | `/projects/:id/generate` | route.ts:448 | `projectService.triggerGeneration` | `generateProjectRequestSchema` | browser-session: `processing.consume`, project(id) | actor `gen` 20/60s | idempotency-key header | plain Hono | D2 |
| 21 | GET | `/projects/:id` | route.ts:473 | `projectService.getProjectSnapshot` |  | browser-session: `content.view`, project(id) |  |  | plain Hono | D2 |
| 22 | GET | `/projects/:id/runs/:workflowRunId` | route.ts:486 | `projectService.getWorkflowRun` |  | browser-session: `content.view`, project(id) |  |  | plain Hono | D2 |
| 23 | GET | `/projects/:id/transcript` | route.ts:507 | `projectService.getTranscriptSnapshot` |  | browser-session: `content.view`, project(id) |  |  | plain Hono | D2 |
| 24 | GET | `/projects/:id/transcript/utterances` | route.ts:526 | `projectService.getTranscriptUtterancesRaw` |  | browser-session: `content.view`, project(id) |  |  | plain Hono | D2 |
| 25 | GET | `/projects/:id/transcript/export` | route.ts:543 | `projectService.getTranscriptExport` | `transcriptExportFormatSchema` | browser-session: `content.download`, project(id) |  | binary/text body | plain Hono | D2 |
| 26 | POST | `/ingest/link` | route.ts:579 | `projectService.queueLinkIngest` | `linkIngestSchema` | browser-session: `processing.consume`, workspace |  |  | plain Hono | D4 |
| 27 | POST | `/ingest/rss/preview` | route.ts:593 | `projectService.previewRssFeed` | `rssPreviewSchema` | browser-session: `processing.consume`, workspace | workspace `rss-preview` 20/60s |  | plain Hono | D4 |
| 28 | POST | `/ingest/rss/import` | route.ts:606 | `projectService.importFromRss` | `rssImportSchema` | browser-session: `processing.consume`, workspace | workspace `rss-import` 5/60s |  | plain Hono | D4 |
| 29 | GET | `/ingest/:projectId` | route.ts:620 | `projectService.getIngestSnapshot` |  | browser-session: `content.view`, project(projectId) |  |  | plain Hono | D4 |
| 30 | GET | `/projects/:id/clips` | route.ts:635 | `clipService.listClips` |  | browser-session: `content.view`, project(id) |  |  | plain Hono | D3 |
| 31 | GET | `/projects/:id/clips/:clipId/preview-peaks` | route.ts:647 | `clipService.getClipPreviewPeaks` |  | browser-session: `content.view`, project(id) |  | binary/text body | plain Hono | D3 |
| 32 | POST | `/projects/:id/clips/:clipId/title-suggestions` | route.ts:663 | `clipService.suggestClipTitles` |  | browser-session: `processing.consume`, project(id) | actor `clip-title-suggest` 30/60s |  | plain Hono | D3 |
| 33 | POST | `/projects/:id/clips/:clipId/duplicate` | route.ts:677 | `clipService.duplicateClip` |  | browser-session: `content.edit`, project(id) | actor `clip-duplicate` 30/60s |  | plain Hono | D3 |
| 34 | POST | `/projects/:id/clips/:clipId/create-from-selection` | route.ts:701 | `clipService.createClipFromSelection` | `createClipFromSelectionSchema` | browser-session: `content.edit`, project(id) |  |  | plain Hono | D3 |
| 35 | POST | `/projects/:id/clips/create-from-range` | route.ts:732 | `clipService.createClipFromRange` |  | browser-session: `content.edit`, project(id); bodyInput(createClipFromSelectionSchema, ["id"]) |  |  | plain Hono | D3 |
| 36 | DELETE | `/projects/:id/clips/:clipId` | route.ts:741 | `clipService.deleteClip` |  | browser-session: `content.edit`, project(id) |  |  | plain Hono | D3 |
| 37 | POST | `/projects/:id/clips/render` | route.ts:752 | `clipService.triggerClipRendering`, `campaignOperationService.renderSelected` | `triggerClipRenderSchema` | browser-session: `processing.consume`, project(id) | actor `render` 20/60s | idempotency-key header | plain Hono | D3 |
| 38 | POST | `/projects/:id/export-bundles` | route.ts:781 | `campaignOperationService.createExportBundle` | `type CreateExportBundleInput` | browser-session: `content.download`, project(id); idempotentBodyInput(createExportBundleSchema, ["id"]); idempotency-key header | actor `export-bundle` 10/3600s | idempotency-key header | plain Hono | D9 |
| 39 | POST | `/projects/:id/export-bundles/preview` | route.ts:797 | `campaignOperationService.previewExportBundle` | `type CreateExportBundleInput` | browser-session: `content.download`, project(id); bodyInput(createExportBundleSchema, ["id"]) | actor `export-bundle-preview` 60/60s |  | plain Hono | D9 |
| 40 | GET | `/projects/:id/export-bundles` | route.ts:812 | `campaignOperationService.listExportBundles` |  | browser-session: `content.view`, project(id) |  |  | plain Hono | D9 |
| 41 | GET | `/projects/:id/campaign-operations` | route.ts:823 | `campaignOperationService.listOperations` |  | browser-session: `content.view`, project(id) |  |  | plain Hono | D3 |
| 42 | POST | `/projects/:id/assisted-copy/generations` | route.ts:834 | `assistedSocialCopyService.generate` | `type GenerateAssistedCopyRequest` | browser-session: `publishing.manage`, project(id); bodyInput(generateAssistedCopySchema, ["id"]) | actor `assisted-copy` 30/60s |  | plain Hono | D5 |
| 43 | POST | `/projects/:id/thumbnail-frames` | route.ts:851 | `thumbnailFramePreparationService.request` | `type RequestThumbnailFrameInput` | browser-session: `publishing.manage`, project(id); bodyInput(requestThumbnailFrameSchema, ["id"]) | actor `thumbnail-frame` 30/60s |  | plain Hono | D3 |
| 44 | GET | `/projects/:id/thumbnail-frames/:operationId` | route.ts:868 | `thumbnailFramePreparationService.get` |  | browser-session: `content.view`, project(id); paramsInput("id", "operationId") |  |  | plain Hono | D3 |
| 45 | POST | `/projects/:id/thumbnail-frames/:operationId/retry` | route.ts:884 | `thumbnailFramePreparationService.retry` |  | browser-session: `publishing.manage`, project(id); paramsInput("id", "operationId") | actor `thumbnail-frame-retry` 20/60s |  | plain Hono | D3 |
| 46 | GET | `/projects/:id/campaign-operations/editor-action-catalog` | route.ts:900 | `campaignOperationService.getEditorActionCatalog` |  | browser-session: `content.view`, project(id); paramsInput("id") |  |  | plain Hono | D3 |
| 47 | POST | `/projects/:id/campaign-operations/preview-editor-action` | route.ts:912 | `campaignOperationService.previewEditorAction` | `type PreviewCampaignEditorActionInput` | browser-session: `content.view`, project(id); bodyInput(previewCampaignEditorActionSchema, ["id"]) | actor `preview-campaign-editor-action` 60/60s |  | plain Hono | D3 |
| 48 | POST | `/projects/:id/campaign-operations/apply-brand-profile` | route.ts:930 | `campaignOperationService.applyProjectBrandProfileSelected` | `type ApplyProjectBrandProfileSelectedInput` | browser-session: `content.edit`, project(id); campaignMutationInput(applyProjectBrandProfileSelectedSchema, [ "id", ]); idempotency-key header | actor `apply-brand-profile-selected` 20/3600s | idempotency-key header | plain Hono | D3 |
| 49 | POST | `/projects/:id/campaign-operations/apply-style` | route.ts:952 | `campaignOperationService.applyStyleSelected` | `type ApplyStyleSelectedInput` | browser-session: `content.edit`, project(id); campaignMutationInput(applyStyleSelectedSchema, ["id"]); idempotency-key header | actor `apply-style-selected` 20/3600s | idempotency-key header | plain Hono | D3 |
| 50 | POST | `/projects/:id/campaign-operations/apply-motion` | route.ts:974 | `campaignOperationService.applyMotionSelected` | `type ApplyMotionSelectedInput` | browser-session: `content.edit`, project(id); campaignMutationInput(applyMotionSelectedSchema, ["id"]); idempotency-key header | actor `apply-motion-selected` 20/3600s | idempotency-key header | plain Hono | D3 |
| 51 | GET | `/projects/:id/export-bundles/:bundleId` | route.ts:996 | `campaignOperationService.getExportBundle` |  | browser-session: `content.view`, project(id); paramsInput("id", "bundleId") |  |  | plain Hono | D9 |
| 52 | POST | `/projects/:id/export-bundles/:bundleId/retry` | route.ts:1011 | `campaignOperationService.retryExportBundle` |  | browser-session: `content.download`, project(id); idempotentParamsInput("id", "bundleId"); idempotency-key header | actor `export-bundle-retry` 10/3600s | idempotency-key header | plain Hono | D9 |
| 53 | POST | `/projects/:id/campaign-operations/:operationId/retry-export-bundle` | route.ts:1031 | `campaignOperationService.retryExportBundleOperation` |  | browser-session: `content.download`, project(id); idempotentParamsInput("id", "operationId"); idempotency-key header | actor `export-operation-retry` 10/3600s | idempotency-key header | plain Hono | D9 |
| 54 | GET | `/projects/:id/export-bundles/:bundleId/download` | route.ts:1054 | `campaignOperationService.getExportBundleDownload` |  | browser-session: `content.download`, project(id); paramsInput("id", "bundleId") |  | redirect | plain Hono | D9 |
| 55 | POST | `/projects/:id/brand-profiles/:profileId/scene-templates/:templateId/apply` | route.ts:1067 | `campaignOperationService.applySceneTemplate` | `type ApplySceneTemplateInput` | browser-session: `content.edit`, project(id); campaignMutationInput(applySceneTemplateSchema, [ "id", "profileId", "templateId", ]); idempotency-key header | actor `apply-scene-template` 20/3600s | idempotency-key header | plain Hono | D6 |
| 56 | POST | `/projects/:id/review-rounds` | route.ts:1090 | `reviewService.createRound` | `type CreateReviewRoundInput` | browser-session: `review.manage`, project(id); bodyInput(createReviewRoundSchema, ["id"]) | actor `review-round` 20/3600s |  | plain Hono | D10 |
| 57 | GET | `/projects/:id/review-rounds` | route.ts:1110 | `reviewService.internalRoom` |  | browser-session: `content.view`, project(id); paramsInput("id") |  |  | plain Hono | D10 |
| 58 | POST | `/projects/:id/review-rounds/:roundId/invite` | route.ts:1125 | `reviewService.inviteReviewers` | `type InviteReviewersInput` | browser-session: `review.manage`, project(id); bodyInput(inviteReviewersSchema, ["id", "roundId"]) | actor `review-invite` 20/3600s |  | plain Hono | D10 |
| 59 | POST | `/projects/:id/review-rounds/:roundId/comments` | route.ts:1147 | `reviewService.addInternalComment` | `type InternalReviewCommentInput` | browser-session: `review.manage`, project(id); bodyInput(internalReviewCommentSchema, ["id", "roundId"]) | actor `review-comment-internal` 60/60s |  | plain Hono | D10 |
| 60 | POST | `/projects/:id/review-rounds/:roundId/comments/:commentId/resolve` | route.ts:1168 | `reviewService.resolveComment` |  | browser-session: `review.manage`, project(id); paramsInput("id", "roundId", "commentId") |  |  | plain Hono | D10 |
| 61 | POST | `/projects/:id/review-rounds/:roundId/comments/:commentId/reopen` | route.ts:1193 | `reviewService.resolveComment` |  | browser-session: `review.manage`, project(id); paramsInput("id", "roundId", "commentId") |  |  | plain Hono | D10 |
| 62 | POST | `/projects/:id/review-rounds/:roundId/notifications/retry` | route.ts:1218 | `reviewNotificationService.retry` | `type RetryReviewNotificationInput` | browser-session: `review.manage`, project(id); bodyInput(retryReviewNotificationSchema, ["id", "roundId"]) | actor `review-notification-retry` 20/3600s |  | plain Hono | D10 |
| 63 | POST | `/projects/:id/review-rounds/:roundId/revoke` | route.ts:1244 | `reviewService.revokeRound` |  | browser-session: `review.manage`, project(id); paramsInput("id", "roundId") |  |  | plain Hono | D10 |
| 64 | POST | `/projects/:id/clips/:clipId/exports` | route.ts:1265 | `clipExportService.create` | `createClipExportSchema` | browser-session: `processing.consume`, project(id) | actor `clip-export` 20/60s | idempotency-key header | plain Hono | D9 |
| 65 | GET | `/projects/:id/exports/current` | route.ts:1294 | `clipExportService.listCurrentProjectExports` |  | browser-session: `content.view`, project(id); paramsInput("id") |  |  | plain Hono | D9 |
| 66 | GET | `/projects/:id/clips/:clipId/exports/:exportId` | route.ts:1305 | `clipExportService.getOwned` |  | browser-session: `content.download`, project(id) |  |  | plain Hono | D9 |
| 67 | GET | `/projects/:id/clips/:clipId/exports/:exportId/subtitles/:format` | route.ts:1313 | `clipExportService.getSubtitles` |  | browser-session: `content.download`, project(id) |  | binary/text body | plain Hono | D9 |
| 68 | GET | `/projects/:id/clips/:clipId/timeline/:format` | route.ts:1329 | `clipTimelineService.archive` | `timelineFormatSchema` | browser-session: `content.download`, project(id) |  | binary/text body | plain Hono | D9 |
| 69 | GET | `/projects/:id/clips/:clipId/timeline-source` | route.ts:1344 | `clipTimelineService.issueSourceGrant` |  | browser-session: `content.download`, project(id) |  |  | plain Hono | D9 |
| 70 | POST | `/projects/:id/clips/:clipId/exports/:exportId/retry` | route.ts:1350 | `clipExportService.retryFailed` |  | browser-session: `processing.consume`, project(id) | actor `clip-export-retry` 12/60s |  | plain Hono | D9 |
| 71 | POST | `/projects/:id/clips/:clipId/exports/:exportId/share-links` | route.ts:1356 | `clipExportService.createShareLink` | `createClipShareLinkSchema` | browser-session: `content.edit`, project(id) | actor `clip-share` 10/60s |  | plain Hono | D9 |
| 72 | DELETE | `/projects/:id/clips/:clipId/exports/:exportId/share-links` | route.ts:1374 | `clipExportService.revokeShareLinks` |  | browser-session: `content.edit`, project(id) |  |  | plain Hono | D9 |
| 73 | POST | `/projects/:id/clips/apply-caption-preset` | route.ts:1383 | `clipEditorDocumentPersistence.mutateProjectSelection` | `applyCaptionPresetToAllSchema` | browser-session: `content.edit`, project(id) |  |  | plain Hono | D3 |
| 74 | POST | `/projects/:id/clips/apply-studio-edits` | route.ts:1405 | `clipEditorDocumentPersistence.mutateProjectSelection` | `applyStudioEditsToAllSchema` | browser-session: `content.edit`, project(id) |  |  | plain Hono | D3 |
| 75 | GET | `/broll/search` | route.ts:1433 | `isPexelsConfigured`, `searchBrollVideos` | `brollSearchQuerySchema` | browser-session: `content.edit`, workspace | actor `broll-search` 60/60s |  | plain Hono | D11 |
| 76 | GET | `/projects/:id/content-suite` | route.ts:1453 | `contentSuiteService.list` |  | browser-session: `content.view`, project(id) |  |  | plain Hono | D2 |
| 77 | POST | `/projects/:id/content-suite` | route.ts:1460 | `contentSuiteService.generate` | `generateContentSuiteRequestSchema` | browser-session: `processing.consume`, project(id) | actor `content-suite` 30/60s |  | plain Hono | D2 |
| 78 | GET | `/projects/:id/analytics` | route.ts:1475 | `analyticsService.getProjectAnalytics` |  | browser-session: `content.view`, project(id) |  |  | plain Hono | D2 |
| 79 | GET | `/social/accounts` | route.ts:1483 | `socialOAuthService.listAccounts` |  | browser-session: `social.manage`, workspace |  |  | plain Hono | D5 |
| 80 | GET | `/social/oauth/start/:platform` | route.ts:1489 | `socialOAuthService.createAuthorizationUrl` | `socialPlatformSchema` | browser-session: `social.manage`, workspace |  | redirect | plain Hono | D5 |
| 81 | GET | `/social/oauth/callback` | route.ts:1531 | `socialOAuthService.handleCallback` |  | independent-trust: `oauth_callback` |  | redirect | plain Hono | D5 |
| 82 | GET | `/social/oauth/facebook-selection/:token` | route.ts:1588 | `socialOAuthService.getFacebookPageSelection` |  | browser-session: `social.manage`, workspace |  |  | plain Hono | D5 |
| 83 | POST | `/social/oauth/facebook-selection/:token` | route.ts:1618 | `socialOAuthService.completeFacebookPageSelection` |  | browser-session: `social.manage`, workspace | actor `facebook-page-selection` 10/900s |  | plain Hono | D5 |
| 84 | DELETE | `/social/accounts/:accountId` | route.ts:1655 | `socialOAuthService.disconnectAccount` |  | browser-session: `social.manage`, workspace |  |  | plain Hono | D5 |
| 85 | GET | `/projects/:id/dubs` | route.ts:1663 | `dubbingService.listProjectDubs` |  | browser-session: `content.view`, project(id) |  |  | plain Hono | D2 |
| 86 | POST | `/projects/:id/dubs` | route.ts:1669 | `dubbingService.requestClipDub` | `requestClipDubSchema` | browser-session: `processing.consume`, project(id) | actor `dubs` 20/60s | idempotency-key header | plain Hono | D2 |
| 87 | GET | `/projects/:id/dubs/:dubId/download` | route.ts:1688 | `dubbingService.getDubDownloadUrl` | `dubDownloadQuerySchema` | browser-session: `content.download`, project(id) |  |  | plain Hono | D2 |
| 88 | GET | `/projects/:id/clips/previews` | route.ts:1700 | `clipService.getProjectClipPreviewUrls` | `clipDownloadQuerySchema` | browser-session: `content.view`, project(id) |  |  | plain Hono | D3 |
| 89 | GET | `/projects/:id/clips/:clipId/download` | route.ts:1713 | `clipService.getClipDownloadUrl` | `clipDownloadQuerySchema` | browser-session: `content.download`, project(id) |  |  | plain Hono | D3 |
| 90 | GET | `/projects/:id/clips/:clipId/file` | route.ts:1726 | `clipService.getClipDownloadUrl` | `clipDownloadQuerySchema` | browser-session: `content.download`, project(id) |  | redirect | plain Hono | D3 |
| 91 | GET | `/brand-templates` | route.ts:1746 | `brandTemplateService.list` |  | browser-session: `content.view`, workspace |  |  | plain Hono | D6 |
| 92 | GET | `/brand-templates/:id` | route.ts:1752 | `brandTemplateService.get` |  | browser-session: `content.view`, workspace |  |  | plain Hono | D6 |
| 93 | POST | `/brand-templates` | route.ts:1758 | `brandTemplateService.create` | `brandTemplateInputSchema` | browser-session: `brand.manage`, workspace |  |  | plain Hono | D6 |
| 94 | PATCH | `/brand-templates/:id` | route.ts:1769 | `brandTemplateService.update` | `brandTemplateUpdateSchema` | browser-session: `brand.manage`, workspace |  |  | plain Hono | D6 |
| 95 | DELETE | `/brand-templates/:id` | route.ts:1780 | `brandTemplateService.softDelete` |  | browser-session: `brand.manage`, workspace |  |  | plain Hono | D6 |
| 96 | POST | `/brand-templates/:id/set-default` | route.ts:1786 | `brandTemplateService.setDefault` |  | browser-session: `workspace.manage`, workspace |  |  | plain Hono | D6 |
| 97 | POST | `/brand-templates/:id/duplicate` | route.ts:1792 | `brandTemplateService.duplicate` | `duplicateBrandTemplateSchema` | browser-session: `brand.manage`, workspace |  |  | plain Hono | D6 |
| 98 | POST | `/brand-templates/logo/presign` | route.ts:1803 | `brandTemplateService.presignLogoUpload` | `presignBrandLogoSchema` | browser-session: `brand.manage`, workspace | actor `logo-presign` 30/60s |  | plain Hono | D6 |
| 99 | GET | `/brand-templates/:id/logo-url` | route.ts:1815 | `brandTemplateService.getLogoDownloadUrl` |  | browser-session: `content.view`, workspace |  |  | plain Hono | D6 |
| 100 | GET | `/audio-assets` | route.ts:1824 | `audioAssetService.listAssets` | `listAudioAssetsQuerySchema` | browser-session: `content.view`, workspace |  |  | plain Hono | D6 |
| 101 | POST | `/audio-assets/presign-upload` | route.ts:1847 | `audioAssetService.presignUpload` | `presignAudioUploadSchema` | browser-session: `brand.manage`, workspace | actor `audio-asset-presign` 30/60s |  | plain Hono | D6 |
| 102 | POST | `/audio-assets` | route.ts:1863 | `audioAssetService.finalizeUpload` | `finalizeAudioUploadSchema` | browser-session: `brand.manage`, workspace |  |  | plain Hono | D6 |
| 103 | GET | `/audio-assets/:id/playback-url` | route.ts:1879 | `audioAssetService.getPlaybackSource` | `audioAssetIdParamSchema` | browser-session: `content.view`, workspace |  |  | plain Hono | D6 |
| 104 | PUT | `/audio-assets/:id/favorite` | route.ts:1901 | `audioAssetService.setFavorite` | `audioAssetIdParamSchema` | browser-session: `brand.manage`, workspace |  |  | plain Hono | D6 |
| 105 | DELETE | `/audio-assets/:id/favorite` | route.ts:1920 | `audioAssetService.setFavorite` | `audioAssetIdParamSchema` | browser-session: `brand.manage`, workspace |  |  | plain Hono | D6 |
| 106 | DELETE | `/audio-assets/:id` | route.ts:1939 | `audioAssetService.deleteUserAsset` | `audioAssetIdParamSchema` | browser-session: `brand.manage`, workspace |  |  | plain Hono | D6 |
| 107 | POST | `/upload-sessions/open` | upload-session-http.ts:24 | `uploadSessionService.open` | `openUploadSessionSchema` | browser-session: `processing.consume`, workspace | actor `upload-session-open` 60/60s | Retry-After | plain Hono | D4 |
| 108 | POST | `/upload-sessions/finalize` | upload-session-http.ts:47 | `uploadSessionService.finalize` | `finalizeUploadSessionSchema` | browser-session: `processing.consume`, workspace | actor `upload-session-finalize` 60/60s | Retry-After | plain Hono | D4 |
| 109 | POST | `/upload-sessions/grants` | upload-session-http.ts:70 | `uploadSessionService.grant` | `grantUploadPartsSchema` | browser-session: `processing.consume`, workspace | actor `upload-session-grants` 120/60s |  | plain Hono | D4 |
| 110 | POST | `/upload-sessions/status` | upload-session-http.ts:91 | `uploadSessionService.status` | `readUploadSessionSchema` | browser-session: `processing.consume`, workspace | actor `upload-session-status` 120/60s | Retry-After | plain Hono | D4 |
| 111 | POST | `/upload-sessions/discard` | upload-session-http.ts:112 | `uploadSessionService.discard` | `discardUploadSessionSchema` | browser-session: `processing.consume`, workspace | actor `upload-session-discard` 30/60s | Retry-After | plain Hono | D4 |
| 112 | POST | `/webhooks/stripe` | stripe-webhook-http.ts:27 | `billingService.handleWebhook` |  | independent-trust: `stripe_signature` |  |  | plain Hono | P0 |
| 113 | POST | `/billing/checkout` | workspace-billing-routes.ts:75 | `billingService.startCheckout` | `checkoutRequestSchema` | browser-session: `billing.manage`, workspace |  | clientIdempotencyKey (body) | plain Hono | D7 |
| 114 | POST | `/billing/checkout/return` | workspace-billing-routes.ts:97 | `billingService.observeCheckoutReturn` | `checkoutReturnRequestSchema` | browser-session: `billing.manage`, workspace |  | Retry-After | plain Hono | D7 |
| 115 | POST | `/billing/portal` | workspace-billing-routes.ts:120 | `billingService.openPortal` |  | browser-session: `billing.manage`, workspace |  |  | plain Hono | D7 |
| 116 | GET | `/billing/state` | workspace-billing-routes.ts:132 | `billingService.readBillingState` |  | browser-session: `content.view`, workspace |  | Retry-After | plain Hono | D7 |
| 117 | POST | `/billing/plan-change/preview` | workspace-billing-routes.ts:139 | `billingService.previewPlanChange` | `planChangePreviewRequestSchema` | browser-session: `billing.manage`, workspace |  |  | plain Hono | D7 |
| 118 | POST | `/billing/plan-change/confirm` | workspace-billing-routes.ts:154 | `billingService.confirmPlanChange` | `planChangeConfirmRequestSchema` | browser-session: `billing.manage`, workspace |  |  | plain Hono | D7 |
| 119 | POST | `/billing/plan-change/payment` | workspace-billing-routes.ts:169 | `billingService.readPendingPlanChangePayment` |  | browser-session: `billing.manage`, workspace |  |  | plain Hono | D7 |
| 120 | POST | `/billing/plan-change/cancel` | workspace-billing-routes.ts:177 | `billingService.cancelScheduledPlanChange` |  | browser-session: `billing.manage`, workspace |  |  | plain Hono | D7 |
| 121 | POST | `/billing/reconcile` | workspace-billing-routes.ts:185 | `billingService.reconcileCurrentState` |  | browser-session: `billing.manage`, workspace |  | Retry-After | plain Hono | D7 |
| 122 | GET | `/brand-profiles` | brand-profile-routes.ts:39 | `brandProfileService.list` |  | browser-session: `content.view`, workspace; custom zod (query) |  |  | plain Hono | D6 |
| 123 | GET | `/brand-profiles/:id` | brand-profile-routes.ts:48 | `brandProfileService.get` |  | browser-session: `content.view`, workspace; paramsInput("id") |  |  | plain Hono | D6 |
| 124 | POST | `/brand-profiles` | brand-profile-routes.ts:53 | `brandProfileService.create` | `type BrandProfileCreateInput` | browser-session: `brand.manage`, workspace; bodyInput(brandProfileCreateSchema) |  |  | plain Hono | D6 |
| 125 | PATCH | `/brand-profiles/:id` | brand-profile-routes.ts:59 | `brandProfileService.update` | `type BrandProfileUpdateInput` | browser-session: `brand.manage`, workspace; bodyInput(brandProfileUpdateSchema, ["id"]) |  |  | plain Hono | D6 |
| 126 | PUT | `/brand-profiles/:id/membership` | brand-profile-routes.ts:65 | `brandProfileService.setMembership` | `type BrandProfileMembershipInput` | browser-session: `brand.manage`, workspace; bodyInput(brandProfileMembershipSchema, ["id"]) |  |  | plain Hono | D6 |
| 127 | POST | `/brand-profiles/:id/set-default` | brand-profile-routes.ts:71 | `brandProfileService.setDefault` |  | browser-session: `brand.manage`, workspace; paramsInput("id") |  |  | plain Hono | D6 |
| 128 | DELETE | `/brand-profiles/:id` | brand-profile-routes.ts:78 | `brandProfileService.softDelete` | `type BrandProfileSoftDeleteInput` | browser-session: `brand.manage`, workspace; bodyInput(brandProfileSoftDeleteSchema, ["id"]) |  |  | plain Hono | D6 |
| 129 | GET | `/visual-assets` | brand-profile-routes.ts:85 | `visualAssetService.list` |  | browser-session: `content.view`, workspace |  |  | plain Hono | D6 |
| 130 | POST | `/visual-assets/presign-upload` | brand-profile-routes.ts:89 | `visualAssetService.presignUpload` | `type VisualAssetUploadInput` | browser-session: `brand.manage`, workspace; bodyInput(visualAssetUploadSchema) | actor `visual-asset-presign` 30/60s |  | plain Hono | D6 |
| 131 | POST | `/visual-assets` | brand-profile-routes.ts:95 | `visualAssetService.finalizeUpload` | `type VisualAssetFinalizeInput` | browser-session: `brand.manage`, workspace; bodyInput(visualAssetFinalizeSchema) |  |  | plain Hono | D6 |
| 132 | DELETE | `/visual-assets/:id` | brand-profile-routes.ts:101 | `visualAssetService.softDelete` | `type ReusableAssetSoftDeleteInput` | browser-session: `brand.manage`, workspace; optionalBodyInput(reusableAssetSoftDeleteSchema, ["id"]) |  |  | plain Hono | D6 |
| 133 | GET | `/projects/:projectId/generated-media/jobs` | brand-profile-routes.ts:108 | `generatedMediaService.list`, `generatedMediaService.usageSummary` | `listGeneratedMediaJobsSchema` | browser-session: `content.view`, project(projectId); custom zod (query) |  |  | plain Hono | D6 |
| 134 | POST | `/projects/:projectId/generated-media/jobs` | brand-profile-routes.ts:122 | `generatedMediaService.create` | `createGeneratedImageSchema` | browser-session: `content.edit`, project(projectId); bodyInput(createGeneratedImageSchema, ["projectId"]) | actor `generated-image-create` 10/60s |  | plain Hono | D6 |
| 135 | GET | `/projects/:projectId/generated-media/jobs/:id` | brand-profile-routes.ts:130 | `generatedMediaService.get` | `generatedMediaJobIdSchema` | browser-session: `content.view`, project(projectId); paramsInput("projectId", "id") |  |  | plain Hono | D6 |
| 136 | POST | `/projects/:projectId/generated-media/jobs/:id/cancel` | brand-profile-routes.ts:135 | `generatedMediaService.cancel` | `generatedMediaJobIdSchema` | browser-session: `content.edit`, project(projectId); paramsInput("projectId", "id") |  |  | plain Hono | D6 |
| 137 | DELETE | `/projects/:projectId/generated-media/jobs/:id/result` | brand-profile-routes.ts:140 | `generatedMediaService.deleteResult` | `generatedMediaJobIdSchema` | browser-session: `content.edit`, project(projectId); paramsInput("projectId", "id") |  |  | plain Hono | D6 |
| 138 | GET | `/brand-profiles/:id/scene-templates` | brand-profile-routes.ts:146 | `sceneTemplateService.list` |  | browser-session: `content.view`, workspace; paramsInput("id") |  |  | plain Hono | D6 |
| 139 | POST | `/brand-profiles/:id/scene-templates` | brand-profile-routes.ts:151 | `sceneTemplateService.create` | `type SceneTemplateCreateInput` | browser-session: `brand.manage`, workspace; bodyInput(sceneTemplateCreateSchema, ["id"]) |  |  | plain Hono | D6 |
| 140 | PATCH | `/brand-profiles/:id/scene-templates/:templateId` | brand-profile-routes.ts:157 | `sceneTemplateService.update` | `type SceneTemplateUpdateInput` | browser-session: `brand.manage`, workspace; bodyInput(sceneTemplateUpdateSchema, ["id", "templateId"]) |  |  | plain Hono | D6 |
| 141 | DELETE | `/brand-profiles/:id/scene-templates/:templateId` | brand-profile-routes.ts:163 | `sceneTemplateService.softDelete` | `type SceneTemplateDeleteInput` | browser-session: `brand.manage`, workspace; bodyInput(sceneTemplateDeleteSchema, ["id", "templateId"]) |  |  | plain Hono | D6 |
| 142 | GET | `/brand-fonts` | brand-profile-routes.ts:169 | `brandFontService.list` |  | browser-session: `content.view`, workspace |  |  | plain Hono | D6 |
| 143 | POST | `/brand-fonts/presign-upload` | brand-profile-routes.ts:173 | `brandFontService.presignUpload` | `type BrandFontUploadInput` | browser-session: `brand.manage`, workspace; bodyInput(brandFontUploadSchema) | actor `brand-font-presign` 30/60s |  | plain Hono | D6 |
| 144 | POST | `/brand-fonts` | brand-profile-routes.ts:179 | `brandFontService.finalizeUpload` | `type BrandFontFinalizeInput` | browser-session: `brand.manage`, workspace; bodyInput(brandFontFinalizeSchema) |  |  | plain Hono | D6 |
| 145 | DELETE | `/brand-fonts/:id` | brand-profile-routes.ts:185 | `brandFontService.softDelete` | `type ReusableAssetSoftDeleteInput` | browser-session: `brand.manage`, workspace; optionalBodyInput(reusableAssetSoftDeleteSchema, ["id"]) |  |  | plain Hono | D6 |
| 146 | PATCH | `/projects/:id/clips/:clipId` | clip-editor-http.ts:94 | `clipService.updateClipTitle`, `clipEditorDocumentPersistence.mutateDocument` | `updateClipTitleSchema`, `updateClipBoundariesSchema`, `updateClipCaptionPresetSchema`, `updateClipTranscriptSliceSchema`, `updateClipBrollSchema`, `updateClipStudioEditsSchema` | browser-session: `content.edit`, project(id) |  |  | plain Hono | D3 |
| 147 | GET | `/projects/:id/clips/:clipId/editor` | clip-editor-http.ts:214 | `clipService.getClipEditorDocument` |  | browser-session: `content.edit`, project(id) |  |  | plain Hono | D3 |
| 148 | PUT | `/projects/:id/clips/:clipId/editor` | clip-editor-http.ts:226 | `clipService.getClipEditorDocument`, `analyzeSceneDocumentMutation`, `clipEditorDocumentPersistence.mutateDocument`, `visualAssetService.recordGeneratedInsertionsBestEffort` | `saveEditorDocumentSchema` | browser-session: `content.edit`, project(id) |  |  | plain Hono | D3 |
| 149 | POST | `/projects/:id/clips/:clipId/editor/reset` | clip-editor-http.ts:280 | `clipEditorDocumentPersistence.mutateDocument` | `resetEditorDocumentSchema` | browser-session: `content.edit`, project(id) |  |  | plain Hono | D3 |
| 150 | POST | `/projects/:id/clips/regenerate` | clip-generation-http.ts:11 | `clipService.regenerateClips` | `type RegenerateClipsRequest` | browser-session: `processing.consume`, project(id); idempotentBodyInput(regenerateClipsRequestSchema, ["id"]); idempotency-key header | actor `regenerate` 20/60s | idempotency-key header | plain Hono | D3 |
| 151 | POST | `/projects/:id/campaign-operations/schedule/preview` | social-publication-http.ts:31 | `bulkSocialSchedulingService.preview` | `type PublishingPreviewRequest` | browser-session: `publishing.manage`, project(id); bodyInput(publishingPreviewSchema, ["id"]) | actor `publishing-preview` 60/60s |  | plain Hono | D5 |
| 152 | POST | `/projects/:id/campaign-operations/schedule` | social-publication-http.ts:37 | `bulkSocialSchedulingService.schedule` | `type BulkSocialScheduleRequest` | browser-session: `publishing.manage`, project(id); bodyInput(bulkSocialScheduleSchema, ["id"]) | actor `campaign-schedule` 20/3600s |  | plain Hono | D5 |
| 153 | GET | `/projects/:id/social-accounts/:accountId/publishing-options` | social-publication-http.ts:48 | `socialPublishingOptions` |  | browser-session: `content.view`, project(id); paramsInput("id", "accountId") | actor `publishing-options` 30/60s |  | plain Hono | D5 |
| 154 | POST | `/projects/:id/social-posts/:postId/refresh-inbox` | social-publication-http.ts:54 | `refreshTikTokInbox` |  | browser-session: `publishing.manage`, project(id); paramsInput("id", "postId") | actor `refresh-inbox` 20/60s |  | plain Hono | D5 |
| 155 | GET | `/projects/:id/social-posts` | social-publication-http.ts:60 | `socialService.listProjectPosts` |  | browser-session: `content.view`, project(id); paramsInput("id") |  |  | plain Hono | D5 |
| 156 | DELETE | `/projects/:id/social-posts/:postId` | social-publication-http.ts:71 | `socialService.cancelPost` |  | browser-session: `publishing.manage`, project(id); paramsInput("id", "postId") |  |  | plain Hono | D5 |
| 157 | GET | `/projects/:id/social-posts/:postId/publication` | social-publication-http.ts:77 | `socialService.inspectPublication` |  | browser-session: `content.view`, project(id); paramsInput("id", "postId") |  |  | plain Hono | D5 |
| 158 | POST | `/projects/:id/social-posts/:postId/recheck` | social-publication-http.ts:83 | `socialService.recheckPublication` | `type RecheckSocialPublicationInput` | browser-session: `publishing.manage`, project(id); bodyInput(recheckSocialPublicationSchema, ["id", "postId"]) |  |  | plain Hono | D5 |
| 159 | POST | `/projects/:id/social-posts/:postId/confirm` | social-publication-http.ts:91 | `socialService.confirmPublication` | `type ConfirmSocialPublicationInput` | browser-session: `publishing.manage`, project(id); bodyInput(confirmSocialPublicationSchema, ["id", "postId"]) |  |  | plain Hono | D5 |
| 160 | POST | `/projects/:id/social-posts/:postId/publish-again` | social-publication-http.ts:99 | `socialService.republishPublication` | `type RepublishSocialPublicationInput` | browser-session: `publishing.manage`, project(id); bodyInput(republishSocialPublicationSchema, ["id", "postId"]) |  |  | plain Hono | D5 |
| 161 | POST | `/webhooks/zoom` | zoom-http.ts:13 | `zoomService.acceptWebhook` |  | independent-trust: `zoom_signature` |  |  | plain Hono | P0 |
| 162 | GET | `/zoom/connections` | zoom-http.ts:23 | `zoomService.listConnections` |  | browser-session: `content.view`, workspace |  |  | plain Hono | D8 |
| 163 | DELETE | `/zoom/connections/:connectionId` | zoom-http.ts:24 | `zoomService.disconnect` |  | browser-session: `content.edit`, workspace; paramsInput("connectionId") |  |  | plain Hono | D8 |
| 164 | GET | `/zoom/oauth/start` | zoom-http.ts:28 | `zoomService.createAuthorizationUrl` |  | browser-session: `content.edit`, workspace | actor `zoom-connect` 10/3600s | redirect | plain Hono | D8 |
| 165 | GET | `/zoom/oauth/callback` | zoom-http.ts:29 | `zoomService.handleCallback` |  | browser-session: `content.edit`, workspace |  | redirect | plain Hono | D8 |

Notes on the table:
- `GET /projects`, `GET /workspace/search` and other list routes take query params directly (`limit`, `cursor`, `folder`, `q`, `status`, `source`, `sort`) without a policy-level schema; `GET /library/search` has a custom strict zod query schema (`q`, `limit`, `projectId`) in the policy.
- `PATCH /projects/:id/clips/:clipId` (clip-editor-http.ts:94) is a union-by-shape update: tries `updateClipTitleSchema`, `updateClipBoundariesSchema`, `updateClipCaptionPresetSchema`, `updateClipTranscriptSliceSchema`, `updateClipBrollSchema`, `updateClipStudioEditsSchema` in order, else 400 `unrecognized_clip_update` (the status case is listed in the error text). `PUT .../editor` validates scene references (`visualAssetService`, `brandFontService`) before `clipEditorDocumentPersistence.mutateDocument`.
- Source lines for `route.ts` rows are the line of the `app.<method>(` call.
- `GET /social/oauth/callback` is the only browser-redirect route in the independent-trust list; it relies on the signed `state` (the Clerk middleware `isProtectedRoute` list still requires a signed-in session for `/api/social(.*)`, so the session cookie must reach the callback; see 3.5).
- `POST /social/oauth/facebook-selection/:token` maps `PlanRequirementError` to 402.
- Route-level tests next to the modules (move/port with the code): `clip-editor-http.test.ts`, `clip-generation-http.test.ts`, `social-publication-http.test.ts`, `stripe-webhook-http.test.ts`, `upload-session-http.test.ts`, `workspace-billing-routes.test.ts`, `zoom-http.test.ts`. `route.ts` itself has no test; the inventory is covered by `lib/authenticated-request-inventory.test.ts` and `lib/authenticated-request-hono.test.ts`.

### 3.3 Public REST API v1 (`apps/web/lib/rest-api/app.ts`, 537 lines)

- Factory `createRestApi({ checkRateLimit, appOrigin, callbackResolver?, log? })` returns an `OpenAPIHono<Env>` with `.basePath("/api/v1")`. `app/api/v1/[[...route]]/route.ts` instantiates it with `checkRateLimit` from services and `appOrigin: () => process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000"` and exports `GET/POST/DELETE = handle(app)`.
- Auth: **Workspace API key only** (`Authorization: Bearer nf_...`, checked by `workspaceService.authenticateApiKey`), no Clerk, no cookies; `IntegrationAdmission` re-checks membership, role, plan and key scope per request through `REST_ENDPOINT_COMMANDS` (one integration command per endpoint, shared with MCP). Per-key rate limit `rest:${apiKeyId}` 300/60s (`REST_API_RATE_LIMIT`), `RateLimit-Limit` / `RateLimit-Remaining` response headers, `Retry-After`. `newMutationGuard` blocks new mutations when the limiter is unavailable. Mutations require `Idempotency-Key` (`REST_IDEMPOTENCY_KEY_PATTERN`); replays set `Idempotent-Replayed: true`. Completion callbacks validated by `assertCompletionCallbackUrl` (DNS check via injectable `HostResolver`).
- Cross-cutting: request-id (`req_<uuid>`) and `Cache-Control: no-store` on every response, structured log `rest_api_request`, error envelope `{ error, message, requestId, details?, retryAfterSeconds? }`, domain failures mapped with `domainFailureHttpStatus` imported from `../authenticated-request-http` (a web `lib` file the API must own or share).
- OpenAPI: served at `GET /api/v1/openapi.json` via `app.doc31` (unauthenticated, bypasses the key middleware), document header from `openApiDocumentConfig(origin)`. `lib/rest-api/public-openapi.ts` builds the production document (`PUBLIC_API_ORIGIN = https://app.narriflow.com`) with a stubbed limiter, and `lib/docs/openapi.ts` imports it, and `lib/docs/{entries,navigation,markdown,endpoint-markdown,search-index}.ts` plus the API reference components under `app/(docs)/_components/api/` and `app/(docs)/docs/[[...slug]]/page.tsx` read from `openapi.ts`. **Moving `createRestApi` to `apps/api` breaks the docs build unless the document is exported from a shared package, generated at build time, or committed as a snapshot** (see section 4 surprises). Snapshot test: `lib/rest-api/__snapshots__/app.test.ts.snap` (8074 lines) from `app.test.ts` (827 lines); also `events.db.test.ts`, `public-openapi.test.ts`.

| # | Method | Path (under `/api/v1`) | app.ts line | Tag | Summary | Integration command (admission scope) | Handler calls | Idempotency-Key | Request validation |
|---|---|---|---|---|---|---|---|---|---|
| 1 | GET | `/workspace` | 282 | Workspace | Get the key's Workspace, plan, and credit usage | `get_workspace_usage` | `projectService.getUsageSummary` |  |  |
| 2 | GET | `/brand-profiles` | 288 | Workspace | List Brand Profiles | `list_brand_profiles` | `brandProfileService.listSummaries` |  |  |
| 3 | GET | `/recipes` | 294 | Workspace | List Recipes | `list_recipes` | `recipesView` |  |  |
| 4 | GET | `/recipes/:id` | 299 | Workspace | Get a Recipe | `list_recipes` | `recipeView`, `recipeService.get` |  | params |
| 5 | POST | `/uploads` | 304 | Uploads | Open an Upload Session | `open_upload` | `uploads.open` | required | json body |
| 6 | GET | `/uploads/:id` | 325 | Uploads | Read an Upload Session | `open_upload` | `uploadSessionService.statusById` |  | params |
| 7 | POST | `/uploads/:id/grants` | 330 | Uploads | Issue more multipart part URLs | `open_upload` | `uploads.grant` |  | params, json body |
| 8 | POST | `/uploads/:id/finalize` | 336 | Uploads | Finalize an upload and start its intake | `open_upload` | `uploads.finalize` |  | params, json body |
| 9 | DELETE | `/uploads/:id` | 346 | Uploads | Discard an unfinished upload | `open_upload` | `uploads.discard` |  | params |
| 10 | POST | `/projects` | 352 | Projects | Submit a video link | `submit_video` | `submitVideo` | required | json body |
| 11 | POST | `/captioned-videos` | 362 | Projects | Caption a finished video | `create_captioned_video` | `createCaptionedVideo`, `uploads.open` | required | json body |
| 12 | GET | `/projects` | 385 | Projects | List projects | `list_projects` | `workspaceLibraryService.listProjects`, `projectView` |  | query |
| 13 | GET | `/projects/:id` | 392 | Projects | Get a project | `get_project` | `projectService.getProjectSnapshot`, `projectView` |  | params |
| 14 | GET | `/library/search` | 399 | Library | Search transcripts | `search_library` | `librarySearchService.search` |  | query |
| 15 | POST | `/projects/:id/generations` | 406 | Projects | Generate clips | `generate_clips` | `generateClips` | required | params, json body |
| 16 | GET | `/projects/:id/clips` | 417 | Clips | List a project's clips by virality | `list_clips` | `clipService.listClipReviewFacts`, `clipView` |  | query, params |
| 17 | GET | `/clips/:id` | 423 | Clips | Get a clip | `get_clip` | `locateClip`, `clipView`, `clipService.getClipReviewFacts` |  | query, params |
| 18 | GET | `/clips/:id/timeline` | 430 | Clips | Get an editor timeline | `get_clip_timeline` | `locateClip`, `clipTimelineService.export` |  | query, params |
| 19 | POST | `/clips/:id/exports` | 437 | Exports | Export a clip revision | `create_clip_export` | `locateClip`, `createClipExport`, `exportView` | required | params, json body |
| 20 | GET | `/exports/:id` | 448 | Exports | Get an export | `get_clip_export` | `locateExport`, `clipExportService.getOwned`, `exportView` |  | params |
| 21 | GET | `/exports/:id/download` | 456 | Exports | Issue Download Grants and subtitles | `get_export_download` | `clipExportService.issueDownloadGrants` |  | query, params |
| 22 | GET | `/operations/:id` | 462 | Operations | Get Operation Status | `get_operation` | `operationStatusService.read` |  | params |
| 23 | GET | `/social-accounts` | 469 | Publishing | List connected social accounts | `list_social_accounts` | `socialAccountsView` |  |  |
| 24 | POST | `/social-posts/proposals` | 474 | Publishing | Propose a social post | `propose_social_post` | `proposeSocialPost` | required | json body |
| 25 | GET | `/events` | 484 | Events | List Workspace Events | `list_events` | `listEvents` |  | query |
| 26 | GET | `/webhooks` | 491 | Webhooks | List webhooks | `list_webhooks` | `webhookSubscriptions.list` |  |  |
| 27 | POST | `/webhooks` | 496 | Webhooks | Create a webhook | `manage_webhooks` | `webhookSubscriptions.create` |  |  |
| 28 | DELETE | `/webhooks/:id` | 506 | Webhooks | Delete a webhook | `manage_webhooks` | `webhookSubscriptions.delete` |  | params |
| 29 | POST | `/webhooks/:id/enable` | 512 | Webhooks | Re-enable a webhook | `manage_webhooks` | `webhookSubscriptions.enable` |  | params |
| 30 | POST | `/webhooks/:id/test` | 519 | Webhooks | Send a test event | `manage_webhooks` | `webhookSubscriptions.test` |  | params |
| 31 | POST | `/operations/:id/callback/redeliver` | 526 | Operations | Redeliver completion callbacks | `redeliver_callback` | `redeliverCallbacks` | required | params |

Style note: REST v1 handlers are `.openapi(createRoute(...), handler)` chains with `c.req.valid("json"|"query"|"param"|"header")`; the `defaultHook` converts zod failures to `RestFailure(400, invalid_request | idempotency_key_required)`. The other Hono apps are plain Hono. The brief's "one route style everywhere" therefore means converting the 165 plain-Hono routes, or accepting a mixed API during the cutover.

### 3.4 `apps/web/proxy.ts` (Next 16 middleware) and Next config

- `clerkMiddleware`. `isPublicInfrastructureRoute` (returns `NextResponse.next()` untouched): `/api/health`, `/api/v1(.*)`, `/mcp(.*)`, `/.well-known/oauth-protected-resource(.*)`, `/.well-known/oauth-authorization-server(.*)`.
- `isProtectedRoute` page prefixes: `/home /projects /exports /calendar /performance /autopilot /brand-kit /workspaces /settings /upload` and exact `/auth/continue`. Unauthenticated page requests redirect to `authEntryHref("sign-in", destination)` (for `/auth/continue` the destination is `redirect_url`).
- `isProtectedRoute` API prefixes (401 JSON `{ error: "Unauthorized" }` when no `userId`, else `auth.protect()`): `/api/projects /api/upload-sessions /api/ingest /api/stream /api/workspace /api/billing /api/autopilot /api/social /api/zoom /api/brand-templates /api/audio-assets /api/brand-profiles /api/brand-fonts /api/visual-assets /api/generated-media` (15). **Not listed, so only the Hono policy guards them:** `/api/recipes`, `/api/library`, `/api/broll`, `/api/webhooks/*`, `/api/review/*`, `/api/docs/*`. Pages not listed (guarded only by the page-level `admit*Page` helpers): `/invite`, `/integrations`, `/search`, `/recipes`, `/workspace-unavailable`, `/review`, `/share`.
- Extra rule: `/` with `?auth=<mode>` and a signed-in user redirects to the auth continuation href.
- Matcher excludes `_next`, `mcp`, `api/v1`, the two `.well-known/oauth-*` prefixes, `api/health`, and static file extensions. Everything else (including `/api/webhooks/*`, `/api/review/*`) still goes through `clerkMiddleware` (no protect).
- `next.config.ts`: `serverExternalPackages` = `@node-rs/argon2`, `@ffprobe-installer/ffprobe`, `sharp`; `outputFileTracingIncludes` for `/api/*` copies ffprobe binaries (the API image must ship ffprobe and sharp natives); `transpilePackages` = auth, db, email, services, ui, validators; `redirects` = `/settings` to `/settings/profile`, `/developers/api` to `/docs/api/introduction`; `rewrites` = `/docs.md`, `/docs/:path*.md`, and `Accept: text/markdown` on `/docs/:path*` to `/docs-markdown/...`; `headers` = global security headers on `/:path*` (nosniff, `X-Frame-Options: DENY`, referrer policy, HSTS, `Permissions-Policy`, `frame-ancestors 'none'` CSP, a report-only CSP whose `connect-src` is `'self'` + Clerk + R2 + Upstash + accounts.google.com, so **browser calls to a separate API origin need that origin added to `connect-src`** before the CSP is enforced), no-store/noindex headers for `/integrations/mcp/:path*`, `/review/:path*` (strict CSP with `form-action 'self'`, `connect-src 'self'` + Clerk) and `/api/review/:path*`, `Vary: Accept` on `/docs/:path*`. The API must set its own secure headers (the Next global headers stop applying to API responses).
- `vercel.json`: only `installCommand` (clean `node_modules`, `bun install --frozen-lockfile --linker hoisted`). **No crons, rewrites, headers, `functions`/maxDuration overrides.**

### 3.5 Facts the migrator must not miss

1. Active workspace and Clerk session are cookie based today. Every browser-session route resolves the actor from cookies (`narriflow_active_workspace`, httpOnly, written by `setActiveWorkspaceForActor` in `packages/auth/src/index.ts`); Bearer clients need an explicit workspace selector.
2. OAuth flows are **full-page navigations** (`/api/social/oauth/start/:platform`, `/api/zoom/oauth/start`) and return as `GET` redirects to registered callback URLs; the callbacks resolve the actor from the session cookie (zoom callback is browser-session, social callback is independent-trust but still behind the Clerk `/api/social` protect rule). On a separate API origin the cookie will not arrive unless the API shares the registrable domain with `credentials`, or the flow is reworked (start returns a URL; callback is state-only).
3. Presigned-URL redirects (`/file`, `/download`) are used as `<a href>` / media `src`; those need either cookies on the API origin or a "get signed URL" JSON variant (the JSON variants `clips/:clipId/download` and `clips/previews` already exist).
4. `app/api/[[...route]]/upload-session-http.ts` is imported by `lib/mcp-upload-http.ts` (cross-surface reuse), and `lib/authenticated-request-hono.ts` is imported by `brand-profile-routes.ts` (value import of `authenticatedHonoInput`).


## 4. Other Next route handlers

`find apps/web/app -name 'route.ts*'` returns **16** files: the two Hono catch-alls (sections 3.2 and 3.3) plus the **14** below. A 15th handler module, `app/api/review/review-guest-http.ts`, holds the logic behind `app/api/review/[token]/[[...review]]/route.ts` (a one-line re-export).

| # | File | Methods | What it does | Next-specific dependencies | Trust / auth | Verdict |
|---|---|---|---|---|---|---|
| 1 | `app/api/stream/[projectId]/route.ts` (402 lines) | GET | Server-Sent Events progress stream. Admission through `freshAuthenticatedRequestPolicy.execute({ adapter: "stream", operationName: "open-workflow-progress-stream", admission: project content.view })`; replays missed events from the DB (`getWorkflowEventsSince`, `sinceSeq` query) and subscribes to the Redis channel (`getWorkflowChannel`, `UPSTASH_REDIS_URL`, `ioredis`), 15s heartbeat + `createWorkflowStreamReauthorizationGuard` re-checks access, 15s fallback poll if Redis is down. Returns `text/event-stream` with `Cache-Control: no-cache, no-transform`, `X-Accel-Buffering: no`. | `export const runtime = "nodejs"` only. Imports `@/lib/authenticated-request-policy.server` (server-only, React `cache`, `next/navigation` `unstable_rethrow`, Clerk session). No `next/*` in the file itself. Web client helpers: `lib/workflow-stream.ts`, `workflow-stream-authorization.ts`, `workflow-stream-reauthorization.ts` (pure). | Browser session cookie (Clerk) | **Move to API.** Needs Bearer auth, and clients must use `fetch` + `eventsource-parser` (EventSource cannot send `Authorization`). Bun note: `Bun.serve` default `idleTimeout` is 10 s, which is shorter than the 15 s heartbeat, so set `idleTimeout` (max 255) or send comments more often. |
| 2 | `app/api/webhooks/clerk/route.ts` (143 lines) | POST | Svix-verified Clerk webhook: `user.created/updated` to `syncClerkUserPayload`, `user.deleted` to `markUserDeletedByClerkId`, `email.*` relayed by `@narriflow/email` `relayClerkEmail`; idempotent via `getWebhookDeliveryLog` / `recordWebhookDeliveryLog("clerk", svixId)`. | `headers()` from `next/headers`; `UserJSON` type from `@clerk/nextjs/server`; `validateWebhookEnv()` from `lib/env.ts` (`server-only`); `runtime = "nodejs"`. | Svix signature (`CLERK_WEBHOOK_SECRET`) | **Move to API** (backend writes users). Replace `headers()` with `c.req.header`, type from `@clerk/backend`; update the endpoint URL in the Clerk dashboard (external registration). |
| 3 | `app/api/review/[token]/[[...review]]/route.ts` (1 line) + `app/api/review/review-guest-http.ts` (224 lines) | GET, POST, PATCH, DELETE | Guest review API: `POST ""`/`POST access` exchanges the review token + guest credentials for a signed session cookie (`reviewService.authenticate`, cookie `nf_review_<hash12>`, httpOnly, `SameSite=Strict`, `Path=/api/review/<token>`, 12 h, `secure` in production); then `GET ""` (round + comments), `POST comments`, `POST decision`, `PATCH`/`DELETE comments/:commentId`, `GET media/:itemId/:variantId` and `download/:itemId/:variantId` (307 to presigned URL). `guestReviewRoutes` table lists 9 route shapes. 32 KiB streaming body cap. | `NextRequest` / `NextResponse` (cookie get/set, JSON, redirect); `context.params` Promise; `request.headers.get("x-forwarded-for")` for IP. | Signed guest cookie (`REVIEW_SESSION_SECRET` >= 32 chars), independent of Clerk; **same-origin check** `assertSameOrigin` compares `Origin` to the request URL origin on POST/PATCH/DELETE. | **Move to API** (uses `@narriflow/services`). Cross-origin consequences: the same-origin check must become an allowlist, the `SameSite=Strict` cookie lives on the API host (needs `credentials: "include"` and a shared registrable domain, or switch to a bearer-style session returned in the body), and the cookie `path` and Next headers for `/api/review/:path*` (noindex, no-store) must be re-applied by the API. Tests: `review-guest-http.test.ts`. |
| 4 | `app/review/opt-out/route.ts` (48 lines) | GET, POST | Server-rendered HTML page for the "stop automated review requests" link from Standing Grant emails. `GET ?token=` shows a confirm form (`reviewerOptOut.preview`), `POST` form-encoded confirms (`reviewerOptOut.confirm`). Inline HTML, `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, `X-Robots-Tag: noindex`. | `dynamic = "force-dynamic"`, `revalidate = 0`; plain `Request`/`Response`. Covered by `next.config` headers for `/review/:path*` (CSP `form-action 'self'`). Not in `proxy.ts` protected list. | Signed token in URL (no login) | **Move the logic to API** (imports `reviewerOptOut` from services, banned in web); the email link URL builder and the form `action` must then point at the API origin, or keep a thin web route handler that calls an API endpoint. Decision needed. |
| 5 | `app/mcp/route.ts` (17 lines) | GET, POST, DELETE, OPTIONS | Remote MCP server endpoint: `createNarriflowMcpHttpHandler` from `@narriflow/mcp-core/http` with `narriflowMcpTokenVerifier`, allowed hosts/origins, resource-metadata URL, `checkRateLimit`, `buildNarriflowMcpServer`. | `runtime/dynamic/maxDuration = 60` exports; `lib/mcp-auth.ts` imports `server-only`. Handler is Web-standard `Request` to `Response`. Excluded from the Clerk matcher. | OAuth bearer (Clerk-issued) or Workspace API key, verified by the handler | **Move to API.** `lib/mcp-auth.ts` reads `NEXT_PUBLIC_APP_URL`, `CLERK_OAUTH_ISSUER`, `MCP_ALLOWED_HOSTS`/`MCP_ALLOWED_ORIGINS`, `CLERK_SECRET_KEY`. The resource URL (`<app origin>/mcp`) is registered in MCP clients and in the `.well-known` metadata; moving the host changes it (or rewrite `/mcp` and `/.well-known/*` from web to the API). |
| 6 | `app/mcp/integrations/[workspaceId]/[...upload]/route.ts` (50 lines) | POST, OPTIONS | MCP upload transport: validates host/origin (`hostHeaderValidationResponse`, `rejectMcpOrigin`), `workspaceId` UUID, bounded body, then `createMcpUploadHttpHandler` which mounts the browser `createUploadSessionHttpRoutes` under `/mcp/integrations/:workspaceId` (5 POST routes: `upload-sessions/open|finalize|grants|status|discard`). Two admissions: bearer (`authenticateMcpRequest` + `McpToolAdmission narriflow_upload_video`) or the `X-Narriflow-Upload-Intent` handoff token completed by a **signed-in person** (`getCurrentAppUser()` from `@narriflow/auth`, `verifyMcpUploadHandoff`, owner rate limit `mcp-upload-owner:<userId>` 300/60s, direct `getPrismaClient().uploadSession.findFirst`). | `runtime/dynamic/maxDuration = 60`; `getCurrentAppUser` is the Clerk-cookie (Next) session helper; `lib/mcp-auth.ts` `server-only`. Excluded from the Clerk matcher by the `mcp` prefix. | Bearer, or handoff token + browser session | **Move to API** with the MCP route. The handoff branch needs a Clerk Bearer/session instead of the Next cookie helper (the person finishes the upload from the web page `app/(app)/integrations/mcp/upload`). Handoff/continuation URLs are built from `NEXT_PUBLIC_APP_URL` (see section 6). |
| 7 | `app/.well-known/oauth-authorization-server/route.ts` | GET, OPTIONS | Proxies the Clerk issuer's `/.well-known/oauth-authorization-server` metadata (`fetch` with 10 s timeout, 502 on failure), CORS `*`. | `fetch(..., { next: { revalidate: 3600 } })` (Next data cache) | Public | **Move to API** (replace the Next fetch cache with an in-memory TTL cache). Must stay reachable at the MCP resource's origin (RFC 9728/8414). |
| 8 | `app/.well-known/oauth-protected-resource/mcp/route.ts` | GET, OPTIONS | Returns `getMcpProtectedResourceMetadata()` JSON, CORS `*`. | none (imports `lib/mcp-auth`, `server-only`) | Public | **Move to API.** |
| 9 | `app/.well-known/oauth-protected-resource/route.ts` | GET, OPTIONS | Re-exports route 8 (`export { GET, OPTIONS } from "./mcp/route"`). | none | Public | **Move to API** with route 8 (serve both paths). |
| 10 | `app/api/docs/search/route.ts` (6 lines) | GET | Docs search: `searchDocs(query)` over the fumadocs index; `Response.json`. | none (`@/lib/docs/search-index`) | Public | **Stay in web.** Docs/content only; called same-origin by the docs UI. |
| 11 | `app/(docs)/docs-markdown/[[...slug]]/route.ts` (20 lines) | GET | Markdown rendition of each docs page (target of the `.md` and `Accept: text/markdown` rewrites). | `dynamic = "force-static"`, `generateStaticParams` | Public | **Stay in web.** |
| 12 | `app/(docs)/docs-og/[[...slug]]/route.tsx` (104 lines) | GET | OG image per docs page. | `next/og` `ImageResponse`, `node:fs` font read, `force-static`, `dynamicParams = false`; imports `lib/docs/openapi` (which imports `createRestApi`) | Public | **Stay in web.** Depends on the REST OpenAPI document (see below). |
| 13 | `app/(docs)/docs/llms.txt/route.ts` (7 lines) | GET | `llms.txt` index. | `force-static` | Public | **Stay in web.** |
| 14 | `app/(docs)/docs/llms-full.txt/route.ts` (7 lines) | GET | `llms-full.txt`. | `force-static` | Public | **Stay in web.** |

Counts: 16 route files in total = 2 Hono catch-alls (section 3, move) + 14 others. Of the 14: **9 move** (stream, clerk webhook, review guest, review opt-out, mcp, mcp upload, 3 `.well-known` files) and **5 stay** (docs search, docs-markdown, docs-og, llms.txt, llms-full.txt). Exported handlers across the 14 files (25 total; the review file re-exports 4 from `review-guest-http.ts`, `oauth-protected-resource/route.ts` re-exports 2): GET 12, POST 5, PATCH 1, DELETE 2, OPTIONS 5. Auth surfaces of the 9 that move: Clerk browser session 1 (stream), signed guest cookie 1 (review), signed email token 1 (opt-out), Svix signature 1 (clerk webhook), OAuth bearer / API key (+ browser-session handoff on upload) 2 (mcp, mcp upload), public discovery 3 (`.well-known`).

### 4.1 Surprises and decisions for the migrator

1. **Docs depend on the REST app.** `lib/docs/openapi.ts` imports `lib/rest-api/public-openapi.ts`, which calls `createRestApi(...)` (a services-importing module) to build the OpenAPI document that renders `/docs/api/*` and feeds docs navigation, markdown, search index and `docs-og`. Moving `lib/rest-api` out of web and forbidding services imports in web means the document must be produced elsewhere: export a `publicOpenApiDocument()` from `apps/api` (or a small package) and have web's build consume a generated `openapi.json` committed or produced by a turbo task before `next build`.
2. **Review guest session is a first-party cookie plus same-origin check.** Both break on a separate API origin (see route 3).
3. **MCP and OAuth discovery URLs are externally registered.** Moving `/mcp` and `/.well-known/oauth-*` to a new host changes the protected-resource URL clients cached; the least risky option is to keep the public paths on the app origin via Next `rewrites` to the API (the matcher already exempts them from Clerk) or to host the API under the same origin through a reverse proxy.
4. **Streaming limits.** The SSE route is the only long-lived HTTP response (`maxDuration` is not set on it; Vercel function duration governs it today). On Bun, set `idleTimeout`; on Railway there is no function timeout.
5. **No Next `after()`, `unstable_cache`, `cookies()` or `revalidate*` in any route handler.** Only `headers()` (clerk webhook), `NextRequest`/`NextResponse` (review guest), `next/og`, and `fetch` with `next.revalidate` (well-known). Everything else in the API is already Web-standard `Request`/`Response` or Hono.
6. **Edge/segment config to carry over:** `maxDuration = 60` on 4 handlers (`[[...route]]`, `v1`, `mcp`, `mcp upload`); on Railway this becomes the request timeout/`idleTimeout` policy, not a platform cap.
7. **CSP report-only `connect-src`** must list the API origin before the policy is promoted to enforcement.

## 5. Client mutation and refresh call sites

All paths are relative to `apps/web/`. Line numbers verified against the working tree on 2026-10-29.
Counts come from `grep -rnE 'router\.refresh\(\)' app lib --include='*.ts' --include='*.tsx'`.

### 5.0 Counts

| Metric | Count |
| --- | --- |
| Raw `router.refresh()` matches | 83 lines in 48 files |
| Of which comments/docstrings only | 8 lines (`upload/_lib/use-ingest-stream.ts:35`, `projects/_components/projects-explorer.tsx:253`, `projects/[projectId]/page.tsx:1097`, `project-events-provider.tsx:66,136`, `clip-actions-menu.tsx:56,100`, `processing-panel.tsx:363`); 3 files are comment-only (`use-ingest-stream.ts`, `projects/[projectId]/page.tsx`, `processing-panel.tsx`) |
| **Real `router.refresh()` calls** | **75 calls in 45 files** |
| Other refresh mechanisms | `window.location.reload()` x5, `window.location.assign()` x9 (5.13); polling intervals (5.15 item 6); `revalidatePath` in 10 action files, 40 call sites (5.10); local `refresh()` helpers that refetch via `fetch` in `recipes-panel.tsx`, `export-delivery-client.tsx`, `review-panel.tsx`, `publishing-provider.tsx`, `projects-explorer.tsx` |
| Client `fetch(` call expressions (excl. docs, server code, tests, code snippets) | 102 in 50 files (includes presigned-storage PUTs and a few non-`/api` URLs) |
| `new EventSource(` | 3 (`project-events-provider.tsx:143`, `export-delivery-client.tsx:155`, `upload/_lib/use-ingest-stream.ts:62`), all against `GET /api/stream/:projectId?sinceSeq=` |
| `XMLHttpRequest` | 1 (`upload/_lib/upload-session-browser.ts:442`, PUT of upload parts to a presigned URL, for progress events) |
| `navigator.sendBeacon` / `new Request(` | 0 / 0 (a `fetch(... keepalive: true)` stands in at `studio-editing-session-browser.ts:502`) |
| Server-action call/reference sites in client-reachable code | about 65 across 40 files (5.11) |
| Inline `"use server"` closures in `studio/page.tsx` called by the client | 6: `fetchPreviewStatus`, `fetchAutoLayoutAnalysis`, `fetchSplitLayoutAnalysis`, `fetchScreenLayoutAnalysis`, `updateProjectCensorTerms`, `recordAutoCensorEvent` (lines 225-266); consumed at `studio-shell.tsx:949-1123` and `censor-panel.tsx:97,317` |
| `useRouter` importers | 68 files; `router.push|replace` call sites: 45 (navigation only) |

Pattern notes for the migrator:
- Client mutations are already about 60% `fetch("/api/...")`; the rest are server actions. Both end the same way: `router.refresh()` (RSC re-render of the server page) or local state.
- `router.refresh()` re-runs the whole server tree, including `(app)/layout.tsx` (auth, usage stats, workspace chip). With React Query each refresh must become a narrow `invalidateQueries`.
- Client-side idempotency keys already exist at: `clip-row.tsx:554,659`, `render-clips-button.tsx:260`, `studio-shell.tsx:1936`, `edit-clip-length-dialog.tsx:715`, `dubbing-panel.tsx:300`, `campaign-command-bar.tsx:538,614,744,831`, `campaign-editor-action-preview.tsx:572`, `publishing-cover.tsx:204`, `publishing-composition-session.ts:354,561-575`, `publishing-provider.tsx:616`, `processing-panel.tsx` (hidden form fields), `generated-images-panel.tsx:235`, `billing-plans.tsx:241,250,326`, `workspaces/new/checkout-request.ts`, `upload/_lib/upload-session-browser.ts:563-593,1058`, `upload/_lib/upload-resume.ts`.

### 5.1 Workspace / auth / members / avatar

| file:line | Trigger | Mutation just performed | Refreshes |
| --- | --- | --- | --- |
| `app/_components/auth/auth-form.tsx:65` | Clerk sign-in/sign-up finished (`signInHook.setActive`) then `router.replace(completion)` | Clerk client SDK (not the Narriflow backend) | Root and `(app)` layout so server auth state is re-read; becomes session reset plus `queryClient.clear()` |
| `(app)/_components/app-chrome.tsx:88` | Workspace banner "switch" button | `switchWorkspaceAction(workspaceId)` (:77) | Whole `(app)` tree: layout chip, usage, current page. Action also does `revalidatePath("/", "layout")` |
| `(app)/_components/workspace-switcher.tsx:62` | Workspace switcher menu item | `switchWorkspaceAction` (:51) | Same |
| `(app)/projects/_components/workspace-mismatch-notice.tsx:64` | "Switch workspace" on a project in another workspace; `router.push(returnTo)` then refresh | `switchWorkspaceAction` (:49) | Whole tree, then project page for the new workspace |
| `(app)/settings/members/members-panel.tsx:156` | Invite form submit | `inviteMemberAction({email, role})` (:143) | `/settings/members` (members, invites, seat counts) |
| `members-panel.tsx:175` | "Resend" | `resendInviteAction(inviteId)` (:164) | `/settings/members` |
| `members-panel.tsx:191` | "Revoke" invite | `revokeInviteAction(inviteId)` (:181) | `/settings/members` |
| `members-panel.tsx:211` | Role select (refreshes even on failure) | `changeMemberRoleAction(memberId, role)` (:207) | `/settings/members` (+ seat billing line) |
| `members-panel.tsx:223` | "Remove" member (refreshes even on failure) | `removeMemberAction(memberId)` (:219) | `/settings/members` |
| `(app)/settings/workspace/workspace-avatar-control.tsx:43` | Avatar file chosen | `POST /api/workspace/avatar/presign` (:28), `PUT` presigned URL (:35), `PATCH /api/workspace/avatar {storageKey}` (:37) | `/settings/workspace` and layout workspace chip |
| `workspace-avatar-control.tsx:55` | "Remove" avatar | `PATCH /api/workspace/avatar {storageKey:null}` (:53) | Same |

No refresh (local state, redirect, or implicit `revalidatePath`):
- `workspace-unavailable/open-workspace-button.tsx:25` `switchWorkspaceAction` then `router.push("/home")` (:30).
- `(app)/integrations/mcp/workspace-billing-link.tsx:27` `switchWorkspaceAction` then `router.push(href)` (:32).
- `workspaces/new/create-workspace-form.tsx:25` `useActionState(createBusinessWorkspaceAction)`; on `state.checkoutUrl` does `window.location.assign` (:28).
- `invite/[token]/invite-view.tsx:102` `AuthenticatedActionForm` with `acceptWorkspaceInviteAction.bind(null, token)` (bound in `invite/[token]/page.tsx:20`); server action `redirect("/home")` after `setActiveWorkspaceForActor`.
- `(app)/settings/workspace/page.tsx:57,77` `AuthenticatedActionForm` forms for `updateWorkspaceAction` and `updatePerformanceGuidanceAction` (server `revalidatePath("/", "layout")`, `/settings/workspace`, `/performance`).
- `(app)/settings/workspace/censor-words-card.tsx:93-94` passes `replaceCensorWordsAction`/`resetCensorWordsAction` into a shared word-list editor (server `revalidatePath("/settings/workspace")`).

### 5.2 Projects (list, folders, project page, processing, review)

| file:line | Trigger | Mutation just performed | Refreshes |
| --- | --- | --- | --- |
| `(app)/projects/_components/projects-header-actions.tsx:46` | "New folder" dialog | `createFolderAction(name)` (:32) | `/projects` folders list |
| `(app)/projects/_components/folders-panel.tsx:52` | Inline rename | `renameFolderAction(folderId, name)` (:42) | `/projects` folders + counts |
| `folders-panel.tsx:75` | Delete folder | `deleteFolderAction` (:67) | `/projects` |
| `folders-panel.tsx:94` | Drop project onto folder | `moveProjectToFolderAction` (:86) | `/projects` |
| `(app)/projects/_components/projects-explorer.tsx:113` | "Move to folder" dialog (bulk) | `moveProjectToFolderAction` per project (:100) | `/projects` list page 1 |
| `projects-explorer.tsx:334` (inside `refresh` effect-event, called :356 and :360) | `setInterval(LIVE_REFRESH_INTERVAL_MS)` and `visibilitychange`, only while `hasActiveProjects` | none (poll) plus re-fetch of already-loaded extra pages with `GET /api/projects?cursor=` (:340); "load more" at :418 | `/projects` page 1 (server props) and "load more" pages (client state) |
| `(app)/projects/[projectId]/project-events-provider.tsx:105,115` | SSE `workflow.stage.updated` non-terminal event, throttled `PROGRESS_REFRESH_THROTTLE_MS = 5_000` (`scheduleIncrementalRefresh`) | none (stream) | Whole project page: clips list, processing panel, finishing, exports |
| `project-events-provider.tsx:186` | SSE terminal event (`completed`/`partial`/`failed`), once per `workflowTerminalEventIdentity` | none | Whole project page |
| `project-events-provider.tsx:201` | SSE `authorization.revoked` with unparsable control | none | Whole project page |
| `(app)/projects/[projectId]/finishing-auto-refresh.tsx:11` | `setInterval(15_000)`, mounted by `finishing-status.tsx:38` while finishing is "working" | none (finishing writes no Project events) | Project page finishing status |
| `(app)/projects/[projectId]/publishing-provider.tsx:542` | Effect when any export's `currentEditorRevision` exceeds the clip's `editorRevision` | none | Project page clips |
| `(app)/projects/[projectId]/render-clips-button.tsx:282` | "Render clips" button | `POST /api/projects/:id/clips/render` (:256, idempotency-key) | Project page clips + processing |
| `render-clips-button.tsx:486` | Retry ingest form | `retryIngestFormAction(formData)` (:484) | Project page ingest status |
| `(app)/projects/[projectId]/clip-row.tsx:589` | Per-clip "Render" | `POST /api/projects/:id/clips/render` (:548) | Project page clip row |
| `(app)/projects/[projectId]/clip-actions-menu.tsx:139` | Rename dialog save | `PATCH /api/projects/:id/clips/:clipId` (:106 `saveTitle`) | Project page clip list; also studio top bar title (`top-bar.tsx:21`) |
| `clip-actions-menu.tsx:224` | Apply AI title suggestion | `saveTitle` after `POST .../title-suggestions` (:169) | Same |
| `clip-actions-menu.tsx:264` | Duplicate (skipped when `onDuplicated` prop given) | `POST .../clips/:id/duplicate` (:238) | Same |
| `clip-actions-menu.tsx:303` | Delete (skipped when `onDeleted` prop given) | `DELETE .../clips/:id` (:280) | Same |
| `(app)/projects/[projectId]/edit-clip-length-dialog.tsx:732` | Trim saved but reframe render failed to queue | `PATCH .../clips/:id` (:686) then `POST .../clips/render` (:709) | Project page clip row |
| `edit-clip-length-dialog.tsx:737` | Trim saved (dialog closes) | same | Project page clip row |
| `(app)/projects/[projectId]/dubbing-panel.tsx:324` | "Create dub" | `POST /api/projects/:id/dubs` (:296, idempotency-key) | Project page Dubbing tab list |
| `(app)/projects/[projectId]/review-panel.tsx:294` | Any review-round action | `POST /api/projects/:id/review-rounds{path}` (:282); then local `refresh()` (:269, `GET .../review-rounds`) | Review tab (local state) plus project page |
| `(app)/projects/[projectId]/project-share-button.tsx:106` | Share create/revoke | `POST /api/projects/:id/review-rounds{path}` (:94); then `loadRoom()` (`GET`, :76) | Share state (local) plus project page |
| `(app)/projects/[projectId]/campaign-command-bar.tsx:724` | Apply editor action result (`receiveEditorActionResult`, :678) | `POST .../campaign-operations/apply-brand-profile`, `apply-style`, `apply-motion`, or `brand-profiles/:p/scene-templates/:t/apply` (endpoint helper :206-214; sent from `campaign-editor-action-preview.tsx:568`); list via `GET .../campaign-operations` (:684) | Project page clips / editor revisions plus campaign operations list |
| `campaign-command-bar.tsx:812` | Apply selected motion | `POST .../campaign-operations/apply-motion` (:738, idempotency-key) then `GET .../campaign-operations` (:778) | Same |
| `campaign-command-bar.tsx:886` | Retry editor action | `POST` retry endpoint (:825, `campaign-retry-of` header) then `GET` list (:853) | Same |

No refresh (local state, optimistic, or implicit `revalidatePath`):
- `projects/_components/delete-project-button.tsx:62` `deleteProjectFormAction`; server `revalidatePath("/projects")` plus `redirect("/projects")` (NEXT_REDIRECT is swallowed at :73).
- `projects/[projectId]/project-brand-picker.tsx:55` `applyProjectBrandProfileFormAction` inside `useOptimistic` + `useTransition`; relies on server `revalidatePath("/projects/:id")`.
- `projects/[projectId]/processing-panel.tsx:299` `setNotifyPreferenceAction` in `useOptimistic`; `:487` and `page.tsx:869,940` use `AuthenticatedActionForm` for `queueTranscriptionFormAction` and `regenerateClipsFormAction` (server `revalidatePath("/projects/:id")`; `processing-panel.tsx:449` also `regenerateClipsFormAction`).
- `projects/[projectId]/content-suite-panel.tsx:417,449` `GET` / `POST /api/projects/:id/content-suite` into local `assets` state.
- `projects/[projectId]/clip-row.tsx:449` `GET .../clips/previews?aspectRatio=` (preview poll), `:630` `GET .../exports/current`, `:657` `POST .../clips/:id/exports` then `router.push(exportPage(id))`.
- `projects/[projectId]/transcript-panel.tsx:415` `window.location.assign("/api/projects/:id/transcript/export?format=")` (download navigation).
- `projects/[projectId]/dubbing-panel.tsx:340,353` `GET .../dubs/:id/download?asset=` then `window.location.assign(downloadUrl)`.
- `projects/[projectId]/edit-clip-length-dialog.tsx:82` and `studio/_components/trim-transcript-cache.ts:68` `GET /api/projects/:id/transcript/utterances` (module-level cache).
- `projects/[projectId]/publishing-provider.tsx` (posts, exports, options, schedule, assisted copy), `publishing-posts.tsx:148-174`, `publishing-cover.tsx:159-268`: all via `publishingRequest` (`publishing-draft.ts:109`), results kept in provider state. `onSubmitted` (:286) calls the provider's own `refresh()` (`GET .../social-posts?active=1&tracked=`, :201). `proposeToQueueAction` (:615) revalidates `/calendar*`, not the project page.

### 5.3 Clips and Studio (editor)

Studio has zero `router.refresh()`; it keeps state in `StudioEditingSession` and fetches directly. Paths below are under `projects/[projectId]/clips/[clipId]/studio/_components/` unless noted.

| file:line | Trigger | Call | Notes |
| --- | --- | --- | --- |
| `studio-editing-session-browser.ts:453` | Session open | `GET /api/projects/:p/clips/:c/editor` | Loads editor doc + revision |
| `...:466` | Autosave | `PUT .../editor` `{baseRevision, document}` | 409 revision conflict handling |
| `...:481` | "Reset to original" | `POST .../editor/reset` | Followed by `window.location.reload()` (`studio-shell.tsx:2004`) |
| `...:502` | Page unload | `PUT .../editor` with `keepalive: true` | Replaces `sendBeacon`; must still work with a Bearer header cross-origin |
| `studio-shell.tsx:1930` | Export | `POST .../clips/:c/exports` (idempotency-key) then `router.push(.../exports/:id)` (:1960) | No refresh |
| `studio-shell.tsx:949-1123` | Mount + interval | Calls prop closures `fetchPreviewStatus`, `fetchAutoLayoutAnalysis`, `fetchScreenLayoutAnalysis`, `fetchSplitLayoutAnalysis` (inline `"use server"` in `studio/page.tsx:225-259`) | Polling loops, no router |
| `transcript-panel.tsx:1227` | "Create clip from selection" | `POST .../clips/:c/create-from-selection` | Toast "Open" -> `router.push(studio)` |
| `tool-panels/transitions-panel.tsx:294` | Apply transition to all | `POST /api/projects/:p/clips/apply-studio-edits` | Local |
| `tool-panels/captions-panel.tsx:721` | Apply caption preset to all | `POST /api/projects/:p/clips/apply-caption-preset` | Local |
| `tool-panels/broll-panel.tsx:111` | Search stock | `GET /api/broll/search?query=&orientation=` | Local |
| `tool-panels/brand-template-panel.tsx:317` | Open panel | `GET /api/brand-templates` | Local |
| `tool-panels/audio-library.ts:56,110,125` | Browse / favorite / preview | `GET /api/audio-assets?...`, `POST|DELETE /api/audio-assets/:id/favorite`, `GET /api/audio-assets/:id/playback-url` | Local |
| `video-preview.tsx:1418,1459` | Preview audio | `GET /api/audio-assets/:id/playback-url` | Local |
| `tool-panels/uploads-tab.tsx:105` | Delete upload | `DELETE /api/audio-assets/:id` | Local |
| `tool-panels/audio-upload.ts:69,84,91` | Upload audio | `POST /api/audio-assets/presign-upload`, `PUT` presigned URL, `POST /api/audio-assets` (finalize) | Local |
| `tool-panels/generated-images-browser.ts:14-30` (`request` wrapper) | Generated media | `GET|POST .../generated-media/jobs?clipId=`, `POST .../jobs`, `POST .../jobs/:id/cancel`, `DELETE .../jobs/:id/result` | `generated-images-panel.tsx:207,215` polls every 2.5 s |
| `tool-panels/generated-images-panel.tsx:344` | Brand membership | `PUT /api/brand-profiles/:id/membership` | Local |
| `tool-panels/censor-panel.tsx:97,309-317` | Censor tool | `recordAutoCensorEvent`, `replaceWorkspaceCensorWords`, `resetWorkspaceCensorWords`, `updateProjectCensorTerms` (server actions passed as props from `studio/page.tsx:322-324`) | Local |
| `waveform-peaks.ts:51` | Waveform | `fetch(waveformPeaksUrl, {credentials:"same-origin"})`, a URL produced by the server page | Cookie-credentialed; breaks cross-origin unless the URL is signed |
| `(app)/search/library-search.tsx:94` | "Make clip" from a passage | `POST /api/projects/:p/clips/create-from-range` then `router.push(studio)` | No refresh |

Cookie-dependent media/navigation URLs that become cross-origin: `lib/clip-media.ts:115` (`clipFileDownloadPath`, rendered as `<a href>` at `clip-row.tsx:1164`), `campaign-command-bar.tsx:1467` (`/api/projects/:p/export-bundles/:id/download`), `(app)/exports/page.tsx:139,220,268` (`/api/workspace/exports/:id/download?variant=`, also a media `src`), `transcript-panel.tsx:415`, `dubbing-panel.tsx:353`. They cannot send a Bearer header; they need signed URLs or fetch-then-blob.

### 5.4 Upload / intake

| file:line | Trigger | Call | Refreshes |
| --- | --- | --- | --- |
| `(app)/upload/_components/upload-shell.tsx:187` | Upload Session finished; the adapter's `navigate(projectId)` does `router.push("/projects/:id")` then refresh | `POST /api/upload-sessions/{open,status,grants,finalize,discard}` (`upload-session-browser.ts:578,741,883,1054,1308`) plus `PUT` parts (XHR :442, fetcher :506) | `/projects/:id` |
| `upload-shell.tsx:716,719` | RSS "Generate" success; `router.push(/projects/:id or /projects)` then refresh | `generateFromRssAction(formData)` (:702); preview `POST /api/ingest/rss/preview` (:641) | Project page or `/projects` list |
| `(app)/upload/_components/retry-import-band.tsx:56` | "Retry import" band | `retryIngestFormAction` (:54) | Project page ingest status (`useIngestStream` reconnects) |

No refresh: `commit-step.tsx:304,309` `commitDriveImportAction` / `commitLinkImportAction` (then navigates); `commit-step.tsx:205` and `configure-step.tsx:105` `fetchYoutubeMetadataAction` (read-through action; server-side `fetch(oembedUrl)` at `upload/actions.ts:94`); `configure-step.tsx:165` `saveGenerationDraftAction` -> `router.push` (:175); `:185` `finalizeLinkConfigureAction` -> `router.push` (:198). `integrations/mcp/upload/upload-picker.tsx:27-37` rewrites `/api/upload-sessions/*` to `/mcp/integrations/:workspaceId/upload-sessions/:action` with header `X-Narriflow-Upload-Intent` (independent-trust surface, `credentials: "same-origin"`, `redirect: "error"`, navigates with `router.push`).

### 5.5 Publishing / calendar / social accounts

| file:line | Trigger | Mutation | Refreshes |
| --- | --- | --- | --- |
| `(app)/calendar/calendar-live-refresh.tsx:13` | `setTimeout(delayMs)` set by `calendar/page.tsx:250` (`liveRefreshDelay`) while posts are in flight | none (poll) | `/calendar` |
| `(app)/calendar/queue/posting-schedule-editor.tsx:65` | Save/clear posting schedule (also on failure) | `savePostingScheduleAction(accountId, schedule)` (:59) | `/calendar/queue` |
| `(app)/calendar/queue/proposals-inbox.tsx:201` | Per-proposal caption / reject / accept (`run()`) | `updateProposalCaptionAction` (:240), `rejectProposalAction` (:263), `acceptProposalAction` (:276,:290) | `/calendar/queue`, `/calendar` |
| `proposals-inbox.tsx:342` | "Accept all" loop (paginated) | `acceptAllProposalsAction(after)` (:325) | Same |
| `(app)/settings/social-accounts/social-accounts-panel.tsx:269` | Facebook Page chosen after OAuth; `router.replace("/settings/social-accounts")` then refresh | `POST /api/social/oauth/facebook-selection/:token` (:250; preloaded with `GET` at :222) | `/settings/social-accounts` |
| `social-accounts-panel.tsx:321` | "Disconnect" | `DELETE /api/social/accounts/:id` (:295) | `/settings/social-accounts` |

No refresh: `calendar/page.tsx:415` `AuthenticatedActionForm` with `cancelWorkspacePostAction.bind(...)` (server `revalidatePath("/calendar")`); `proposals-inbox.tsx:94` `tiktokAcceptanceOptionsAction` (read-through). Full-page link navigations (not fetch) to OAuth start routes: `social-accounts-panel.tsx:103-104`, `(app)/integrations/page.tsx:253` -> `GET /api/social/oauth/start/:platform?redirect=`; `autopilot-panel.tsx:974`, `zoom-connections.tsx:34` -> `GET /api/zoom/oauth/start`. These carry the session cookie; with a separate API origin they need a web-side hop or a signed start URL.

### 5.6 Brand kit

| file:line | Trigger | Call | Refreshes |
| --- | --- | --- | --- |
| `brand-kit/_components/brand-profile-create-form.tsx:58` | Create profile; `router.push("/brand-kit/:id")` then refresh | `POST /api/brand-profiles` (:43) | `/brand-kit/:id` |
| `brand-profile-delete-button.tsx:60` | Delete profile; `router.replace("/brand-kit")` then refresh | `DELETE /api/brand-profiles/:id` (:49, optional `replacementProfileId`) | `/brand-kit` list |
| `brand-profile-default-button.tsx:26` | "Make default" | `POST /api/brand-profiles/:id/set-default` (:16) | `/brand-kit` + `/brand-kit/:id` |
| `profile-editor.tsx:42` (on 409) and `:47` | Any profile field save (`revision` optimistic concurrency) | `PATCH /api/brand-profiles/:id` (:34) | `/brand-kit/:id` (409 reloads latest revision) |
| `profile-membership.tsx:35` (`useMembershipChange`) | Add/remove assets in profile | `PUT /api/brand-profiles/:id/membership` (:16) | `/brand-kit/:id` |
| `profile-font-roles.tsx:91` | Assign font role | `PUT /api/brand-profiles/:id/membership` (:73) | `/brand-kit/:id` |
| `font-manager.tsx:66` | Delete font | `DELETE /api/brand-fonts/:id` (:64) | `/brand-kit` fonts |
| `font-manager.tsx:227` | Upload font | `POST /api/brand-fonts/presign-upload` (:207), `PUT` presigned URL (:211), `POST /api/brand-fonts` (:217) | `/brand-kit` fonts |
| `brand-kit/[id]/scene-template-manager.tsx:67` | Create/default/delete scene template | `POST|PATCH|DELETE /api/brand-profiles/:id/scene-templates[/:sceneId]` (:63; call sites :78,:130,:162) | `/brand-kit/:id` |
| `template-form.tsx:300` | Save existing style | `updateBrandTemplateAction(id, data)` (:286) | `/brand-kit/styles/:id` (server also `revalidatePath("/brand-kit","layout")`) |

No refresh: `template-form.tsx:270` `createBrandTemplateAction` then `router.push("/brand-kit/styles/:id")`; `template-gallery.tsx:177,211,246` `setDefaultBrandTemplateAction`, `duplicateBrandTemplateAction`, `deleteBrandTemplateAction` rely on server `revalidatePath("/brand-kit","layout")` (duplicate also server-redirects at `style-actions.ts:57`); `template-form.tsx:166,221,238` `GET /api/brand-templates/:id/logo-url`, `POST /api/brand-templates/logo/presign`, `PUT` presigned.

### 5.7 Billing / credits / account

| file:line | Trigger | Call | Refreshes |
| --- | --- | --- | --- |
| `(app)/settings/billing/billing-plans.tsx:345` (in `refreshAfterPlanChange`) | After plan-change confirm | `POST /api/billing/reconcile` (:341; also :424) | `/settings/billing` server props plus local `setView(workspaceBillingViewSchema.parse(...))` |

Everything else in billing is `fetch` into local state or `window.location.assign` to Stripe: `GET /api/billing/state` (:136, polled by `pollBillingActivation`), `POST /api/billing/checkout/return` (:162), `POST /api/billing/checkout` via `postForUrl` (:211-249) -> `assign(url)` (:248), `POST /api/billing/portal` via `postForUrl` (:285) and `(app)/_components/account-menu.tsx:94` -> `assign(body.url)` (:97), `POST /api/billing/plan-change/{preview,confirm}` (:296) -> payment-URL redirects (:362, :411), `POST /api/billing/reconcile` (:424). Idempotency keys at :241,:250,:326.

### 5.8 Settings (API keys, webhooks, automation grants), autopilot, recipes, search

| file:line | Trigger | Mutation | Refreshes |
| --- | --- | --- | --- |
| `(app)/settings/api/create-key-dialog.tsx:55` | Create key | `createApiKeyAction` (:49) | `/settings/api` keys list (secret shown from the action result) |
| `settings/api/api-keys-panel.tsx:68` | Revoke key | `revokeApiKeyAction` (:63) | `/settings/api` |
| `settings/api/callback-secret-panel.tsx:36` | Rotate signing secret | `rotateCallbackSigningSecretAction` (:30) | `/settings/api` |
| `settings/api/add-webhook-dialog.tsx:50` | Add webhook | `createWebhookAction` (:43) | `/settings/api` |
| `settings/api/webhooks-panel.tsx:71` (generic `run()`, also on failure) | Delete (:82), enable (:150), test (:159) | `deleteWebhookAction`, `enableWebhookAction`, `testWebhookAction` | `/settings/api` |
| `settings/automation-grants/grants-panel.tsx:202` | Create or renew grant dialog | `createStandingGrantAction` (:192) / `renewStandingGrantAction` (:191) | `/settings/automation-grants`, `/autopilot` |
| `grants-panel.tsx:364` (generic `run()`, also on failure) | Pause (:469) / revoke (:375) | `pauseStandingGrantAction`, `revokeStandingGrantAction` | Same |
| `(app)/autopilot/autopilot-panel.tsx:473` | Rule created | `POST /api/autopilot/rules` (:442) | `/autopilot` rules |
| `autopilot-panel.tsx:498` | Pause/resume | `PATCH /api/autopilot/rules/:id` (:479) | `/autopilot` |
| `autopilot-panel.tsx:522` | Take over | `POST .../rules/:id/take-over` (:505) | `/autopilot` |
| `autopilot-panel.tsx:546` | Run now | `POST .../rules/:id/run-now` (:529) | `/autopilot` |
| `autopilot-panel.tsx:577` | Delete rule | `DELETE .../rules/:id` (:560) | `/autopilot` |
| `autopilot-panel.tsx:1124` | Edit dialog saved | `PATCH .../rules/:id` (:1173) | `/autopilot` |
| `autopilot/zoom-connections.tsx:23` | Disconnect Zoom | `DELETE /api/zoom/connections/:id` (:21) | `/autopilot` (connections; rules pause) |
| `(app)/recipes/recipes-panel.tsx:101` (`refresh` helper; invoked :115 after duplicate/delete, :286 after save) | Duplicate / delete / create / edit | `POST /api/recipes/:id/duplicate` (:107), `DELETE /api/recipes/:id` (:108), `PATCH /api/recipes/:id` (:369), `POST /api/recipes` (:379) | `/recipes` |

No refresh: `integrations/mcp/confirm/page.tsx:39` form with `confirmMcpPublication` (server `redirect(...)`); `settings/api/api-quickstart.tsx:20` is only a code snippet; `(app)/_components/global-search.tsx:187` `GET /api/workspace/search?q=` and `(app)/search/library-search.tsx:66` `GET /api/library/search?q=` read into local state.

### 5.9 Exports and public review

| file:line | Trigger | Call | Refreshes |
| --- | --- | --- | --- |
| `projects/[projectId]/clips/[clipId]/exports/[exportId]/export-delivery-client.tsx:138-195` (`refresh`, no `router.refresh`) | SSE `clip_rendering` stage events (:155), 10 s interval fallback, 5 s after SSE error, visibilitychange | `GET /api/projects/:p/clips/:c/exports/:id` (:138) | Local `data` snapshot |
| `export-delivery-client.tsx:232,265,281,301` | Create/revoke share link, retry, and a fourth action at :301 | `POST|DELETE .../exports/:id/share-links`, `POST .../retry` | Local (calls `refresh()`) |
| `(app)/exports/page.tsx:146` | Retry on workspace exports list | `AuthenticatedActionForm` + `retryWorkspaceExportAction` (server `revalidatePath("/exports")`) | `/exports` |
| `app/review/[token]/review-client.tsx:156,180,200` (public, token auth, no Clerk) | Load; grant access (`POST .../access`); comments `POST|PATCH|DELETE comments[/:id]` (:223,:241,:624,:646); `POST decision` (:251) | `/api/review/:token/**` (served by `app/api/review/[token]/[[...review]]/route.ts`) | Local state; no router |

### 5.10 Implicit refresh via `revalidatePath` in server actions (disappears with the actions)

| Action file | Paths revalidated |
| --- | --- |
| `(app)/_actions/workspace.ts:16` | `/` (layout) |
| `(app)/settings/actions.ts:71-72,84-85,102,135,173,190,218,253,283,293,303` | `/` (layout), `/settings/workspace`, `/performance`, `/settings/members`, `/settings/api` |
| `(app)/settings/automation-grants/actions.ts:10-11` | `/settings/automation-grants`, `/autopilot` |
| `(app)/settings/workspace/censor-words-actions.ts:14` | `/settings/workspace` |
| `(app)/brand-kit/style-actions.ts:20,31,39,46,56` | `/brand-kit` (layout); `duplicateBrandTemplateAction` also `redirect("/brand-kit/styles/:id")` (:57) |
| `(app)/calendar/actions.ts:16` | `/calendar` |
| `(app)/calendar/queue/actions.ts:17-18` | `/calendar/queue`, `/calendar` |
| `(app)/exports/actions.ts:12` | `/exports` |
| `(app)/projects/actions.ts:62,100,113,152,176,182,217,238,244,267,319,400` | `/projects`, `/projects/:id`; `redirect("/projects/:id")` (:47) and `redirect("/projects")` (:401) |
| `(app)/upload/actions.ts:137,174,224,264,347` | `/projects/:id` |
| `(app)/integrations/mcp/confirm/actions.ts:27-29` | `redirect(...)` only |
| `invite/[token]/actions.ts:36` | `redirect("/home")` only |

Total `revalidatePath` call sites: 40 in 10 files (`grep -rn revalidatePath app lib`).

### 5.11 Server-action call sites by client component

Legend: R = followed by `router.refresh()`; L = local state only; N = `router.push|replace` / `location` navigation; RP = relies on server `revalidatePath`.

- Workspace: `app-chrome.tsx:77` R; `workspace-switcher.tsx:51` R; `workspace-mismatch-notice.tsx:49` N+R; `workspace-unavailable/open-workspace-button.tsx:25` N; `integrations/mcp/workspace-billing-link.tsx:27` N; `workspaces/new/create-workspace-form.tsx:25` N (`location.assign`); `invite/[token]/invite-view.tsx:102` server redirect.
- Members: `members-panel.tsx:143,164,181,207,219` R x5.
- Settings: `workspace/page.tsx:57,77` RP; `censor-words-card.tsx:93-94` RP; `api/create-key-dialog.tsx:49`, `api-keys-panel.tsx:63`, `callback-secret-panel.tsx:30`, `add-webhook-dialog.tsx:43`, `webhooks-panel.tsx:82,150,159` all R; `automation-grants/grants-panel.tsx:191,192,375,469` R.
- Projects: `projects-header-actions.tsx:32` R; `folders-panel.tsx:42,67,86` R; `projects-explorer.tsx:100` R; `delete-project-button.tsx:62` server redirect; `project-brand-picker.tsx:55` optimistic + RP; `processing-panel.tsx:299` optimistic L, `:449,:487` and `page.tsx:869,940` RP (queueTranscription, regenerateClips); `render-clips-button.tsx:484` R; `retry-import-band.tsx:54` R.
- Upload: `upload-shell.tsx:702` N+R; `commit-step.tsx:205,304,309` L/N; `configure-step.tsx:105,165,185` L/N.
- Publishing: `calendar/page.tsx:415` RP; `proposals-inbox.tsx:94,240,263,276,290,325` R; `posting-schedule-editor.tsx:59` R; `publishing-provider.tsx:615` L.
- Brand kit: `template-form.tsx:270` N, `:286` R; `template-gallery.tsx:177,211,246` RP.
- Exports: `exports/page.tsx:146` RP. MCP: `integrations/mcp/confirm/page.tsx:39` server redirect.
- Studio props: `studio/page.tsx:322-323` censor word list (L), plus the 6 inline closures.

Never called from a client (dead exports to drop rather than port): `renderClipsFormAction`, `queueGenerationFormAction` (alias of `queueTranscriptionFormAction`) in `projects/actions.ts`.

### 5.12 Workflow-stream consumers (all use `GET /api/stream/:projectId?sinceSeq=`)

Helpers: `lib/workflow-stream.ts` and `lib/workflow-stream-reauthorization.ts` are server-side (imported only by `app/api/stream/[projectId]/route.ts:21,25`). `lib/workflow-stream-authorization.ts` is client-side: `parseWorkflowAuthorizationControl`, `recoverFromWorkflowAuthorizationLoss` (`authentication_required` -> `window.location.assign(authEntryHref("sign-in", dest))`, else `window.location.reload()`). Event names handled: `workflow.stage.updated` and `authorization.revoked`.

| Consumer | Connects when | What it does with events |
| --- | --- | --- |
| `projects/[projectId]/project-events-provider.tsx:143` (`ProjectEventsProvider`, mounted once at `projects/[projectId]/page.tsx:500`) | Page mount; effect re-keys on `projectId`/`initialSeq` (a new `initialSeq` arrives with every `router.refresh()`) | Parses with `parseWorkflowEventMessage`, dedups by `workflowEventRowIdentity`, keeps `events` (cap `PROJECT_EVENT_ROW_LIMIT`) and `latestByStage` in context; terminal event -> immediate `router.refresh()` (once per terminal identity); other events -> `scheduleIncrementalRefresh` (5 s throttle with trailing call); `authorization.revoked` -> recover or `router.refresh()` |
| `pipeline-stepper.tsx:32`, `processing-panel.tsx:367`, `project-events.tsx:210` | via `useProjectEvents()` context | Read `latestByStage` (stepper, checklist) or `events` (Activity tab); no connection of their own |
| `projects/[projectId]/clips/[clipId]/exports/[exportId]/export-delivery-client.tsx:155` | While `data.status` is active (`ACTIVE_STATUSES`) | Only `clip_rendering` stage events trigger `refresh()` (GET export snapshot into local state); tracks `lastSeqRef`; `onerror` closes and falls back to 5 s polling; 10 s fallback interval always on while active; `authorization.revoked` -> recover |
| `upload/_lib/use-ingest-stream.ts:62` (`useIngestStream`, used by `upload/_components/configure-step.tsx:66`) | Mount while `initial.ingestStatus` is not `ready`/`failed`; re-keys on `initial.ingestStatus`; closes on first terminal ingest event | Maps `ingest_queued/downloading/normalizing/ready` and `failed` to local `IngestStreamState`; `authorization.revoked` -> recover or `window.location.reload()` |

React Query implication: one shared stream hook per project that (a) updates a project-events cache, (b) invalidates project detail / clips / exports narrowly on terminal events and throttled on incremental ones, and (c) is reused by export delivery and ingest. The `initialSeq` handshake (server page passes the latest seq so the stream resumes with no overlap) has to become `sinceSeq` derived from cached events. `EventSource` cannot send an `Authorization` header, so the brief's `fetch` + `eventsource-parser` approach is required for Bearer auth.

### 5.13 `window.location` reloads and assigns (non-router refresh)

| file:line | Behavior |
| --- | --- |
| `lib/workflow-stream-authorization.ts:36,41` | `assign(sign-in href)` or `reload()` on revoked stream authorization |
| `upload/_lib/use-ingest-stream.ts:101` | `reload()` on unparsable revoke control |
| `export-delivery-client.tsx:182` | `reload()` on unparsable revoke control |
| `studio/_components/studio-shell.tsx:2004` | `reload()` after "Reset to original" |
| `app/sso-callback/[[...sso-callback]]/page.tsx:25` | "Try again" `reload()` |
| `workspaces/new/create-workspace-form.tsx:28` | `assign(checkoutUrl)` (Stripe) |
| `(app)/_components/account-menu.tsx:97` | `assign(portal url)` |
| `settings/billing/billing-plans.tsx:248,285,362,411` | `assign(checkout/portal/payment url)` |
| `projects/[projectId]/transcript-panel.tsx:415` | `assign(/api/.../transcript/export?...)` download |
| `projects/[projectId]/dubbing-panel.tsx:353` | `assign(downloadUrl)` |

### 5.14 Non-app `fetch` sites

| file:line | Call | Disposition |
| --- | --- | --- |
| `(docs)/_components/search/search-dialog.tsx:32` | `GET /api/docs/search?query=` | Docs; stays in web with `app/api/docs/search/route.ts` unless the owner moves docs search |
| `(docs)/_components/page/copy-page-menu.tsx:45` | `GET <markdownPath>` (`/docs-markdown/...`) | Docs; stays in web |
| `(docs)/_components/api/playground.tsx:86` | `fetch(request.url)` against the public REST API (user-supplied key) | Docs; needs the API's public base URL from config rather than same-origin `/api` |
| `(docs)/_components/api/snippets.ts:164,216` | Generated code strings only | No runtime fetch |
| `(app)/upload/actions.ts:94` | Server-side `fetch(oembedUrl)` | Moves with `fetchYoutubeMetadataAction` |

### 5.15 Surprises worth flagging

1. `components/` does not exist in `apps/web`; UI lives in `app/**/_components` and `@narriflow/ui`. Only `lib/clip-media.ts:115` (`clipFileDownloadPath`) and `lib/workflow-stream-authorization.ts` build client-side API/redirect behavior in `lib/`.
2. `renderClipsFormAction` and `queueGenerationFormAction` have no callers.
3. Several handlers call `router.refresh()` even on failure (`members-panel.tsx:211,223`, `proposals-inbox.tsx:201`, `posting-schedule-editor.tsx:65`, `webhooks-panel.tsx:71`, `grants-panel.tsx:364`); the React Query version should invalidate in `onSettled`.
4. `moveProjectToFolderAction` is called per project from `projects-explorer.tsx:100` for bulk moves (N sequential round trips); a single bulk endpoint is better.
5. Cookie-only mechanisms that break on a separate API origin: `EventSource` (no headers), `<a href="/api/...">` downloads and `<video src>` (5.3), OAuth start links (5.5), `waveform-peaks.ts:51` (`credentials:"same-origin"`), `upload-picker.tsx:37` (`/mcp/...` same-origin), `fetch keepalive` on unload.
6. Poll loops that become `refetchInterval` or stream-driven invalidations: `finishing-auto-refresh.tsx` (15 s), `calendar-live-refresh.tsx` (adaptive), `projects-explorer.tsx` (visible-only, also re-fetches loaded extra pages), `generated-images-panel.tsx:215` (2.5 s), `billing-plans.tsx` (`pollBillingActivation`), `export-delivery-client.tsx` (5/10 s fallback).
7. Presigned storage uploads (`PUT` straight to R2) at `workspace-avatar-control.tsx:35`, `font-manager.tsx:211`, `template-form.tsx:238`, `audio-upload.ts:84`, `publishing-cover.tsx:262`, and parts in `upload-session-browser.ts:442/506` must stay direct to storage and carry no API credentials.
8. Three client modules cache module-level fetch promises (`trim-transcript-cache.ts`, `edit-clip-length-dialog.tsx:82`, `previewCache` in `clip-media.ts`); they map onto React Query but need `staleTime` parity.

## 6. Externally registered and externally linked URLs

"Base" means the canonical web origin today (`NEXT_PUBLIC_APP_URL`, e.g. `https://app.narriflow.com`). "Registered" = typed into a provider dashboard (changing it needs a human step); "runtime" = generated by code per request or per send.

Origin resolution today (all pull from the web origin):

| Resolver | file:line | Behavior | Consumers |
|---|---|---|---|
| `resolveCanonicalAppOrigin({configuredOrigin, environment, requestUrl})` | `apps/web/lib/safe-redirect.ts:80` | Returns `NEXT_PUBLIC_APP_URL` (must be a bare origin) or, in `NODE_ENV=development` only, the loopback request origin; throws `AppOriginConfigurationError` otherwise | `getOAuthOrigin` (`apps/web/app/api/[[...route]]/route.ts:228`), `workspaces/new/actions.ts:102` |
| `getOAuthOrigin(requestUrl)` | `apps/web/app/api/[[...route]]/route.ts:228` | Wraps the above with `process.env.NEXT_PUBLIC_APP_URL` + `NODE_ENV` | social OAuth start/callback (route.ts:1489,1531), Zoom start/callback (`zoom-http.ts:28-30`), workspace billing checkout + portal (`route.ts:175` -> `workspace-billing-routes.ts:91,126`) |
| `inviteUrl(token)` | `apps/web/app/(app)/settings/actions.ts:28` | `NEXT_PUBLIC_APP_URL` (trailing slash trimmed, else `http://localhost:3000`) + `/invite/<token>` | invite email (`deliverWorkspaceInvite`, `sendEmail`) |
| REST v1 `appOrigin` | `apps/web/app/api/v1/[[...route]]/route.ts:13`, `apps/web/lib/rest-api/app.ts:104,154` | `NEXT_PUBLIC_APP_URL ?? http://localhost:3000`; builds `reviewUrl`, `statusUrl` (`/api/v1/operations/:id`), `queueUrl` in responses (app.ts:241,273,360,373,389,415,446,454,482) | every v1 response carrying a link |
| `PUBLIC_API_ORIGIN` | `apps/web/lib/rest-api/public-openapi.ts:5` | Hard-coded `https://app.narriflow.com`, used for the OpenAPI document rendered in docs | docs API reference (stays in web, but must point at the API origin) |
| MCP `appOrigin` | `packages/mcp-core/src/index.ts:38`, `mcp-tasks.ts:117` | `options.appOrigin ?? NEXT_PUBLIC_APP_URL ?? http://localhost:3000` | MCP tool payload `reviewUrl`/`handoffUrl`/`queueUrl`/`composerUrl` (index.ts:78-207), MCP Apps CSP + `data-app-origin` (`mcp-apps.ts:42-52`, `mcp-apps/v2/document.ts:14`) |
| MCP resource URLs | `apps/web/lib/mcp-auth.ts:17-41` | `NEXT_PUBLIC_APP_URL` (required in production, HTTPS) + `/mcp`, `/.well-known/oauth-protected-resource/mcp`; issuer = `CLERK_OAUTH_ISSUER` | `/mcp` handler, `.well-known` documents |
| Worker base URL | `apps/worker/src/notifications.ts:42` | `WORKER_APP_BASE_URL` (a separate var from `NEXT_PUBLIC_APP_URL`; localhost fallback outside production, notification skipped in production if missing) | all worker-built emails |
| `docs/site.ts` ORIGIN | `apps/web/lib/docs/site.ts:5` | `NEXT_PUBLIC_APP_URL` | llms.txt, docs markdown (stays in web) |
| layout `metadataBase` | `apps/web/app/layout.tsx:19` | `NEXT_PUBLIC_APP_URL` | web only |
| `auth/continue` origin | `apps/web/app/auth/continue/page.tsx:18` | request Host/proto or `NEXT_PUBLIC_APP_URL`; passes `CLERK_OAUTH_ISSUER` and `CLERK_OAUTH_CONSENT_ORIGIN` to `resolvePostAuthRedirect` (`lib/post-auth-redirect.ts:1`) | web only (post-auth redirect) |
| Connector page / MCP settings / API settings pages | `(marketing)/connector/page.tsx:53`, `(app)/integrations/mcp/page.tsx:36`, `(app)/settings/api/page.tsx:48` | Display `${APP_URL}/mcp` and `${APP_URL}/api/v1` to the user | web pages; after the split these must show the API origin, not the web origin |

### 6.1 Provider-registered inbound URLs (dashboards)

| URL pattern | Caller | Registered where | Source (handler) | Docs that name it | Must change when web != API origin |
|---|---|---|---|---|---|
| `POST {base}/api/webhooks/stripe` | Stripe | Stripe dashboard (event list in `docs/runbooks/workspace-billing.md:48`) | `apps/web/app/api/[[...route]]/stripe-webhook-http.ts:27` (mounted route.ts:107) | workspace-billing runbook | YES: re-register in Stripe at the API origin (secret `STRIPE_WEBHOOK_SECRET`) |
| `POST {base}/api/webhooks/clerk` | Clerk (Svix) | Clerk dashboard webhooks | `apps/web/app/api/webhooks/clerk/route.ts:1` (`POST` at ~line 50, uses `next/headers`, `svix`) | env example | YES: re-register in Clerk (secret `CLERK_WEBHOOK_SECRET`) |
| `POST {base}/api/webhooks/zoom` | Zoom | Zoom Marketplace app event subscription | `zoom-http.ts:13` (mounted route.ts:238) | `docs/runbooks/zoom-autopilot.md:39` | YES: re-register in Zoom |
| `POST {base}/api/webhooks/tiktok/publication` | TikTok | TikTok developer portal (Content Posting webhook) | `apps/web/app/api/[[...route]]/route.ts:132` (uses `TIKTOK_CLIENT_KEY`/`SECRET` at :133-134) | `docs/runbooks/social-publication.md:13,116` | YES: re-register in TikTok |
| `GET {base}/api/social/oauth/callback` (single redirect URI for TikTok, YouTube/Google, Meta, LinkedIn, X) | Provider redirect of the user's browser | Every social provider app's redirect-URI allow-list; the URI string is built at runtime as `callbackUrl(origin)` = `{origin}/api/social/oauth/callback` (`packages/services/src/social-oauth.service.ts:27,102`) | route.ts:1531 (callback), route.ts:1489 (start) | README.md:234,284 | YES, and subtle: the callback lands the user back on `{origin}/settings/social-accounts` (route.ts:1544) or `safeSocialRedirectPath(...)` (a web path). If the API origin differs, `origin` for the callback URL must be the API origin while the final redirect must go to the web origin. Today one `origin` serves both; two origins are needed |
| `GET {base}/api/zoom/oauth/callback` | Zoom redirect | Zoom app redirect URI + allow-list (`docs/runbooks/zoom-autopilot.md:23`); built as `new URL(ZOOM_CALLBACK_PATH, origin)` (`packages/services/src/zoom.service.ts:53,63`, `zoom.ts:6`) and the exact string is persisted in `zoomOAuthState.redirectUri` and compared on return (zoom.service.ts:66) | `zoom-http.ts:29`; success redirect goes to `{origin}/autopilot?zoom=...` | zoom runbook | YES (same two-origin split as social OAuth; the stored redirectUri equality check means in-flight states break across the cutover) |
| `GET {base}/api/zoom/oauth/start`, `GET {base}/api/social/oauth/start/:platform?redirect=` | User browser navigation (full-page link) | Not registered; generated links in the UI | `zoom-http.ts:28`, route.ts:1489 | | YES: the UI link must target the API origin and the API must authenticate a top-level navigation (no Bearer header possible on a link); needs a short-lived signed start token or a POST that returns the provider URL |
| `GET/POST {base}/mcp` (resource), `{base}/mcp/integrations/:workspaceId/*upload` | MCP clients (Claude, Cursor, Codex...), `apps/mcp` stdio upload (`apps/mcp/src/upload.ts:47` builds `{NARRIFLOW_URL}/mcp/integrations/:ws/upload-sessions/{action}`) | User-configured in each client; documented publicly as `https://app.narriflow.com/mcp` (`apps/web/content/docs/ai/*.mdx`, connector page) | `apps/web/app/mcp/route.ts`, `apps/web/app/mcp/integrations/[workspaceId]/[...upload]/route.ts` | docs/ai/*, README.md:42,312 | Depends on the owner decision whether the public MCP URL stays `app.narriflow.com/mcp` (needs a web proxy/rewrite) or moves; the OAuth `resource` audience is the exact `/mcp` URL (`docs/runbooks/mcp-launch-acceptance.md:32`), so changing it re-issues every client token |
| `GET {base}/.well-known/oauth-protected-resource[/mcp]`, `GET {base}/.well-known/oauth-authorization-server` | MCP clients doing OAuth discovery | Discovered, not registered; the resource metadata URL is emitted in `WWW-Authenticate` (`mcp-auth.ts:36`) | `apps/web/app/.well-known/**/route.ts` (3 files; authorization-server proxies Clerk metadata with `next: {revalidate: 3600}`, CORS `*`) | | Must be served at the same origin as the MCP resource |
| Clerk OAuth issuer / consent | Clerk-hosted OAuth server redirects the browser to the web consent flow | Clerk dashboard (OAuth application + `CLERK_OAUTH_CONSENT_ORIGIN`) | `apps/web/app/auth/continue/page.tsx:19`, `lib/post-auth-redirect.ts` | mcp-launch-acceptance runbook | Stays on web |
| Clerk sign-in/up and SSO callback | Clerk redirects | Env `NEXT_PUBLIC_CLERK_SIGN_IN_URL` etc. and `ClerkProvider` props (`apps/web/app/layout.tsx:88`: `/?auth=sign-in`, `/?auth=sign-up`, fallback `/auth/continue`); `redirectUrl` `/sso-callback` (`lib/auth-entry.ts:23`, `_components/auth/auth-form.tsx:175`) | Clerk dashboard allowed redirect URLs | | Stays on web |
| Google Identity / Picker, Dropbox Chooser | Browser | Google Cloud "Authorized JavaScript origins" and API-key HTTP referrers = every origin serving the upload page (`docs/runbooks/cloud-file-pickers.md:75-80`); no redirect URI | `apps/web/app/(app)/upload/page.tsx:149-152` | cloud-file-pickers runbook | No change while the upload UI stays on the web origin |
| R2 presigned PUT/GET | Browser (uploads), worker, providers | R2 bucket CORS allow-list (not in repo; assumed to list the web origin) | `packages/services/src/r2-storage.ts` | | CORS stays on web origin (browser origin is the web page); API origin needs no R2 CORS entry |

### 6.2 Runtime-generated links sent outward

| URL pattern | Who receives it | Built where (file:line) | Base source | Must change |
|---|---|---|---|---|
| `{origin}/invite/<token>` | Invitee (email) | `apps/web/app/(app)/settings/actions.ts:28-31`, sent via `sendEmail` (actions.ts:34+) | `NEXT_PUBLIC_APP_URL` | Web origin: API needs `WEB_APP_URL` (or keep `NEXT_PUBLIC_APP_URL` meaning "web") |
| Stripe Checkout `success_url` = `{returnDestination}?checkout=return&session_id={CHECKOUT_SESSION_ID}`, `cancel_url` = `...checkout=cancelled` | Stripe redirects the user's browser | `packages/services/src/workspace-billing.service.ts:3082-3083` (`returnDestination` = `{origin}/settings/billing` from `workspace-billing-routes.ts:91` and `workspaces/new/actions.ts:113`; stored in the checkout attempt and compared for idempotent replays at :735, :1260) | `getOAuthOrigin`/`resolveCanonicalAppOrigin` | Must be the WEB origin; replay equality check means a changed origin makes old attempts look different |
| Stripe Billing Portal `return_url` = `{origin}/settings/billing` | Stripe | `workspace-billing-routes.ts:126` -> `billing.service.ts:440,771-777` | same | WEB origin |
| `{origin}/projects/:id`, `/projects/:id?tab=publishing|review`, `/projects/:id/clips/:clipId/studio`, `/projects/:id/clips/:clipId/exports/:exportId`, `/integrations/mcp/upload?intent=<token>`, `/calendar/queue` | MCP + REST v1 clients, MCP App UIs | `packages/services/src/integration-commands.ts:432-458`, `packages/mcp-core/src/index.ts:78-207,133,185,188`, `mcp-projections.ts:18,30`, `mcp-apps/v2/app.ts:62-128`, `upload-progress.ts:24`, `apps/web/lib/rest-api/app.ts` (lines above) | `NEXT_PUBLIC_APP_URL` | WEB origin (user-facing pages) |
| `{origin}/api/v1/operations/:id` (`statusUrl`) | REST v1 clients | `apps/web/lib/rest-api/app.ts:241` | `appOrigin()` | API origin |
| Worker emails: `{WORKER_APP_BASE_URL}/projects/:id` (clips ready / failed / no clips / finishing ready), `/settings/billing` (project expiring), `/settings/api#webhooks` (webhook disabled), `/settings/automation-grants` (grant paused) | Workspace members (email) | `apps/worker/src/notifications.ts:77-100,122,149`; `packages/services/src/webhook-subscription-runtime.ts:45`; `standing-grant-runtime.ts:59`; templates in `packages/email/src/templates/*.ts` take the finished URL as `deepLink`/`settingsLink`/`upgradeLink`/`retryLink`/`reviewUrl` (no origin logic in `packages/email`) | `WORKER_APP_BASE_URL` | WEB origin; the worker env stays but must keep pointing at web |
| `{base}/review/<token>` and `{base}/review/opt-out?token=<signed>` | External reviewers (email, copy-link) | Paths built in `packages/services/src/review.service.ts:546,1098` and `review-notification.service.ts:175,179`; absolute URL assembled by the worker (`apps/worker/src/notifications.ts`, review retry loop ~107-160) using `getWorkerAppBaseUrl`; UI copy-link uses `new URL(round.path, window.location.origin)` (`project-share-button.tsx:150`, `review-panel.tsx:385`) | `WORKER_APP_BASE_URL` / `window.location.origin` | WEB origin for the page; `/review/opt-out` is a form POST to itself (`apps/web/app/review/opt-out/route.ts:37`) |
| `{origin}/share/<token>` | Public share-link visitors | Path from `packages/services/src/clip-export.service.ts:941`; origin from `window.location.origin` (`export-delivery-client.tsx:220-241`) | browser origin | WEB origin (page `app/share/[token]/page.tsx` stays) |
| Review guest API `/api/review/<token>[/session|comments|...]` | Reviewer browser (same-origin fetch from `review-client.tsx:119`) | `apps/web/app/api/review/review-guest-http.ts` (cookie `nf_review_<hash12>`, `Path=/api/review/<token>`, `HttpOnly`, `SameSite=Strict`, `Secure` in production, set at :111-118; `assertSameOrigin` compares the `Origin` header to the request URL origin at ~:47) | | Cross-origin by definition once the API moves: SameSite=Strict cookie and same-origin check both break. Either keep `/api/review/*` reverse-proxied through the web origin (`next.config.ts` rewrite) or replace the cookie with a bearer session token held in memory |
| Outbound completion callbacks (REST v1 `callback`) and webhook subscriptions | Customer endpoints | `packages/services/src/completion-callback.ts` (signed with a key derived from `SOCIAL_TOKEN_ENCRYPTION_KEY`, :72), `webhook-subscription-runtime.ts`, sent by the worker | customer-registered URL | No web-origin dependency |
| Outbound `SOCIAL_PUBLISH_WEBHOOK_URL` (assisted posts), signed `X-Narriflow-Signature: sha256=` | Customer receiver | `packages/services/src/social-publication-config.ts:106,127`; README.md:236 | env | None |
| OAuth discovery CORS | Browsers | `Access-Control-Allow-Origin: *` on `.well-known` routes; MCP handler echoes allowed origin (`packages/mcp-core/src/mcp-http.ts:15,36-39`; allow-list from `MCP_ALLOWED_ORIGINS` + resource origin, `mcp-auth.ts:75`) | | Already cross-origin ready |

### 6.3 Other Section 6 findings

| Item | Detail | file:line |
|---|---|---|
| No CORS middleware exists for the internal Hono app | The app is same-origin today; `cors` appears only in `.well-known` routes and the MCP handler. The new API needs an explicit allowlist (web origin(s), Expo dev origins are not needed for native, localhost in dev). | `grep Access-Control` in `apps/web/app`, `packages/mcp-core/src/mcp-http.ts` |
| `proxy.ts` Clerk middleware route lists | Protected API prefixes (`/api/projects`, `/api/upload-sessions`, `/api/ingest`, `/api/stream`, `/api/workspace`, `/api/billing`, `/api/autopilot`, `/api/social`, `/api/zoom`, `/api/brand-templates`, `/api/audio-assets`, `/api/brand-profiles`, `/api/brand-fonts`, `/api/visual-assets`, `/api/generated-media`) and public ones (`/api/health`, `/api/v1`, `/mcp`, `.well-known/oauth-*`). `/api/review`, `/api/webhooks`, `/api/docs/search` are matched by the middleware but not protected. These prefixes are the exact inventory of "internal Hono" top-level groups. | `apps/web/proxy.ts:5-37,57` |
| next.config.ts headers | `/review/:path*` and `/api/review/:path*` get `noindex`, `no-referrer`, `private, no-store` and a strict CSP (`connect-src 'self'` + Clerk); `/integrations/mcp/:path*` gets `no-store`. The global report-only CSP `connect-src` lists `'self'`, Clerk, R2, Upstash, Google; it must add the API origin (and review CSP `connect-src` too) or every `fetch` to the API is blocked in enforcing mode. | `apps/web/next.config.ts:64-140` |
| Health | `GET /api/health` (`{ok: true, service: "narriflow-web-api"}`) public | `route.ts:236` |
| Mobile/other consumers of web URLs | `apps/mcp` stdio uses `NARRIFLOW_URL` (default `http://localhost:3000`) for `/mcp/integrations/...` only; `packages/mcp-core/scripts/e2e-clients.ts` uses `MCP_E2E_BASE_URL` | `apps/mcp/src/upload.ts:136`, e2e script:75 |
| Worker does not call the web app | No `fetch` from `apps/worker` to the web origin; it only builds URLs for emails (above). | grep of `apps/worker/src` |

---

## 7. Next-specific dependencies inside non-page code

Scope: `apps/web/lib/**` and `apps/web/proxy.ts`, every non-test `packages/**` file, plus route-handler modules under `apps/web/app/api`, `app/mcp`, `app/.well-known` that the API will absorb. Test files and `*.fixture.ts` excluded (`authenticated-request-policy.server.ts`, `auth-flow.ts` fixtures still must be rewritten; see section 2).

### 7.1 `apps/web/lib/**` and `proxy.ts` (7 files)

| file:line | Symbol | Used for | Replacement in Hono/Bun API |
|---|---|---|---|
| `apps/web/lib/authenticated-request-policy.server.ts:1` | `import "server-only"` | Marks the Browser Actor resolver server-only | Drop (Bun process); keep file as plain module, rename `.server` suffix is optional |
| `.../authenticated-request-policy.server.ts:4,60,62` | `cache` from `react` | Per-request memoization of `resolveBrowserActorScope` and `resolveBrowserSignedInActorScope` (two exports wrapped) | Per-request memo on the Hono context (`c.get/c.set`) or compute once in an auth middleware; no module-level `cache` |
| `.../authenticated-request-policy.server.ts:5,86` | `unstable_rethrow` from `next/navigation` | `rethrowFrameworkControlFlow` so Next redirect/notFound errors are not swallowed by the policy's catch | Remove; Hono has no control-flow exceptions (use `HTTPException` / returned responses) |
| `apps/web/lib/authenticated-request-page.ts:1,4` | `server-only`; `notFound`, `redirect` from `next/navigation` | `admit*Page` helpers: sign-in redirect (line 25), `project_not_found` -> `notFound()` (27), restricted-workspace redirects (31, 43) | Not portable. Replace with typed API errors (`unauthenticated`, `project_not_found`, `workspace_restricted`) and client route guards in web (section 2) |
| `apps/web/lib/authenticated-request-action.ts:1` | `server-only` | Server-action wrapper (`AuthenticatedActionForm` support) | Delete with the actions; API uses Hono middleware instead |
| `apps/web/lib/mcp-auth.ts:1` | `server-only` (also uses `process.env` at :18, :52, :91) | MCP token verifier, allowed hosts/origins, resource metadata | Move to `apps/api` unchanged except drop the import; `CLERK_SECRET_KEY` read stays |
| `apps/web/lib/env.ts:1` | `server-only` | `validateCoreEnv` (called from `app/layout.tsx`), `validateWebhookEnv` (Clerk webhook route) | Replace with a startup env check in `apps/api` (fail fast at boot instead of per render) |
| `apps/web/lib/auth-flow.ts:1` | type-only `useSignIn`, `useSignUp` from `@clerk/nextjs` | Types for the sign-in/up UI flow | Stays in web (client UI) |
| `apps/web/proxy.ts:1-2` | `clerkMiddleware`, `createRouteMatcher` from `@clerk/nextjs/server`; `NextResponse` from `next/server` | Page protection (`auth.protect`, redirect to `authEntryHref("sign-in", ...)`), API 401 JSON for protected `/api/*` prefixes, `/?auth=` redirect for signed-in users | Page protection stays in web (client guards plus a slimmer middleware if desired). API-side: `@clerk/backend` `authenticateRequest` in a Hono middleware returning 401 JSON; the `/api/*` protected-prefix list goes away because every non-public API route is protected by default |

### 7.2 `packages/**` non-test code

| file:line | Symbol | Used for | Replacement |
|---|---|---|---|
| `packages/auth/src/index.ts:1` | `import "server-only"` | Whole module is server-only | Drop |
| `packages/auth/src/index.ts:3` | `auth`, `clerkClient`, `currentUser`, `type UserJSON` from `@clerk/nextjs/server` | `auth()` at :709 (session userId in `getCurrentAppUser`), `clerkClient()` at :688 (look up/update Clerk user), `currentUser()` at :726, :735 (user sync when the row is stale or missing), `UserJSON` type for `syncClerkUserPayload` (:323) | `@clerk/backend`: `createClerkClient({secretKey})`, `authenticateRequest(request)` -> `toAuth().userId`; `clerk.users.getUser(userId)` replaces `currentUser()`; `UserJSON` type from `@clerk/backend` (also used by the Clerk webhook route, `apps/web/app/api/webhooks/clerk/route.ts:2`) |
| `packages/auth/src/index.ts:4` | `isClerkAPIResponseError` from `@clerk/nextjs/errors` (used :693) | 404 detection when Clerk user is gone | `isClerkAPIResponseError` from `@clerk/backend/errors` |
| `packages/auth/src/index.ts:6,556,657` | `cookies` from `next/headers` | Active-workspace cookie `narriflow_active_workspace` (const :20): `getWorkspaceContextForUser` reads it (:556), `setActiveWorkspaceForActor` writes it httpOnly/lax/secure-in-prod/1 year/path `/` (:657-664, `NODE_ENV` read at :661) | Remove ambient cookie access. Accept an explicit workspace selector (e.g. `X-Workspace-Id` header) validated against membership; keep the cookie only on web if at all. `getWorkspaceContextForUser(user)` and `setActiveWorkspaceForActor` need an explicit `requestedWorkspaceId` parameter. Functions that call ambient `auth()`: `getCurrentAppUser` (:708), `requireCurrentAppUser` (:744), `listCurrentUserWorkspaces` (:640) |
| `packages/email/src/index.ts:1` | `import "server-only"` | Marks mail module server-only | Drop (note `packages/email/src/mailer.ts`, `worker.ts` are plain; `relayClerkEmail` is called by the Clerk webhook route) |
| `packages/ui/src/provider.tsx:6` | `useServerInsertedHTML` from `next/navigation` | Chakra emotion SSR style injection | Stays in web; the API must not import `@narriflow/ui` |
| `packages/ui/src/components/nav-link.tsx:3-4` | `Link` from `next/link`; `usePathname` from `next/navigation` | Active-link component | Stays in web |
| `packages/services`, `packages/db`, `packages/validators`, `packages/composition-plan`, `packages/mcp-core`, `packages/config`, `packages/caption-fonts` | none | No `next/*`, `@clerk/nextjs*`, `server-only` or `react` imports (grep). `packages/validators/src/caption-font.ts:4` mentions `next/font/local` only in a comment. `packages/mcp-core/src/mcp-apps/v2/*.ts` is browser DOM code for the MCP App iframe, not React. | Ready to be loaded by the API as-is |
| `packages/*/package.json` | `@clerk/nextjs ^6.39.5` and `next 16.3.6` in `packages/auth`; `react`, `react-dom`, `next ^16.3.6` in `packages/ui`; none in the other packages | Dependency declarations the API would inherit via `@narriflow/auth` | Replace `@clerk/nextjs` with `@clerk/backend`; drop `next` from `packages/auth` |

### 7.3 Route-handler modules the API will absorb (outside `lib/`, for completeness)

| file:line | Symbol | Used for | Replacement |
|---|---|---|---|
| `apps/web/app/api/review/review-guest-http.ts:1` | `NextRequest`, `NextResponse` from `next/server` | Guest review routes: `NextResponse.json`, `response.cookies.set(...)` (:111), `new NextRequest(request).cookies.get(...)` (~:121) | Hono: `c.json`, `hono/cookie` `setCookie`/`getCookie` |
| `apps/web/app/api/webhooks/clerk/route.ts:1-2` | `headers` from `next/headers`; `UserJSON` type from `@clerk/nextjs/server`; also `export const runtime = "nodejs"` | Reads svix headers | `c.req.header(...)`; `@clerk/backend` types; drop `runtime` export |
| `apps/web/app/.well-known/oauth-authorization-server/route.ts:14` | `fetch(..., { next: { revalidate: 3600 } })` | Caches Clerk AS metadata for an hour | In-process TTL cache or `Cache-Control`; `next` fetch option does not exist outside Next |
| `apps/web/app/mcp/route.ts:12-13`, stream route, other route files | `export const runtime/dynamic/maxDuration` | Next route config | Delete; set `Bun.serve` idle timeout for long-lived stream (`idleTimeout`) and MCP |
| Web-only (stay) | `app/review/[token]/page.tsx:1` (`Metadata`), `app/share/[token]/*` (`next/link`, `next/navigation`) | UI | Stay in web |

---

## 8. Environment variables

Method: `grep process.env.X` in `apps/web` (non-test, excluding `.next`/`node_modules`) and in the packages the API will load, plus dynamic reads (`process.env[name]`, `environment: NodeJS.ProcessEnv = process.env` defaults). `apps/web/lib/env.ts` only validates (`DATABASE_URL`, `CLERK_SECRET_KEY`, `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_PUBLISHABLE_KEY` in `validateCoreEnv`; `CLERK_WEBHOOK_SECRET`, `RESEND_API_KEY`, `NARRIFLOW_EMAIL_FROM` in `validateWebhookEnv`). `packages/config` has zero env reads. The reference template is `apps/web/.env.example` (116 lines).

Side key: API = read only by code that moves to `apps/api`; UI = read only by code that stays in web (client or server-rendered UI); both = both sides need it (value must be provisioned in both services).

### 8.1 Read directly in `apps/web`

| Var | file:line (reads) | Side | Notes |
|---|---|---|---|
| `NEXT_PUBLIC_APP_URL` | `app/layout.tsx:19`; `lib/docs/site.ts:5`; `(marketing)/connector/page.tsx:53`; `(app)/integrations/mcp/page.tsx:36,37`; `(app)/settings/api/page.tsx:48`; `app/auth/continue/page.tsx:18`; `(app)/settings/actions.ts:29`; `workspaces/new/actions.ts:103`; `app/api/[[...route]]/route.ts:230`; `app/api/v1/[[...route]]/route.ts:13`; `lib/mcp-auth.ts:17,33,39` (via `requiredUrl`); also `packages/mcp-core/src/index.ts:38`, `mcp-tasks.ts:117` | both | Public, not secret. Today means "the one origin". After the split, web keeps it as the web origin; the API needs the web origin (for redirects, invite and checkout return links, review links) and its own origin (for `/mcp` resource URL, `statusUrl`, OAuth callback). Recommend two explicit vars: `WEB_APP_URL` and `API_PUBLIC_URL`; `mcp-auth.ts` and `resolveCanonicalAppOrigin` need both |
| `NODE_ENV` | `next.config.ts:5`; `studio/page.tsx:43`; `studio/_components/tool-panels/censor-panel.tsx:178`; `(home)/_components/landing-shell.tsx:34`; `app/prototype/{ui-kit,dashboard,caption-parity}/page.tsx` (notFound in production); `workspaces/new/actions.ts:104`; `app/api/review/review-guest-http.ts:116` (cookie `secure`); `app/api/[[...route]]/route.ts:231`; `lib/mcp-auth.ts:20,26,67`; `packages/auth/src/index.ts:661`; `packages/services/src/upload-session.service.ts:168` | both | `development` gates localhost origin fallback (`safe-redirect.ts:92`), localhost MCP hosts, cookie Secure flag |
| `CLERK_SECRET_KEY` | `lib/mcp-auth.ts:91`; implicit in `@clerk/nextjs` (middleware, `auth()`, `clerkClient`); `lib/env.ts:6` check | both | Secret. Web keeps it only if web keeps Clerk middleware/page guards; the API always needs it (`@clerk/backend`, OAuth token verification at `api.clerk.com`, `packages/mcp-core/src/mcp-auth.ts:60-64`) |
| `CLERK_PUBLISHABLE_KEY`, `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | only `lib/env.ts:7-8` (validation) + implicit in Clerk SDKs | both | Public. API needs `CLERK_PUBLISHABLE_KEY` for `authenticateRequest`; web needs the `NEXT_PUBLIC_` one for `ClerkProvider` |
| `NEXT_PUBLIC_CLERK_SIGN_IN_URL`, `..._SIGN_UP_URL`, `..._SIGN_IN_FALLBACK_REDIRECT_URL`, `..._SIGN_UP_FALLBACK_REDIRECT_URL` | not read in code (`ClerkProvider` props hard-coded at `layout.tsx:88`); present in `.env.example` | UI | Read implicitly by Clerk SDK; web only |
| `CLERK_WEBHOOK_SECRET` | `app/api/webhooks/clerk/route.ts:22`; `lib/env.ts:10` | API | Secret, moves with the webhook |
| `CLERK_OAUTH_ISSUER` | `lib/mcp-auth.ts:17,44`; `(app)/integrations/mcp/page.tsx:37`; `app/auth/continue/page.tsx:19` | both | Public URL. API: MCP metadata. Web: post-auth redirect validation |
| `CLERK_OAUTH_CONSENT_ORIGIN` | `app/auth/continue/page.tsx:19` | UI | Web only |
| `MCP_ALLOWED_HOSTS`, `MCP_ALLOWED_ORIGINS` | `lib/mcp-auth.ts:52` (dynamic `process.env[name]`; `MCP_ALLOWED_ORIGINS` also :76) | API | Comma lists |
| `MCP_CONTINUATION_SECRET` | `(app)/integrations/mcp/page.tsx:37` (presence flag passed to `inspectMcpConfiguration`); `packages/mcp-core/src/mcp-confirmation.ts:59` | both today | Secret. The page only checks presence: replace with an API field. API only afterwards |
| `REVIEW_SESSION_SECRET` | `app/api/review/review-guest-http.ts:37` (>= 32 chars); `packages/services/src/review.service.ts:173` (falls back from `REVIEW_ACCESS_SECRET`) | API | Secret |
| `REVIEW_ACCESS_SECRET` | `packages/services/src/review.service.ts:173`; worker review emails decrypt delivery tokens | both (API and worker) | Secret; must match across API and worker |
| `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET` | `app/api/[[...route]]/route.ts:133-134`; `social-oauth.service.ts:759,863` | API | Secret (webhook signature + OAuth) |
| `UPSTASH_REDIS_URL` | `app/api/stream/[projectId]/route.ts:92`; `packages/services/src/{workflow.service.ts:14, rate-limit.ts:26, pexels.service.ts:171}` | both (API + worker) | Secret (URL contains token). `UPSTASH_REDIS_TOKEN` is in `.env.example` but never read via `process.env.UPSTASH_REDIS_TOKEN` (ioredis uses the URL) |
| `NEXT_PUBLIC_GOOGLE_API_KEY`, `NEXT_PUBLIC_GOOGLE_CLIENT_ID`, `NEXT_PUBLIC_GOOGLE_APP_ID`, `NEXT_PUBLIC_DROPBOX_APP_KEY` | `(app)/upload/page.tsx:149-152` (passed to client via props); `(app)/upload/_lib/source-pickers.ts:9-21` (type + trim); `packages/services/src/drive-source.ts:204` reads `NEXT_PUBLIC_GOOGLE_CLIENT_ID` | UI (+ API for Drive) | Public. Web inlines them at build; API needs `NEXT_PUBLIC_GOOGLE_CLIENT_ID` only if `drive-source.ts` token verification stays server-side |
| `NARRIFLOW_API_KEY` | `(app)/settings/api/api-quickstart.tsx:20`; `(docs)/_components/api/snippets.ts:173` | UI | Appears only as text inside generated code snippets (documentation string), not a real read |
| `AUTHENTICATED_REQUEST_POLICY_TEST_DATABASE_URL`, `..._TEST_DATABASE_SCHEMA`, `..._TEST_KEEP_SCHEMA`, `DATABASE_URL`, `DIRECT_URL` | `scripts/run-authenticated-request-policy-db-tests.ts` | test tooling | Moves with that gate to `apps/api` |

Total distinct `process.env.X` names read directly in `apps/web` runtime code: 21 (`NEXT_PUBLIC_APP_URL`, `NODE_ENV`, `CLERK_SECRET_KEY` (1 direct), `CLERK_WEBHOOK_SECRET`, `CLERK_OAUTH_ISSUER`, `CLERK_OAUTH_CONSENT_ORIGIN`, `MCP_ALLOWED_ORIGINS`, `MCP_ALLOWED_HOSTS` (dynamic), `MCP_CONTINUATION_SECRET`, `REVIEW_SESSION_SECRET`, `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET`, `UPSTASH_REDIS_URL`, 4x `NEXT_PUBLIC_GOOGLE_*`/`DROPBOX`, `NARRIFLOW_API_KEY`) plus the 4 validated Clerk keys in `lib/env.ts`.

### 8.2 Read inside packages the API will load

| Package | Vars (first file:line) | Side |
|---|---|---|
| `packages/db` | `DATABASE_URL` (`src/client.ts:10`); `DIRECT_URL` is preferred by Prisma config/CLI | API + worker; Secret |
| `packages/auth` | `NODE_ENV` (`src/index.ts:661`); Clerk keys implicit via SDK | API |
| `packages/email` | `RESEND_API_KEY` (`src/mailer.ts:33`), `NARRIFLOW_EMAIL_FROM` (`mailer.ts:47`); `notification.service.ts:464` re-reads `RESEND_API_KEY` | API (invites, Clerk email relay) + worker |
| `packages/mcp-core` | `MCP_CONTINUATION_SECRET` (`mcp-confirmation.ts:59`), `NEXT_PUBLIC_APP_URL` (`index.ts:38`, `mcp-tasks.ts:117`), `R2_ACCOUNT_ID`, `R2_BUCKET` (`mcp-apps.ts:43-44`, CSP only); dev-only scripts `MCP_E2E_*` | API |
| `packages/validators`, `packages/composition-plan`, `packages/config` | none | n/a |
| `packages/services` storage | `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` (`r2-storage.ts:262-265`), `R2_MULTIPART_CONCURRENCY` (:201), `R2_INCOMPLETE_MULTIPART_LIFECYCLE_DAYS` (`upload-session.service.ts:165`) | API + worker; Secret |
| `packages/services` upload sessions | `UPLOAD_SINGLE_PUT_THRESHOLD_BYTES`, `UPLOAD_MULTIPART_PART_SIZE_BYTES`, `UPLOAD_MULTIPART_CONCURRENCY`, `UPLOAD_MAXIMUM_MULTIPART_PARTS`, `UPLOAD_MAXIMUM_GRANT_PARTS`, `UPLOAD_GRANT_TTL_SECONDS`, `UPLOAD_SESSION_IDLE_MS`, `UPLOAD_SESSION_HARD_LIFETIME_MS`, `UPLOAD_RECONCILIATION_*` (9 vars) (`upload-session.service.ts:3089-3179`) | tuning, optional with defaults; API + worker |
| `packages/services` billing | `STRIPE_SECRET_KEY` (`billing.service.ts:120,228`), `STRIPE_WEBHOOK_SECRET` (:213), `STRIPE_PORTAL_CONFIGURATION_ID` (:218), `STRIPE_PRICE_{CREATOR,PRO,BUSINESS}_{MONTHLY,ANNUAL}` and `STRIPE_PRICE_BUSINESS_SEAT_{MONTHLY,ANNUAL}` (dynamic, :148,155), `WORKSPACE_BILLING_{BATCH_SIZE,CONCURRENCY,LEASE_MS,PROVIDER_CALL_BUDGET,PROVIDER_DEADLINE_MS}` (:127-191) | API (checkout/portal/webhook) + worker (reconcile). `app/layout.tsx` calls `billingService.validateConfiguration` per render today: web stops needing Stripe secrets. `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` is in `.env.example` but unused in code |
| `packages/services` social OAuth + publishing | `SOCIAL_TOKEN_ENCRYPTION_KEY` (`social-oauth.service.ts:119`, `completion-callback.ts:72`, `zoom.ts:42`), `TIKTOK_CLIENT_KEY/SECRET`, `GOOGLE_CLIENT_ID/SECRET`, `META_CLIENT_ID/SECRET`, `LINKEDIN_CLIENT_ID/SECRET`, `X_CLIENT_ID/SECRET` (`requireEnv`, :84), `META_GRAPH_VERSION`, `LINKEDIN_API_VERSION`, `YOUTUBE_API_VERSION`, `YOUTUBE_UPLOAD_CHUNK_BYTES`, `SOCIAL_PUBLICATION_CHECKPOINT_KEY`, `SOCIAL_PUBLISH_{WEBHOOK_URL,WEBHOOK_SECRET,WEBHOOK_REDIRECT_POLICY,...}` and `SOCIAL_PUBLISH_*` tuning (`social-publication-config.ts:106-319`) | API (OAuth, connect, webhook verify) + worker (publish); Secret |
| `packages/services` Zoom | `ZOOM_CLIENT_ID`, `ZOOM_CLIENT_SECRET`, `ZOOM_WEBHOOK_SECRET_TOKEN` (`zoom.ts:42`) | API; Secret |
| `packages/services` AI/content | `OPENAI_API_KEY` (`library-search-runtime.ts:15`, `openai-image-provider.ts:179`, `assisted-social-copy-runtime.ts:221`), `OPENAI_CLIP_MODEL`, `OPENAI_CONTENT_MODEL`, `OPENAI_ASSISTED_COPY_MODEL`, `OPENAI_TTS_MODEL`, `OPENAI_IMAGE_MODEL`, `OPENAI_IMAGE_QUALITY`, `GENERATED_IMAGE_MAX_*`, `GENERATED_MEDIA_PROMPT_{ACTIVE_KEY_VERSION,ENCRYPTION_KEY,DECRYPTION_KEYS_JSON,FINGERPRINT_KEY}`, `ASSISTED_COPY_TIMEOUT_MS`, `PEXELS_API_KEY`, `PEXELS_SEARCH_CACHE_TTL_SEC`, `EXPORT_BUNDLE_RETENTION_DAYS` (`campaign-operation.service.ts:145`), `MEDIA_CLEANUP_*` | API for the interactive paths (library search, image generation, copy, Pexels search); worker for the rest |
| `packages/services` lifecycle | `WORKER_SHUTDOWN_DRAIN_MS` (`workflow-run-lifecycle.ts:36`) | worker only |

### 8.3 Worker-only vars that touch web (for the record)

| Var | file:line | Note |
|---|---|---|
| `WORKER_APP_BASE_URL` | `apps/worker/src/notifications.ts:43` | Web origin used in emails; not in `apps/web/.env.example`. Keep pointing at web |
| `NARRIFLOW_URL`, `NARRIFLOW_API_KEY` | `apps/mcp/src/index.ts:7`, `apps/mcp/src/upload.ts:136` | stdio MCP client; `NARRIFLOW_URL` must point at the origin that serves `/mcp/integrations/*` |

### 8.4 Proposed env lists

`apps/api` (new Railway service) needs:

- Core: `NODE_ENV`, `PORT`, `DATABASE_URL`, `DIRECT_URL` (migrations only), `UPSTASH_REDIS_URL`, new `API_PUBLIC_URL`, new `WEB_APP_URL` (replaces the web meaning of `NEXT_PUBLIC_APP_URL` for redirects, invites, checkout return, review links), new CORS allow-list (can derive from `WEB_APP_URL`).
- Auth: `CLERK_SECRET_KEY`, `CLERK_PUBLISHABLE_KEY`, `CLERK_WEBHOOK_SECRET`, `CLERK_OAUTH_ISSUER`, `MCP_ALLOWED_HOSTS`, `MCP_ALLOWED_ORIGINS`, `MCP_CONTINUATION_SECRET`, `REVIEW_SESSION_SECRET`, `REVIEW_ACCESS_SECRET`.
- Billing: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PORTAL_CONFIGURATION_ID`, the 8 `STRIPE_PRICE_*`.
- Storage: `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, `R2_INCOMPLETE_MULTIPART_LIFECYCLE_DAYS`.
- Social: `SOCIAL_TOKEN_ENCRYPTION_KEY`, `SOCIAL_PUBLICATION_CHECKPOINT_KEY`, `TIKTOK_*`, `GOOGLE_CLIENT_ID/SECRET`, `META_*`, `LINKEDIN_*`, `X_*`, `ZOOM_*`, `META_GRAPH_VERSION`, `LINKEDIN_API_VERSION`.
- AI/content: `OPENAI_API_KEY`, `OPENAI_*_MODEL`, `OPENAI_IMAGE_*`, `GENERATED_MEDIA_PROMPT_*`, `GENERATED_IMAGE_*`, `ASSEMBLYAI_API_KEY` (listed in `.env.example`), `PEXELS_API_KEY`.
- Email: `RESEND_API_KEY`, `NARRIFLOW_EMAIL_FROM`.
- Optional: `NEXT_PUBLIC_GOOGLE_CLIENT_ID` (Drive source), `EXPORT_BUNDLE_RETENTION_DAYS`, upload tuning vars.

`apps/web` keeps:

- `NEXT_PUBLIC_APP_URL` (web origin), new `NEXT_PUBLIC_API_URL` (API origin, inlined into the client bundle), `NODE_ENV`.
- Clerk UI: `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY` (only while `proxy.ts`/`ClerkProvider` middleware stays), `NEXT_PUBLIC_CLERK_SIGN_IN_URL`, `..._SIGN_UP_URL`, `..._FALLBACK_REDIRECT_URL` x2, `CLERK_OAUTH_ISSUER`, `CLERK_OAUTH_CONSENT_ORIGIN`.
- Pickers: `NEXT_PUBLIC_GOOGLE_API_KEY`, `NEXT_PUBLIC_GOOGLE_CLIENT_ID`, `NEXT_PUBLIC_GOOGLE_APP_ID`, `NEXT_PUBLIC_DROPBOX_APP_KEY`.
- Docs: nothing beyond `NEXT_PUBLIC_APP_URL`.
- Removed from web: `DATABASE_URL`, `DIRECT_URL`, `UPSTASH_REDIS_URL`, `STRIPE_*`, `R2_*`, `OPENAI_*`, `SOCIAL_*`, provider client secrets, `REVIEW_*`, `MCP_*`, `RESEND_API_KEY`, `NARRIFLOW_EMAIL_FROM`, `CLERK_WEBHOOK_SECRET`, `TIKTOK_*`, `ZOOM_*`.

`apps/worker` keeps its env (unchanged), including `WORKER_APP_BASE_URL`.

Unused entries in `apps/web/.env.example` (no code reads them): `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`, `UPSTASH_REDIS_TOKEN`, `SENTRY_AUTH_TOKEN`, `NEXT_PUBLIC_SENTRY_DSN`, `OTEL_EXPORTER_OTLP_ENDPOINT`, `NEXT_PUBLIC_POSTHOG_KEY`, `NEXT_PUBLIC_POSTHOG_HOST`.

## 9. Suggested domain split

### 9.0 Rules that keep parallel implementers from colliding

1. Ownership is by directory. A domain owner may create, edit and delete any file listed under its heading in 9.2, and may only import (never edit) files owned by another domain. Section 9.3 groups the 50 non-P0 files that other domains import today; their exported props and signatures are frozen until the owning domain's PR lands.
2. Step 0 (P0, lead, before anyone starts) must land these seams, otherwise two domains edit the same file:
   - Split `apps/web/app/api/[[...route]]/route.ts` (106 inline routes, 1963 lines) into one route module per domain, mechanically, with no behavior change. Sibling modules already exist for brand-profile (24 routes), social-publication (10), workspace-billing (9), upload-session (5), zoom (5), clip-editor (4), clip-generation (1), stripe-webhook (1). Target layout: `apps/api/src/routes/<domain>.ts`, mounted by `apps/api/src/app.ts` (the only shared file, owned by P0).
   - Split `apps/web/app/(app)/settings/actions.ts` (14 exports) into the D1 half (first 7: workspace, performance guidance, member invites) and the D8 half (last 7: API keys, callback secret, webhooks) so D1 and D8 never share it.
   - Create empty per-domain files in `packages/api-client/src/<domain>.ts` (query keys, `queryOptions`, mutation hooks) and re-export them from one barrel owned by P0. Cross-domain callers import hooks from the barrel instead of another domain's `actions.ts`.
   - Rewrite `apps/web/lib/authenticated-request-inventory.ts` (1437 lines) and its test; they list every action, page and Hono surface and are asserted against the `"use server"` files.
   - Land the admission-error to client-redirect mapper (section 2 helper description) and the active-workspace selector (header instead of the `narriflow_active_workspace` cookie, see 1.10).
3. API routes keep their paths (`/api/...`), so each domain moves its handlers verbatim, then adds the new GET endpoints that its pages need (list in 2.E).
4. Tests follow the file they cover (same directory). Cross-cutting contract tests (`lib/authenticated-request-*.test.ts`, `lib/personal-workspace-auth.test.ts`, `lib/integration-admission-parity.test.ts`, `lib/plan-upgrade-pages.test.ts`, `lib/auth-server.contract.fixture.ts`) belong to P0 and are rewritten once at the end.

### 9.1 Domain summary

Counts: classifier output over 591 files (446 source + 145 test/fixture; `.ts/.tsx/.css`) in `apps/web/app` (excluding `(docs)`, `(marketing)`, `(home)`, `prototype`) plus `apps/web/lib` (excluding `lib/docs`), `proxy.ts`, `next.config.ts`. "Hono routes" counts the 165 rows of 3.2 by the rule in 9.4. D11 (4 files) and D9 (8 files) are small: assign D11 to the D2 implementer and D9 to the D3 implementer to land on 10 workstreams.

| Domain | Source files | Test/fixture | Pages/layouts | Server actions | Hono routes (by prefix) |
|---|---|---|---|---|---|
| P0 Platform foundation (done first, by the lead) | 67 | 23 | 2 | 0 | 4 |
| D1 Workspace, onboarding, invites, members, profile | 36 | 6 | 10 | 12 | 2 |
| D2 Projects list, folders, project page, home | 50 | 9 | 3 | 12 | 13 |
| D3 Clips, campaign operations, Studio/editor | 95 | 43 | 2 | 6 | 27 |
| D4 Upload, intake, recipes, MCP upload | 44 | 17 | 3 | 6 | 14 |
| D5 Publishing, calendar, queue, social accounts, performance | 29 | 11 | 5 | 8 | 17 |
| D6 Brand kit | 28 | 3 | 5 | 5 | 41 |
| D7 Billing, credits, upgrade prompts | 16 | 12 | 2 | 0 | 9 |
| D8 Settings API/webhooks, automation grants, integrations, MCP, autopilot, notifications | 41 | 5 | 9 | 12 | 10 |
| D9 Exports | 8 | 0 | 2 | 1 | 17 |
| D10 Review and public links | 12 | 6 | 2 | 0 | 8 |
| D11 Search and library | 4 | 0 | 1 | 0 | 3 |
| S Split-before-start file | 1 | 0 | 0 | - | - |
| A0 API core (lib/rest-api) | 2 | 3 | 0 | - | - |
| W Route handlers that leave web (assigned in 9.4) | 13 | 7 | 0 | - | - |
| Total classified | 446 | 145 | | 61 distinct (62 exports incl. alias) | 165 |

### 9.2 Per-domain ownership

Paths are relative to `apps/web/`. A trailing `/**` means every file under the directory (including co-located `*.test.*` and `*.fixture.*`) belongs to that domain only. Counts are non-test source files (`.ts`, `.tsx`, `.css`) and test/fixture files, produced by a classifier over `find app lib proxy.ts next.config.ts` excluding docs, marketing, home-marketing, prototype and `lib/docs`.

#### P0 Platform foundation (done first, by the lead)

- Web files: 67 source + 23 test/fixture. Pages/layouts: 2. Server actions: none. Existing Hono routes by prefix rule: 4 (platform (health, stripe/zoom/tiktok webhooks)).
- Pages/layouts: `app/(app)/layout.tsx`, `app/layout.tsx`
- Files:

  - `app/(app)/_components/account-menu.tsx`
  - `app/(app)/_components/app-chrome.tsx`
  - `app/(app)/_components/feature-hero.tsx`
  - `app/(app)/_components/mobile-nav.tsx`
  - `app/(app)/_components/nav-items.ts`
  - `app/(app)/_components/project-workspace.module.css`
  - `app/(app)/_components/project-workspace.tsx`
  - `app/(app)/_components/settings-chrome.tsx`
  - `app/(app)/_components/shell-panel.tsx`
  - `app/(app)/_components/sidebar.tsx`
  - `app/(app)/_components/theme-toggle.tsx`
  - `app/(app)/_components/use-settings-return.ts`
  - `app/(app)/_components/workspace-status-notice.test.tsx`
  - `app/(app)/_components/workspace-status-notice.tsx`
  - `app/(app)/_shared/**`
  - `app/(app)/error.tsx`
  - `app/(app)/layout.tsx`
  - `app/(app)/loading.tsx`
  - `app/(app)/not-found.tsx`
  - `app/_components/**`
  - `app/caption-fonts.test.ts`
  - `app/caption-fonts.ts`
  - `app/global-error.tsx`
  - `app/layout.tsx`
  - `app/opengraph-image.tsx`
  - `app/robots.ts`
  - `lib/account-display.ts`
  - `lib/auth-entry.ts`
  - `lib/auth-flow.test.ts`
  - `lib/auth-flow.ts`
  - `lib/auth-form.test.ts`
  - `lib/auth-server.contract.fixture.ts`
  - `lib/authenticated-request-action.ts`
  - `lib/authenticated-request-browser.test.ts`
  - `lib/authenticated-request-browser.ts`
  - `lib/authenticated-request-hono.test.ts`
  - `lib/authenticated-request-hono.ts`
  - `lib/authenticated-request-http.test.ts`
  - `lib/authenticated-request-http.ts`
  - `lib/authenticated-request-input.test.ts`
  - `lib/authenticated-request-input.ts`
  - `lib/authenticated-request-inventory.test.ts`
  - `lib/authenticated-request-inventory.ts`
  - `lib/authenticated-request-page.ts`
  - `lib/authenticated-request-policy.db.test.ts`
  - `lib/authenticated-request-policy.server.ts`
  - `lib/authenticated-request-policy.test.ts`
  - `lib/authenticated-request-policy.ts`
  - `lib/authenticated-request-project.ts`
  - `lib/docs-url.ts`
  - `lib/env.ts`
  - `lib/format.test.ts`
  - `lib/format.ts`
  - `lib/integration-admission-parity.test.ts`
  - `lib/motion-options.ts`
  - `lib/navigation-actions.test.ts`
  - `lib/navigation-actions.ts`
  - `lib/personal-workspace-auth.test.ts`
  - `lib/project-state.test.ts`
  - `lib/project-state.ts`
  - `lib/safe-redirect.test.ts`
  - `lib/safe-redirect.ts`
  - `lib/settings-return.test.ts`
  - `lib/settings-return.ts`
  - `lib/workflow-stream-authorization.test.ts`
  - `lib/workflow-stream-authorization.ts`
  - `lib/workflow-stream-reauthorization.test.ts`
  - `lib/workflow-stream-reauthorization.ts`
  - `lib/workflow-stream.test.ts`
  - `lib/workflow-stream.ts`
  - `next.config.ts`
  - `proxy.ts`

#### D1 Workspace, onboarding, invites, members, profile

- Web files: 36 source + 6 test/fixture. Pages/layouts: 10. Server actions: `_actions/workspace.ts` (1: switchWorkspaceAction), `workspaces/new/actions.ts` (1), `invite/[token]/actions.ts` (1), `settings/actions.ts` first 7 (updateWorkspaceAction, updatePerformanceGuidanceAction, inviteMemberAction, resendInviteAction, revokeInviteAction, changeMemberRoleAction, removeMemberAction), `settings/workspace/censor-words-actions.ts` (2) = 12. Existing Hono routes by prefix rule: 2 (workspace).
- Pages/layouts: `app/(app)/settings/layout.tsx`, `app/(app)/settings/members/page.tsx`, `app/(app)/settings/page.tsx`, `app/(app)/settings/profile/page.tsx`, `app/(app)/settings/workspace/page.tsx`, `app/auth/continue/page.tsx`, `app/invite/[token]/page.tsx`, `app/sso-callback/[[...sso-callback]]/page.tsx`, `app/workspace-unavailable/page.tsx`, `app/workspaces/new/page.tsx`
- Files:

  - `app/(app)/_actions/**`
  - `app/(app)/_components/censor-word-list-dialog.tsx`
  - `app/(app)/_components/workspace-switcher.tsx`
  - `app/(app)/settings/_components/**`
  - `app/(app)/settings/layout.tsx`
  - `app/(app)/settings/members/**`
  - `app/(app)/settings/page.tsx`
  - `app/(app)/settings/profile/**`
  - `app/(app)/settings/workspace/**`
  - `app/auth/**`
  - `app/invite/**`
  - `app/sso-callback/**`
  - `app/workspace-unavailable/**`
  - `app/workspaces/**`
  - `lib/post-auth-redirect.test.ts`
  - `lib/post-auth-redirect.ts`
  - `lib/workspace-entry.db.fixture.ts`

#### D2 Projects list, folders, project page, home

- Web files: 50 source + 9 test/fixture. Pages/layouts: 3. Server actions: `projects/actions.ts` (12 exports: 11 functions + alias queueGenerationFormAction) = 12. Existing Hono routes by prefix rule: 13 (projects).
- Pages/layouts: `app/(app)/home/page.tsx`, `app/(app)/projects/[projectId]/page.tsx`, `app/(app)/projects/page.tsx`
- Files:

  - `app/(app)/home/**`
  - `app/(app)/projects/[projectId]/analytics-panel.test.tsx`
  - `app/(app)/projects/[projectId]/analytics-panel.tsx`
  - `app/(app)/projects/[projectId]/content-suite-panel.tsx`
  - `app/(app)/projects/[projectId]/dubbing-panel.tsx`
  - `app/(app)/projects/[projectId]/error.tsx`
  - `app/(app)/projects/[projectId]/loading.tsx`
  - `app/(app)/projects/[projectId]/page.tsx`
  - `app/(app)/projects/[projectId]/panel-header.tsx`
  - `app/(app)/projects/[projectId]/pipeline-stepper.tsx`
  - `app/(app)/projects/[projectId]/processing-panel.tsx`
  - `app/(app)/projects/[projectId]/processing-timeframe-fields.tsx`
  - `app/(app)/projects/[projectId]/project-access.test.ts`
  - `app/(app)/projects/[projectId]/project-access.ts`
  - `app/(app)/projects/[projectId]/project-activity.test.ts`
  - `app/(app)/projects/[projectId]/project-activity.ts`
  - `app/(app)/projects/[projectId]/project-brand-picker.tsx`
  - `app/(app)/projects/[projectId]/project-events-provider.tsx`
  - `app/(app)/projects/[projectId]/project-events.tsx`
  - `app/(app)/projects/[projectId]/project-panels.test.tsx`
  - `app/(app)/projects/[projectId]/project-skeleton.tsx`
  - `app/(app)/projects/[projectId]/project-tab.test.ts`
  - `app/(app)/projects/[projectId]/project-tab.ts`
  - `app/(app)/projects/[projectId]/project-tabs.tsx`
  - `app/(app)/projects/[projectId]/soft-bar.tsx`
  - `app/(app)/projects/[projectId]/source-icon.tsx`
  - `app/(app)/projects/[projectId]/transcript-panel.tsx`
  - `app/(app)/projects/[projectId]/transcript-paragraphs.test.ts`
  - `app/(app)/projects/[projectId]/transcript-paragraphs.ts`
  - `app/(app)/projects/_components/**`
  - `app/(app)/projects/_lib/**`
  - `app/(app)/projects/actions.ts`
  - `app/(app)/projects/loading.tsx`
  - `app/(app)/projects/page.tsx`

#### D3 Clips, campaign operations, Studio/editor

- Web files: 95 source + 43 test/fixture. Pages/layouts: 2. Server actions: 6 inline actions in `studio/page.tsx` (fetchPreviewStatus, fetchAutoLayoutAnalysis, fetchSplitLayoutAnalysis, fetchScreenLayoutAnalysis, updateProjectCensorTerms, recordAutoCensorEvent) = 6. Existing Hono routes by prefix rule: 27 (clips-studio).
- Pages/layouts: `app/(app)/projects/[projectId]/clips/[clipId]/studio/layout.tsx`, `app/(app)/projects/[projectId]/clips/[clipId]/studio/page.tsx`
- Files:

  - `app/(app)/projects/[projectId]/advanced-clip-settings.tsx`
  - `app/(app)/projects/[projectId]/campaign-command-bar.tsx`
  - `app/(app)/projects/[projectId]/campaign-command-state.test.ts`
  - `app/(app)/projects/[projectId]/campaign-command-state.ts`
  - `app/(app)/projects/[projectId]/campaign-editor-action-preview.tsx`
  - `app/(app)/projects/[projectId]/campaign-selection.test.ts`
  - `app/(app)/projects/[projectId]/campaign-selection.ts`
  - `app/(app)/projects/[projectId]/clip-action-error-copy.test.ts`
  - `app/(app)/projects/[projectId]/clip-action-error-copy.ts`
  - `app/(app)/projects/[projectId]/clip-actions-menu.tsx`
  - `app/(app)/projects/[projectId]/clip-row.tsx`
  - `app/(app)/projects/[projectId]/clips-panel.tsx`
  - `app/(app)/projects/[projectId]/clips/[clipId]/studio/**`
  - `app/(app)/projects/[projectId]/edit-clip-length-dialog.tsx`
  - `app/(app)/projects/[projectId]/finishing-auto-refresh.tsx`
  - `app/(app)/projects/[projectId]/finishing-status.test.tsx`
  - `app/(app)/projects/[projectId]/finishing-status.tsx`
  - `app/(app)/projects/[projectId]/render-clips-button.tsx`
  - `app/(app)/projects/[projectId]/review-panel.tsx`
  - `app/(app)/projects/[projectId]/source-hover-preview.tsx`
  - `lib/clip-media.test.ts`
  - `lib/clip-media.ts`

#### D4 Upload, intake, recipes, MCP upload

- Web files: 44 source + 17 test/fixture. Pages/layouts: 3. Server actions: `upload/actions.ts` = 6. Existing Hono routes by prefix rule: 14 (upload).
- Pages/layouts: `app/(app)/integrations/mcp/upload/page.tsx`, `app/(app)/recipes/page.tsx`, `app/(app)/upload/page.tsx`
- Files:

  - `app/(app)/integrations/mcp/upload/**`
  - `app/(app)/recipes/**`
  - `app/(app)/upload/**`
  - `app/mcp/integrations/**`
  - `lib/mcp-upload-handoff.test.ts`
  - `lib/mcp-upload-handoff.ts`
  - `lib/mcp-upload-http.test.ts`
  - `lib/mcp-upload-http.ts`

#### D5 Publishing, calendar, queue, social accounts, performance

- Web files: 29 source + 11 test/fixture. Pages/layouts: 5. Server actions: `calendar/actions.ts` (1) + `calendar/queue/actions.ts` (7) = 8. Existing Hono routes by prefix rule: 17 (publishing).
- Pages/layouts: `app/(app)/calendar/new/page.tsx`, `app/(app)/calendar/page.tsx`, `app/(app)/calendar/queue/page.tsx`, `app/(app)/performance/page.tsx`, `app/(app)/settings/social-accounts/page.tsx`
- Files:

  - `app/(app)/calendar/**`
  - `app/(app)/performance/**`
  - `app/(app)/projects/[projectId]/publishing-composition-session-protocol.test.ts`
  - `app/(app)/projects/[projectId]/publishing-composition-session.test.ts`
  - `app/(app)/projects/[projectId]/publishing-composition-session.ts`
  - `app/(app)/projects/[projectId]/publishing-cover.tsx`
  - `app/(app)/projects/[projectId]/publishing-draft.ts`
  - `app/(app)/projects/[projectId]/publishing-posts.test.tsx`
  - `app/(app)/projects/[projectId]/publishing-posts.tsx`
  - `app/(app)/projects/[projectId]/publishing-preview.tsx`
  - `app/(app)/projects/[projectId]/publishing-provider.tsx`
  - `app/(app)/projects/[projectId]/publishing.browser.fixture.tsx`
  - `app/(app)/projects/[projectId]/publishing.test.ts`
  - `app/(app)/settings/social-accounts/**`
  - `lib/performance-format.test.ts`
  - `lib/performance-format.ts`
  - `lib/social-platform-mark.tsx`
  - `lib/social-post-links.tsx`
  - `lib/social-post-status.test.ts`
  - `lib/social-post-status.ts`

#### D6 Brand kit

- Web files: 28 source + 3 test/fixture. Pages/layouts: 5. Server actions: `brand-kit/style-actions.ts` = 5. Existing Hono routes by prefix rule: 41 (brand-kit).
- Pages/layouts: `app/(app)/brand-kit/[id]/page.tsx`, `app/(app)/brand-kit/new/page.tsx`, `app/(app)/brand-kit/page.tsx`, `app/(app)/brand-kit/styles/[id]/page.tsx`, `app/(app)/brand-kit/styles/new/page.tsx`
- Files:

  - `app/(app)/brand-kit/**`

#### D7 Billing, credits, upgrade prompts

- Web files: 16 source + 12 test/fixture. Pages/layouts: 2. Server actions: none (billing is Hono-only today; `workspace-billing-routes.ts` 9 routes). Existing Hono routes by prefix rule: 9 (billing).
- Pages/layouts: `app/(app)/settings/billing/page.tsx`, `app/(app)/settings/usage/page.tsx`
- Files:

  - `app/(app)/_components/credits-menu.test.tsx`
  - `app/(app)/_components/credits-menu.tsx`
  - `app/(app)/_components/plan-limit-notice.tsx`
  - `app/(app)/_components/upgrade-visuals.tsx`
  - `app/(app)/_components/upgrade.browser.fixture.tsx`
  - `app/(app)/_components/upgrade.test.tsx`
  - `app/(app)/_components/upgrade.tsx`
  - `app/(app)/_components/usage-palette.ts`
  - `app/(app)/_components/usage.ts`
  - `app/(app)/integrations/_components/upgrade-tile-button.tsx`
  - `app/(app)/settings/billing/**`
  - `app/(app)/settings/usage/**`
  - `lib/billing-browser.test.ts`
  - `lib/billing-browser.ts`
  - `lib/billing-plan-change.test.ts`
  - `lib/billing-plan-change.ts`
  - `lib/billing-view-model.test.ts`
  - `lib/billing-view-model.ts`
  - `lib/feature-upgrade-prompt.test.ts`
  - `lib/feature-upgrade-prompt.ts`
  - `lib/plan-upgrade-pages.contract.fixture.ts`
  - `lib/plan-upgrade-pages.test.ts`

#### D8 Settings API/webhooks, automation grants, integrations, MCP, autopilot, notifications

- Web files: 41 source + 5 test/fixture. Pages/layouts: 9. Server actions: `settings/actions.ts` last 7 (createApiKeyAction, revokeApiKeyAction, rotateCallbackSigningSecretAction, createWebhookAction, deleteWebhookAction, enableWebhookAction, testWebhookAction), `settings/automation-grants/actions.ts` (4), `integrations/mcp/confirm/actions.ts` (1) = 12. Existing Hono routes by prefix rule: 10 (settings-integrations (autopilot, zoom)).
- Pages/layouts: `app/(app)/autopilot/page.tsx`, `app/(app)/help/page.tsx`, `app/(app)/integrations/mcp/confirm/page.tsx`, `app/(app)/integrations/mcp/page.tsx`, `app/(app)/integrations/page.tsx`, `app/(app)/settings/api/page.tsx`, `app/(app)/settings/automation-grants/page.tsx`, `app/(app)/settings/notifications/page.tsx`, `app/(app)/whats-new/page.tsx`
- Files:

  - `app/(app)/autopilot/**`
  - `app/(app)/help/**`
  - `app/(app)/integrations/_components/brand-tile.tsx`
  - `app/(app)/integrations/loading.tsx`
  - `app/(app)/integrations/mcp/assistant-setup.tsx`
  - `app/(app)/integrations/mcp/confirm/**`
  - `app/(app)/integrations/mcp/connector-unavailable.test.tsx`
  - `app/(app)/integrations/mcp/connector-unavailable.tsx`
  - `app/(app)/integrations/mcp/loading.tsx`
  - `app/(app)/integrations/mcp/page.tsx`
  - `app/(app)/integrations/mcp/workspace-billing-link.tsx`
  - `app/(app)/integrations/page.tsx`
  - `app/(app)/settings/api/**`
  - `app/(app)/settings/automation-grants/**`
  - `app/(app)/settings/notifications/**`
  - `app/(app)/whats-new/**`
  - `app/.well-known/**`
  - `app/mcp/route.ts`
  - `lib/mcp-auth.ts`
  - `lib/mcp-configuration.test.ts`
  - `lib/mcp-configuration.ts`
  - `lib/mcp-continuation-principal.test.ts`
  - `lib/mcp-continuation-principal.ts`
  - `lib/mcp-integration-admission.ts`

#### D9 Exports

- Web files: 8 source + 0 test/fixture. Pages/layouts: 2. Server actions: `exports/actions.ts` = 1. Existing Hono routes by prefix rule: 17 (exports).
- Pages/layouts: `app/(app)/exports/page.tsx`, `app/(app)/projects/[projectId]/clips/[clipId]/exports/[exportId]/page.tsx`
- Files:

  - `app/(app)/exports/**`
  - `app/(app)/projects/[projectId]/clips/[clipId]/exports/**`

#### D10 Review and public links

- Web files: 12 source + 6 test/fixture. Pages/layouts: 2. Server actions: none (guest API is Hono). Existing Hono routes by prefix rule: 8 (review).
- Pages/layouts: `app/review/[token]/page.tsx`, `app/share/[token]/page.tsx`
- Files:

  - `app/(app)/projects/[projectId]/project-share-button.tsx`
  - `app/(app)/projects/[projectId]/project-share-model.test.ts`
  - `app/(app)/projects/[projectId]/project-share-model.ts`
  - `app/api/review/**`
  - `app/review/**`
  - `app/share/**`
  - `lib/review-preselection.test.ts`
  - `lib/review-preselection.ts`

#### D11 Search and library

- Web files: 4 source + 0 test/fixture. Pages/layouts: 1. Server actions: none. Existing Hono routes by prefix rule: 3 (search-library).
- Pages/layouts: `app/(app)/search/page.tsx`
- Files:

  - `app/(app)/_components/global-search.tsx`
  - `app/(app)/search/**`

### 9.3 Shared files: imported by more than one domain

Generated by resolving every relative and `@/` import in non-test source and listing the files whose importers sit in a different domain. The importing domains are in the last column. P0 as importer is common (the app shell), so P0-owned shared files (36 of them, mostly `lib/authenticated-request-*`, `lib/format`, `lib/env`, `app/_components/**`, `(app)/_shared/**`) are not listed here; they are rewritten by P0 in step 0.

| Owner | File | Imported by | Resolution |
|---|---|---|---|
| D7 | `app/(app)/_components/upgrade.tsx` | D1 D2 D3 D4 D5 D6 D8 D9 D10 P0 | Freeze props. D7 swaps its internals to `useBillingQuery`, never changes the component API. |
| D7 | `app/(app)/_components/plan-limit-notice.tsx` | D2 D3 D4 D5 D6 D8 D9 | Freeze props. |
| D7 | `lib/feature-upgrade-prompt.ts` | D2 D3 D4 D5 D6 D8 D9 | Pure function; freeze. |
| D7 | `app/(app)/_components/upgrade-visuals.tsx` | D1 D4 D5 D6 D8 | Freeze. |
| D7 | `app/(app)/_components/usage.ts`, `usage-palette.ts`, `credits-menu.tsx`, `lib/billing-view-model.ts` | P0 (layout, shell), D1 | `usage.ts` imports a services value (`(app)/layout` credits); D7 turns it into a hook, P0 consumes in layout. |
| D5 | `lib/social-post-status.ts` | D2 D3 D4 D8 | Pure; freeze. |
| D5 | `lib/social-platform-mark.tsx` | D3 D4 | Freeze. |
| D5 | `lib/performance-format.ts` | D2 D3 | Freeze. |
| D5 | `app/(app)/projects/[projectId]/publishing-provider.tsx` | D2 (project page), D3 | Seam: project page mounts it. D5 owns the provider, D2 owns the one mounting line in `page.tsx`. |
| D1 | `app/(app)/_actions/workspace.ts` | D2, D8, P0 | Deleted; callers use `useSwitchWorkspace` from the api-client barrel. D1 deletes the file, P0/D2/D8 only edit their own call sites. |
| D1 | `app/(app)/settings/_components/{access-note,settings-skeleton,settings-ui}.tsx` | D5 D6 D7 D8 | Freeze. |
| D1 | `app/(app)/settings/workspace/censor-words-actions.ts`, `app/(app)/_components/censor-word-list-dialog.tsx` | D3 (Studio, `studio/page.tsx`) | D1 replaces the action with API calls; D3 consumes a hook from the barrel. Studio also has its own inline `updateProjectCensorTerms`. |
| D1 | `app/(app)/settings/actions.ts` | D1, D8 | Split in step 0. |
| D2 | `app/(app)/projects/actions.ts` | D3 (`render-clips-button`, `clips-panel`), D4 (upload) | Deleted by D2; D3/D4 use `projects.ts` hooks from the barrel. |
| D2 | `app/(app)/projects/[projectId]/panel-header.tsx` | D3 D5 | Freeze. |
| D2 | `app/(app)/projects/[projectId]/processing-timeframe-fields.tsx` | D3 | Freeze. |
| D2 | `app/(app)/projects/_lib/youtube.ts` | D4 | Freeze. |
| D3 | `projects/[projectId]/{clips-panel,finishing-status,advanced-clip-settings,render-clips-button,source-hover-preview,campaign-command-state,review-panel}.tsx/.ts` | D2 (`page.tsx`) | Seam: the project page composes these. D2 owns `page.tsx` data loading; D3 owns the component internals. Do not change their props in the same wave. |
| D3 | `.../studio/_components/caption-style-engine.tsx` | P0 | Freeze. |
| D3 | `.../studio/_components/tool-panels/audio-library.ts`, `audio-upload.ts` | D6 (brand-kit audio) | Freeze or move to D6 in the same PR. |
| D3 | `.../studio/_components/waveform-peaks.ts` | D3 only, but a client-bundled module that imports a services value (`@narriflow/services/clip-preview-storage`) | Needs a new home before the Biome ban. |
| D4 | `app/(app)/upload/_components/format-settings.tsx`, `_lib/content-pack-form.ts` | D3, D2 | Freeze. |
| D4 | `app/(app)/recipes/finishing-form.ts` | D8 | Freeze. |
| D6 | `app/(app)/brand-kit/_components/brand-kit-ui.tsx`, `brand-fonts.tsx` | D2, D3, D4 | Freeze. |
| D8 | `app/(app)/integrations/_components/brand-tile.tsx`, `integrations/mcp/connector-unavailable.tsx` | D5 D7 / D4 | Freeze. |
| D8 | `lib/mcp-auth.ts`, `lib/mcp-continuation-principal.ts`, `lib/mcp-integration-admission.ts` | D4 (`lib/mcp-upload-http.ts`, `mcp-upload-handoff.ts`) | Moves to API with `app/mcp/**`; D4 owns the MCP upload routes; they must land in the same PR or D4 waits for D8. |
| D10 | `lib/review-preselection.ts` | D2 (page), D3 (`review-panel.tsx`) | Imports a services value and is bundled to the client; D10 rewrites it to be pure and move the services call to the API. |
| D10 | `projects/[projectId]/project-share-button.tsx`, `project-share-model.ts` | D2 | Seam: mounted by `page.tsx`. |
| API | `app/api/[[...route]]/upload-session-http.ts` | D4 (`mcp-upload-http.ts` imports it) | Single module reused by two surfaces; moves with D4. |
| P0 | `app/(app)/layout.tsx` (D7 `upgrade`, `billing-view-model`, `usage` imports), `app/layout.tsx` | all | P0 only. Removes `billingService.validateConfiguration` from the root layout. |

Hot files that are not in the table because they are single-domain by directory but hold cross-domain data:
- `app/(app)/projects/[projectId]/page.tsx` (1107 lines, D2 owns). It reads data for D3 (clips, finishing, campaign operations), D5 (publishing posts and accounts), D7 (plan limits, upgrade) and D10 (review rounds, share). Assigned to D2 as a seam owner: D2 converts it into a shell that renders tab components, each tab component being fetched by the owning domain with its own query.
- `app/(app)/projects/[projectId]/clips/[clipId]/studio/page.tsx` (327 lines, D3) imports `censor-words-actions` (D1) and `brand-fonts` (D6).
- `packages/api-client/src/index.ts`, `apps/api/src/app.ts`, `biome.json` (noRestrictedImports), `lib/authenticated-request-inventory.ts` are P0-only.

### 9.4 API-side ownership: how the 165 current routes map to domains

Prefix rules (first match wins), so each domain's API route module is fixed in advance:

| Domain | Rule | Count |
|---|---|---|
| P0 platform | `/health`, `/webhooks/*` (tiktok, stripe, zoom) | 4 |
| D9 exports | `/projects/:id/clips/:clipId/exports*`, `/clips/:clipId/timeline*`, `/projects/:id/export-bundles*`, `/projects/:id/exports/current`, `/workspace/exports/:id/download`, `campaign-operations/:id/retry-export-bundle` | 17 |
| D10 review | `/projects/:id/review-rounds*` | 8 |
| D5 publishing | `/social*`, `/projects/:id/social-posts*`, `/projects/:id/social-accounts*`, `/projects/:id/assisted-copy*`, `campaign-operations/schedule*` | 17 |
| D6 brand kit | `/brand-templates*`, `/brand-profiles*`, `/brand-fonts*`, `/audio-assets*`, `/visual-assets*`, `/projects/:id/generated-media*`, scene-template apply | 41 |
| D4 upload | `/upload-sessions*`, `/ingest*`, `/recipes*` | 14 |
| D7 billing | `/billing*` | 9 |
| D8 settings-integrations | `/autopilot*`, `/zoom*` | 10 |
| D11 search-library | `/library*`, `/workspace/search`, `/broll/search` | 3 |
| D1 workspace | `/workspace/avatar*` | 2 |
| D3 clips-studio | remaining `/projects/:id/clips*`, `campaign-operations*`, `thumbnail-frames*` | 27 |
| D2 projects | `/projects`, `/projects/:id`, `/generate`, `runs`, `transcript*`, `content-suite*`, `analytics`, `dubs*` | 13 |
| Total | | 165 |

Not in the 165 and therefore new API work per domain: every route needed for a page read or server action that has no Hono route today (section 2.E lists about 40 GETs; section 1 lists the actions without a route, e.g. workspace switch, invites, members, API keys, webhooks, automation grants, folders, queue/proposals, calendar post, MCP confirm, censor words, studio polling reads, upload server actions).
Routes outside `[[...route]]` that move: progress stream (`/api/stream/:projectId`, P0), Clerk webhook (P0), `/api/v1` REST app (A0, P0), `/mcp` and `/.well-known/*` (D8), MCP upload (D4), review guest routes (D10). Stay in web: docs search, docs-markdown, docs-og, llms*.txt (section 4).

### 9.5 Not owned by any domain

- Stay in web untouched: `app/(docs)/**`, `app/(marketing)/**`, `app/(home)/**`, `app/prototype/**`, `lib/docs/**`, `content/**`, `app/api/docs/search/route.ts`. Caveat from 3/4: `lib/docs/openapi.ts` imports `createRestApi` from `lib/rest-api/public-openapi.ts`, so A0 must publish the OpenAPI document (generated file or fetch at build time) before `lib/rest-api` leaves web.
- `app/(marketing)/pricing/page.tsx` reads the plan catalog (`@narriflow/validators`) only; it stays in web (not D7).
- `app/(app)/dashboard/`, `app/(app)/workspaces/`, `app/oauth-consent/`, `app/qa/`, `app/studio-session-harness/` are empty directories (no files); delete in step 0.
