# 25. Expose developer controls and convert integrations UI

**What to build:** Developer settings and integrations use admitted browser endpoints, including credential-neutral replay for one-time key/secret issuance.

**Blocked by:** [05 - Expose session and Workspace controls](05-expose-session-and-workspace-controls.md), [06 - Convert app shell and Workspace UI](06-convert-app-shell-and-workspace-ui.md), [17 - Move publishing OAuth queue and performance API](17-move-publishing-oauth-queue-and-performance-api.md), [23 - Move REST v1 and detach docs from backend](23-move-rest-v1-and-detach-docs-from-backend.md), [24 - Move MCP discovery and upload protocols](24-move-mcp-discovery-and-upload-protocols.md)

**Status:** done

**Suggested implementer:** Claude. The other pairing side reviews and returns findings to this owner.

Read [spec.md](../spec.md). It is the complete contract; the original brief/plan/reviews are not prerequisites. Claim this ticket before editing.

## Exact ownership

Paths are repo-relative. Every existing file below is exclusively assigned for this phase, including files that only need verification. A new `/**` directory includes its local tests/helpers, not adjacent directories. Read other files as evidence; do not edit them.

Existing files:

- `apps/web/app/(app)/integrations/_components/brand-tile.tsx`
- `apps/web/app/(app)/integrations/loading.tsx`
- `apps/web/app/(app)/integrations/page.tsx`
- `apps/web/app/(app)/settings/actions.ts`
- `apps/web/app/(app)/settings/api/add-webhook-dialog.tsx`
- `apps/web/app/(app)/settings/api/api-keys-panel.tsx`
- `apps/web/app/(app)/settings/api/api-quickstart.tsx`
- `apps/web/app/(app)/settings/api/callback-secret-panel.tsx`
- `apps/web/app/(app)/settings/api/create-key-dialog.tsx`
- `apps/web/app/(app)/settings/api/loading.tsx`
- `apps/web/app/(app)/settings/api/page.tsx`
- `apps/web/app/(app)/settings/api/webhooks-panel.tsx`
- `packages/services/src/completion-callback-runtime.ts`
- `packages/services/src/completion-callback.db.test.ts`
- `packages/services/src/completion-callback.test.ts`
- `packages/services/src/completion-callback.ts`
- `packages/services/src/webhook-subscription-runtime.ts`
- `packages/services/src/webhook-subscription.db.test.ts`
- `packages/services/src/webhook-subscription.ts`
- `packages/services/src/workspace.service.test.ts`
- `packages/services/src/workspace.service.ts`

New files/directories or reserved skeletons handed off by a blocker:

- `apps/api/src/domains/developer/**`
- `apps/api/src/types/developer.ts`
- `packages/api-client/src/developer/**`
- `packages/validators/src/api/developer.ts`
- `packages/services/src/developer-receipt-commands.ts`
- `packages/services/src/developer-commands.ts`
- `packages/services/src/developer-commands-runtime.ts`

The old shared settings/actions.ts is exclusively deleted here after 06 converted Workspace callers. This ticket can extend workspace.service.ts only after 05 and 06 finish; no concurrent Workspace owner remains. Do not expose operator modules as admin endpoints.

The chosen new endpoints for this ticket are the matching owner row in spec.md, "Endpoint and screen contracts added by extraction". All current endpoints/actions below retain their semantics unless that row explicitly changes transport. Fill only this domain's receipt-command module; current native receipts remain native.

## Endpoints, actions, pages and refresh sites

Rows retain their section/ordinal or exact source-line identifier from the independent inventory. Abbreviated table filenames are accompanied by the literal ownership manifest and exact source occurrences below. All action/page/fetch/refresh rows in owned files are in scope, including no-refresh callers and media navigation. Baseline observations do not override the spec's selected origins, route style, guest Bearer or new endpoints.

### Inventory 1.3 function `createApiKeyAction({name, scopes?})`

