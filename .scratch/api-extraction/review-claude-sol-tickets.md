# Claude paired review: Sol tickets 23, 24, 27 (2026-10-29)

Scope: working tree on `dev` vs 9fed947a originals. Read-only review; no source edited.

## Verification run by reviewer

| Command | Result |
| --- | --- |
| `bun run --cwd apps/api typecheck` | FAIL, 2 errors, both in these tickets: `domains/rest/routes.ts:176` (TS2352, ticket 23); `domains/reviews/guest-replay-child.ts:6` (TS2345, two `@types/pg` versions 8.15.5 vs 8.21.0, ticket 27) |
| `bunx tsc -p packages/api-client/tsconfig.json --noEmit` | FAIL, 1 error: the same `rest/routes.ts:176` (ticket 23) |
| `bun run --cwd packages/services typecheck` | pass |
| `bun test apps/api/src/domains/{rest,integrations,reviews} packages/api-client/src/{reviews,rest}` | 122 pass, 17 skip (DB), 0 fail, 2 snapshots |
| `ALLOW_REVIEW_REPLAY_DB_TESTS=1 db-gate.sh bun test .../guest-replay.db.test.ts` | 6 pass (local throwaway PG) |
| `bun run --cwd apps/api openapi:check` | pass, all 31 operations |

## Findings, by severity

### Medium

1. **Review playback reloads about every minute.** Ticket 27, with 28 as consumer. `packages/services/src/review.service.ts:721-724` issues a 60 s media grant. `review-client-model.ts:59-61` refetches before it expires and on every window focus. `review-client.tsx:561` then swaps `<video src>`. Scenario: a reviewer watches a clip that is longer than about 50 s, pauses, or tabs back in. The src changes and the playback position resets. The old 307 redirect left src stable. Fix: give playback grants a longer TTL bounded by the session `exp` (for example the 15 min export TTL), and have the UI keep the current src while it plays. Do not swap src on focus.
2. **Review media and room reads share one 60/min IP bucket.** Ticket 27. `reviews/routes.ts` applies `readLimit` (prefix `review-public-read`) to the room, media, download, share and opt-out preview. A round can hold 100 items with up to 4 variants each, plus the focus-driven refetches from finding 1. That pushes past 60/min, and several reviewers behind one NAT reach it sooner, so 429s follow. This also depends on `TRUSTED_CLIENT_IP_HEADER`. If 31/32 leave it unset on Railway, every guest shares the proxy socket IP and the bucket is global. Record that check in the cutover checklist.
3. **Integration defaults ship `http://localhost:4000`.** Ticket 23, then 31/32. Affected: `integrations/zapier/src/api.ts:4` and the Make `base`/`connection`/`make-an-api-call` defaults. A hosted Zapier or Make user who keeps the default gets a broken connection. Users who paste the old W URL now get a 404 from Vercel with no hint. This must be replaced at cutover; leave the item open as a blocker in ticket 32.
4. **15 docs pages still hard-code `https://app.narriflow.com/api/v1` and `/mcp`.** Owner: unowned. Affected: `apps/web/content/docs/{api/*,ai/*,search,editor-timelines,publishing-queue}.mdx`. They contradict the API-origin split, and no ticket manifest owns `content/docs`. Assign them to 31.

### Low

