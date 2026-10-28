# 17. Move publishing OAuth queue and performance API

**What to build:** Publishing, queue, OAuth and performance endpoints keep native publication acceptance, uncertainty/recovery, account slots and callback state.

**Blocked by:** [04 - Wire API runtime and partition the catch-all](04-wire-api-runtime-and-partition-the-catch-all.md)

**Status:** ready-for-agent

**Suggested implementer:** Claude. The other pairing side reviews and returns findings to this owner.

Read [spec.md](../spec.md). It is the complete contract; the original brief/plan/reviews are not prerequisites. Claim this ticket before editing.

## Exact ownership

Paths are repo-relative. Every existing file below is exclusively assigned for this phase, including files that only need verification. A new `/**` directory includes its local tests/helpers, not adjacent directories. Read other files as evidence; do not edit them.

Existing files:

- `apps/web/app/api/[[...route]]/social-publication-http.test.ts`
- `apps/web/app/api/[[...route]]/social-publication-http.ts`
- `packages/services/src/performance.service.ts`
- `packages/services/src/posting-schedule.test.ts`
- `packages/services/src/posting-schedule.ts`
- `packages/services/src/publishing-queue.db.test.ts`
- `packages/services/src/publishing-queue.service.ts`
- `packages/services/src/social-oauth.service.ts`
- `packages/services/src/social.service.ts`

New files/directories or reserved skeletons handed off by a blocker:

- `apps/api/src/domains/publishing/**`
- `apps/api/src/types/publishing.ts`
- `packages/api-client/src/publishing/**`
- `packages/validators/src/api/publishing.ts`
- `packages/services/src/publishing-receipt-commands.ts`
- `packages/services/src/publishing-commands.ts`
- `packages/services/src/publishing-commands-runtime.ts`

The chosen new endpoints for this ticket are the matching owner row in spec.md, "Endpoint and screen contracts added by extraction". All current endpoints/actions below retain their semantics unless that row explicitly changes transport. Fill only this domain's receipt-command module; current native receipts remain native.

## Endpoints, actions, pages and refresh sites

Rows retain their section/ordinal or exact source-line identifier from the independent inventory. Abbreviated table filenames are accompanied by the literal ownership manifest and exact source occurrences below. All action/page/fetch/refresh rows in owned files are in scope, including no-refresh callers and media navigation. Baseline observations do not override the spec's selected origins, route style, guest Bearer or new endpoints.

### Inventory 1.8 function `savePostingScheduleAction(accountId, schedule: unknown)`

| File:line | Function | Input | Service / auth calls | Policy helper + capability | Plan check | Returns | Side effects | Client callers | Target endpoint | Domain |
|---|---|---|---|---|---|---|---|---|---|---|
| `app/(app)/calendar/queue/actions.ts:22` | `savePostingScheduleAction(accountId, schedule: unknown)` | `z.strictObject({accountId: uuid, schedule: postingScheduleSchema.nullable()})` | `publishingQueue.setPostingSchedule` | `executeWorkspaceActionWithInput("publishing.manage")` | none in action | `void` / failure | `revalidatePath("/calendar/queue")`, `/calendar` | `calendar/queue/posting-schedule-editor.tsx:59` (`router.refresh`:65) | `PUT /api/social/accounts/:accountId/posting-schedule` | publishing |

### Inventory 1.8 function `tiktokAcceptanceOptionsAction(accountId)`

| File:line | Function | Input | Service / auth calls | Policy helper + capability | Plan check | Returns | Side effects | Client callers | Target endpoint | Domain |
|---|---|---|---|---|---|---|---|---|---|---|
| `:35` | `tiktokAcceptanceOptionsAction(accountId)` | `z.strictObject({accountId: uuid})` | `socialPublishingOptions(actor, accountId)` (returns subset: `directEnabled, inboxEnabled, privacyOptions, commentDisabled, duetDisabled, stitchDisabled`) | `executeWorkspaceActionWithInput("publishing.manage")` | none | options subset / failure | none | `calendar/queue/proposals-inbox.tsx:94` | `GET /api/social/accounts/:accountId/tiktok-options`; existing project-scoped `GET /api/projects/:id/social-accounts/:accountId/publishing-options` returns more | publishing |

