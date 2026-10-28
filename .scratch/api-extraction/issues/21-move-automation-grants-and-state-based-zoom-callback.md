# 21. Move automation grants and state-based Zoom callback

**What to build:** Automation and grants keep acting-member/plan/consent rules, while Zoom callback resolves identity from consumed stored state rather than a Clerk navigation cookie.

**Blocked by:** [04 - Wire API runtime and partition the catch-all](04-wire-api-runtime-and-partition-the-catch-all.md), [15 - Move intake Upload Sessions and recipes](15-move-intake-upload-sessions-and-recipes.md)

**Status:** ready-for-agent

**Suggested implementer:** Claude. The other pairing side reviews and returns findings to this owner.

Read [spec.md](../spec.md). It is the complete contract; the original brief/plan/reviews are not prerequisites. Claim this ticket before editing.

## Exact ownership

Paths are repo-relative. Every existing file below is exclusively assigned for this phase, including files that only need verification. A new `/**` directory includes its local tests/helpers, not adjacent directories. Read other files as evidence; do not edit them.

Existing files:

- `apps/web/app/api/[[...route]]/zoom-http.test.ts`
- `apps/web/app/api/[[...route]]/zoom-http.ts`
- `packages/services/src/autopilot.service.test.ts`
- `packages/services/src/autopilot.service.ts`
- `packages/services/src/standing-grant-runtime.ts`
- `packages/services/src/standing-grant.db.test.ts`
- `packages/services/src/standing-grant.ts`
- `packages/services/src/zoom.db.test.ts`
- `packages/services/src/zoom.service.ts`
- `packages/services/src/zoom.test.ts`
- `packages/services/src/zoom.ts`

New files/directories or reserved skeletons handed off by a blocker:

- `apps/api/src/domains/automation/**`
- `apps/api/src/types/automation.ts`
- `packages/api-client/src/automation/**`
- `packages/validators/src/api/automation.ts`
- `packages/services/src/automation-receipt-commands.ts`
- `packages/services/src/automation-commands.ts`
- `packages/services/src/automation-commands-runtime.ts`

The chosen new endpoints for this ticket are the matching owner row in spec.md, "Endpoint and screen contracts added by extraction". All current endpoints/actions below retain their semantics unless that row explicitly changes transport. Fill only this domain's receipt-command module; current native receipts remain native.

## Endpoints, actions, pages and refresh sites

Rows retain their section/ordinal or exact source-line identifier from the independent inventory. Abbreviated table filenames are accompanied by the literal ownership manifest and exact source occurrences below. All action/page/fetch/refresh rows in owned files are in scope, including no-refresh callers and media navigation. Baseline observations do not override the spec's selected origins, route style, guest Bearer or new endpoints.

### Inventory 1.3 function `createStandingGrantAction(input)`

| File:line | Function | Input | Service / auth calls | Policy helper + capability | Plan check | Returns | Side effects | Client callers | Target endpoint | Domain |
|---|---|---|---|---|---|---|---|---|---|---|
| `app/(app)/settings/automation-grants/actions.ts:14` | `createStandingGrantAction(input)` | `createStandingGrantSchema` | `standingGrants.create` | `executeWorkspaceActionWithInput("workspace.manage")` | none in action | `void` / failure | `revalidatePath("/settings/automation-grants")`, `/autopilot` | `settings/automation-grants/grants-panel.tsx:192` (`router.refresh`:202) | `POST /api/automation/standing-grants` | settings-integrations |

### Inventory 1.3 function `renewStandingGrantAction(input)`

| File:line | Function | Input | Service / auth calls | Policy helper + capability | Plan check | Returns | Side effects | Client callers | Target endpoint | Domain |
|---|---|---|---|---|---|---|---|---|---|---|
| `:22` | `renewStandingGrantAction(input)` | `renewStandingGrantSchema` | `standingGrants.renew` | same | none | same | same | `grants-panel.tsx:191` | `POST /api/automation/standing-grants/:grantId/renew` | settings-integrations |

