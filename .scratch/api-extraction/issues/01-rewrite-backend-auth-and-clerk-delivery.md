# 01. Rewrite backend auth and Clerk delivery

**What to build:** Bun can verify a Clerk Bearer identity, provision the App User/personal Workspace and process raw Svix Clerk delivery without Next dependencies.

**Blocked by:** None

**Status:** ready-for-agent

**Suggested implementer:** Claude. The other pairing side reviews and returns findings to this owner.

Read [spec.md](../spec.md). It is the complete contract; the original brief/plan/reviews are not prerequisites. Claim this ticket before editing.

## Exact ownership

Paths are repo-relative. Every existing file below is exclusively assigned for this phase, including files that only need verification. A new `/**` directory includes its local tests/helpers, not adjacent directories. Read other files as evidence; do not edit them.

Existing files:

- `apps/web/app/api/webhooks/clerk/route.ts`
- `bun.lock`
- `packages/auth/package.json`
- `packages/auth/src/index.ts`
- `packages/auth/test-fixtures/personal-workspace-auth.ts`
- `packages/auth/tsconfig.build.json`
- `packages/auth/tsconfig.json`
- `packages/email/src/index.ts`

New files/directories or reserved skeletons handed off by a blocker:

- `packages/auth/src/**`
- `apps/api/src/domains/platform/clerk/**`

## Endpoints, actions, pages and refresh sites

Rows retain their section/ordinal or exact source-line identifier from the independent inventory. Abbreviated table filenames are accompanied by the literal ownership manifest and exact source occurrences below. All action/page/fetch/refresh rows in owned files are in scope, including no-refresh callers and media navigation. Baseline observations do not override the spec's selected origins, route style, guest Bearer or new endpoints.

### Inventory 4 row 2

| # | File | Methods | What it does | Next-specific dependencies | Trust / auth | Verdict |
|---|---|---|---|---|---|---|
| 2 | `app/api/webhooks/clerk/route.ts` (143 lines) | POST | Svix-verified Clerk webhook: `user.created/updated` to `syncClerkUserPayload`, `user.deleted` to `markUserDeletedByClerkId`, `email.*` relayed by `@narriflow/email` `relayClerkEmail`; idempotent via `getWebhookDeliveryLog` / `recordWebhookDeliveryLog("clerk", svixId)`. | `headers()` from `next/headers`; `UserJSON` type from `@clerk/nextjs/server`; `validateWebhookEnv()` from `lib/env.ts` (`server-only`); `runtime = "nodejs"`. | Svix signature (`CLERK_WEBHOOK_SECRET`) | **Move to API** (backend writes users). Replace `headers()` with `c.req.header`, type from `@clerk/backend`; update the endpoint URL in the Clerk dashboard (external registration). |

Capture the median of three warm `bun run --cwd apps/web typecheck` runs before source changes; record machine and command durations here for 31/32. Dependency-install lockfile ownership is serial 01 -> 02 -> 03 -> 04, then 31.

## Acceptance criteria

- [ ] Missing/malformed Bearer remains 401 even with a Clerk cookie; session-only token type, authorizedParties and provider-unavailable 503 tested.
- [ ] Provisioning, stale user refresh, defaults, personal Workspace, uniqueness races and confirmed-Clerk-404 email release preserved.
- [ ] Explicit selection resolver supports bootstrap fallback and refuses invalid scoped selection; staff variant resolves only from verified identity and server allowlist.
- [ ] Clerk bytes/signature/delivery receipts/email relay preserved; auth and email imports run under Bun without Next/server-only/React.
- [ ] No unowned files changed; paired review findings and verification evidence recorded under Comments.

## Verification

Run these from the repository root after dependencies are installed. A command naming a new package script is implemented by the owning setup ticket, not silently skipped. PostgreSQL gates need a disposable schema; a skipped DB suite does not satisfy its gate. During the undeployed integration sequence, record any unrelated transitional compile failure with its owning blocker; this ticket's behavior tests must pass and the final integrated gates cannot be waived.

```sh
bun test packages/auth apps/api/src/domains/platform/clerk
```

## Comments

Append claim, requested seam changes, paired review and evidence here.
