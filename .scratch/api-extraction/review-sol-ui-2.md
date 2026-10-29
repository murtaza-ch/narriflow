# API extraction UI/API pair review

Reviewed 2026-10-29 against `9fed947a`, including `a1c2ad41`, `06b089b1`, and ticket 29's now-committed `8cd992b4`. HEAD advanced to `cf06cd14` during review; that commit changes MCP continuation pages outside this review. Concurrent review/share edits were left alone. Read the extraction spec and all eight requested tickets' Comments. No implementation or ticket files were changed.

Verdict: changes required before cutover. No P0 blocker found. Six P1 major findings and three P2 major findings follow. Findings distinguish reproduced failures from conclusions established by code inspection.

## R1. P1 major: Retry import does not reopen the stream after a live failure

- Owning ticket: **29**, integration with **16**.
- Location: `apps/web/app/(app)/upload/_lib/use-ingest-stream.ts:49`, `:59`, `:84`; caller at `apps/web/app/(app)/upload/_components/configure-step.tsx:254`.
- Failure scenario: a fresh import starts with `initial = { ingestStatus: "queued", errorCode: null }`. A streamed failure changes local state to failed and sets `done = true`. A successful Retry sets `ingestStart` to a new object with those same initial queued/null values. The reset effect depends only on the two primitive fields, so it never runs. The pill stays failed and the shared subscription stays disabled while the retried job runs.
- Evidence: a read-only happy-dom/React probe mounted the real hook, delivered an ingest failure, and rerendered with the successful retry's queued/null object. Both before and after retry it returned `{"ingestStatus":"failed","errorCode":"download_failed","enabled":false}`. Invalidating ingest queries does not fix this local state.
- Required correction: carry an explicit retry generation/reset signal or consume authoritative snapshot state so every accepted retry resets the local state and rejoins from the retained cursor. Cover a failure after an initial queued mount and successive retries.

## R2. P1 major: one-time key/signing plaintext enters the mutation cache

- Owning ticket: **25**.
- Location: `packages/api-client/src/developer/mutations.ts:51` and `:92`; component resets at `apps/web/app/(app)/settings/api/create-key-dialog.tsx:65` and `callback-secret-panel.tsx:39`.
- Failure scenario: both mutation functions return the complete response including `secret`. React Query records that response in `Mutation.state.data` and publishes it to mutation-cache subscribers. `gcTime: 0` only controls later collection after the observer detaches. A component's success callback calls `reset()` after the success notification, which cannot prevent the plaintext from entering the shared cache or being seen by devtools/cache subscribers.
- Evidence: the real `MutationObserver`, runtime, and rotation factory with a synthetic secret produced `{"leakedNotification":true,"cacheContainsSecret":true}`. The existing factory test calls `mutationFn` directly and never exercises this cache path; the browser fixture checks after reset/GC.
- Required correction: deliver plaintext directly to component-local state without returning it as mutation data. Keep only safe issuance facts in the mutation result. Assert on every mutation-cache update, including before reset, that the synthetic secret is absent.

## R3. P1 major: live delivery has an unbounded promise queue

- Owning ticket: **29**.
- Location: `apps/api/src/domains/progress/stream.ts:209`, especially `:213` and `:229`.
- Failure scenario: after initial catch-up, a missing sequence starts a slow durable-log read in `deliverLive`. Every subsequent Redis event creates another `.then(...).catch(...)` pair retaining its event. `maxBufferedEvents` applies only while `catchingUp`; `maxQueuedFrames` applies only to frames already enqueued for the client. Neither bounds the pending live-delivery chain. A stalled DB read plus live bursts can grow process memory until the process fails, even with a fast client.
- Evidence: a real stream-core probe configured `maxBufferedEvents: 3`, blocked the gap read, and delivered 10,000 additional live events. The subscription remained open: `{"emittedWhileGapReadBlocked":10000,"maxBufferedEvents":3,"subscriptionClosed":false}`. The existing overflow test covers initial catch-up only. This queue shape was inherited from the original route, but ticket 29's explicit memory-bound requirement remains unmet.
- Required correction: bound pending live deliveries throughout the connection, disconnect/drop the pending queue on overflow, and recover from the durable cursor. Test overflow while gap recovery is blocked, plus cleanup after close.

