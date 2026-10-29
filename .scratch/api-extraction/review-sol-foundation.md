# Sol foundation review

Reviewed 2026-10-29 on `dev`, HEAD `899e27552a3192dae6130ebab2d25d5e33853c5b`, against `git diff 9fed947a..899e2755` and the original files at `9fed947a`. Read AGENTS.md, the extraction spec, all four foundation tickets and implementer comments. No commit or deployment made. The pre-existing `apps/web/next-env.d.ts` edit was left untouched.

**Recommendation (superseded: every finding below is now FIXED, see each Resolution): hold domain fan-out.** Three shared major defects remain OPEN: admission registration, RPC response-body scope tracking, and drain lifecycle races. Five majors and one minor were FIXED in the working tree. No separate blocker-severity finding. The undeployed branch is still intentionally incomplete; later-ticket work is not counted as a foundation defect.

## Findings

### F01. Major, FIXED: a later admission marker can authorize an earlier unguarded handler

- Locations: `apps/api/src/http/admission.ts:135`; `apps/api/src/route-inventory.ts:43`, `:109`.
- Failure: register `.get('/probe', unguardedHandler)` before `.get('/probe', admit(declaration), guardedHandler)` in a domain. An anonymous request returns the first handler's 200 payload. The guard finds the later marker with `matched.some`, but execution never reaches it. The inventory also passes this duplicate because it counts admission markers, not registrations; there is exactly one marker.
- Reproduced through the actual `createInventoryApp` composition, plus a standalone `/api/probe` inventory with one declaration: HTTP 200 `{unauthorized:true}`, inventory `problems: []`.
- Required correction: bind admission to the registration that can answer, and detect duplicate registrations even when one lacks admission. Add an adversarial mixed guarded/unguarded duplicate test. This needs a deliberate registration contract, so I did not invent one inside the review.
- **Resolution:** Fixed: domains register only through `createRouteApp(table)`, which installs the declared admission/trust as the first, marked entry; the guard refuses any unmarked handler in front of, behind or beside it and the inventory flags unmarked entries and multi-registration routes. Tests: `admission.test.ts` "an unguarded duplicate registered before the guarded route is refused, not served" and "...behind the guarded route is refused too"; `route-inventory.test.ts` "flags an unguarded duplicate in front of a guarded registration", "...behind...", `createRouteApp` describe. Contract: `## Route registration contract` in spec.md.

### F02. Major, FIXED: the Hono RPC fetch path releases scope tracking before consuming the response

- Location: `packages/api-client/src/core/transport.ts:253`, especially `:256`.
- Failure: `await client...$get()` or bound `.fetch()` resolves at response headers and immediately calls `release()`. A Workspace switch or sign-out during `await response.json()/blob()/text()` no longer aborts the body. Releasing also removes the caller AbortSignal listener. The parsed result has no final scope check. Every domain client uses this path through `createRpcClient`.
- Reproduced with a real loopback `Bun.serve` and real fetch, without providers or DB: return the first half of JSON, await bound fetch, start `.json()`, switch A to B, finish JSON. It resolves `{stale:true}`. A synthetic probe also confirms the tracked signal remains un-aborted after switching.
- Required correction: retain cancellation through body consumption and reject stale parsed results on the RPC path. Define how abandonment/clone/cancel releases resources. The `.json()` convenience path already retains tracking, so its passing tests do not establish RPC safety.
- **Resolution:** Fixed: bound `fetch` returns a Response whose body stays scope-tracked until read to the end, errored or cancelled (abort listener, per-chunk and end-of-body scope check, FinalizationRegistry for dropped bodies). Tests: `transport.test.ts` "bound fetch keeps scope tracking through the response body" (incl. "real loopback server: switching Workspace between header and end of the JSON body rejects").

### F03. Major, FIXED: draining misses subscribers registered after the closer snapshot

- Locations: `apps/api/src/server-hooks.ts:30`, `:36`; `apps/api/src/index.ts:65`; `apps/api/src/app.ts:82`.
- Failure: SIGTERM snapshots and clears the closers before `server.stop()` is called. A request already awaiting Clerk/DB can finish admission and register its SSE closer afterward. `onDrain` simply stores that closer despite `draining === true`; it will never run. `server.stop()` then waits for the stream until the 20-second hard exit. Admission has no drain gate, and new requests can also enter while asynchronous existing closers run. A synchronously throwing closer additionally prevents later closers from being invoked by the current `map`.
- Reproduced the lifecycle case: `await beginDrain(); onDrain(closer)` leaves the closer uncalled. An app with `isDraining() === true` still executes a declared handler with HTTP 200.
- Required correction: stop new admission at drain entry, make late subscriber registration close/refuse immediately, and invoke every closer even if another throws. Test a request paused before stream registration while SIGTERM begins. The Railway grace-period configuration fix in F08 does not solve this race.
- **Resolution:** Fixed: `beginDrain` flips `draining` synchronously and is idempotent, late `onDrain` closers run immediately, every closer runs even if one throws, and `drainGate` answers new requests (except health/ready) 503 `server_draining` with Retry-After 5. Tests: `app.test.ts` "draining" describe, notably "a request paused before it registers its stream closer is closed when SIGTERM begins the drain".

### F04. Major, FIXED: Content-Length bypassed body byte counting

- Location: `apps/api/src/http/limits.ts:38`.
- Failure before fix: installed Hono 4.12.28 skips its byte counter when Content-Length exists without Transfer-Encoding. A 40,000-byte body declaring length `1` passed the guest 32 KiB limit and reached the handler. The application-level contract explicitly prohibits trusting that header, regardless of what a particular network parser rejects first.
- Fix: count every actual body before admission/parsing, cancel on overflow, and preserve the original bytes. Retain the original Bun request in `ApiEnv` so reconstructed bodies do not break native socket-IP/timeout hooks. Tests cover small/invalid/negative declared lengths and native-request socket lookup. Existing chunked/body-class and webhook tests pass.

### F05. Major, FIXED: A to B to A accepted an old request when fetch ignored abort

