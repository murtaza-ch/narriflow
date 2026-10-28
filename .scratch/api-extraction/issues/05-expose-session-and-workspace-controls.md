# 05. Expose session and Workspace controls

**What to build:** Session/Workspace/bootstrap/member/invite/censor/profile commands expose the former server reads/actions with current membership and capability checks.

**Blocked by:** [04 - Wire API runtime and partition the catch-all](04-wire-api-runtime-and-partition-the-catch-all.md)

**Status:** done

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

- [x] All copied action/read rows map to chosen spec endpoints with exact capability and safe DTO; bootstrap and switching remain usable from restricted Workspaces.
- [x] Member/invite operations retain seat limits, acting-member attribution, email deduplication and human WEB_ORIGIN links.
- [x] Workspace create/invite commands add transaction-aware receipt identities and test concurrent/lost-response replay; no plaintext token/secret is logged.
- [x] Removed selection cannot run a command in personal Workspace; signed-in invite accept returns explicit selection and navigation facts.
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

Claimed and implemented by Claude (Sonnet 5.5), 2026-10-29. Paired review not run by the implementer (last acceptance box left open for the orchestrator).

### Contract for other tickets
- **Session routes** (`domains/session`, all `signed_in`): `GET /session/bootstrap` (`SessionBootstrap`: user, memberships with role/status/plan/avatar, `selection {workspaceId, workspaceSelectionChanged}`, capabilities of the effective Workspace, `authContinuation {issuerUrl, consentOrigin}`; sets `X-Workspace-Id`), `POST /session/workspace-selection {workspaceId}` (live membership only; non-member = 403 `workspace_access_denied`), `GET /invites/:token` (preview), `POST /invites/:token/accept` (returns `WorkspaceSelection` + `destination: "/home"`, sets `X-Workspace-Id`, no cookie).
- **Workspace routes** (`domains/workspace`): the 14 routes of the spec row plus the two avatar routes. Capabilities exactly as the old actions (`content.view` reads; `workspace.manage` settings/guidance/censor PUT+DELETE/avatar; `members.invite` invites/members). Invite create/resend need `Idempotency-Key` and are receipt-backed (`deferRateRefusal`, limiter enforced in `beforeAccept` after replay lookup). Replay: HTTP 200, `Idempotent-Replayed: true`, `inviteUrl`/`emailSent` are `null` (the raw token is a credential and is never stored in a receipt; the admin uses Resend). First acceptance: 201 with `inviteUrl` on WEB_ORIGIN and the email sent with provider key `workspace-invite/<inviteId>`.
- **DTOs/schemas**: `@narriflow/validators/api/session` and `/api/workspace` (`workspaceCapabilities(context)`, `WORKSPACE_CAPABILITY_NAMES`, all request schemas, response types). `PUT /workspace/censor-words` body is `{words}` (was a bare array in the action).
- **api-client** (`session/`, `workspace/`): `sessionBootstrapQuery`, `inviteQuery`, `selectWorkspaceMutation`, `acceptInviteMutation`; `workspaceBootstrapQuery` (seeds the usage key), `workspaceProfileQuery`, `workspaceUsageQuery`, `workspaceMembersQuery`, `workspaceCensorWordsQuery`, mutations for update, avatar presign/set, performance guidance, invite/resend (own idempotency intent per factory: create once per form), revoke, role change, remove, censor replace/reset, plus `invalidateWorkspaceProfile|Members`. Factories take `(api: ApiRuntime | api.transport, scope)`.
- **For ticket 07**: `workspaceCommands.createBusinessWorkspace(actorUserId, {name}, {clientIdempotencyKey, beforeAccept?})` (services index) creates the pending Workspace in the receipt transaction (receipt recorded under the actor's personal Workspace) and returns `{workspaceId, name, replayed}`. Call it from `POST /workspaces/business-checkout` before `billingService.startCheckout`.
- **For ticket 17/18**: `performanceGuidanceMutation` invalidates `scopedKey(scope, "publishing", "guidance")`; key the guidance read that way (or tell 05's owner the real key).

### Deviations from the spec
- `GET /session/bootstrap` reads the selection hint from `X-Workspace-Id` **or** `?workspaceId=`. The transport's `identity()` binding deletes the header (and a `scoped()` binding rejects a fallback response as `workspace_response_mismatch`), so identity-only clients cannot send it; the query parameter is the same hint, validated against live membership. `sessionBootstrapQuery(transport, scope, hint)` uses it.
- Avatar routes gained shared validators; a non-numeric `sizeBytes` is now `invalid_input` (400) instead of the service's `workspace_avatar_invalid` (also 400).
- A replayed invite response carries no link (see above); the old action always returned `inviteUrl`.

### Requests for other owners
- 04/31: `packages/api-client/src/index.ts` exports only the three client symbols per domain. Add `export * from "./session"; export * from "./workspace";` (and equivalents) so `workspaceBootstrapQuery`, mutations and invalidators reach `@narriflow/api-client` (names are collision-free, prefixed by domain).
- 04/31: `apps/api/src/route-inventory.test.ts:27` hard-codes `checkedRoutes` to 108; every domain ticket invalidates it (now 250). Replace with a lower bound or drop it.
- 02/04: `ApiConfig` has no `CLERK_OAUTH_ISSUER` / `CLERK_OAUTH_CONSENT_ORIGIN`; `session/runtime.ts` reads and origin-validates them from `process.env` (null when unset). Move them into `loadApiConfig` when convenient.
- 06: replace `app/(app)/_actions/workspace.ts`, `app/invite/[token]/actions.ts`, the settings/members/workspace actions and `censor-words-actions.ts` with these clients; on switch/accept call the mutation, then navigate (`destination`).
- Unrelated existing failures seen, not mine: `apps/api/src/domains/rest/routes.ts(176)` and `reviews/guest-replay-child.ts` type errors (23/27); two `vizard-expansion.db.test.ts` review tests fail in `test:vizard-expansion:db` (27).

### Evidence
- `bun test apps/api/src/domains/session` 11 pass; `bun test apps/api/src/domains/workspace` 24 pass; `bun test packages/api-client/src/{session,workspace}` 7 pass; `bun test packages/services/src/workspace-commands.test.ts` 8 pass (concurrent same-key, lost commit response, changed input, token never in receipt, replay skips limiter but reauthorizes).
- `.scratch/api-extraction/db-gate.sh bun run test:vizard-expansion:db`: `workspace-membership.db.test.ts` 8 pass (5 new: four simultaneous invites -> one invite, one receipt, one token holder, hash matches, receipt has no token; lost-response replay; changed-input conflict; plan refusal leaves nothing; resend once per key; three simultaneous Workspace creations -> one pending Business Workspace). Two failures in the same command are `vizard-expansion.db.test.ts` review tests (ticket 27's area).
- `db-gate.sh bun run test:authenticated-request-policy:db` 4 pass; `db-gate.sh bun run test:workspace-billing:db` 16 pass.
- Typecheck: `apps/api`, `packages/services`, `packages/validators` clean for my paths; `packages/api-client` shows only `apps/api/src/domains/rest/routes.ts(176)` (23). `bun run --cwd apps/api test:inventory` -> `problems=0`.
- `bunx biome check` on all owned paths: clean.
- Added `packages/services/src/workspace-commands.test.ts` (not in the manifest; next to its owned implementation).