### Inventory 1.8 function `updateProposalCaptionAction(proposalId, caption)`

| File:line | Function | Input | Service / auth calls | Policy helper + capability | Plan check | Returns | Side effects | Client callers | Target endpoint | Domain |
|---|---|---|---|---|---|---|---|---|---|---|
| `:54` | `updateProposalCaptionAction(proposalId, caption)` | `updateSocialPostProposalSchema.extend({proposalId: uuid})` | `publishingQueue.updateProposalCaption` | `executeWorkspaceActionWithInput("publishing.manage")` | none | `void` / failure | revalidate queue + calendar | `proposals-inbox.tsx:240` (`router.refresh`:201 in shared `run`) | `PATCH /api/social/proposals/:proposalId` | publishing |

### Inventory 1.8 function `rejectProposalAction(proposalId)`

| File:line | Function | Input | Service / auth calls | Policy helper + capability | Plan check | Returns | Side effects | Client callers | Target endpoint | Domain |
|---|---|---|---|---|---|---|---|---|---|---|
| `:66` | `rejectProposalAction(proposalId)` | `z.strictObject({proposalId: uuid})` | `publishingQueue.reject` | same | none | `void` / failure | same | `proposals-inbox.tsx:263` | `POST /api/social/proposals/:proposalId/reject` | publishing |

### Inventory 1.8 function `acceptProposalAction(proposalId, choices)`

| File:line | Function | Input | Service / auth calls | Policy helper + capability | Plan check | Returns | Side effects | Client callers | Target endpoint | Domain |
|---|---|---|---|---|---|---|---|---|---|---|
| `:78` | `acceptProposalAction(proposalId, choices)` | `z.strictObject({proposalId, choices: acceptSocialPostProposalSchema})` (`choices ?? {}`, TikTok choices under `tiktok`) | `publishingQueue.accept` | same | none in action | `{accepted:[accepted], skippedTikTok:0, failed:[]}` / failure | same | `proposals-inbox.tsx:276`, `:290` | `POST /api/social/proposals/:proposalId/accept` | publishing |

### Inventory 1.8 function `acceptAllProposalsAction(after: string\|null = null)`

| File:line | Function | Input | Service / auth calls | Policy helper + capability | Plan check | Returns | Side effects | Client callers | Target endpoint | Domain |
|---|---|---|---|---|---|---|---|---|---|---|
| `:93` | `acceptAllProposalsAction(after: string\|null = null)` | `z.strictObject({after: uuid.nullable()})` | `publishingQueue.acceptAll(actor,{after})` (cursor batches; skips TikTok) | same | none | `{accepted, skippedTikTok, failed, nextCursor}` (caller loops until `nextCursor` null) | same | `proposals-inbox.tsx:325` (`router.refresh`:342) | `POST /api/social/proposals/accept-all` `{after}` | publishing |

### Inventory 1.8 function `proposeToQueueAction(input: unknown)`

| File:line | Function | Input | Service / auth calls | Policy helper + capability | Plan check | Returns | Side effects | Client callers | Target endpoint | Domain |
|---|---|---|---|---|---|---|---|---|---|---|
| `:102` | `proposeToQueueAction(input: unknown)` | `proposeSocialPostSchema.extend({idempotencyKey: uuid})` | `publishingQueue.propose(actor, proposal, {source:"person", mutation:{clientIdempotencyKey}})` | same | none in action | `{proposalId}` / failure | same | `app/(app)/projects/[projectId]/publishing-provider.tsx:615`; test fixture `publishing.browser.fixture.tsx:23` | `POST /api/social/proposals` with `Idempotency-Key`; REST v1 has `POST /social-posts/proposals` (API-key surface, keep separate) | publishing |

### Inventory 3.2 row 1