- Location: `packages/api-client/src/core/transport.ts:131`, `:225`, `:289`.
- Failure before fix: scope equality became true again after A to B to A, so an already invalidated response was accepted. Reproduced `{stale:true}` with a delayed fetch; this contradicted the existing versioned scope model.
- Fix: check the tracked request's permanent `scopeAborted` flag after token acquisition, headers, and JSON body consumption. Regression now returns `scope_changed`. F02 remains a separate issue because RPC fetch releases that tracker early.

### F06. Major, FIXED: admitted responses omitted X-Workspace-Id

- Location: `apps/api/src/http/admission.ts:284`.
- Failure before fix: no production first-party handler set the admitted Workspace header. The client explicitly accepts an absent header, so its response-scope verification never ran against these routes.
- Fix: Workspace/Project admission sets the header from the resolved actor before downstream validation/operation. Identity-only routes do not fabricate a Workspace. Added a regression assertion.

### F07. Major, FIXED: intent fingerprinting rejected valid review passcodes

- Locations: `packages/api-client/src/core/keys.ts:59`, `:102`; `packages/api-client/src/core/idempotency.ts:41`.
- Failure before fix: `createIntent().keyFor({passcode:null})` threw the query-key credential prohibition. `createReviewRoundSchema` has a valid nullable/defaulted `passcode`, so ordinary review creation could not use the advertised shared intent helper.
- Fix: separate credential rejection for cache keys from canonical serialization of in-memory command inputs. Passcode changes mint a new intent key; identical inputs keep it. Query-key credential rejection still passes its original tests. Nothing is persisted or logged.

### F08. Major, FIXED in code: Railway had no configured shutdown grace

- Locations: `apps/api/railway.json:10`; `apps/api/src/index.ts:23`.
- Failure before fix: code assumes a 20-second drain budget, but checked-in configuration and the example did not set Railway's grace period. Railway documents a default of zero seconds before SIGKILL, so the new service could lose all cleanup time.
- Fix: set `deploy.drainingSeconds` to `"25"`, leaving five seconds beyond the application's hard deadline. JSON/Biome checks pass. Deployment owners must verify the service loads `apps/api/railway.json` and the effective setting; no deployed configuration was inspected or changed. Sources: [Railway teardown](https://docs.railway.com/deployments/deployment-teardown), [configuration field](https://docs.railway.com/config-as-code/reference), [default grace](https://docs.railway.com/deployments/reference).

### F09. Minor, FIXED: stream reconnect shortens Retry-After

- Location: `packages/api-client/src/core/stream.ts:250`.
- Failure: a 429/503 with `Retry-After: 120` reconnects after 30 seconds because server guidance is clamped to the backoff cap. A synthetic run recorded `sleep(30000)` for a 120-second refusal.
- Required correction: honor the bounded server delay independently of the exponential-backoff cap, or stop reconnecting for an excessive delay, as the ordinary query retry policy does.
- **Resolution:** Fixed: server `Retry-After` honored in full up to `MAX_STREAM_RETRY_AFTER_SECONDS` (300); longer ends the run as fatal. Test: `stream.test.ts` "Retry-After beyond the backoff cap is honored in full; one beyond the stream bound ends the run".

### F10. Minor, FIXED: Clerk directory outages become 500 during provisioning

- Locations: `packages/auth/src/identity.ts:283`, `:289`; `apps/api/src/http/request-policy-runtime.ts:106`.
- Failure: JWT verification succeeds, but first-login or stale-user `users.getUser` fails with a Clerk/network outage. Only the authenticator's unavailable result is translated to `authentication_unavailable` 503. The directory error escapes `loadAppUser` and becomes generic 500 without the intended Retry-After 5. It remains safely redacted and does not sign the user out, which limits the impact.
- Required correction: classify actual directory outages as provider unavailable while retaining confirmed-404/email-release and DB-error distinctions. Add a first-use/stale-refresh outage test, rather than mapping every provisioning exception to 503.
- **Resolution:** Fixed: `ClerkDirectoryUnavailableError` (network, 408, 429, 5xx from the Backend API lookup, in first-use, stale refresh and email-release paths) maps to 503 `authentication_unavailable` Retry-After 5; 404 release and DB errors keep their behavior. Tests: `personal-workspace-auth` fixture ("a first-login Clerk outage is a typed unavailable error...", "a stale-profile refresh outage...", "a non-outage Clerk refusal and a database failure stay ordinary errors"), `clerk.test.ts` "an outage is a network failure...", `admission.test.ts` "a Clerk directory outage while provisioning is a retryable 503...".

### F11. Minor, FIXED: Bun's hard body cap bypasses the common envelope

- Location: `apps/api/src/index.ts:38`.
- Failure: a real request exceeding 8 MiB receives Bun's empty 413, with no request ID, CORS, or JSON envelope. Reproduced on host Bun 1.4.2 for both Content-Length and chunked requests; the declared-length case never invokes `fetch` at all. `app.request` tests cannot exercise this boundary.
- Required decision: reconcile the application-envelope promise with the native ingress ceiling, and verify the chosen behavior on image Bun 1.3.6. Keep a hard bound; do not silently disable it just to satisfy an envelope test. Document any intentional native-ingress exception.
- **Resolution:** Fixed by decision: Bun cap is `NATIVE_BODY_CAP_BYTES` = 16 MiB (twice the largest route class) so ordinary overflow gets the app's 413 envelope with CORS; only a declared length above 16 MiB is a documented bare native refusal. Verified on host Bun 1.4.2 and image Bun 1.3.6 (1.3.6 does not cap chunked bodies natively; `limitBody` bounds them; reused-connection over-cap answers a bare 400). Test: `app.test.ts` "native body ceiling" (passes on both Bun versions).

### F12. Minor, FIXED: blocked localStorage can crash the provider before graceful hint handling

- Location: `apps/web/app/_components/api-provider.tsx:99`, `:121`.
- Failure: reading the `window.localStorage` property can itself throw SecurityError when storage is blocked. The hint store catches method failures only after that property has already been read, so rendering can fail before a runtime exists. The storage-event handler reads it again outside a catch.
- Required correction: obtain browser storage through a guarded accessor and tolerate its absence. It is an advisory selection hint, not a prerequisite for API access.
- **Resolution:** Fixed: `browserStorage()` guards the property read for both the hint store and the storage event handler. Test: `browser-storage.test.ts` "reading the blocked property (SecurityError) is tolerated rather than thrown".