5. **`/openapi.json` suffix skips auth.** Ticket 23, `rest/routes.ts:182`. The middleware checks `c.req.path.endsWith("/openapi.json")`. Verified: an unauthenticated `GET /api/v1/projects/openapi.json` (and `/recipes/openapi.json`) returns 500 `internal_error`. The cause is a TypeError reading an undefined `restLimiter` in the `authenticate` middleware (line 225). The expected answer is 401. It is not a bypass. Compare the exact path, as the old code did.
6. **Unknown `/api/v1/*` paths reach the first-party chain.** Ticket 23 with 04/31: `app.ts:85` mounts REST, then `app.ts:99` mounts first party at `/api`. Hono probe: after REST middleware calls `next()`, first-party CORS, `requireJsonContentType`, the policy and the parent 404 run. REST's `notFound` at `routes.ts:218` is dead code. An authenticated unknown path returns the first-party envelope, or a 415 for POSTs that are not JSON, instead of `route_not_found`. Terminate inside REST with a catch-all.
7. **Malformed operation IDs now return 404, not 400.** Ticket 23, `routes.ts:231`. `GET /operations/op_bad` and redeliver decode the ID before param validation and admission. They answer 404 `operation_not_found` where they used to answer 400 `invalid_request`, and they answer it ahead of scope/status refusals. Decode after validation, or accept and document the change.
8. **Content-Type check is narrower.** Ticket 23, `routes.ts:234`. The check requires exactly `application/json`, so `application/*+json` bodies that Hono used to accept are now refused. Snapshot tests do not cover this.
9. **REST ignores limits on replayable endpoints.** Ticket 23. With an exhausted budget, those endpoints still run admission DB reads and callback DNS resolution (`mutation()`) before `beforeAccept` refuses. Spec ordering requires this, but resolve callbacks only after the limiter check where possible.
10. **MCP loopback hosts dropped.** Ticket 24, `integrations/mcp-auth.ts:20`. Old non-production code also allowed `localhost`, `127.0.0.1` and `[::1]`. Locally, `http://127.0.0.1:4000/mcp` is now refused unless `MCP_ALLOWED_HOSTS` lists it. Also, with no issuer configured, metadata advertises `authorization_servers: []` where the old code threw.
11. **Share grants refresh too early.** Ticket 27, `reviews/routes.ts:96`. The share's `expiresAt` is a fixed 60 s while the presigned URLs last 15 min. The result is needless refetch, `lastUsedAt` writes, and the same src-reset effect as finding 1 on `/share`. Derive it from the real TTL minus a margin.
12. **Guest writes call Redis inside the transaction.** Ticket 27. `addComment`/`decide` run `enforceReviewRateLimit` (Redis) and load the whole room (`readRound` twice) inside `executeGuestReviewCommand`, while holding the advisory lock and the round `FOR UPDATE`. That is correct but lengthens the lock hold. Acceptable at current volume.
13. **Signed tokens travel in query strings.** Tickets 24/27: `preparations?token=`, `upload-handoff?intent=`, `opt-out?token=`. The app logger records route patterns only, which is good. Railway or edge HTTP logs may record full URLs. Spec-mandated, so record this as residual risk.
14. **Confirmation retries fail after token expiry.** Ticket 24, `runtime.ts confirm`. `verifyMcpPreparation` without `allowExpired` runs before the native replay lookup, so a retry after a lost response past expiry fails instead of replaying. Same as the old action; noting it only.

## Confirmed correct

- REST: 31 operations, snapshot parity, and only the configured server origin changed. `nf_` key admission now runs before input validation. `Idempotent-Replayed` is set on receipt replays. `statusUrl` uses A; review, queue, project, clip and export links use W. CORS uses exact origins and no credentials. The 1 MiB body limit is in place. The API-key client omits credentials and strips `X-Workspace-Id`.
- Docs: import only the generated `@narriflow/api-client/openapi` JSON, with no backend import in docs/connector. The playground uses `apiServers` (NEXT_PUBLIC_API_URL) instead of `window.location.origin`. Search is capped at 300 characters. Note: if NEXT_PUBLIC_API_URL is missing from the Vercel build, public docs advertise localhost (31 owns Turbo env).
- MCP: resource and audience are exactly A/mcp, and a W-audience token is refused (test). Host and origin checks run before the body and CORS. Upload handoff uses Clerk session Bearer with authorizedParties. The originating OAuth token is re-verified online, now also at preview. API-key revocation and scope intersection are kept. An expired intent can only resume via `hasOwnSessionByClientKey`. The workspace comes from the signed state, not the header.
- Reviews: the guest Bearer `grant` is the full access-token hash and is compared with the path token. The round, guest grant, status, expiry and project are rechecked live, and again under the lock. The session TTL is capped at 12 h. The web origin allowlist is enforced, and Origin may be omitted. Guest receipts live on immutable audit metadata with no App User. The advisory lock covers round, guest, grant, command and key digest. Internal receipts are encrypted, and the receipt is stripped from the manager audit view. Opt-out GET only previews and POST confirms. The share DTO goes through the schema and keeps only completed downloadable variants.
- No tokens or secrets appear in logs or response bodies beyond the intended `sessionToken`. HMAC verification precedes all hash equality checks.

## Requested owners