| # | Method | Path (under `/api`) | Source | Handler calls | Handler-level validation | Policy (cap / admission / input) | Rate limit | Flags | Style | Domain (9.4) |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | POST | `/webhooks/tiktok/publication` | route.ts:132 | `acceptTikTokPublicationWebhook` |  | independent-trust: `provider_signature` |  |  | plain Hono | P0 |

### Inventory 3.2 row 42

| # | Method | Path (under `/api`) | Source | Handler calls | Handler-level validation | Policy (cap / admission / input) | Rate limit | Flags | Style | Domain (9.4) |
|---|---|---|---|---|---|---|---|---|---|---|
| 42 | POST | `/projects/:id/assisted-copy/generations` | route.ts:834 | `assistedSocialCopyService.generate` | `type GenerateAssistedCopyRequest` | browser-session: `publishing.manage`, project(id); bodyInput(generateAssistedCopySchema, ["id"]) | actor `assisted-copy` 30/60s |  | plain Hono | D5 |

### Inventory 3.2 row 79

| # | Method | Path (under `/api`) | Source | Handler calls | Handler-level validation | Policy (cap / admission / input) | Rate limit | Flags | Style | Domain (9.4) |
|---|---|---|---|---|---|---|---|---|---|---|
| 79 | GET | `/social/accounts` | route.ts:1483 | `socialOAuthService.listAccounts` |  | browser-session: `social.manage`, workspace |  |  | plain Hono | D5 |

### Inventory 3.2 row 80

| # | Method | Path (under `/api`) | Source | Handler calls | Handler-level validation | Policy (cap / admission / input) | Rate limit | Flags | Style | Domain (9.4) |
|---|---|---|---|---|---|---|---|---|---|---|
| 80 | GET | `/social/oauth/start/:platform` | route.ts:1489 | `socialOAuthService.createAuthorizationUrl` | `socialPlatformSchema` | browser-session: `social.manage`, workspace |  | redirect | plain Hono | D5 |

### Inventory 3.2 row 81

| # | Method | Path (under `/api`) | Source | Handler calls | Handler-level validation | Policy (cap / admission / input) | Rate limit | Flags | Style | Domain (9.4) |
|---|---|---|---|---|---|---|---|---|---|---|
| 81 | GET | `/social/oauth/callback` | route.ts:1531 | `socialOAuthService.handleCallback` |  | independent-trust: `oauth_callback` |  | redirect | plain Hono | D5 |

### Inventory 3.2 row 82

| # | Method | Path (under `/api`) | Source | Handler calls | Handler-level validation | Policy (cap / admission / input) | Rate limit | Flags | Style | Domain (9.4) |
|---|---|---|---|---|---|---|---|---|---|---|
| 82 | GET | `/social/oauth/facebook-selection/:token` | route.ts:1588 | `socialOAuthService.getFacebookPageSelection` |  | browser-session: `social.manage`, workspace |  |  | plain Hono | D5 |

### Inventory 3.2 row 83

| # | Method | Path (under `/api`) | Source | Handler calls | Handler-level validation | Policy (cap / admission / input) | Rate limit | Flags | Style | Domain (9.4) |
|---|---|---|---|---|---|---|---|---|---|---|
| 83 | POST | `/social/oauth/facebook-selection/:token` | route.ts:1618 | `socialOAuthService.completeFacebookPageSelection` |  | browser-session: `social.manage`, workspace | actor `facebook-page-selection` 10/900s |  | plain Hono | D5 |

### Inventory 3.2 row 84

| # | Method | Path (under `/api`) | Source | Handler calls | Handler-level validation | Policy (cap / admission / input) | Rate limit | Flags | Style | Domain (9.4) |
|---|---|---|---|---|---|---|---|---|---|---|
| 84 | DELETE | `/social/accounts/:accountId` | route.ts:1655 | `socialOAuthService.disconnectAccount` |  | browser-session: `social.manage`, workspace |  |  | plain Hono | D5 |