### Inventory 1.3 function `pauseStandingGrantAction(grantId)`

| File:line | Function | Input | Service / auth calls | Policy helper + capability | Plan check | Returns | Side effects | Client callers | Target endpoint | Domain |
|---|---|---|---|---|---|---|---|---|---|---|
| `:29` | `pauseStandingGrantAction(grantId)` | `standingGrantReferenceSchema` | `standingGrants.pause` | same | none | same | same | `grants-panel.tsx:469` (`router.refresh`:364 in `run`) | `POST /api/automation/standing-grants/:grantId/pause` | settings-integrations |

### Inventory 1.3 function `revokeStandingGrantAction(grantId)`

| File:line | Function | Input | Service / auth calls | Policy helper + capability | Plan check | Returns | Side effects | Client callers | Target endpoint | Domain |
|---|---|---|---|---|---|---|---|---|---|---|
| `:36` | `revokeStandingGrantAction(grantId)` | `standingGrantReferenceSchema` | `standingGrants.revoke` | same | none | same | same | `grants-panel.tsx:375` | `POST /api/automation/standing-grants/:grantId/revoke` | settings-integrations |

### Inventory 3.2 row 3

| # | Method | Path (under `/api`) | Source | Handler calls | Handler-level validation | Policy (cap / admission / input) | Rate limit | Flags | Style | Domain (9.4) |
|---|---|---|---|---|---|---|---|---|---|---|
| 3 | GET | `/autopilot/rules` | route.ts:242 | `autopilotService.listRules` |  | browser-session: `content.view`, workspace |  |  | plain Hono | D8 |

### Inventory 3.2 row 4

| # | Method | Path (under `/api`) | Source | Handler calls | Handler-level validation | Policy (cap / admission / input) | Rate limit | Flags | Style | Domain (9.4) |
|---|---|---|---|---|---|---|---|---|---|---|
| 4 | POST | `/autopilot/rules` | route.ts:249 | `autopilotService.createRule` | `autopilotRuleInputSchema` | browser-session: `content.edit`, workspace | workspace `autopilot-create` 5/3600s |  | plain Hono | D8 |

### Inventory 3.2 row 5

| # | Method | Path (under `/api`) | Source | Handler calls | Handler-level validation | Policy (cap / admission / input) | Rate limit | Flags | Style | Domain (9.4) |
|---|---|---|---|---|---|---|---|---|---|---|
| 5 | PATCH | `/autopilot/rules/:ruleId` | route.ts:262 | `autopilotService.updateRule` | `autopilotRuleUpdateSchema` | browser-session: `content.edit`, workspace |  |  | plain Hono | D8 |

### Inventory 3.2 row 6

| # | Method | Path (under `/api`) | Source | Handler calls | Handler-level validation | Policy (cap / admission / input) | Rate limit | Flags | Style | Domain (9.4) |
|---|---|---|---|---|---|---|---|---|---|---|
| 6 | DELETE | `/autopilot/rules/:ruleId` | route.ts:275 | `autopilotService.deleteRule` |  | browser-session: `content.edit`, workspace |  |  | plain Hono | D8 |

### Inventory 3.2 row 7

| # | Method | Path (under `/api`) | Source | Handler calls | Handler-level validation | Policy (cap / admission / input) | Rate limit | Flags | Style | Domain (9.4) |
|---|---|---|---|---|---|---|---|---|---|---|
| 7 | POST | `/autopilot/rules/:ruleId/take-over` | route.ts:282 | `autopilotService.takeOver` |  | browser-session: `workspace.manage`, workspace |  |  | plain Hono | D8 |

### Inventory 3.2 row 8

| # | Method | Path (under `/api`) | Source | Handler calls | Handler-level validation | Policy (cap / admission / input) | Rate limit | Flags | Style | Domain (9.4) |
|---|---|---|---|---|---|---|---|---|---|---|
| 8 | POST | `/autopilot/rules/:ruleId/run-now` | route.ts:289 | `autopilotService.triggerRuleNow` |  | browser-session: `processing.consume`, workspace | workspace `autopilot-run` 10/3600s |  | plain Hono | D8 |