## R4. P1 major: attachment limit is checked after full buffering

- Owning ticket: **30**.
- Location: `packages/api-client/src/exports/attachments.ts:31`, especially `:38`.
- Failure scenario: a timeline ZIP without `Content-Length`, with a misleading length, or with transfer compression is fully accumulated by `response.blob()` before its size is checked. The 25 MiB constant therefore does not bound browser memory. A sufficiently large generated archive can exhaust the tab before the code throws.
- Evidence: a synthetic chunked 40 MiB response passed through the real `fetchTimelineArchive` helper. It consumed all 40 chunks before raising `RangeError`: `{"error":"RangeError","readMiB":40,"limitMiB":25}`. The existing oversize test covers declared length only.
- Required correction: count bytes while reading, cancel immediately when the limit is crossed, then construct the Blob from the bounded chunks. Preserve content type, filename, and revision as the helper currently does.

## R5. P1 major: export consumer bypasses the invalidation throttle

- Owning ticket: **29**.
- Location: `apps/web/app/(app)/projects/[projectId]/clips/[clipId]/exports/[exportId]/export-delivery-client.tsx:204`, especially `:206`.
- Failure scenario: every `clip_rendering` event for the Project calls `detail.refetch()`, including events for other clips/exports. A busy multi-clip render produces requests or repeated request cancellation at event cadence while the hub also performs its throttled invalidation. This defeats the five-second throttle and can exhaust the actor/Workspace read bucket or interrupt downloads/page reads with 429s. The ten-second fallback poll adds another independent trigger.
- Evidence: direct event callback and query ownership inspection. Explicit `refetch()` is outside `createProgressHub`'s throttle and terminal deduplication. The live test uses no mounted delivery consumer, so it does not check this path.
- Required correction: put the affected export-detail invalidation behind the shared owner/throttle, with immediate deduplicated terminal refresh. Retain the narrow fallback poll and reconnect/resume refresh. Test request counts with an actual delivery consumer during an event burst.

## R6. P1 major: revoked Project data remains rendered in cache

- Owning ticket: **29**, with the recovery gate in **10**.
- Location: `apps/web/app/(app)/projects/[projectId]/project-events-provider.tsx:135`; `apps/web/app/(app)/projects/[projectId]/project-screen.tsx:65`; `packages/api-client/src/projects/mutations.ts:66`.
- Failure scenario: a successfully loaded Project becomes inaccessible/purging, or its Workspace becomes restricted. The heartbeat correctly emits a refusal and the hub drops the connection. The consumer only invalidates the Project. Its refetch fails, but React Query retains the successful data, and the screen deliberately handles errors only when `!detailQuery.data`. The Project and its cached media remain rendered; the stream has stopped and the missing/restricted recovery never appears. A Workspace-selection 409 has separate global handling, which does not cover Project 404 or restriction refusals.
- Evidence: the revocation callback calls only `invalidateProject`, whose implementation only invalidates queries. The screen's error guard excludes cached-data failures. The original authorization-loss flow navigated/refreshed instead of retaining the screen.
- Required correction: cancel and clear protected Project reads on access loss and enter the appropriate recovery state. Treat authorization/missing/restriction refetch failures as authoritative even when stale data exists. Preserve stale data only for recoverable transport failures. Test revocation after a successful Project load.

## R7. P2 major: ingest has no fallback snapshot polling when SSE is unavailable

