# 27. Move review guest share and opt-out API

**What to build:** Review/internal round/public share/opt-out API preserves permissions and notifications while exchanging guest access for scoped Bearer rather than cookies.

**Blocked by:** [04 - Wire API runtime and partition the catch-all](04-wire-api-runtime-and-partition-the-catch-all.md)

**Status:** ready-for-agent

**Suggested implementer:** Sol. The other pairing side reviews and returns findings to this owner.

Read [spec.md](../spec.md). It is the complete contract; the original brief/plan/reviews are not prerequisites. Claim this ticket before editing.

## Exact ownership

Paths are repo-relative. Every existing file below is exclusively assigned for this phase, including files that only need verification. A new `/**` directory includes its local tests/helpers, not adjacent directories. Read other files as evidence; do not edit them.

Existing files:

- `apps/web/app/api/review/[token]/[[...review]]/route.ts`
- `apps/web/app/api/review/review-guest-http.test.ts`
- `apps/web/app/api/review/review-guest-http.ts`
- `apps/web/app/review/opt-out/route.ts`
- `packages/services/src/review-notification.service.test.ts`
- `packages/services/src/review-notification.service.ts`
- `packages/services/src/review-opt-out.test.ts`
- `packages/services/src/review-opt-out.ts`
- `packages/services/src/review.service.test.ts`
- `packages/services/src/review.service.ts`

New files/directories or reserved skeletons handed off by a blocker:

- `apps/api/src/domains/reviews/**`
- `apps/api/src/types/reviews.ts`
- `packages/api-client/src/reviews/**`
- `packages/validators/src/api/reviews.ts`
- `packages/services/src/reviews-receipt-commands.ts`
- `packages/services/src/reviews-commands.ts`
- `packages/services/src/reviews-commands-runtime.ts`
- `packages/validators/src/review-selection.ts`

Own deletion of app/review/opt-out/route.ts; 28 owns its new page.tsx, a different file. Internal review-panel.tsx was reassigned from inventory D3 to 28 so guest/review data decisions have one UI owner.

The chosen new endpoints for this ticket are the matching owner row in spec.md, "Endpoint and screen contracts added by extraction". All current endpoints/actions below retain their semantics unless that row explicitly changes transport. Fill only this domain's receipt-command module; current native receipts remain native.

## Endpoints, actions, pages and refresh sites

Rows retain their section/ordinal or exact source-line identifier from the independent inventory. Abbreviated table filenames are accompanied by the literal ownership manifest and exact source occurrences below. All action/page/fetch/refresh rows in owned files are in scope, including no-refresh callers and media navigation. Baseline observations do not override the spec's selected origins, route style, guest Bearer or new endpoints.

### Inventory 3.2 row 56

| # | Method | Path (under `/api`) | Source | Handler calls | Handler-level validation | Policy (cap / admission / input) | Rate limit | Flags | Style | Domain (9.4) |
|---|---|---|---|---|---|---|---|---|---|---|
| 56 | POST | `/projects/:id/review-rounds` | route.ts:1090 | `reviewService.createRound` | `type CreateReviewRoundInput` | browser-session: `review.manage`, project(id); bodyInput(createReviewRoundSchema, ["id"]) | actor `review-round` 20/3600s |  | plain Hono | D10 |

### Inventory 3.2 row 57

| # | Method | Path (under `/api`) | Source | Handler calls | Handler-level validation | Policy (cap / admission / input) | Rate limit | Flags | Style | Domain (9.4) |
|---|---|---|---|---|---|---|---|---|---|---|
| 57 | GET | `/projects/:id/review-rounds` | route.ts:1110 | `reviewService.internalRoom` |  | browser-session: `content.view`, project(id); paramsInput("id") |  |  | plain Hono | D10 |

### Inventory 3.2 row 58

| # | Method | Path (under `/api`) | Source | Handler calls | Handler-level validation | Policy (cap / admission / input) | Rate limit | Flags | Style | Domain (9.4) |
|---|---|---|---|---|---|---|---|---|---|---|
| 58 | POST | `/projects/:id/review-rounds/:roundId/invite` | route.ts:1125 | `reviewService.inviteReviewers` | `type InviteReviewersInput` | browser-session: `review.manage`, project(id); bodyInput(inviteReviewersSchema, ["id", "roundId"]) | actor `review-invite` 20/3600s |  | plain Hono | D10 |

