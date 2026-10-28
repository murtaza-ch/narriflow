# 05. Expose session and Workspace controls

**What to build:** Session/Workspace/bootstrap/member/invite/censor/profile commands expose the former server reads/actions with current membership and capability checks.

**Blocked by:** [04 - Wire API runtime and partition the catch-all](04-wire-api-runtime-and-partition-the-catch-all.md)

**Status:** ready-for-agent

**Suggested implementer:** Claude. The other pairing side reviews and returns findings to this owner.

Read [spec.md](../spec.md). It is the complete contract; the original brief/plan/reviews are not prerequisites. Claim this ticket before editing.

## Exact ownership

Paths are repo-relative. Every existing file below is exclusively assigned for this phase, including files that only need verification. A new `/**` directory includes its local tests/helpers, not adjacent directories. Read other files as evidence; do not edit them.

Existing files:

- `packages/services/src/workspace-membership.db.test.ts`
- `packages/services/src/workspace-membership.service.test.ts`
- `packages/services/src/workspace-membership.service.ts`
- `packages/services/src/workspace.service.test.ts`
- `packages/services/src/workspace.service.ts`

New files/directories or reserved skeletons handed off by a blocker:

- `apps/api/src/domains/session/**`
- `apps/api/src/types/session.ts`
- `packages/api-client/src/session/**`
- `packages/validators/src/api/session.ts`
- `apps/api/src/domains/workspace/**`
- `apps/api/src/types/workspace.ts`
- `packages/api-client/src/workspace/**`
- `packages/validators/src/api/workspace.ts`
- `packages/services/src/workspace-receipt-commands.ts`
- `packages/services/src/workspace-commands.ts`
- `packages/services/src/workspace-commands-runtime.ts`

The chosen new endpoints for this ticket are the matching owner row in spec.md, "Endpoint and screen contracts added by extraction". All current endpoints/actions below retain their semantics unless that row explicitly changes transport. Fill only this domain's receipt-command module; current native receipts remain native.

## Endpoints, actions, pages and refresh sites

Rows retain their section/ordinal or exact source-line identifier from the independent inventory. Abbreviated table filenames are accompanied by the literal ownership manifest and exact source occurrences below. All action/page/fetch/refresh rows in owned files are in scope, including no-refresh callers and media navigation. Baseline observations do not override the spec's selected origins, route style, guest Bearer or new endpoints.

### Inventory 1.1 function `switchWorkspaceAction(workspaceId)`

| File:line | Function | Input | Service / auth calls | Policy helper + capability | Plan check | Returns | Side effects | Client callers | Target endpoint | Domain |
|---|---|---|---|---|---|---|---|---|---|---|
| `app/(app)/_actions/workspace.ts:13` | `switchWorkspaceAction(workspaceId)` | `workspaceSelectionActionSchema` `{workspaceId}` | `setActiveWorkspaceForActor` (`@narriflow/auth`; membership check + **sets cookie**) | `executeSignedInActionWithInput` (deliberately not workspace-scoped: a member of a paused workspace needs a way out) | none | `void` / `AuthenticatedActionFailure` | `revalidatePath("/", "layout")` | `app/workspace-unavailable/open-workspace-button.tsx:25` (then `router.push("/home")`), `app/(app)/projects/_components/workspace-mismatch-notice.tsx:49` (`router.push`+`router.refresh`), `app/(app)/integrations/mcp/workspace-billing-link.tsx:27` (`router.push`), `app/(app)/_components/workspace-switcher.tsx:51` (`router.refresh`:62), `app/(app)/_components/app-chrome.tsx:77` (`router.refresh`:88) | Client-only: store selected workspace id and send as header; optionally `POST /api/me/active-workspace` that validates membership and returns the workspace context. On success clients invalidate **all** queries. | workspace |

### Inventory 1.1 function `acceptWorkspaceInviteAction(token)`

| File:line | Function | Input | Service / auth calls | Policy helper + capability | Plan check | Returns | Side effects | Client callers | Target endpoint | Domain |
|---|---|---|---|---|---|---|---|---|---|---|
| `app/invite/[token]/actions.ts:12` | `acceptWorkspaceInviteAction(token)` | `workspaceInviteAcceptanceActionSchema` `{token}` | `workspaceMembershipService.acceptInvite`, `setActiveWorkspaceForActor` (cookie) | `executeSignedInActionWithInput` | none | on failure `{ok:false, error, code, message}`; on success **`redirect("/home")`** | `redirect("/home")`; sets active-workspace cookie | `app/invite/[token]/page.tsx:20` via `action={acceptWorkspaceInviteAction.bind(null, token)}` into `invite-view.tsx:102` `AuthenticatedActionForm` | `POST /api/invites/:token/accept` -> `{workspaceId}`; client then sets active workspace and navigates to `/home` | workspace |