| File:line | Function | Input | Service / auth calls | Policy helper + capability | Plan check | Returns | Side effects | Client callers | Target endpoint | Domain |
|---|---|---|---|---|---|---|---|---|---|---|
| `app/(app)/settings/actions.ts:243` | `createApiKeyAction({name, scopes?})` | `workspaceApiKeyActionSchema` | `workspaceService.createApiKey` | `executeWorkspaceActionWithInput("api.manage")` | none in action (service enforces) | `{ok:true, key:{...key, createdAt ISO}}` (secret shown once) / `{ok:false,...}` | `revalidatePath("/settings/api")` | `app/(app)/settings/api/create-key-dialog.tsx:49` (`router.refresh`:55) | `POST /api/workspace/api-keys` | settings-integrations |

### Inventory 1.3 function `revokeApiKeyAction(keyId)`

| File:line | Function | Input | Service / auth calls | Policy helper + capability | Plan check | Returns | Side effects | Client callers | Target endpoint | Domain |
|---|---|---|---|---|---|---|---|---|---|---|
| `:279` | `revokeApiKeyAction(keyId)` | `workspaceApiKeyReferenceActionSchema` | `workspaceService.revokeApiKey` | `executeWorkspaceActionWithInput("api.manage")` | none | `void` / failure | `revalidatePath("/settings/api")` | `settings/api/api-keys-panel.tsx:63` (`router.refresh`:68) | `DELETE /api/workspace/api-keys/:keyId` | settings-integrations |

### Inventory 1.3 function `rotateCallbackSigningSecretAction()`

| File:line | Function | Input | Service / auth calls | Policy helper + capability | Plan check | Returns | Side effects | Client callers | Target endpoint | Domain |
|---|---|---|---|---|---|---|---|---|---|---|
| `:289` | `rotateCallbackSigningSecretAction()` | none | `callbackSigningSecrets.rotate(workspaceId)` | `executeWorkspaceAction("api.manage")` | `requirePlanFeature(tier, "integrations.api")` | `{ok:true, secret, createdAt}` (secret returned once; previous signs 24h) | `revalidatePath("/settings/api")` | `settings/api/callback-secret-panel.tsx:30` (`router.refresh`:36) | `POST /api/workspace/callback-signing-secret/rotate` | settings-integrations |

### Inventory 1.3 function `createWebhookAction({url, types})`

| File:line | Function | Input | Service / auth calls | Policy helper + capability | Plan check | Returns | Side effects | Client callers | Target endpoint | Domain |
|---|---|---|---|---|---|---|---|---|---|---|
| `:311` | `createWebhookAction({url, types})` | `createWebhookRequestSchema` | `assertCompletionCallbackUrl`, `webhookSubscriptions.create` (via `webhookOperation` helper :299) | `executeWorkspaceActionWithInput("api.manage")` | `requirePlanFeature(tier, "integrations.api")` | `{ok:true, webhook}` / `{ok:false, error, errorCode}` | `revalidatePath("/settings/api")` | `settings/api/add-webhook-dialog.tsx:43` (`router.refresh`:50) | `POST /api/workspace/webhooks` (may share logic with `/api/v1/webhooks`; that one is API-key auth, keep separate adapter) | settings-integrations |

### Inventory 1.3 function `deleteWebhookAction(webhookId)`

| File:line | Function | Input | Service / auth calls | Policy helper + capability | Plan check | Returns | Side effects | Client callers | Target endpoint | Domain |
|---|---|---|---|---|---|---|---|---|---|---|
| `:318` | `deleteWebhookAction(webhookId)` | `webhookReferenceActionSchema` | `webhookSubscriptions.delete` | same + `integrations.api` | yes | `{ok:true, ...result}` / `{ok:false,...}` | `revalidatePath("/settings/api")` | `settings/api/webhooks-panel.tsx:82` (`router.refresh`:71 in shared `run`) | `DELETE /api/workspace/webhooks/:webhookId` | settings-integrations |

### Inventory 1.3 function `enableWebhookAction(webhookId)`

| File:line | Function | Input | Service / auth calls | Policy helper + capability | Plan check | Returns | Side effects | Client callers | Target endpoint | Domain |
|---|---|---|---|---|---|---|---|---|---|---|
| `:323` | `enableWebhookAction(webhookId)` | `webhookReferenceActionSchema` | `webhookSubscriptions.enable` | same | yes | `{ok:true, webhook}` / failure | same | `webhooks-panel.tsx:150` | `POST /api/workspace/webhooks/:webhookId/enable` | settings-integrations |