### Inventory 3.2 row 59

| # | Method | Path (under `/api`) | Source | Handler calls | Handler-level validation | Policy (cap / admission / input) | Rate limit | Flags | Style | Domain (9.4) |
|---|---|---|---|---|---|---|---|---|---|---|
| 59 | POST | `/projects/:id/review-rounds/:roundId/comments` | route.ts:1147 | `reviewService.addInternalComment` | `type InternalReviewCommentInput` | browser-session: `review.manage`, project(id); bodyInput(internalReviewCommentSchema, ["id", "roundId"]) | actor `review-comment-internal` 60/60s |  | plain Hono | D10 |

### Inventory 3.2 row 60

| # | Method | Path (under `/api`) | Source | Handler calls | Handler-level validation | Policy (cap / admission / input) | Rate limit | Flags | Style | Domain (9.4) |
|---|---|---|---|---|---|---|---|---|---|---|
| 60 | POST | `/projects/:id/review-rounds/:roundId/comments/:commentId/resolve` | route.ts:1168 | `reviewService.resolveComment` |  | browser-session: `review.manage`, project(id); paramsInput("id", "roundId", "commentId") |  |  | plain Hono | D10 |

### Inventory 3.2 row 61

| # | Method | Path (under `/api`) | Source | Handler calls | Handler-level validation | Policy (cap / admission / input) | Rate limit | Flags | Style | Domain (9.4) |
|---|---|---|---|---|---|---|---|---|---|---|
| 61 | POST | `/projects/:id/review-rounds/:roundId/comments/:commentId/reopen` | route.ts:1193 | `reviewService.resolveComment` |  | browser-session: `review.manage`, project(id); paramsInput("id", "roundId", "commentId") |  |  | plain Hono | D10 |

### Inventory 3.2 row 62

| # | Method | Path (under `/api`) | Source | Handler calls | Handler-level validation | Policy (cap / admission / input) | Rate limit | Flags | Style | Domain (9.4) |
|---|---|---|---|---|---|---|---|---|---|---|
| 62 | POST | `/projects/:id/review-rounds/:roundId/notifications/retry` | route.ts:1218 | `reviewNotificationService.retry` | `type RetryReviewNotificationInput` | browser-session: `review.manage`, project(id); bodyInput(retryReviewNotificationSchema, ["id", "roundId"]) | actor `review-notification-retry` 20/3600s |  | plain Hono | D10 |

### Inventory 3.2 row 63

| # | Method | Path (under `/api`) | Source | Handler calls | Handler-level validation | Policy (cap / admission / input) | Rate limit | Flags | Style | Domain (9.4) |
|---|---|---|---|---|---|---|---|---|---|---|
| 63 | POST | `/projects/:id/review-rounds/:roundId/revoke` | route.ts:1244 | `reviewService.revokeRound` |  | browser-session: `review.manage`, project(id); paramsInput("id", "roundId") |  |  | plain Hono | D10 |

### Inventory 4 row 3

| # | File | Methods | What it does | Next-specific dependencies | Trust / auth | Verdict |
|---|---|---|---|---|---|---|
| 3 | `app/api/review/[token]/[[...review]]/route.ts` (1 line) + `app/api/review/review-guest-http.ts` (224 lines) | GET, POST, PATCH, DELETE | Guest review API: `POST ""`/`POST access` exchanges the review token + guest credentials for a signed session cookie (`reviewService.authenticate`, cookie `nf_review_<hash12>`, httpOnly, `SameSite=Strict`, `Path=/api/review/<token>`, 12 h, `secure` in production); then `GET ""` (round + comments), `POST comments`, `POST decision`, `PATCH`/`DELETE comments/:commentId`, `GET media/:itemId/:variantId` and `download/:itemId/:variantId` (307 to presigned URL). `guestReviewRoutes` table lists 9 route shapes. 32 KiB streaming body cap. | `NextRequest` / `NextResponse` (cookie get/set, JSON, redirect); `context.params` Promise; `request.headers.get("x-forwarded-for")` for IP. | Signed guest cookie (`REVIEW_SESSION_SECRET` >= 32 chars), independent of Clerk; **same-origin check** `assertSameOrigin` compares `Origin` to the request URL origin on POST/PATCH/DELETE. | **Move to API** (uses `@narriflow/services`). Cross-origin consequences: the same-origin check must become an allowlist, the `SameSite=Strict` cookie lives on the API host (needs `credentials: "include"` and a shared registrable domain, or switch to a bearer-style session returned in the body), and the cookie `path` and Next headers for `/api/review/:path*` (noindex, no-store) must be re-applied by the API. Tests: `review-guest-http.test.ts`. |