- Owning ticket: **29**, integration with **16**.
- Location: `apps/web/app/(app)/upload/_lib/use-ingest-stream.ts:79`; unused consumer factory at `packages/api-client/src/ingest/queries.ts:51`.
- Failure scenario: the separate-origin SSE path is unavailable or repeatedly fails while ordinary ingest reads work. Configure derives its current state solely from stream events. No upload component consumes `ingestSnapshotQueryOptions`, and there is no active-ingest poll. Invalidating `ingest/snapshot` therefore refetches nothing. The one-time resume decision is disabled after the first answer and does not update the hook. The pill/CTA can stay queued or downloading after the backend succeeds or fails.
- Evidence: source search across the upload directory found neither an ingest-snapshot consumer nor interval polling. Export delivery has an active fallback poll; ingest does not. The spec explicitly requires progress to continue through bounded polling when SSE is unavailable.
- Required correction: observe the current ingest snapshot with bounded active polling and reconcile terminal state/cursor/retry state through that read. Stop on terminal/unmount/scope change. Exercise an unavailable SSE endpoint alongside successful snapshot reads.

## R8. P2 major: developer webhook durability requirements remain open

- Owning ticket: **25**, REST integration with **23**.
- Location: `apps/api/src/domains/developer/routes.ts:172`; `packages/services/src/webhook-subscription.ts:239`; `apps/api/src/domains/rest/routes.ts:511`.
- Failure scenario: the webhook-test endpoint has no caller key or receipt. It updates `lastTestedAt`, then sends directly to the external endpoint. A crash between those steps loses the test; a lost successful response followed by retry gets a throttle refusal, and retry after the interval sends a different event. Separately, REST webhook creation still calls the unreceipted `webhookSubscriptions.create` rather than the canonical `create_webhook` command, so a retry cannot replay its original acceptance or share browser command identity.
- Evidence: both omissions are acknowledged in ticket 25's Comments and its unchecked acceptance criteria, and remain present in the reviewed code. Existing throttling/duplicate detection does not supply an immutable accepted result.
- Required correction: complete the promised durable test intent/delivery and canonical webhook-create command integration, or explicitly revise the spec with the coordinator before closing the ticket. Do not mark the current acceptance criteria satisfied based on the adapter tests.

## R9. P2 major: cross-domain invalidation misses dependent aggregates

- Owning tickets: **18**, **20**, **22**, with developer overview owned by **25**.
- Locations: `packages/api-client/src/publishing/mutations.ts:95`; `packages/api-client/src/brand/queries.ts:314`; `packages/api-client/src/automation/invalidation.ts:13`.
- Failure scenarios:
  - **18**: disconnect/select an account, then reopen Integrations or Standing Grants within their stale window. Account invalidation misses `developer/overview` and `automation/standing-grants`, so those screens keep the disconnected account or obsolete destination choices.
  - **20**: delete a Brand Profile used by a Recipe. The service updates the Recipe and pauses affected Standing Grants through `onRecipeContentChanged`; brand invalidation never invalidates the automation/grants aggregate, so an already-open grants view still presents the grant as active.
  - **22**: create/delete/repoint a rule using a Recipe. Automation invalidation only touches automation and Project home. Cached Recipes retain obsolete rule-use facts and delete availability.
- Evidence: seeded real QueryClient reads stayed `isInvalidated: false` for all four edges after their actual invalidators ran: account -> integrations/grants, brand -> grants, automation -> recipes.
- Required correction: add these concrete dependency edges in the owning invalidators, scoped to the captured identity/Workspace. Assert the actual aggregate keys rather than only domain-local keys.

## Verification