### Inventory 3.2 row 161

| # | Method | Path (under `/api`) | Source | Handler calls | Handler-level validation | Policy (cap / admission / input) | Rate limit | Flags | Style | Domain (9.4) |
|---|---|---|---|---|---|---|---|---|---|---|
| 161 | POST | `/webhooks/zoom` | zoom-http.ts:13 | `zoomService.acceptWebhook` |  | independent-trust: `zoom_signature` |  |  | plain Hono | P0 |

### Inventory 3.2 row 162

| # | Method | Path (under `/api`) | Source | Handler calls | Handler-level validation | Policy (cap / admission / input) | Rate limit | Flags | Style | Domain (9.4) |
|---|---|---|---|---|---|---|---|---|---|---|
| 162 | GET | `/zoom/connections` | zoom-http.ts:23 | `zoomService.listConnections` |  | browser-session: `content.view`, workspace |  |  | plain Hono | D8 |

### Inventory 3.2 row 163

| # | Method | Path (under `/api`) | Source | Handler calls | Handler-level validation | Policy (cap / admission / input) | Rate limit | Flags | Style | Domain (9.4) |
|---|---|---|---|---|---|---|---|---|---|---|
| 163 | DELETE | `/zoom/connections/:connectionId` | zoom-http.ts:24 | `zoomService.disconnect` |  | browser-session: `content.edit`, workspace; paramsInput("connectionId") |  |  | plain Hono | D8 |

### Inventory 3.2 row 164

| # | Method | Path (under `/api`) | Source | Handler calls | Handler-level validation | Policy (cap / admission / input) | Rate limit | Flags | Style | Domain (9.4) |
|---|---|---|---|---|---|---|---|---|---|---|
| 164 | GET | `/zoom/oauth/start` | zoom-http.ts:28 | `zoomService.createAuthorizationUrl` |  | browser-session: `content.edit`, workspace | actor `zoom-connect` 10/3600s | redirect | plain Hono | D8 |

### Inventory 3.2 row 165

| # | Method | Path (under `/api`) | Source | Handler calls | Handler-level validation | Policy (cap / admission / input) | Rate limit | Flags | Style | Domain (9.4) |
|---|---|---|---|---|---|---|---|---|---|---|
| 165 | GET | `/zoom/oauth/callback` | zoom-http.ts:29 | `zoomService.handleCallback` |  | browser-session: `content.edit`, workspace |  | redirect | plain Hono | D8 |

## Acceptance criteria

- [ ] Ten automation/Zoom routes and Zoom webhook plus four grant actions map to spec with current roles/features and grant source consent.
- [ ] Zoom callback consumes hashed one-use state, resolves stored actor/Workspace, validates redirect URI/expiry and rechecks membership before/after provider exchange.
- [ ] Zoom starts POST JSON; callback/webhook declare independent trust; CRC stays signature-secret challenge without Clerk.
- [ ] Rule/grant retryable acceptance is receipt-safe; take-over/pause/revoke/caps/acting-member semantics and provider-unavailable states preserved.
- [ ] No unowned files changed; paired review findings and verification evidence recorded under Comments.

## Verification

Run these from the repository root after dependencies are installed. A command naming a new package script is implemented by the owning setup ticket, not silently skipped. PostgreSQL gates need a disposable schema; a skipped DB suite does not satisfy its gate. During the undeployed integration sequence, record any unrelated transitional compile failure with its owning blocker; this ticket's behavior tests must pass and the final integrated gates cannot be waived.

```sh
bun test apps/api/src/domains/automation
bun run test:vizard-expansion:db
bun run test:integration-api:db
bun run --cwd apps/api typecheck
```

## Comments

Append claim, requested seam changes, paired review and evidence here.