### F13. Minor, FIXED: api-client retained unnecessary backend path aliases

- Location: `packages/api-client/tsconfig.json:3`.
- The implementer was correct that type-only route inference traverses backend declarations, but the claim that mirrored backend aliases were required no longer holds after ticket 04's package exports. A no-paths compile succeeded; the real api-client config now removes `baseUrl` and the complete backend `paths` block. Package typecheck and build both pass. This removes an unnecessary alternate resolution path; it was not evidence of browser value imports.
- Added useful read/mutation inference checks for a second real domain, Brand, alongside Projects, including negative field-type assertions. Added a full exported-client browser bundle graph check, extending the previous core-only check. No backend workspace values enter either graph. No declaration precompilation was added.

### F14. Minor, FIXED: URL/header ingress failures run before CORS

- Locations: `apps/api/src/app.ts:64`, `:83`; `apps/api/src/http/limits.ts:79`.
- Failure: a legitimate cross-origin browser request exceeding the 8 KiB URL or 32 KiB header bound gets a JSON 414/431 without Access-Control-Allow-Origin. Browser fetch sees a network/CORS failure instead of the typed refusal and request ID. Body ceilings below Bun's native cap do run after first-party CORS.
- Required correction: make allowed-origin application ingress refusals readable without wrapping MCP/webhooks in first-party trust. Identity must still remain after the ingress checks.
- **Resolution:** Fixed: `limitRequestEnvelope` (414/431) and the drain 503 add first-party CORS headers for an allowed Origin on first-party paths only, before identity. Test: `app.test.ts` "ingress refusals stay readable by first-party browsers".

## Decisions and accepted implementation choices

- **Do not require an always-present azp claim.** Clerk documents omission when Origin is empty/null. Keep the session-only Bearer requirement and exact authorizedParties verification when the claim exists; a missing claim cannot forge a signature or make cookies authenticate. Added a real signed-token missing-claim test. This is a clarification to the spec's description of azp verification. Requiring azp universally would impose a new policy on valid sessions and could exclude a future native client. It does not prove Expo compatibility: test actual Expo-issued session claims before shipping that client or changing its allowlist. [Clerk session claims](https://clerk.com/docs/guides/sessions/session-tokens).
- Claude was right to refuse oversized envelopes/bodies and wrong origins before identity. These are ingress refusals, not a reversal of the authenticated policy's capability/rate/Project/input order. Apply that distinction to the spec's broad admission-order wording. F11/F14 concern serialization and browser visibility, not a demand to authenticate before bounding untrusted input.
- The social origin split is behaviorally correct: service `origin` currently constructs provider callback URIs only; the adapter supplies API_ORIGIN there and WEB_ORIGIN for human redirects. A second unused service-origin parameter is unnecessary. POST/JSON OAuth starts and download-grant conversions remain correctly assigned to later tickets.
- Removing Next/React/server-only from auth/email is correct. Provisioning, refresh/defaults, unique-race recovery, confirmed-Clerk-404 email release, live membership selection refusal and the distinct staff allowlist are retained. Raw Svix bytes, delivery records and email relay remain equivalent to the original; sanitizing exception text is a justified change.
- Policy capability/status precedes rates, Project concealment/mismatch and validators. Actor identity remains separate from the Workspace owner. Editor baseline keys are 120/minute per actor+Workspace+clip plus 300/minute actor-global, without the 60/minute control-mutation bucket. The old 35 operation limits present in the partition match exactly; the other 15 are in later sibling migrations.
- Receipt support is a helper contract, not automatic idempotency. The closed command union and executor authorize before replay; replay bypasses `beforeAccept`, with the locked recheck before new acceptance. Domain owners still must set `deferRateRefusal`, enforce recorded exhaustion/outage in `beforeAccept`, preserve native body-key equality and emit replay headers. A header validator alone supplies none of those guarantees. Their absence on mechanically copied, not-yet-converted routes is assigned domain work, not a completed receipt implementation.
- Ordinary safe errors/request IDs/logged route patterns, exact-origin rejection, omission of cookies, 401 refresh with unchanged serialized body/key, query retry/cancellation defaults, and last-applied stream cursor are covered by the targeted suites. Staff cannot be obtained through a Workspace Admin role, and mutation registration requires an audit dependency.
- Pool configuration reaches the shared Neon adapter and retains Prisma transaction settings. Health/readiness, 120-second ordinary idle timeout, admitted-stream timeout hook and Railway readiness path are sensible. API does not start worker queues. Redis teardown by process exit is acceptable with the current service ownership; subscriber cleanup must still satisfy F03.
- Dockerfiles include all workspace manifests via app manifests plus `COPY packages`, `patches/`, frozen installation, root postinstall generation, native libraries and FFmpeg. The API workdir/native-smoke paths are correct. Actual image execution, Bun 1.3.6 behavior, Railway ingress/IP overwrite, effective config/region and deployed provider registrations remain release evidence, not established by a host smoke check. No Docker executable is available here.

## Route parity result and deltas

All **106/106** inline registrations have the same method and path. Every session route's capability, Workspace/Project kind, Project parameter and existing rate scope/prefix/limit/window match the old inventory. Compared original handler service calls/arguments, success status/shape and validation against each new home. No inline route was lost. The 59 sibling declarations are intentionally still with their domain owners and are not claimed as migrated. Current runtime inventory is 108 endpoints: those 106 plus ready and the separately moved Clerk webhook.

Changed behavior, beyond mechanical handler/DI moves:

1. Shared bounded error envelopes, malformed JSON rejection, content-type/origin/size refusals, explicit Workspace selection, Bearer transport and new baseline rate tiers apply as specified. Malformed JSON previously swallowed into `{}` by some handlers now refuses. Optional empty bodies without a JSON Content-Type still validate as `{}`.
2. The existing required idempotency-key routes now use the shared trimmed 1-128-character check and `idempotency_key_required` code. Several original handlers already returned 400 for a missing key; this is not uniformly a newly introduced status.
3. `GET /projects/:id/transcript/utterances` changes its 120-second private cache to no-store. Preview peaks keep the old private immutable cache for the Studio owner to resolve.
4. Social OAuth start/callback use configured API callback origins and web return origins. Invalid-origin runtime branches disappear because startup validates configuration. GET/302 starts are intentionally retained until ticket 17.
5. Health changes service name and adds version; ready is new.
6. Query validation now sees complete query objects through Hono. In particular, strict library search rejects unknown query names that the old adapter discarded, and repeated fields become arrays instead of the old first value. This is stricter input acceptance, not a lost route; preserve or document it in the owning adapter contract.
7. FIXED review deltas add actual admitted Workspace headers and correct the shared ingress/client bugs described above. No domain success DTO or service implementation was otherwise changed by this review.

The ledger below names every original inline registration, its original line, and its current home. Rows marked preserved retain handler success behavior and validation semantics subject to the shared transport changes above. Explicit deltas are named in the last column.