### Inventory 1.2 function `updateWorkspaceAction(formData)`

| File:line | Function | Input | Service / auth calls | Policy helper + capability | Plan check | Returns | Side effects | Client callers | Target endpoint | Domain |
|---|---|---|---|---|---|---|---|---|---|---|
| `app/(app)/settings/actions.ts:56` | `updateWorkspaceAction(formData)` | `workspaceSettingsActionSchema` `{name, timezone}` from `name`, `timezone` form fields | `workspaceService.updateWorkspace(actorUserId, workspaceId, {name,timezone})` | `executeWorkspaceActionWithInput("workspace.manage")` | none | `void` / failure | `revalidatePath("/", "layout")`, `/settings/workspace` | `app/(app)/settings/workspace/page.tsx:57` (`AuthenticatedActionForm action=`) | `PATCH /api/workspace` | settings-integrations |

### Inventory 1.2 function `updatePerformanceGuidanceAction(formData)`

| File:line | Function | Input | Service / auth calls | Policy helper + capability | Plan check | Returns | Side effects | Client callers | Target endpoint | Domain |
|---|---|---|---|---|---|---|---|---|---|---|
| `:77` | `updatePerformanceGuidanceAction(formData)` | `performanceGuidanceSettingActionSchema` `{enabled}` (`enabled === "on"`) | `performanceService.setGuidanceEnabled(appUser, enabled)` | `executeWorkspaceActionWithInput("workspace.manage")` | none | `void` / failure | `revalidatePath("/settings/workspace")`, `/performance` | `settings/workspace/page.tsx:77` | `PATCH /api/workspace/performance-guidance` | settings-integrations |

### Inventory 1.2 function `inviteMemberAction({email, role})`

| File:line | Function | Input | Service / auth calls | Policy helper + capability | Plan check | Returns | Side effects | Client callers | Target endpoint | Domain |
|---|---|---|---|---|---|---|---|---|---|---|
| `:90` | `inviteMemberAction({email, role})` | `workspaceInviteActionSchema` | `workspaceService.createInvite`, **`sendEmail` (`@narriflow/email`)** via local `deliverWorkspaceInvite`; invite URL built from `process.env.NEXT_PUBLIC_APP_URL` (fallback `http://localhost:3000`) + `/invite/:token`, email idempotency key `workspace-invite/${id}` | `executeWorkspaceActionWithInput("members.invite")` | none at action layer (seat limits inside service) | `{ok:true, inviteUrl, emailSent}` / `{ok:false, error, errorCode, requestId}` (double try/catch via `authenticatedActionResultError`) | `revalidatePath("/settings/members")` | `app/(app)/settings/members/members-panel.tsx:143` (`router.refresh`:156) | `POST /api/workspace/invites` | workspace |

### Inventory 1.2 function `resendInviteAction(inviteId)`

| File:line | Function | Input | Service / auth calls | Policy helper + capability | Plan check | Returns | Side effects | Client callers | Target endpoint | Domain |
|---|---|---|---|---|---|---|---|---|---|---|
| `:126` | `resendInviteAction(inviteId)` | `workspaceInviteReferenceActionSchema` `{inviteId}` | `workspaceService.resendInvite`, same email delivery | `executeWorkspaceActionWithInput("members.invite")` | none | same shape as invite | `revalidatePath("/settings/members")` | `members-panel.tsx:164` (`router.refresh`:175) | `POST /api/workspace/invites/:inviteId/resend` | workspace |

### Inventory 1.2 function `revokeInviteAction(inviteId)`

| File:line | Function | Input | Service / auth calls | Policy helper + capability | Plan check | Returns | Side effects | Client callers | Target endpoint | Domain |
|---|---|---|---|---|---|---|---|---|---|---|
| `:169` | `revokeInviteAction(inviteId)` | `workspaceInviteReferenceActionSchema` | `workspaceService.revokeInvite` | `executeWorkspaceActionWithInput("members.invite")` | none | `void` / failure | `revalidatePath("/settings/members")` | `members-panel.tsx:181` (`router.refresh`:191) | `DELETE /api/workspace/invites/:inviteId` | workspace |

### Inventory 1.2 function `changeMemberRoleAction(memberId, role)`

| File:line | Function | Input | Service / auth calls | Policy helper + capability | Plan check | Returns | Side effects | Client callers | Target endpoint | Domain |
|---|---|---|---|---|---|---|---|---|---|---|
| `:177` | `changeMemberRoleAction(memberId, role)` | `workspaceMemberRoleActionSchema` `{memberId, role}` | `workspaceMembershipService.changeRole` | `executeWorkspaceActionWithInput("members.invite")` | none | `{ok:true}` / `{ok:false, error, errorCode, requestId}` | `revalidatePath("/settings/members")` | `members-panel.tsx:207` (`router.refresh`:211) | `PATCH /api/workspace/members/:memberId` | workspace |