- 23: cast at `rest/routes.ts:176` (`as unknown as`, or type `limitBody` generically); findings 5-9.
- 27: `guest-replay-child.ts` pg type clash (cast the Pool, or align `@types/pg`); findings 1, 2, 11. 28: stop swapping the video src while it plays.
- 31/32: findings 3, 4 and 6, plus the trusted-IP header, Clerk client injection, the DB runner path and the parity test import already recorded in the tickets.

## Resolution (Sol)

2026-10-29. Scoped review-fix pass in the shared `dev` checkout. No commits, dependency installs, environment-file edits, or process termination. Ticket 28/29 source files were not edited. Ticket 28 received only the requested Comments handoff.

### Compile and receipt failures

- REST middleware typecheck: `limitBody` is independent of REST credential variables. Its existing API-context middleware now crosses Hono's invariant context type through `unknown`, without changing runtime admission.
- Review child-process typecheck: pass a Pool configuration to `PrismaPg`, which owns/disposes its own pool, instead of passing a `pg.Pool` from another `@types/pg` version. No cast or install needed.
- `operation-receipt.test.ts`: all seven internal review receipt commands now use the registry's `^[a-z][a-z0-9_]*$` convention, including `create_review_round`. Updated execution and plan-check comparisons together. No legacy command aliases or reads.

### Per-finding disposition