| # | Method and path under /api | Original line | Current home | Disposition |
| --- | --- | ---: | --- | --- |
| 1 | `POST /webhooks/tiktok/publication` | 132 | `apps/api/src/domains/publishing/webhooks.ts:17` | Preserved |
| 2 | `GET /health` | 236 | `apps/api/src/domains/platform/health.ts:41` | Service name/version; independent liveness |
| 3 | `GET /autopilot/rules` | 242 | `apps/api/src/domains/automation/routes.ts:19` | Preserved |
| 4 | `POST /autopilot/rules` | 249 | `apps/api/src/domains/automation/routes.ts:24` | Preserved |
| 5 | `PATCH /autopilot/rules/:ruleId` | 262 | `apps/api/src/domains/automation/routes.ts:34` | Preserved |
| 6 | `DELETE /autopilot/rules/:ruleId` | 275 | `apps/api/src/domains/automation/routes.ts:48` | Preserved |
| 7 | `POST /autopilot/rules/:ruleId/take-over` | 282 | `apps/api/src/domains/automation/routes.ts:57` | Preserved |
| 8 | `POST /autopilot/rules/:ruleId/run-now` | 289 | `apps/api/src/domains/automation/routes.ts:66` | Preserved |
| 9 | `GET /recipes` | 298 | `apps/api/src/domains/recipes/routes.ts:19` | Preserved |
| 10 | `POST /recipes` | 305 | `apps/api/src/domains/recipes/routes.ts:24` | Preserved |
| 11 | `PATCH /recipes/:recipeId` | 318 | `apps/api/src/domains/recipes/routes.ts:34` | Preserved |
| 12 | `POST /recipes/:recipeId/duplicate` | 332 | `apps/api/src/domains/recipes/routes.ts:49` | Preserved |
| 13 | `DELETE /recipes/:recipeId` | 339 | `apps/api/src/domains/recipes/routes.ts:58` | Preserved |
| 14 | `GET /projects` | 346 | `apps/api/src/domains/projects/routes.ts:43` | Preserved |
| 15 | `GET /workspace/search` | 377 | `apps/api/src/domains/library/routes.ts:28` | Preserved |
| 16 | `GET /library/search` | 386 | `apps/api/src/domains/library/routes.ts:33` | Same schema; stricter unknown/repeated query handling |
| 17 | `GET /workspace/exports/:exportId/download` | 401 | `apps/api/src/domains/exports/routes.ts:35` | Preserved |
| 18 | `POST /workspace/avatar/presign` | 421 | `apps/api/src/domains/workspace/routes.ts:17` | Preserved |
| 19 | `PATCH /workspace/avatar` | 435 | `apps/api/src/domains/workspace/routes.ts:31` | Preserved |
| 20 | `POST /projects/:id/generate` | 448 | `apps/api/src/domains/projects/routes.ts:75` | Shared key validation/code; service input preserved |
| 21 | `GET /projects/:id` | 473 | `apps/api/src/domains/projects/routes.ts:91` | Preserved |
| 22 | `GET /projects/:id/runs/:workflowRunId` | 486 | `apps/api/src/domains/projects/routes.ts:99` | Preserved |
| 23 | `GET /projects/:id/transcript` | 507 | `apps/api/src/domains/projects/routes.ts:118` | Preserved |
| 24 | `GET /projects/:id/transcript/utterances` | 526 | `apps/api/src/domains/projects/routes.ts:129` | No-store replaces max-age=120 |
| 25 | `GET /projects/:id/transcript/export` | 543 | `apps/api/src/domains/projects/routes.ts:144` | Preserved |
| 26 | `POST /ingest/link` | 579 | `apps/api/src/domains/ingest/routes.ts:19` | Preserved |
| 27 | `POST /ingest/rss/preview` | 593 | `apps/api/src/domains/ingest/routes.ts:29` | Preserved |
| 28 | `POST /ingest/rss/import` | 606 | `apps/api/src/domains/ingest/routes.ts:42` | Preserved |
| 29 | `GET /ingest/:projectId` | 620 | `apps/api/src/domains/ingest/routes.ts:52` | Preserved |
| 30 | `GET /projects/:id/clips` | 635 | `apps/api/src/domains/clips/routes.ts:55` | Preserved |
| 31 | `GET /projects/:id/clips/:clipId/preview-peaks` | 647 | `apps/api/src/domains/clips/routes.ts:62` | Preserved |
| 32 | `POST /projects/:id/clips/:clipId/title-suggestions` | 663 | `apps/api/src/domains/clips/routes.ts:80` | Preserved |
| 33 | `POST /projects/:id/clips/:clipId/duplicate` | 677 | `apps/api/src/domains/clips/routes.ts:96` | Preserved |
| 34 | `POST /projects/:id/clips/:clipId/create-from-selection` | 701 | `apps/api/src/domains/clips/routes.ts:112` | Preserved |
| 35 | `POST /projects/:id/clips/create-from-range` | 732 | `apps/api/src/domains/clips/routes.ts:130` | Preserved |
| 36 | `DELETE /projects/:id/clips/:clipId` | 741 | `apps/api/src/domains/clips/routes.ts:147` | Preserved |
| 37 | `POST /projects/:id/clips/render` | 752 | `apps/api/src/domains/clips/routes.ts:156` | Shared key validation/code; service input preserved |
| 38 | `POST /projects/:id/export-bundles` | 781 | `apps/api/src/domains/exports/routes.ts:60` | Shared key validation/code; service input preserved |
| 39 | `POST /projects/:id/export-bundles/preview` | 797 | `apps/api/src/domains/exports/routes.ts:86` | Preserved |
| 40 | `GET /projects/:id/export-bundles` | 812 | `apps/api/src/domains/exports/routes.ts:110` | Preserved |
| 41 | `GET /projects/:id/campaign-operations` | 823 | `apps/api/src/domains/clips/routes.ts:192` | Preserved |
| 42 | `POST /projects/:id/assisted-copy/generations` | 834 | `apps/api/src/domains/publishing/routes.ts:34` | Preserved |
| 43 | `POST /projects/:id/thumbnail-frames` | 851 | `apps/api/src/domains/clips/routes.ts:210` | Preserved |
| 44 | `GET /projects/:id/thumbnail-frames/:operationId` | 868 | `apps/api/src/domains/clips/routes.ts:229` | Preserved |
| 45 | `POST /projects/:id/thumbnail-frames/:operationId/retry` | 884 | `apps/api/src/domains/clips/routes.ts:242` | Preserved |
| 46 | `GET /projects/:id/campaign-operations/editor-action-catalog` | 900 | `apps/api/src/domains/clips/routes.ts:255` | Preserved |
| 47 | `POST /projects/:id/campaign-operations/preview-editor-action` | 912 | `apps/api/src/domains/clips/routes.ts:277` | Preserved |
| 48 | `POST /projects/:id/campaign-operations/apply-brand-profile` | 930 | `apps/api/src/domains/clips/routes.ts:303` | Shared key validation/code; service input preserved |
| 49 | `POST /projects/:id/campaign-operations/apply-style` | 952 | `apps/api/src/domains/clips/routes.ts:334` | Shared key validation/code; service input preserved |
| 50 | `POST /projects/:id/campaign-operations/apply-motion` | 974 | `apps/api/src/domains/clips/routes.ts:365` | Shared key validation/code; service input preserved |
| 51 | `GET /projects/:id/export-bundles/:bundleId` | 996 | `apps/api/src/domains/exports/routes.ts:128` | Preserved |
| 52 | `POST /projects/:id/export-bundles/:bundleId/retry` | 1011 | `apps/api/src/domains/exports/routes.ts:145` | Shared key validation/code; service input preserved |
| 53 | `POST /projects/:id/campaign-operations/:operationId/retry-export-bundle` | 1031 | `apps/api/src/domains/exports/routes.ts:171` | Shared key validation/code; service input preserved |
| 54 | `GET /projects/:id/export-bundles/:bundleId/download` | 1054 | `apps/api/src/domains/exports/routes.ts:197` | Preserved |
| 55 | `POST /projects/:id/brand-profiles/:profileId/scene-templates/:templateId/apply` | 1067 | `apps/api/src/domains/brand/routes.ts:55` | Shared key validation/code; service input preserved |
| 56 | `POST /projects/:id/review-rounds` | 1090 | `apps/api/src/domains/reviews/routes.ts:28` | Preserved |
| 57 | `GET /projects/:id/review-rounds` | 1110 | `apps/api/src/domains/reviews/routes.ts:50` | Preserved |
| 58 | `POST /projects/:id/review-rounds/:roundId/invite` | 1125 | `apps/api/src/domains/reviews/routes.ts:71` | Preserved |
| 59 | `POST /projects/:id/review-rounds/:roundId/comments` | 1147 | `apps/api/src/domains/reviews/routes.ts:95` | Preserved |
| 60 | `POST /projects/:id/review-rounds/:roundId/comments/:commentId/resolve` | 1168 | `apps/api/src/domains/reviews/routes.ts:114` | Preserved |
| 61 | `POST /projects/:id/review-rounds/:roundId/comments/:commentId/reopen` | 1193 | `apps/api/src/domains/reviews/routes.ts:133` | Preserved |
| 62 | `POST /projects/:id/review-rounds/:roundId/notifications/retry` | 1218 | `apps/api/src/domains/reviews/routes.ts:152` | Preserved |
| 63 | `POST /projects/:id/review-rounds/:roundId/revoke` | 1244 | `apps/api/src/domains/reviews/routes.ts:177` | Preserved |
| 64 | `POST /projects/:id/clips/:clipId/exports` | 1265 | `apps/api/src/domains/exports/routes.ts:218` | Shared key validation/code; service input preserved |
| 65 | `GET /projects/:id/exports/current` | 1294 | `apps/api/src/domains/exports/routes.ts:235` | Preserved |
| 66 | `GET /projects/:id/clips/:clipId/exports/:exportId` | 1305 | `apps/api/src/domains/exports/routes.ts:253` | Preserved |
| 67 | `GET /projects/:id/clips/:clipId/exports/:exportId/subtitles/:format` | 1313 | `apps/api/src/domains/exports/routes.ts:269` | Preserved |
| 68 | `GET /projects/:id/clips/:clipId/timeline/:format` | 1329 | `apps/api/src/domains/exports/routes.ts:295` | Preserved |
| 69 | `GET /projects/:id/clips/:clipId/timeline-source` | 1344 | `apps/api/src/domains/exports/routes.ts:318` | Preserved |
| 70 | `POST /projects/:id/clips/:clipId/exports/:exportId/retry` | 1350 | `apps/api/src/domains/exports/routes.ts:332` | Preserved |
| 71 | `POST /projects/:id/clips/:clipId/exports/:exportId/share-links` | 1356 | `apps/api/src/domains/exports/routes.ts:346` | Preserved |
| 72 | `DELETE /projects/:id/clips/:clipId/exports/:exportId/share-links` | 1374 | `apps/api/src/domains/exports/routes.ts:362` | Preserved |
| 73 | `POST /projects/:id/clips/apply-caption-preset` | 1383 | `apps/api/src/domains/clips/routes.ts:394` | Preserved |
| 74 | `POST /projects/:id/clips/apply-studio-edits` | 1405 | `apps/api/src/domains/clips/routes.ts:412` | Preserved |
| 75 | `GET /broll/search` | 1433 | `apps/api/src/domains/library/routes.ts:49` | Preserved |
| 76 | `GET /projects/:id/content-suite` | 1453 | `apps/api/src/domains/projects/routes.ts:169` | Preserved |
| 77 | `POST /projects/:id/content-suite` | 1460 | `apps/api/src/domains/projects/routes.ts:178` | Preserved |
| 78 | `GET /projects/:id/analytics` | 1475 | `apps/api/src/domains/projects/routes.ts:192` | Preserved |
| 79 | `GET /social/accounts` | 1483 | `apps/api/src/domains/publishing/routes.ts:53` | Preserved |
| 80 | `GET /social/oauth/start/:platform` | 1489 | `apps/api/src/domains/publishing/routes.ts:58` | API callback / web return origin split |
| 81 | `GET /social/oauth/callback` | 1531 | `apps/api/src/domains/publishing/routes.ts:85` | API callback / web return origin split |
| 82 | `GET /social/oauth/facebook-selection/:token` | 1588 | `apps/api/src/domains/publishing/routes.ts:126` | Preserved |
| 83 | `POST /social/oauth/facebook-selection/:token` | 1618 | `apps/api/src/domains/publishing/routes.ts:152` | Preserved |
| 84 | `DELETE /social/accounts/:accountId` | 1655 | `apps/api/src/domains/publishing/routes.ts:191` | Preserved |
| 85 | `GET /projects/:id/dubs` | 1663 | `apps/api/src/domains/projects/routes.ts:197` | Preserved |
| 86 | `POST /projects/:id/dubs` | 1669 | `apps/api/src/domains/projects/routes.ts:202` | Shared key validation/code; service input preserved |
| 87 | `GET /projects/:id/dubs/:dubId/download` | 1688 | `apps/api/src/domains/projects/routes.ts:218` | Preserved |
| 88 | `GET /projects/:id/clips/previews` | 1700 | `apps/api/src/domains/clips/routes.ts:438` | Preserved |
| 89 | `GET /projects/:id/clips/:clipId/download` | 1713 | `apps/api/src/domains/clips/routes.ts:452` | Preserved |
| 90 | `GET /projects/:id/clips/:clipId/file` | 1726 | `apps/api/src/domains/clips/routes.ts:467` | Preserved |
| 91 | `GET /brand-templates` | 1746 | `apps/api/src/domains/brand/routes.ts:86` | Preserved |
| 92 | `GET /brand-templates/:id` | 1752 | `apps/api/src/domains/brand/routes.ts:90` | Preserved |
| 93 | `POST /brand-templates` | 1758 | `apps/api/src/domains/brand/routes.ts:94` | Preserved |
| 94 | `PATCH /brand-templates/:id` | 1769 | `apps/api/src/domains/brand/routes.ts:104` | Preserved |
| 95 | `DELETE /brand-templates/:id` | 1780 | `apps/api/src/domains/brand/routes.ts:118` | Preserved |
| 96 | `POST /brand-templates/:id/set-default` | 1786 | `apps/api/src/domains/brand/routes.ts:123` | Preserved |
| 97 | `POST /brand-templates/:id/duplicate` | 1792 | `apps/api/src/domains/brand/routes.ts:132` | Preserved |
| 98 | `POST /brand-templates/logo/presign` | 1803 | `apps/api/src/domains/brand/routes.ts:146` | Preserved |
| 99 | `GET /brand-templates/:id/logo-url` | 1815 | `apps/api/src/domains/brand/routes.ts:156` | Preserved |
| 100 | `GET /audio-assets` | 1824 | `apps/api/src/domains/brand/routes.ts:168` | Preserved |
| 101 | `POST /audio-assets/presign-upload` | 1847 | `apps/api/src/domains/brand/routes.ts:178` | Preserved |
| 102 | `POST /audio-assets` | 1863 | `apps/api/src/domains/brand/routes.ts:188` | Preserved |
| 103 | `GET /audio-assets/:id/playback-url` | 1879 | `apps/api/src/domains/brand/routes.ts:198` | Preserved |
| 104 | `PUT /audio-assets/:id/favorite` | 1901 | `apps/api/src/domains/brand/routes.ts:213` | Preserved |
| 105 | `DELETE /audio-assets/:id/favorite` | 1920 | `apps/api/src/domains/brand/routes.ts:224` | Preserved |
| 106 | `DELETE /audio-assets/:id` | 1939 | `apps/api/src/domains/brand/routes.ts:235` | Preserved |