- `bun test apps/api/src/domains/progress apps/api/src/domains/automation apps/api/src/domains/developer apps/api/src/domains/exports packages/api-client/src/progress packages/api-client/src/automation packages/api-client/src/developer packages/api-client/src/exports`: **137 pass, 2 skip, 0 fail**, 456 assertions. The skipped tests are the opt-in live-stream file.
- `LIVE_STREAM_SECONDS=70 bun test src/domains/progress/live.test.ts`, from `apps/api`: **1 pass**, 12 assertions, 83.81 seconds. Real Bun server and fixture-owned Redis, token expiry, Redis loss, shared subscribers, ordered delivery, revocation, memory assertion, and disconnect cleanup passed. The fixture port was checked unused first; no existing processes were killed.
- Additional ingest/recipes/publishing/brand/automation client and relevant automation/developer/export service tests: **69 pass, 0 fail**, 215 assertions across eight files.
- Requested web directories, including Project/upload/export consumers and publishing-client tests: **676 pass, 2 fail, 2 errors**, 2,143 assertions across 88 files. The two errors are `SyntaxError: Export named 'redirect' not found` in the combined Bun process after incomplete global `next/navigation` mocks. `finishing-auto-refresh.test.ts` passes alone, 3 tests. The combined run is not a clean verification gate; isolate/repair the mocks before claiming it passes.
- `bunx tsc -p apps/web/tsconfig.json --noEmit --incremental false`: **exit 2, no diagnostics in the reviewed files**. At that point, 14 diagnostics were outside this review: review-client's media URL type and obsolete `lib/authenticated-request-action.ts` / `authenticated-request-page.ts` imports/types. Incremental writes were disabled to honor source-file immutability. Concurrent agents subsequently changed review files; these diagnostics are the observed run, not a claim about their final edits.
- Read-only adversarial probes reproduced R1-R4 and R9 using real hooks/helpers/cache objects and synthetic credentials/data; no probe files were added.

## Checks without additional findings

- Zoom callback stores a hashed, expiring state, atomically consumes it once, checks the configured redirect URI, and rechecks current membership before and after provider I/O. CRC remains outside Clerk admission. Rule create/run-now use their existing receipt identities and defer new-work limiter refusal until after replay.
- Developer credential receipts contain safe resource facts, not plaintext; replay returns `credential_already_issued`, and automatic mutation retries are disabled. Developer-private reads retain `api.manage`; unauthorized overview readers do not trigger those reads. R2 concerns browser cache disclosure, not receipt persistence.
- Upload Session changes preserve the transfer/resume algorithm and direct credential-free R2 PUT/XHR path. Drive commit is a direct command, so its access token is not put into a React Query mutation/query cache. Native commit/session identities remain in the command bodies.
- Export grant endpoints return JSON and large media navigates to storage. Attachment helpers preserve filename, content type and editor revision; their byte bound is the R4 gap.
- OAuth starts use authenticated POST followed by browser assignment. Publishing recovery/proposal and Brand Kit/Recipe/Autopilot creates inspected here carry per-intent identities. Publishing-provider polling is bounded by query intervals. No backend value import was found in the reviewed client/UI source paths by the focused scan.
- Signed-in cross-origin browser workflows and visual parity were not exercised in this read-only review. The tests and source inspection do not replace ticket 32's browser/build/dependency-graph verification or disposable-schema DB gates.

## Resolution

Implemented 2026-10-29 (Claude). Each fix has a test written first (R3 and R4 and R5 reproduced red before the change).