### Inventory 3.2 row 151

| # | Method | Path (under `/api`) | Source | Handler calls | Handler-level validation | Policy (cap / admission / input) | Rate limit | Flags | Style | Domain (9.4) |
|---|---|---|---|---|---|---|---|---|---|---|
| 151 | POST | `/projects/:id/campaign-operations/schedule/preview` | social-publication-http.ts:31 | `bulkSocialSchedulingService.preview` | `type PublishingPreviewRequest` | browser-session: `publishing.manage`, project(id); bodyInput(publishingPreviewSchema, ["id"]) | actor `publishing-preview` 60/60s |  | plain Hono | D5 |

### Inventory 3.2 row 152

| # | Method | Path (under `/api`) | Source | Handler calls | Handler-level validation | Policy (cap / admission / input) | Rate limit | Flags | Style | Domain (9.4) |
|---|---|---|---|---|---|---|---|---|---|---|
| 152 | POST | `/projects/:id/campaign-operations/schedule` | social-publication-http.ts:37 | `bulkSocialSchedulingService.schedule` | `type BulkSocialScheduleRequest` | browser-session: `publishing.manage`, project(id); bodyInput(bulkSocialScheduleSchema, ["id"]) | actor `campaign-schedule` 20/3600s |  | plain Hono | D5 |

### Inventory 3.2 row 153

| # | Method | Path (under `/api`) | Source | Handler calls | Handler-level validation | Policy (cap / admission / input) | Rate limit | Flags | Style | Domain (9.4) |
|---|---|---|---|---|---|---|---|---|---|---|
| 153 | GET | `/projects/:id/social-accounts/:accountId/publishing-options` | social-publication-http.ts:48 | `socialPublishingOptions` |  | browser-session: `content.view`, project(id); paramsInput("id", "accountId") | actor `publishing-options` 30/60s |  | plain Hono | D5 |

### Inventory 3.2 row 154

| # | Method | Path (under `/api`) | Source | Handler calls | Handler-level validation | Policy (cap / admission / input) | Rate limit | Flags | Style | Domain (9.4) |
|---|---|---|---|---|---|---|---|---|---|---|
| 154 | POST | `/projects/:id/social-posts/:postId/refresh-inbox` | social-publication-http.ts:54 | `refreshTikTokInbox` |  | browser-session: `publishing.manage`, project(id); paramsInput("id", "postId") | actor `refresh-inbox` 20/60s |  | plain Hono | D5 |

### Inventory 3.2 row 155

| # | Method | Path (under `/api`) | Source | Handler calls | Handler-level validation | Policy (cap / admission / input) | Rate limit | Flags | Style | Domain (9.4) |
|---|---|---|---|---|---|---|---|---|---|---|
| 155 | GET | `/projects/:id/social-posts` | social-publication-http.ts:60 | `socialService.listProjectPosts` |  | browser-session: `content.view`, project(id); paramsInput("id") |  |  | plain Hono | D5 |

### Inventory 3.2 row 156

| # | Method | Path (under `/api`) | Source | Handler calls | Handler-level validation | Policy (cap / admission / input) | Rate limit | Flags | Style | Domain (9.4) |
|---|---|---|---|---|---|---|---|---|---|---|
| 156 | DELETE | `/projects/:id/social-posts/:postId` | social-publication-http.ts:71 | `socialService.cancelPost` |  | browser-session: `publishing.manage`, project(id); paramsInput("id", "postId") |  |  | plain Hono | D5 |

### Inventory 3.2 row 157

| # | Method | Path (under `/api`) | Source | Handler calls | Handler-level validation | Policy (cap / admission / input) | Rate limit | Flags | Style | Domain (9.4) |
|---|---|---|---|---|---|---|---|---|---|---|
| 157 | GET | `/projects/:id/social-posts/:postId/publication` | social-publication-http.ts:77 | `socialService.inspectPublication` |  | browser-session: `content.view`, project(id); paramsInput("id", "postId") |  |  | plain Hono | D5 |