## Verification and limits

- `bun test apps/api/src packages/auth packages/api-client/src`: **419 pass, 6 skip, 0 fail**, 1,608 assertions. The six skips are the DB suite's normal disabled lifecycle cases; its separate gate below ran real PostgreSQL tests.
- `bun run --cwd apps/api typecheck`: pass.
- `bun run --cwd packages/api-client typecheck` and `build`: pass, with backend aliases removed and useful Projects/Brand client type checks.
- `bun run --cwd apps/api test:inventory`: **108 routes, 0 problems**. F01 demonstrates a blind spot in this passing gate.
- `.scratch/api-extraction/db-gate.sh bun run test:authenticated-request-policy:db`: **4 pass, 0 skip, 0 fail** after fixes. Only throwaway localhost PostgreSQL on port 55432 was used; never shared Neon.
- `bun test packages/services/src/operation-receipt.test.ts`: **13 pass, 0 fail**. A direct receipt DB-suite invocation through `db-gate.sh` was disabled by its additional ALLOW_INTEGRATION_DB_TESTS switch: **15 skip**, not counted as DB evidence. The full integration gate was not claimed or rerun.
- `bun run --cwd apps/api smoke:native`: font metadata, argon2id hash/verify, sharp+ffprobe and FFmpeg thumbnail all pass on the host.
- Biome checks on every edited foundation path and `git diff --check`: pass.
- Real local network probes reproduced F02 and F11 without external calls or DB access; synthetic dependency probes reproduced F01, F03 and F09. Reproductions of F04/F05/F07 were observed before their fixes and covered by regression tests afterward.
- Full web/root compile and the typecheck performance comparison remain transitional cleanup gates, as recorded by the implementers. Host Bun is 1.4.2; the Docker image pins 1.3.6. Container build/smoke and deployed configuration were not verified. No shared-resource chaos tests, migrations, provider calls, messages, commits or pushes were performed.