### Inventory 4 row 4

| # | File | Methods | What it does | Next-specific dependencies | Trust / auth | Verdict |
|---|---|---|---|---|---|---|
| 4 | `app/review/opt-out/route.ts` (48 lines) | GET, POST | Server-rendered HTML page for the "stop automated review requests" link from Standing Grant emails. `GET ?token=` shows a confirm form (`reviewerOptOut.preview`), `POST` form-encoded confirms (`reviewerOptOut.confirm`). Inline HTML, `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, `X-Robots-Tag: noindex`. | `dynamic = "force-dynamic"`, `revalidate = 0`; plain `Request`/`Response`. Covered by `next.config` headers for `/review/:path*` (CSP `form-action 'self'`). Not in `proxy.ts` protected list. | Signed token in URL (no login) | **Move the logic to API** (imports `reviewerOptOut` from services, banned in web); the email link URL builder and the form `action` must then point at the API origin, or keep a thin web route handler that calls an API endpoint. Decision needed. |

Implement the spec's Guest command replay section inside the existing review-service transaction and its audit event. No schema migration is authorized by this ticket.

## Guest route declarations to preserve

These are the nine rows in review-guest-http.ts, identified by method and relative path; the parent is `/api/review/:token`. Explicit signed-review trust is mandatory, not the default session admission. Transport changes named in spec override cookies/redirects.

| Method | Relative path | Trust |
| --- | --- | --- |
| POST | empty path | Signed review token plus access credentials; no guest session yet |
| POST | access | Same access exchange; preserve the two currently registered entry paths |
| GET | empty path | Bound guest Bearer |
| POST | comments | Bound guest Bearer, caller-key replay |
| POST | decision | Bound guest Bearer, caller-key replay |
| PATCH | comments/:commentId | Bound guest Bearer, author grant/edit window |
| DELETE | comments/:commentId | Bound guest Bearer, author grant/edit window/replies guard |
| GET | media/:itemId/:variantId | Bound guest Bearer, JSON playback grant |
| GET | download/:itemId/:variantId | Bound guest Bearer, JSON download grant |

## Acceptance criteria

- [ ] Eight internal review routes, nine guest registrations, public share and opt-out move with exact trust/plan/permission/refusal behavior.
- [ ] Guest access returns bound sessionToken/expiresAt, max 12h, with token/round digest binding, explicit web-origin checks and existing passcode/email throttles.
- [ ] Guest comment/decision replay uses immutable ReviewAuditEvent metadata and a transaction advisory lock scoped to round/guest/grant/command/key digest; no fake App User actor. Internal commands use OperationReceipt. Test same-key concurrency, changed-body conflict, lost response, grant rotation, expiry and receipt replay after later edits/deletes.
- [ ] Opt-out GET is preview-only, POST confirms once; grants expose only safe downloadable variants and expire/refetch normally.
- [ ] Review selection decoder moves to validators; service uses same decoder and no parallel parser.
- [ ] No unowned files changed; paired review findings and verification evidence recorded under Comments.

## Verification

Run these from the repository root after dependencies are installed. A command naming a new package script is implemented by the owning setup ticket, not silently skipped. PostgreSQL gates need a disposable schema; a skipped DB suite does not satisfy its gate. During the undeployed integration sequence, record any unrelated transitional compile failure with its owning blocker; this ticket's behavior tests must pass and the final integrated gates cannot be waived.

```sh
bun test apps/api/src/domains/reviews
bun test apps/api/src/domains/reviews packages/services/src/review-opt-out.test.ts
bun run test:authenticated-request-policy:db
bun run --cwd apps/api typecheck
```

## Comments

Append claim, requested seam changes, paired review and evidence here.
