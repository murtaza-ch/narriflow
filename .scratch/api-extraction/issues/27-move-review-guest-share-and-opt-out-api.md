# 27. Move review guest share and opt-out API

**What to build:** Review/internal round/public share/opt-out API preserves permissions and notifications while exchanging guest access for scoped Bearer rather than cookies.

**Blocked by:** [04 - Wire API runtime and partition the catch-all](04-wire-api-runtime-and-partition-the-catch-all.md)

**Status:** done

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

- [x] Eight internal review routes, nine guest registrations, public share and opt-out move with exact trust/plan/permission/refusal behavior.
- [x] Guest access returns bound sessionToken/expiresAt, max 12h, with token/round digest binding, explicit web-origin checks and existing passcode/email throttles.
- [x] Guest comment/decision replay uses immutable ReviewAuditEvent metadata and a transaction advisory lock scoped to round/guest/grant/command/key digest; no fake App User actor. Internal commands use OperationReceipt. Test same-key concurrency, changed-body conflict, lost response, grant rotation, expiry and receipt replay after later edits/deletes.
- [x] Opt-out GET is preview-only, POST confirms once; grants expose only safe downloadable variants and expire/refetch normally.
- [x] Review selection decoder moves to validators; service uses same decoder and no parallel parser.
- [x] No unowned files changed; paired review findings and verification evidence recorded under Comments.

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

Claimed by GPT-6.1-Sol, 2026-10-29. Implementation in the shared dev checkout; only ticket-owned files will be edited.

### Implementation

- Registered all 20 operations through `createRouteApp(reviewsAdmission)`: eight internal, nine guest, public share, opt-out preview and confirmation. Literal opt-out precedes the token route. Removed the Next guest handlers/tests and opt-out HTML handler; no proxy or cookie path remains.
- Access returns the existing HMAC-signed session plus its signed expiry, with the full review-token digest and round binding. Exact configured web origins are checked; credentialed server calls may omit Origin. Guest admission checks the live round/grant before validation. Preserved passcode/email throttles, guest author/edit-window/reply guards and the existing notification ledger.
- Guest comment/decision acceptance writes the safe immutable result on the corresponding audit event. Transaction advisory identity is round + guest + subject-grant hash + command + caller-key digest. A round row lock prevents grant rotation during the final authorization and acceptance. Replay precedes throttles, survives later edits/deletes/decisions and rejects changed input, expiry, revocation and old grants. Guest data never enters OperationReceipt.
- All seven internal POST commands use OperationReceipt in the same transaction as the domain write/notification intent. Admission records rate outcomes; locked new acceptance enforces them after replay. Receipt results are encrypted with the existing review delivery secret because round creation returns a capability URL; no plaintext link is stored in a receipt.
- Media returns a 60-second storage grant. Public share reuses `getShared`, projects through the safe export schema, retains only completed downloadable variants and supplies a conservative 60-second refetch deadline. Selection encode/decode now re-export the validators implementation; the services copy is deleted.
- Added typed client query factories, separate guest transport with no Clerk/cookies/automatic retry, scoped invalidation helpers and `packages/api-client/src/reviews/README.md` for ticket 28.

### Requests and review

- 28: consume the client handoff, store guest credentials only in tab sessionStorage keyed by the review-token digest, clear on expiry/refusal and refetch media/share grants after expiry or tab resume. Keep the new opt-out presentation page on the human web URL.
- 28/31: finish the review UI XSS/CSP check, including API-origin connect-src and no raw HTML/script interpolation. These files are outside ticket 27's ownership.
- Paired Claude review remains with the orchestrator; no nested delegate was started by this implementation sub-agent. No findings have been received yet.
- Global inventory currently fails in ticket 05's `apps/api/src/domains/session/routes.ts`: `inviteTokenParamSchema` is imported from the validators root, but its home is `@narriflow/validators/api/session`. Please fix the import in the owning ticket. No unowned file was edited.

### Verification