Before domain fan-out, resolve F01-F03 and rerun their adversarial regressions alongside the passing foundation gates. Do not treat the current green inventory/core tests as proof that those cases are safe.

## Re-check (round 2)

Reviewed 2026-10-29, branch `dev`, HEAD `f1a6ac85a618efd80f8bd34276db1a2795a09e60`, including the FIXED notes and appended registration contract. Domain tickets were changing this checkout during review. Only this section was appended; no source, fixture, configuration, or domain-ticket files were edited. Probes ran inline, without DB/provider calls.

**Recommendation: reopen F01 and F02.** The original ordinary mixed-registration leak and ordinary RPC body race are fixed, but the promised registration/inventory contract still has a clone escape, and RPC Response cloning recreates premature release. F03, F09, F10, F11, F12 and F14 are CLOSED.

### F01. REOPENED: Hono basePath clones escape registration restrictions, and inventory ignores ALL entries

Locations: `apps/api/src/http/admission.ts:185` and `:203`; `apps/api/src/route-inventory.ts:38`.

The direct helper calls behave correctly: missing declarations, duplicate method/path, no handler, and direct `use/all/on/route/mount` calls throw. Existing mixed raw/guarded GET duplicates in either order return 500 before handlers and fail inventory. The regression tests for these cases passed.

However, `createRouteApp(table).basePath("/")` returns Hono's ordinary clone, sharing the original routes/router but without the patched registration methods. All five supposedly forbidden methods then succeed at construction. An author can add an unmarked `ALL` entry ahead of a properly declared GET on the same helper. The inventory skips every ALL entry, including endpoint handlers, so it reports zero problems. The runtime guard does still refuse with 500 `request_policy_missing`: this remaining reproduction is a construction/inventory false negative and broken endpoint, not a reproduced anonymous data leak.

Minimal reproduction, run from `apps/api` via `bun -e`, using the actual composition:

```ts
import { Hono } from "hono";
import { createRouteApp } from "./src/http/admission.ts";
import { createInventoryApp } from "./src/test-app.ts";
import { checkRouteInventory } from "./src/route-inventory.ts";
const entry = { kind: "workspace", capability: "content.view" } as const;
const domain = createRouteApp({ "GET /probe": entry });
domain.basePath("/").all("/probe", c => c.json({ unauthorized: true }));
domain.get("/probe", c => c.json({ guarded: true }));
const mounted = new Hono().route("/api", domain);
console.log(checkRouteInventory(mounted, new Map([["GET /api/probe", entry]])).problems);
// []
console.log((await createInventoryApp({ domains: { projects: domain } })
  .request("/api/probe")).status);
// 500
```

Repeated with cloned `use`, `all`, `on`, `route`, and `mount`: all constructed and returned 500. Inventory missed use/all/route-with-an-ALL-child/mount; it caught on("GET", ...) as missing admission plus duplicate registration. Close the clone escape and inspect matching ALL entries while distinguishing approved composition middleware. Add these cases to construction and inventory tests.

### F02. REOPENED: collecting the original Response releases tracking while its clone still reads

Location: `packages/api-client/src/core/transport.ts:285`, with finalizer at `:132`.

The ordinary no-clone synthetic and real-loopback A→B body-consumption regressions passed, as did cancellation, caller abort, bodiless responses, and the existing A→B→A test. But the finalizer tracks the original Response object's lifetime, which does not include the lifetime of `response.clone()` or its body reader. Once the original is collected, it calls `tracked.release()` while the clone is active. Workspace transitions then cannot set that request's permanent `scopeAborted` flag or abort its reader. A→B→A before the remaining bytes arrive passes the per-chunk equality check and returns stale JSON.

Reproduced twice on Bun 1.4.2, first with a synthetic stream and then with real fetch against loopback Bun.serve. Both printed `releases before body end 1` followed by `{ value: { stale: true } }`. The real-network probe was:

```ts
import { ApiScope } from "./packages/api-client/src/core/scope.ts";
import { createApiTransport } from "./packages/api-client/src/core/transport.ts";
const scope = new ApiScope();
scope.setUser("u"); scope.selectWorkspace("A");
let releases = 0;
const track = scope.track.bind(scope);
scope.track = (...args) => {
  const tracked = track(...args);
  return {
    signal: tracked.signal,
    get scopeAborted() { return tracked.scopeAborted; },
    release() { releases++; tracked.release(); },
  };
};
let finish!: () => void;
const done = new Promise<void>(resolve => { finish = resolve; });
const encoder = new TextEncoder();
const server = Bun.serve({
  port: 0, hostname: "127.0.0.1",
  fetch: () => new Response(new ReadableStream({
    async start(controller) {
      controller.enqueue(encoder.encode('{"stale":'));
      await done;
      controller.enqueue(encoder.encode("true}"));
      controller.close();
    },
  })),
});
try {
  const bound = createApiTransport({
    baseUrl: "http://127.0.0.1:" + server.port,
    scope, getToken: async () => "t",
  }).scoped({ userId: "u", workspaceId: "A" });
  let original: Response | null = await bound.fetch("/api/probe");
  const clone = original.clone();
  original = null;
  const read = clone.json().then(value => ({ value }), error => ({ error: error.code }));
  for (let i = 0; i < 40 && !releases; i++) {
    Bun.gc(true);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  console.log("real fetch releases before body end", releases);
  scope.selectWorkspace("B"); scope.selectWorkspace("A");
  finish();
  console.log(await read);
} finally { await server.stop(true); }
```

Keep tracking until the guarded body and its consumers finish or cancel. Response collection alone cannot establish abandonment. Add a clone/body-lifetime regression that exercises collection before scope changes.

### Remaining finding dispositions