| Finding | Resolution |
| --- | --- |
| M1, review playback resets | Fixed API/client side. Playback/download grants request 900 seconds, bounded by guest session `exp` and round expiry, refusing a grant with less than one second remaining. Cache identity remains item + variant + mode. Grant queries derive freshness from the advertised expiry and disable focus refetch. Added lifetime/expiry regressions and appended ticket 28's UI requirement: retain src/currentTime across playback, pauses, focus and background refresh; replace an expired URL only on a new playback attempt or recovery, restoring currentTime. Ticket 28 owns browser proof. |
| M2, shared guest IP bucket | Fixed. Independent trusted-IP prefixes and per-minute budgets: room 120, media 2400, download 800, share 120, opt-out preview 60. Media accommodates six 100-item x 4-variant rounds per NAT/minute; downloads accommodate two. Access exchange keeps its existing separate tier and durable service throttles are unchanged. Regression issues all 400 media and 400 download requests and checks the separate read buckets. This explicitly overrides the spec's single 60/min guest-read tier at the user's request. |
| M2, Railway IP configuration | Cutover requirement for 31/32: set API `TRUSTED_CLIENT_IP_HEADER=x-real-ip` on Railway. [Railway public networking specifications](https://docs.railway.com/networking/public-networking/specs-and-limits#technical-specifications) list `X-Real-IP` as the client remote IP. Verify on the actual public ingress that client-supplied values are overwritten and separate clients do not share the proxy socket bucket. Header semantics in these docs do not prove every ingress path's overwrite behavior. No deployed setting or env file changed here. |
| M3, Zapier/Make local defaults | Fixed. Both connection forms require an explicit API origin and have no default. Zapier refuses a missing origin locally with `api_origin_required`. Make's base, connection test and universal module use `https://configure-api-origin.invalid` as the fails-loud fallback for saved connections missing the field. READMEs document this placeholder and explicit local testing. Final hostname/reconnection remains a 31/32 cutover check. Tests cover required configuration and remove the old localhost-default assertions. |
| M4, hard-coded docs pages | Deferred to ticket 31 as requested. No docs page source edited. |
| L5, OpenAPI suffix auth | Fixed. Only the registered GET `/openapi.json` terminates before authentication. Removed the suffix exemption entirely; projects/recipes suffixes now return 401 without a key. |
| L6, REST unknown-path fallthrough | Fixed with a final REST catch-all after the 31 registered operations. Mounted-app regression proves unknown GET/POST paths return REST `route_not_found` without reaching first-party middleware, including a non-JSON POST. |
| L7, malformed operation IDs | Fixed. Nonthrowing decoding is used only to choose admission scope; current scope/Workspace admission still runs. Param validation then returns 400 `invalid_request`; an otherwise-shaped invalid encoding also returns 400 in the handler. A valid ID absent from the Workspace retains service 404 concealment. |
| L8, vendor JSON | Fixed. Body admission accepts `application/json` and `application/*+json`, with parameters. A real vendor-JSON POST now reaches the ordinary schema/service and returns 202. |
| L9, replay admission/DNS cost | Retained intentionally. Current authorization and immutable receipt lookup must precede limiter refusal. `IntegrationMutation.callback.url` is a validated URL consumed synchronously to build the receipt fingerprint/registration. Moving DNS validation to acceptance safely requires changing that shared callback contract, beyond these review-owned files. Checking the limiter first would break required exhausted-budget replay. Existing exhausted-budget replay regression still passes. This is an accepted low-priority performance cost, not a security bypass. |
| L10, MCP loopback and missing issuer | Fixed. Non-production restores localhost, 127.0.0.1 and [::1] host admission while preserving exact canonical A/mcp audience/resource. Production receives no implicit loopback additions. Missing issuer makes protected-resource discovery fail safely with 502 `protected_resource_metadata_unavailable` and public CORS, instead of advertising an empty server list. |
| L11, share expiry/cadence | Fixed. Share expiry is the earliest actual `X-Amz-Date` + `X-Amz-Expires` across returned R2 URLs, minus 30 seconds. This also respects project-retention-clamped lifetimes. API-client freshness follows that response expiry instead of a fixed minute and disables focus refetch. UI preservation/renewal requirements are appended to ticket 28. |
| L12, guest lock duration | Accepted as reviewed. Redis and live authorization remain within the transaction's locked acceptance path so replay precedes new-command throttles. No speculative transaction split at current volume. |
| L13, signed query tokens | Accepted spec requirement and residual ingress-log concern. App logging continues to use route patterns, without query strings. Ticket 32 must inspect Railway/edge logging and redact or exclude signed continuation/opt-out query strings. No token transport change here. |
| L14, expired confirmation retry | Retained existing behavior. Preview/confirm still require a currently valid preparation and live principal checks before acceptance/replay. Supporting post-expiry recovery needs a deliberate replay-only contract; simply enabling expired-token verification could admit new work. No behavior expansion in this review-fix pass. |

### Verification

- Reproduced both original API TypeScript errors and `review.round.create` registry failure before editing. Added regressions initially failed for the grant lifetime, OpenAPI suffix 500, REST fallthrough, malformed-ID 404 and vendor-JSON refusal, then passed after the fixes.
- `bun test --timeout 30000 apps/api/src/domains/{rest,integrations,reviews} packages/api-client/src/{rest,integrations,reviews} packages/services/src/{review.service,review-opt-out,review-notification.service,operation-receipt}.test.ts apps/mcp/src packages/mcp-core/src`: **329 pass, 17 DB-only skips, 0 fail**, 2 snapshots. DB suites ran separately below.
- `bun run --cwd integrations/zapier test`: **74 pass**. `node --test integrations/make/test/validate.test.mjs`: **13 pass**.
- `bun run --cwd apps/api typecheck`, `bunx tsc -p packages/api-client/tsconfig.json --noEmit`, `bun run --cwd packages/services typecheck`, `bun run --cwd integrations/zapier typecheck`: **pass**.
- `bun run --cwd apps/api openapi:check`: **pass**, generated artifact still matches all 31 operations.
- `bunx biome check --write` on the exact touched code paths: **15 supported files checked, clean, no formatting changes needed**. Repository Biome excludes integrations; their own tests and Zapier typecheck passed. No broad formatter was run.
- `.scratch/api-extraction/db-gate.sh bun run test:authenticated-request-policy:db`: **4 pass**, disposable local PostgreSQL.
- `.scratch/api-extraction/db-gate.sh bun run test:integration-api:db`: **148 tests pass in all nine service suites**, then the runner fails on the deleted path `apps/web/lib/rest-api/events.db.test.ts`. Ticket 31 must replace that literal with `apps/api/src/domains/rest/events.db.test.ts` in `packages/services/scripts/run-integration-api-db-tests.ts`; that runner is outside this task's ownership.
- `.scratch/api-extraction/db-gate.sh bun apps/api/src/domains/rest/run-db-tests.ts`: **7 pass**, the moved REST/MCP parity suite, disposable schema with all 128 migrations, cleaned up afterward.
- `.scratch/api-extraction/db-gate.sh env ALLOW_REVIEW_REPLAY_DB_TESTS=1 bun test apps/api/src/domains/reviews/guest-replay.db.test.ts`: **6 pass**, including separate-process same-key acceptance after the Pool configuration fix.
- The central integration command's failure is recorded, not waived. Both its service suites and the moved parity suite actually ran successfully. Web build/browser/cutover verification stays with 31/32 and the UI work stays with 28.