### Inventory 3.2 row 158

| # | Method | Path (under `/api`) | Source | Handler calls | Handler-level validation | Policy (cap / admission / input) | Rate limit | Flags | Style | Domain (9.4) |
|---|---|---|---|---|---|---|---|---|---|---|
| 158 | POST | `/projects/:id/social-posts/:postId/recheck` | social-publication-http.ts:83 | `socialService.recheckPublication` | `type RecheckSocialPublicationInput` | browser-session: `publishing.manage`, project(id); bodyInput(recheckSocialPublicationSchema, ["id", "postId"]) |  |  | plain Hono | D5 |

### Inventory 3.2 row 159

| # | Method | Path (under `/api`) | Source | Handler calls | Handler-level validation | Policy (cap / admission / input) | Rate limit | Flags | Style | Domain (9.4) |
|---|---|---|---|---|---|---|---|---|---|---|
| 159 | POST | `/projects/:id/social-posts/:postId/confirm` | social-publication-http.ts:91 | `socialService.confirmPublication` | `type ConfirmSocialPublicationInput` | browser-session: `publishing.manage`, project(id); bodyInput(confirmSocialPublicationSchema, ["id", "postId"]) |  |  | plain Hono | D5 |

### Inventory 3.2 row 160

| # | Method | Path (under `/api`) | Source | Handler calls | Handler-level validation | Policy (cap / admission / input) | Rate limit | Flags | Style | Domain (9.4) |
|---|---|---|---|---|---|---|---|---|---|---|
| 160 | POST | `/projects/:id/social-posts/:postId/publish-again` | social-publication-http.ts:99 | `socialService.republishPublication` | `type RepublishSocialPublicationInput` | browser-session: `publishing.manage`, project(id); bodyInput(republishSocialPublicationSchema, ["id", "postId"]) |  |  | plain Hono | D5 |

### Inventory 1.8 function `cancelWorkspacePostAction(projectId, postId)`

| File:line | Function | Input | Service / auth calls | Policy helper + capability | Plan check | Returns | Side effects | Client callers | Target endpoint | Domain |
|---|---|---|---|---|---|---|---|---|---|---|
| `app/(app)/calendar/actions.ts:7` | `cancelWorkspacePostAction(projectId, postId)` | `string, string` | `socialService.cancelPost(appUser, projectId, postId)` | `executeProjectAction(projectId,"publishing.manage")` | none | `void` / failure | `revalidatePath("/calendar")` | `app/(app)/calendar/page.tsx:415` (`AuthenticatedActionForm action={cancelWorkspacePostAction.bind(null, projectId, postId)}`) | existing `DELETE /api/projects/:id/social-posts/:postId` (`social-publication-http.ts:71`, verify) | publishing |

## Acceptance criteria

- [ ] All 17 publishing routes and TikTok publication webhook move; raw provider validation/publication correlation retained.
- [ ] OAuth starts POST authorizationUrl; callbacks consume state/current membership and use API redirect plus safe WEB_ORIGIN destination.
- [ ] Queue/schedule/proposal commands preserve account locks/cursor batches/TikTok choices and skipped counts; retryable commands use current receipts or atomic new ones.
- [ ] Calendar/performance aggregates preserve timezone/window +/-36h/filter/feature semantics and never expose provider credentials.
- [ ] No unowned files changed; paired review findings and verification evidence recorded under Comments.

## Verification

Run these from the repository root after dependencies are installed. A command naming a new package script is implemented by the owning setup ticket, not silently skipped. PostgreSQL gates need a disposable schema; a skipped DB suite does not satisfy its gate. During the undeployed integration sequence, record any unrelated transitional compile failure with its owning blocker; this ticket's behavior tests must pass and the final integrated gates cannot be waived.

```sh
bun test apps/api/src/domains/publishing
bun run test:social-publication:db
bun run test:vizard-expansion:db
bun run --cwd apps/api typecheck
```

## Comments

Append claim, requested seam changes, paired review and evidence here.