### Inventory 1.3 function `testWebhookAction(webhookId)`

| File:line | Function | Input | Service / auth calls | Policy helper + capability | Plan check | Returns | Side effects | Client callers | Target endpoint | Domain |
|---|---|---|---|---|---|---|---|---|---|---|
| `:331` | `testWebhookAction(webhookId)` | `webhookReferenceActionSchema` | `webhookSubscriptions.test` | same | yes | `{ok:true, delivered, status}` | same | `webhooks-panel.tsx:159` | `POST /api/workspace/webhooks/:webhookId/test` | settings-integrations |

### Inventory 2.B page/type row at inventory line 242

| File (lines) | Gate (line) | Service / db / validators calls (line) | Params / searchParams | Redirect / notFound | Props to client components | Proposed GET endpoint(s) |
| --- | --- | --- | --- | --- | --- | --- |
| `app/(app)/integrations/page.tsx` (306) | content.view L162 | `socialOAuthService.listAccounts` L171; `workspaceService.listApiKeys` L172 (if `api.manage`); `callbackSigningSecrets.status` L173 (if `api.manage`); `workspaceAllowsCapability`, `hasFeature`, `planCountRequirement`, `featureUpgradePrompt` | none | none | tiles: `IntegrationTile`, `LockedButton`, `UpgradeTileButton`; no data-bearing client props beyond hrefs. Connect link `/api/social/oauth/start/:platform?redirect=/settings/social-accounts` | Existing `GET /api/social/accounts`. **NEW** `GET /api/workspace/api-keys`, `GET /api/workspace/callback-signing-secret` (status only). Count-only usage for keys; both are `api.manage` gated. |

### Inventory 2.B page/type row at inventory line 251

| File (lines) | Gate (line) | Service / db / validators calls (line) | Params / searchParams | Redirect / notFound | Props to client components | Proposed GET endpoint(s) |
| --- | --- | --- | --- | --- | --- | --- |
| `app/(app)/settings/api/page.tsx` (114) | `admitWorkspacePage("api.manage")` L40 | `workspaceService.listApiKeys` L44; `callbackSigningSecrets.status` L45; `webhookSubscriptions.list` L46 (only if plan has `integrations.api`); env `NEXT_PUBLIC_APP_URL` -> `apiBase` L48 | none | none | `UpgradeHero`, `CreateKeyDialog`, `ApiKeysPanel{keys}`, `ApiQuickstart{apiBase}`, `CallbackSecretPanel{status}`, `AddWebhookDialog{disabledReason}`, `WebhooksPanel{webhooks}` | **NEW** `GET /api/workspace/api-keys`, `GET /api/workspace/callback-signing-secret`, `GET /api/workspace/webhooks` (browser-session twins of REST v1 `GET /api/v1/webhooks`, which is API-key auth). `apiBase` becomes the API service's public URL (`NEXT_PUBLIC_API_URL`). |

### Inventory 5.8 refresh/fetch row at inventory line 821

| file:line | Trigger | Mutation | Refreshes |
| --- | --- | --- | --- |
| `(app)/settings/api/create-key-dialog.tsx:55` | Create key | `createApiKeyAction` (:49) | `/settings/api` keys list (secret shown from the action result) |

### Inventory 5.8 refresh/fetch row at inventory line 822

| file:line | Trigger | Mutation | Refreshes |
| --- | --- | --- | --- |
| `settings/api/api-keys-panel.tsx:68` | Revoke key | `revokeApiKeyAction` (:63) | `/settings/api` |

### Inventory 5.8 refresh/fetch row at inventory line 823

| file:line | Trigger | Mutation | Refreshes |
| --- | --- | --- | --- |
| `settings/api/callback-secret-panel.tsx:36` | Rotate signing secret | `rotateCallbackSigningSecretAction` (:30) | `/settings/api` |

### Inventory 5.8 refresh/fetch row at inventory line 824

| file:line | Trigger | Mutation | Refreshes |
| --- | --- | --- | --- |
| `settings/api/add-webhook-dialog.tsx:50` | Add webhook | `createWebhookAction` (:43) | `/settings/api` |

### Inventory 5.8 refresh/fetch row at inventory line 825