### Inventory 1.2 function `removeMemberAction(memberId)`

| File:line | Function | Input | Service / auth calls | Policy helper + capability | Plan check | Returns | Side effects | Client callers | Target endpoint | Domain |
|---|---|---|---|---|---|---|---|---|---|---|
| `:209` | `removeMemberAction(memberId)` | `workspaceMemberReferenceActionSchema` | `workspaceMembershipService.removeMember` | `executeWorkspaceActionWithInput("members.invite")` | none | `{ok:true}` / `{ok:false, ...}` | `revalidatePath("/settings/members")` | `members-panel.tsx:219` (`router.refresh`:223) | `DELETE /api/workspace/members/:memberId` | workspace |

### Inventory 1.3 function `replaceCensorWordsAction(input)`

| File:line | Function | Input | Service / auth calls | Policy helper + capability | Plan check | Returns | Side effects | Client callers | Target endpoint | Domain |
|---|---|---|---|---|---|---|---|---|---|---|
| `app/(app)/settings/workspace/censor-words-actions.ts:17` | `replaceCensorWordsAction(input)` | `workspaceCensorWordsSchema` | `autoCensorService.replaceWorkspaceWords` | `executeWorkspaceActionWithInput("workspace.manage")` | none in action | `{ok:true, ...saved}` | `revalidatePath("/settings/workspace")` | `app/(app)/settings/workspace/censor-words-card.tsx:93` (`save:`); Studio page passes it as prop `replaceWorkspaceCensorWords` (`studio/page.tsx:322`) -> `studio-shell.tsx:712` -> `tool-panels/censor-panel.tsx:309` | `PUT /api/workspace/censor-words` | settings-integrations (shared with clips-studio) |

### Inventory 1.3 function `resetCensorWordsAction()`

| File:line | Function | Input | Service / auth calls | Policy helper + capability | Plan check | Returns | Side effects | Client callers | Target endpoint | Domain |
|---|---|---|---|---|---|---|---|---|---|---|
| `:30` | `resetCensorWordsAction()` | none | `autoCensorService.resetWorkspaceWords` | `executeWorkspaceAction("workspace.manage")` | none | `{ok:true, ...saved}` | same | `censor-words-card.tsx:94`; `studio/page.tsx:323` -> `censor-panel.tsx:310` | `DELETE /api/workspace/censor-words` (reset to default) | settings-integrations (shared with clips-studio) |



### Inventory 3.2 row 18

| # | Method | Path (under `/api`) | Source | Handler calls | Handler-level validation | Policy (cap / admission / input) | Rate limit | Flags | Style | Domain (9.4) |
|---|---|---|---|---|---|---|---|---|---|---|
| 18 | POST | `/workspace/avatar/presign` | route.ts:421 | `workspaceService.presignAvatarUpload` |  | browser-session: `workspace.manage`, workspace |  |  | plain Hono | D1 |

### Inventory 3.2 row 19

| # | Method | Path (under `/api`) | Source | Handler calls | Handler-level validation | Policy (cap / admission / input) | Rate limit | Flags | Style | Domain (9.4) |
|---|---|---|---|---|---|---|---|---|---|---|
| 19 | PATCH | `/workspace/avatar` | route.ts:435 | `workspaceService.setAvatar` |  | browser-session: `workspace.manage`, workspace |  |  | plain Hono | D1 |

## Acceptance criteria

- [ ] All copied action/read rows map to chosen spec endpoints with exact capability and safe DTO; bootstrap and switching remain usable from restricted Workspaces.
- [ ] Member/invite operations retain seat limits, acting-member attribution, email deduplication and human WEB_ORIGIN links.
- [ ] Workspace create/invite commands add transaction-aware receipt identities and test concurrent/lost-response replay; no plaintext token/secret is logged.
- [ ] Removed selection cannot run a command in personal Workspace; signed-in invite accept returns explicit selection and navigation facts.
- [ ] No unowned files changed; paired review findings and verification evidence recorded under Comments.

## Verification

Run these from the repository root after dependencies are installed. A command naming a new package script is implemented by the owning setup ticket, not silently skipped. PostgreSQL gates need a disposable schema; a skipped DB suite does not satisfy its gate. During the undeployed integration sequence, record any unrelated transitional compile failure with its owning blocker; this ticket's behavior tests must pass and the final integrated gates cannot be waived.

```sh
bun test apps/api/src/domains/workspace
bun test apps/api/src/domains/session
bun run test:authenticated-request-policy:db
bun run test:workspace-billing:db
bun run --cwd apps/api typecheck
```

## Comments

Append claim, requested seam changes, paired review and evidence here.