- **F03 CLOSED.** App tests reran the paused-before-closer request: drain begins while paused, a new request gets 503, resumed registration invokes its closer once. Late closers run immediately both during and after drain. Sync throws/rejections do not prevent other closers. Drain 503 includes Retry-After 5, envelope, request ID and allowed-origin CORS; health remains open and readiness refuses.
- **F04 CLOSED.** HTTP limit regressions pass for actual-byte counting despite small, invalid and negative Content-Length; chunked overflow refuses and original-request socket hooks remain covered.
- **F05 CLOSED on its original path.** Existing A→B→A ignored-abort transport regression passes. The additional cloned RPC case belongs to reopened F02 above.
- **F06 CLOSED.** Admission regression confirms the response reports the resolved Workspace in X-Workspace-Id.
- **F07 CLOSED.** Idempotency/key tests pass for nullable review passcodes, changed command input and cache-key credential rejection.
- **F08 CLOSED in checked-in code.** railway.json still specifies drainingSeconds "25" versus the application's 20-second deadline. Effective deployment configuration was not inspected.
- **F09 CLOSED.** Stream regression records the full 120,000 ms requested delay instead of 30,000 ms; guidance beyond the 300-second stream bound stops fatally.
- **F10 CLOSED.** Auth fixtures pass first-login and stale-profile directory outages without inventing/deleting users; confirmed 404 release, non-outage refusal and DB failures remain distinct. HTTP regression maps ClerkDirectoryUnavailableError to 503 authentication_unavailable and Retry-After 5; DB failure remains 500.
- **F11 CLOSED under the documented contract.** Real Bun 1.4.2 app test passes: 9 MiB control body gets 413 payload_too_large, allowed-origin CORS and request ID; over 16 MiB receives a bare native refusal. An isolated real Bun 1.3.6 server using the current apiRequestId, firstPartyCors, limitBody and NATIVE_BODY_CAP_BYTES reproduced 9 MiB → enveloped 413 with CORS/ID; 16 MiB + 1 → bare 400 without CORS/ID on the reused connection. Native cap remains configured in index.ts; actual-byte/chunked application limits pass.
- **F12 CLOSED.** All three browser-storage tests pass, including a throwing localStorage property getter. Both provider accesses use browserStorage().
- **F13 CLOSED for this re-check.** api-client tsconfig still has no backend paths/baseUrl; full exported-client browser bundle and core boundary tests pass. No package typecheck/build rerun was claimed during concurrent domain work.
- **F14 CLOSED.** Real-composition app tests pass 414/431 with allowed-origin CORS, Vary and typed JSON, excluding foreign origins, REST and webhook paths.

### Round 2 verification and concurrent edits

- Required `bun test apps/api/src/http packages/api-client/src/core packages/auth`: **334 pass, 6 skip, 0 fail**, 1,282 assertions across 23 files. Skips are the normal disabled PostgreSQL suite, not failures.
- Required `bun run --cwd apps/api test:inventory`: **108 routes, 0 problems** at invocation. F01 above is an independently reproduced blind spot in this green gate.
- Additional `bun test apps/api/src/app.test.ts apps/api/src/route-inventory.test.ts apps/web/app/_components/browser-storage.test.ts`: **39 pass, 0 fail**, 107 assertions.
- Later Bun 1.3.6 full-app native-test attempts could not load the concurrently changing domain graph: missing `executeGuestReviewCommand` export from reviews-commands.ts, then missing `restAdmission` export from domains/rest/admission.ts. These were module-loading failures before the native test, not reproduced HTTP-foundation failures. No attempt was made to fix another agent's files. The isolated current-middleware Bun 1.3.6 network probe above passed.
- No shared-resource tests, migrations, messages, commits, pushes or deployments. These checks establish local behavior at their invocation times, not an atomic validation of the ongoing domain fan-out.

## Round 3 fixes (Claude, 2026-10-29)

### F01. FIXED (round 3)
`createRouteApp` now closes registration at the source: every Hono registration (including `basePath` clones, which share the router and route list, and `Hono.prototype.route/mount.call(app)`) ends in `router.add` and a push on `routes`; both are wrapped and refuse unless a declared `get/post/put/patch/delete` registration is in progress. `use/all/on/route/mount/options/basePath` throw by name, and the sealed methods plus `router`/`routes` are non-writable and non-configurable. `options` was an additional unguarded hatch and is now closed. The inventory now checks `ALL` entries: any `ALL` entry behind the fail-closed guard (marked via `isAdmissionGuard`; all `ALL` entries when the app has no guard) must belong to a declared registration or a marked trust-area guard, else `unregistered_handler`. Protocol prefixes are skipped as before.
Tests: `apps/api/src/route-inventory.test.ts` -> `createRouteApp > refuses every other way of adding routes`, `the sealed methods cannot be reassigned or redefined`, `adversarial registration hatches on the returned app` (`basePath itself refuses`, `a clone taken from the shared prototype still cannot register`, `Hono.prototype.route/mount called on the domain app refuses`, `the router and the route list refuse direct writes`, `declared registrations still work after refused attempts`, `a refused hatch leaves nothing for the runtime guard to refuse`), and `route inventory and ALL entries` (Sol's clone `all()` shape; `all`, `use`, wildcard `use`, `on`, `route()` of an ALL child and `mount`, with and without a guard; composition middleware and protocol prefixes pass; real composition clean).

### F02. FIXED (round 3)
Tracking is now a lease over one tracked request: the guarded body stream holds one reference (finalizer registered on the stream, which tee branches keep alive, not on the Response), and `clone()` enrolls the original and the clone as holders. Each enrolled copy's `json/text/arrayBuffer/blob/bytes/formData` ends with a scope check on the still-live tracked request, so a clone read after the original finished, or the original read after the clone finished, rejects after A->B->A. Tracking is released once, after the last holder finishes; a failed/cancelled stream closes it for all.
Tests: `packages/api-client/src/core/transport.test.ts` -> `clones share one scope-tracked body` (`A to B to A while a clone reads rejects the clone and the original...`, `a clone fully read first does not let the original's buffered bytes through...`, `an unchanged scope reads both copies and releases exactly once, after the last one`, `cancelling every copy releases tracking once`, `real loopback server: the original is collected while its clone reads, then A to B to A rejects`). The old transport fails three of these.

Verification: `bun test apps/api/src/http packages/api-client/src/core` 263 pass, 6 skip (DB), 0 fail; `bun run --cwd apps/api test:inventory` 268 routes, 0 problems; `bun test apps/api/src/route-inventory.test.ts apps/api/src/app.test.ts` pass; biome clean on touched paths.
