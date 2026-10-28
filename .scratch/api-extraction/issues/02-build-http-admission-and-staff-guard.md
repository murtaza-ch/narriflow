# 02. Build HTTP admission and staff guard

**What to build:** Every API route can use one explicit admission/error/limit contract, and the reserved staff-only group cannot accidentally inherit Workspace Admin privileges.

**Blocked by:** [01 - Rewrite backend auth and Clerk delivery](01-rewrite-backend-auth-and-clerk-delivery.md)

**Status:** ready-for-agent

**Suggested implementer:** Claude. The other pairing side reviews and returns findings to this owner.

Read [spec.md](../spec.md). It is the complete contract; the original brief/plan/reviews are not prerequisites. Claim this ticket before editing.

## Exact ownership

Paths are repo-relative. Every existing file below is exclusively assigned for this phase, including files that only need verification. A new `/**` directory includes its local tests/helpers, not adjacent directories. Read other files as evidence; do not edit them.

Existing files:

- `apps/web/lib/authenticated-request-hono.test.ts`
- `apps/web/lib/authenticated-request-hono.ts`
- `apps/web/lib/authenticated-request-http.test.ts`
- `apps/web/lib/authenticated-request-http.ts`
- `apps/web/lib/authenticated-request-input.test.ts`
- `apps/web/lib/authenticated-request-input.ts`
- `apps/web/lib/authenticated-request-policy.db.test.ts`
- `apps/web/lib/authenticated-request-policy.server.ts`
- `apps/web/lib/authenticated-request-policy.test.ts`
- `apps/web/lib/authenticated-request-policy.ts`
- `apps/web/lib/authenticated-request-project.ts`
- `apps/web/scripts/run-authenticated-request-policy-db-tests.ts`
- `bun.lock`
- `packages/services/src/operation-receipt-runtime.ts`
- `packages/services/src/operation-receipt.db.test.ts`
- `packages/services/src/operation-receipt.test.ts`
- `packages/services/src/operation-receipt.ts`

New files/directories or reserved skeletons handed off by a blocker:

- `packages/services/src/workspace-receipt-commands.ts`
- `packages/services/src/projects-receipt-commands.ts`
- `packages/services/src/clips-receipt-commands.ts`
- `packages/services/src/ingest-receipt-commands.ts`
- `packages/services/src/recipes-receipt-commands.ts`
- `packages/services/src/publishing-receipt-commands.ts`
- `packages/services/src/brand-receipt-commands.ts`
- `packages/services/src/automation-receipt-commands.ts`
- `packages/services/src/developer-receipt-commands.ts`
- `packages/services/src/reviews-receipt-commands.ts`
- `packages/services/src/exports-receipt-commands.ts`
- `apps/api/package.json`
- `apps/api/tsconfig.json`
- `apps/api/tsconfig.build.json`
- `apps/api/src/http/**`
- `apps/api/src/config.ts`
- `apps/api/scripts/run-authenticated-request-policy-db-tests.ts`
- `packages/validators/src/api/errors.ts`
- `packages/validators/src/api/origins.ts`

## Endpoints, actions, pages and refresh sites

Rows retain their section/ordinal or exact source-line identifier from the independent inventory. Abbreviated table filenames are accompanied by the literal ownership manifest and exact source occurrences below. All action/page/fetch/refresh rows in owned files are in scope, including no-refresh callers and media navigation. Baseline observations do not override the spec's selected origins, route style, guest Bearer or new endpoints.

No direct UI/domain rows. This ticket supplies the shared contracts or final gates described above.

## Acceptance criteria

- [ ] Policy order identity, Workspace, capability/status, rate, Project, input, operation and one outer requestId tested, including concealment and mismatch.
- [ ] Common failures cover malformed JSON/validation/413/404/unexpected errors with safe fields; per-request actor promise, never global authorization caching.
- [ ] CORS exact origins/headers, secure headers and chunked body limits respect independent MCP/webhook trust; receipt replay precedes mutation-limit refusal.
- [ ] Receipt command union composes typed per-domain literal-name modules; no arbitrary-string escape and no new table.
- [ ] Reserved admin guard distinguishes staff from Workspace Admin, uses 60/10 per-minute rates, and refuses future mutation registration without injected audit.
- [ ] No unowned files changed; paired review findings and verification evidence recorded under Comments.

## Verification

Run these from the repository root after dependencies are installed. A command naming a new package script is implemented by the owning setup ticket, not silently skipped. PostgreSQL gates need a disposable schema; a skipped DB suite does not satisfy its gate. During the undeployed integration sequence, record any unrelated transitional compile failure with its owning blocker; this ticket's behavior tests must pass and the final integrated gates cannot be waived.

```sh
bun test apps/api/src/http packages/services/src/operation-receipt.test.ts
bun run test:authenticated-request-policy:db
```

## Comments

Append claim, requested seam changes, paired review and evidence here.