- `bun test apps/api/src/domains/reviews` and `bun test apps/api/src/domains/reviews packages/services/src/review-opt-out.test.ts`: adapter tests pass; the separately gated PostgreSQL suite is skipped in ordinary runs.
- Combined owned deterministic suites (API routes, client, review service, notifications and opt-out): 39 pass, 0 fail.
- `ALLOW_REVIEW_REPLAY_DB_TESTS=1 .scratch/api-extraction/db-gate.sh bun test apps/api/src/domains/reviews/guest-replay.db.test.ts`: 6 pass, 0 skipped. Includes two separate Bun processes sharing one key, immutable replay after edits/deletes, changed input, grant rotation/expiry/revocation, limiter outage ordering, internal receipts and atomic round/notification creation.
- `.scratch/api-extraction/db-gate.sh bun run test:authenticated-request-policy:db`: 4 pass, 0 skipped.
- Owned-path `bunx biome check` and `git diff --check`: clean. Validators typecheck passes. Final API/services/api-client/web package typechecks were started but did not finish under shared-machine compiler contention. Redundant runs were canceled; no owned compiler process is intentionally left running. These checks are not reported as passing.
- No commits, dependency installs, migrations on shared resources or env-file edits. No spec deviation; encrypted internal receipt snapshots and the conservative share refetch deadline are implementation choices.

### Close-out blocker

Implementation is complete and the five functional acceptance boxes are checked. Status is `blocked` because final package typechecks and Claude's paired review are still required. The validators typecheck passed. The earlier completed API typecheck reported only ticket 23's transitional REST errors (`domains/rest/routes.ts`, `domains/index.ts`, `runtime.ts`), with no ticket 27 diagnostics; later full checks did not finish while more than ten compilers were contending on the shared machine. Please rerun API/services/api-client/web typechecks after the compiler wave settles, fix the ticket 05 inventory import noted above, run the paired review and then mark this ticket done. The remaining acceptance box intentionally stays open.

All functional verification is complete: 39 deterministic tests, 6 disposable-PostgreSQL review tests and the 4-test authenticated-request-policy DB gate pass. No implementation stub or compatibility path remains in this ticket's files.

- Sol claimed the paired-review fixes on 2026-10-29. No commits, env changes or dependency installs; concurrent 28/29 source ownership retained.

### Sol paired-review resolution, 2026-10-29

- Findings and decisions are recorded per finding in [the paired review's Resolution (Sol)](../review-claude-sol-tickets.md#resolution-sol). Both API type errors are fixed without an install; all seven internal review receipt names now obey the registry naming rule.
- Final scoped tests: 329 pass, 17 DB-only skips, no failures; Zapier 74 pass and Make 13 pass. API, API-client, services and Zapier typechecks pass. OpenAPI still matches all 31 operations. Scoped Biome checks all 15 supported changed code files clean; integrations are excluded by the repository configuration and pass their own checks.
- All DB commands used `db-gate.sh` against local disposable PostgreSQL only. Policy gate 4 pass; review replay gate 6 pass; moved REST/MCP parity gate 7 pass. The top-level integration gate passed 148 service tests then failed solely on its deleted web REST suite path. Ticket 31 must replace `apps/web/lib/rest-api/events.db.test.ts` with `apps/api/src/domains/rest/events.db.test.ts` in `packages/services/scripts/run-integration-api-db-tests.ts` and rerun the command. No unowned runner edited.
- Playback/download grants last up to 900 seconds, bounded by session and round expiry. Read IP buckets are independent: room 120/min, media 2400/min, download 800/min, share 120/min and opt-out preview 60/min. The 400-variant regression passes. Share expiry follows the earliest actual presigned R2 lifetime minus 30 seconds, including project-retention clamps.
- Cutover checklist for 31/32: set Railway API `TRUSTED_CLIENT_IP_HEADER=x-real-ip`. [Railway specifications](https://docs.railway.com/networking/public-networking/specs-and-limits#technical-specifications) document X-Real-IP as the client remote IP. Verify ingress overwrites caller-supplied values and separate client IPs receive separate buckets; no deployed configuration was changed here.
- Ticket 28 Comments contain the UI requirement to preserve video src/currentTime across playback, pause/focus and background grant refresh, and renew on explicit playback/recovery. Query options now use expiry-based freshness and disable focus refetch. Ticket 28 source was not edited.
- Review-owned acceptance and requested policy/type/behavior gates pass; ticket done. Broader integrated runner/build/cutover work remains explicitly tracked by 31/32.