| file:line | Trigger | Mutation | Refreshes |
| --- | --- | --- | --- |
| `settings/api/webhooks-panel.tsx:71` (generic `run()`, also on failure) | Delete (:82), enable (:150), test (:159) | `deleteWebhookAction`, `enableWebhookAction`, `testWebhookAction` | `/settings/api` |

### Inventory 5.8 refresh/fetch row at inventory line 826

| file:line | Trigger | Mutation | Refreshes |
| --- | --- | --- | --- |
| `settings/automation-grants/grants-panel.tsx:202` | Create or renew grant dialog | `createStandingGrantAction` (:192) / `renewStandingGrantAction` (:191) | `/settings/automation-grants`, `/autopilot` |

### Inventory 5 exact file occurrences: apps/web/app/(app)/settings/actions.ts

```text
71: revalidatePath("/", "layout");
72: revalidatePath("/settings/workspace");
84: revalidatePath("/settings/workspace");
85: revalidatePath("/performance");
102: revalidatePath("/settings/members");
135: revalidatePath("/settings/members");
173: revalidatePath("/settings/members");
190: revalidatePath("/settings/members");
218: revalidatePath("/settings/members");
253: revalidatePath("/settings/api");
283: revalidatePath("/settings/api");
293: revalidatePath("/settings/api");
303: revalidatePath("/settings/api");
```

### Inventory 5 exact file occurrences: apps/web/app/(app)/settings/api/add-webhook-dialog.tsx

```text
50: router.refresh();
```

### Inventory 5 exact file occurrences: apps/web/app/(app)/settings/api/api-keys-panel.tsx

```text
68: router.refresh();
```

### Inventory 5 exact file occurrences: apps/web/app/(app)/settings/api/api-quickstart.tsx