- **R1 FIXED.** `useIngestStream` takes `{ attempt }`; `ConfigureStep` bumps it on every accepted retry, and the reset effect depends on it, so a retry that restarts at the same queued/null resets state and rejoins from the retained cursor. Tests: `use-ingest-stream.browser.fixture.tsx` "every accepted retry resets a streamed failure and rejoins after the newest applied event" (two successive retries; run through `use-ingest-stream.test.ts`).
- **R2 FIXED.** `createApiKeyMutation` / `rotateCallbackSigningSecretMutation` take an `onSecret` sink, call it from inside `mutationFn`, and return the result without `secret`; the dialog and panel pass their `setSecret`. Test: `developer.test.ts` "a real mutation hands the secret to the callback and no cache update ever holds it" (real `MutationObserver`, snapshots of MutationCache and QueryCache on every cache notification plus the final result). The existing browser fixture still passes.
- **R3 FIXED.** `openProgressStream` keeps a bounded `pending` live queue (`maxBufferedEvents`) drained by one loop; past the bound it drops the queue and the live channel and recovers from the durable cursor by polling. Test: `stream.test.ts` "live events piling up behind a blocked gap read are bounded, then recovered from the log" (50 events behind a blocked read; live channel closed, every seq delivered once in order after release, subscription closed on stream close).
- **R4 FIXED.** `readBoundedBlob` counts bytes while reading, cancels the reader past 25 MiB, then builds the Blob; the Content-Length precheck stays. Tests: `exports.test.ts` "a body without a trustworthy length stops being read once it crosses the bound" (40 MiB chunked: cancelled, pulled < 30 chunks) and "a body within the bound keeps its type, name and revision".
- **R5 FIXED.** The hub's throttled non-terminal invalidation now includes the Project's export detail reads (terminal already refreshed all exports); the delivery client no longer refetches per event (it keeps the reconnect refresh and the 10 s fallback poll). Test: `hub.test.ts` "a burst of render events refetches an open export page once behind the throttle, and a terminal one at once" (real `QueryObserver` fetch counts: 30 events cause one refetch; another Project's export is untouched).
- **R6 FIXED.** New `clearProjectAccess` (cancel + reset of every cached read that names the Project, in this Workspace) is called by the Project events provider and the export client on revocation/fatal. `project-screen.tsx` now treats `projectAccessLost` (missing, forbidden, restricted, mismatch) as authoritative even with cached data; transport failures and throttles keep stale data. The export client observes the screen's query instead of re-seeding `initialData`, so a reset swaps the page for the screen's own recovery. Tests: `wave-b-invalidation.test.ts` "a mounted Project read drops its data and surfaces the refusal; other Projects and Workspaces are untouched"; `project-load-error.test.ts` "gone, forbidden, restricted and foreign answers replace a cached page; outages and throttles keep it". The full screen render after revocation still needs the ticket 32 browser pass.
- **R7 FIXED.** The hook polls `ingestSnapshotQueryOptions` every 5 s while the import is not terminal and reconciles state from it (ignored when older than an applied event, when read before the last reset, or once terminal; reset cancels any in-flight read). Tests: fixture "without any stream events the polled snapshot settles the import and stops polling" and "a snapshot read still in flight when a retry is accepted never brings the old failure back".
- **R8 FIXED for create/test in the first-party API; REST create DISAGREE.** Webhook test is now the receipt-backed `test_webhook` command: the endpoint's answer is recorded under the caller's Idempotency-Key, a retry after a lost response replays it (no resend, no throttle), the limiter's recorded outcome is enforced after the replay lookup and before the send, and the browser mutation mints one key per intent. A process death between the send and the commit resends once the throttle allows (a diagnostic event is at-least-once; no worker ledger is warranted). Tests: `developer-commands.test.ts` `test_webhook` (4), `developer/routes.test.ts` "a test needs a key, and a retry with the same key replays the recorded answer", `developer.test.ts` "a test posts to the webhook's own path; a retry keeps its key...". REST `POST /webhooks` stays on `webhookSubscriptions.create`: routing it through `developerCommands.createWebhook` would change its authorization from `processing.consume` plus the `processing:write` scope to `api.manage`, and add a required header to the frozen 31-operation contract. A lost-response retry is already safe, because the unique URL fingerprint answers `webhook_exists` with the original `webhookId` and creates no duplicate. Revisit only if the owner wants REST to replay the original body.
- **R9 FIXED.** `invalidateAfterAccountChange` now also marks `developer/overview` and `automation/standing-grants`; `invalidateBrand` marks `automation/standing-grants`; `invalidateAfterAutomationChange` marks `recipes`. Tests: `wave-b-invalidation.test.ts` "dependent aggregates follow their sources" (three cases, other Workspace untouched).

Web module-import errors: `SyntaxError: Export named 'redirect' not found` comes from `apps/web/app/(app)/_components/upgrade.browser.fixture.tsx` (its `next/navigation` mock lacks `redirect`), and the `useWorkspaceScope` not-found errors in a combined web run come from `settings/members/members-panel.test.tsx` mocking `api-provider` with only `useApiRuntime`. Neither file belongs to tickets 10/16/25/29/30, so I left them. The tickets' own directories (`projects`, `upload`, `settings/api`) run clean: 623 pass, 0 fail.