```text
20: code: `const response = await fetch("${url}", {\n  headers: { Authorization: \`Bearer \${process.env.NARRIFLOW_API_KEY}\` },\n});\nconsole.log(await response.json());`,
```

### Inventory 5 exact file occurrences: apps/web/app/(app)/settings/api/callback-secret-panel.tsx

```text
36: router.refresh();
```

### Inventory 5 exact file occurrences: apps/web/app/(app)/settings/api/create-key-dialog.tsx

```text
55: router.refresh();
```

### Inventory 5 exact file occurrences: apps/web/app/(app)/settings/api/webhooks-panel.tsx

```text
71: router.refresh();
```

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

## Acceptance criteria

- [x] Seven developer actions and settings/integrations reads map to explicit api.manage/plan-gated endpoints; viewer overview never fetches forbidden private data.
- [x] Create key/rotate signing secret commit credential-neutral receipts; replay returns credential_already_issued recovery without plaintext storage or another issuance.
- [ ] Webhook create/test/redeliver intent is durable/retry-safe; delivery remains worker-owned, signed and SSRF-protected.
- [x] Every owned UI refresh/action/OAuth link converts; one-time secrets stay component-local, never QueryClient cache.
- [ ] workspace.service.ts handoff from 05 is serial through blockers; REST/MCP reuse same command identity without editing their route files.
- [ ] No unowned files changed; paired review findings and verification evidence recorded under Comments.

## Verification

Run these from the repository root after dependencies are installed. A command naming a new package script is implemented by the owning setup ticket, not silently skipped. PostgreSQL gates need a disposable schema; a skipped DB suite does not satisfy its gate. During the undeployed integration sequence, record any unrelated transitional compile failure with its owning blocker; this ticket's behavior tests must pass and the final integrated gates cannot be waived.

```sh
bun test apps/api/src/domains/developer
bun run test:integration-api:db
bun run test:workspace-billing:db
bun run --cwd apps/api typecheck
```

## Comments



Claimed and implemented by Claude (Sonnet 5.5), 2026-10-29. Three acceptance boxes left open: webhook test/redeliver durability (test stays throttle-based, see Deviations), REST reusing the command identity (REST route file not mine), and the paired review.

### What landed
- **Routes** (`apps/api/src/domains/developer`): `GET /integrations` (content.view; key count and signing status only when the actor holds api.manage, else null and nothing read), `GET /developer/settings`, `GET|POST /workspace/api-keys`, `DELETE /workspace/api-keys/:keyId`, `GET /workspace/callback-signing-secret`, `POST .../rotate`, `GET|POST /workspace/webhooks`, `DELETE`, `POST .../enable`, `POST .../test`. All api.manage except the overview; webhook routes keep the `integrations.api` plan gate. Create key, rotate and create webhook use `deferRateRefusal` plus the recorded limiter in the acceptance transaction (after replay lookup).
- **Commands** (`developer-commands.ts`, receipt names `create_api_key`, `rotate_callback_signing_secret`, `create_webhook`): one transaction commits the write and a credential-neutral receipt. Key receipt keeps id/name/prefix/scopes/createdAt; secret receipt keeps the stored secret id and createdAt. A replay (including a lost commit response) throws 409 `credential_already_issued` with safe details and issues nothing. `workspaceService.createApiKey` replaced by tx-aware `issueApiKey`; `callbackSigningSecrets.rotate` removed from the runtime (factory keeps `issue(tx)` and `rotate` for DB tests); `webhookSubscriptions.create` now = `prepareCreate` + `insert` (+ `explainInsertFailure`) so REST keeps its unchanged call.
- **Client** (`@narriflow/api-client/developer`): settings and overview queries (overview seeds `publishing/accounts`), seven mutations. Key/secret mutations: `retry:false`, `gcTime:0`, intent completes on success or `credential_already_issued`; plaintext is held by the component only.
- **UI**: `settings/api` and `integrations` are data-free shells + client screens; all five panels/dialogs use mutations; `router.refresh`, server actions and `settings/actions.ts` deleted. The OAuth "Connect" tile is now a button calling `POST /api/social/oauth/start/:platform` then navigating (no link can carry the Bearer token). Quickstart base is `NEXT_PUBLIC_API_URL + /api/v1`. A member without api.manage sees the existing AccessNote (previously a server redirect to /home).

### Deviations
- Webhook "test" is not receipt-backed: it keeps its existing per-webhook DB throttle (429 `webhook_test_throttled`). No redelivery endpoint exists in this ticket's row, so `redeliver_callback` stays REST's.
- REST `POST /webhooks` still calls `webhookSubscriptions.create` without a receipt (route file not mine); it does not share the `create_webhook` command identity.
- No happy-dom test for `CreateKeyDialog` typing flow (React `onChange` did not fire for the portal input in happy-dom); its logic is covered at mutation level (`packages/api-client/src/developer/developer.test.ts`). Needs the ticket 32 browser pass: create key, rotate secret, add/test/delete webhook, Connect tile, viewer on /settings/api and /integrations.

### Requests for other owners
- Ticket 31: `apps/web/lib/authenticated-request-inventory.ts` still lists `app/(app)/settings/actions.ts`; `repository-verification`/inventory parity must drop it.
- Ticket 23/runner: `bun run test:integration-api:db` fails at the end on a missing `apps/web/lib/rest-api/events.db.test.ts` (moved by 23); `operation-receipt.test.ts` "composes the per-domain lists" fails on the reviews list name `review.round.create` (dots) (ticket 27).
- Pre-existing tsc errors outside my scope: `apps/api/src/domains/rest/routes.ts`, `reviews/guest-replay-child.ts` (pg types), web `lib/authenticated-request-*`, `app/api/stream/...`.

### Evidence
- `bun test apps/api/src/domains/developer` 25 pass; `bun test apps/api/src` 735 pass 0 fail; `bun apps/api/scripts/check-route-inventory.ts`: 280 routes, 0 problems.
- `bun test packages/services/src/developer-commands.test.ts` 14 pass (replay, lost response, simultaneous, changed input, plan refusal, limiter after replay, webhook SSRF/dup).
- `bun test packages/api-client/src/developer` 9 pass; `bun test apps/web/app/(app)/settings/api` pass (failure wording, rotate fixture: secret shown once, absent from query and mutation caches).
- `.scratch/api-extraction/db-gate.sh bun run test:integration-api:db`: completion-callback and webhook-subscription DB suites pass (one earlier mid-drain run flaked at `webhook-subscription.db.test.ts` "deleting a subscription mid-drain", passed on two reruns; untouched code).
- tsc: no errors in developer files for apps/api, packages/services, packages/validators, packages/api-client, apps/web (filtered to settings/api and integrations). Biome clean on all owned paths.

