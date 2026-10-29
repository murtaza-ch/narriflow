# Claude paired review: tickets 26 and 28

Reviewer: Claude (Opus 5.5), 2026-10-29. Scope: commits cf06cd14 and 6b9f6c41 plus the
current state of every owned file in tickets 26 and 28 (compared against the originals at 9fed947a), and the API side
(`apps/api/src/domains/{reviews,integrations}`). Read-only review. No source was edited.

## Verification run

- `bun test apps/web/app/review apps/web/app/share "apps/web/app/(continuation)" "apps/web/app/(app)/integrations/mcp" packages/api-client/src/reviews`
  -> **18 pass, 0 fail** (6 files, 49 expects; includes the subprocess browser fixtures).
- `bunx tsc -p apps/web/tsconfig.json --noEmit` -> **0 diagnostics** across the whole web project (none in reviewed paths).
- Source scan of all reviewed UI: no `@narriflow/{services,db,mcp-core,auth}` import, no `"use server"`,
  no `next/headers`, no `dangerouslySetInnerHTML`/`innerHTML`, no `console.*`, no guest credential in localStorage.

## Findings (ranked)

### M1 (Medium, confirmed by reading): a handoff refetch can abort an in-progress MCP upload
- `apps/web/app/(continuation)/integrations/mcp/upload/upload-screen.tsx:25-26`: the handoff query uses
  `staleTime: 0, gcTime: 0, retry: false` (`packages/api-client/src/integrations/queries.ts:24-29`) and inherits
  `refetchOnWindowFocus/refetchOnReconnect: true` (`packages/api-client/src/core/query-client.ts:71-72`).
- `resumeOnly` is wall-clock based (`apps/api/src/domains/integrations/runtime.ts:58`; TTL 600 s,
  `packages/mcp-core/src/mcp-confirmation.ts:18`), and `upload-picker.tsx:40` lists `props.resumeOnly` in the adapter `useMemo` deps.
- Failure scenario: the person opens the handoff, starts a multi-GB upload at minute 8, switches to the assistant tab, then
  comes back at minute 11. The focus refetch returns `resumeOnly: true`. The adapter is rebuilt and the old one is
  `dispose()`d (`upload-session-browser.ts:1353`, which aborts the active controller). The transfer stops, and the panel goes back to idle.
  The `beforeunload` guard does not apply because this is not a page unload. A second variant is any transient error on a focus or reconnect refetch
  (network blip, 429, 5xx). With `retry: false` it sets `query.isError`. Line 26 then replaces the picker with
  "Upload handoff unavailable" and unmounts the adapter mid-transfer.
- This is a regression. The original server page computed `resumeOnly` once per render.
- Fix: freeze the first successful handoff for the picker's lifetime. Set `refetchOnWindowFocus: false` and
  `refetchOnReconnect: false` on both continuation queries, or set them in the screen. Show unavailable only when
  `query.isError && !query.data`. Remove `resumeOnly` from the adapter deps (an expired `open` already becomes `status` server-side).
- Test: in the continuation fixture, advance the clock past `expiresAtMs`, dispatch `focus` during `uploading`,
  then assert that no abort happens and the snapshot phase is unchanged.
- The same pattern exists, with lower impact, at `confirm/confirmation-screen.tsx:32,46`. A transient error on a focus refetch
  of a still-valid preparation replaces the confirm page with "Confirmation unavailable".

### M2 (Medium, confirmed by reading): one shared intent per surface means uncertain retries can duplicate guest comments, decisions and internal rounds
- `apps/web/app/review/[token]/review-client.tsx:240,246,255` and
  `apps/web/app/(app)/projects/[projectId]/review-panel.tsx:124,145,158` each create a single `createIntent<Command>()`
  for every command kind. `createIntent` (`packages/api-client/src/core/idempotency.ts:40-55`) holds only one pending
  key. Any different fingerprint replaces it, and any success calls `complete()`, which clears it. Edits and deletes also call `keyFor`
  (line 246), even though they never send the key.
- Failure scenario (guest): POST comment, the server commits, the response is lost (`network_error`). The text stays in the box
  (`pendingComment` keeps the input). The guest then edits an older comment or clicks "Approve clip". That request succeeds
  and calls `intent.complete()`. The guest clicks "Comment" again: same `pendingComment` input, but a **new**
  Idempotency-Key, so the comment is duplicated. The mirror case is an uncertain decision followed by a comment, which duplicates
  the decision event.
- Failure scenario (internal): an uncertain "create round" with invitees, then any other command (for example resolve),
  then a retry of create. This produces a duplicate round and duplicate invite emails.
- The fixture covers only a same-command replay (`review-client.browser.fixture.tsx:211`).
- Fix: keep one intent per command identity (for example `Map<kind[:target], Intent>`), call `keyFor` only for keyed kinds,
  and `complete()` only the intent that succeeded.
- Test: lost comment response, then an edit succeeds, then the comment is retried. Assert that the same key is sent.

### M3 (Medium, confirmed by reading): Decline after an uncertain Confirm can say "No post was scheduled" when one was
- `confirm/confirmation-screen.tsx:47,62`: after a retryable failure (`network_error`/429/5xx,
  `(app)/integrations/mcp/continuation.tsx:43-45`), both buttons are enabled again. The API decline path is stateless
  (`apps/api/src/domains/integrations/runtime.ts:72` returns `?declined=1` without checking acceptance).
- Failure scenario: Confirm reaches the API and schedules the post, but the response is lost (for example a 504 from the edge). The person
  clicks Decline and sees "Publication declined. No post was scheduled.", while the post will still go out.
- Fix (smallest): once a confirm attempt fails with an uncertain error, keep Decline disabled and offer only "Try again".
  An alternative is to make decline refuse on an accepted token on the API side (ticket 24 owner).

### L1 (Low): an expired-grant playback error is ignored when the client clock disagrees with storage
- `apps/web/app/review/[token]/review-client-model.ts:116-120`: `onError`/`onPlay` renew only if the *client* clock
  says `expiresAt` has passed. If the client clock runs behind R2's clock, R2 rejects the URL with 403 while the client still
  considers the grant valid. The video stalls with no message and no renewal. This affects review and share playback alike.
- Fix: on `error`, renew once per grant regardless of the computed expiry (guard against loops with a per-URL flag).

### L2 (Low): downloads silently do nothing on an expired or failed refresh
- `share/[token]/shared-export-client.tsx:140-143` swallows the refresh failure (`.catch(() => undefined)`).
- `review/[token]/review-client.tsx:264` does nothing when the fetched grant is already expired.
- The user clicks Download and nothing happens, with no error. Surface an inline error instead (repository rule: no greyed dead ends).

### L3 (Low): the continuation upload has no upgrade affordance
- The `(continuation)` layout has no `UpgradeProvider`. `PlanLimitNotice` (`(app)/_components/plan-limit-notice.tsx:41`)
  therefore falls back to the default context (`canManageBilling: false`, no-op `openUpgrade`). A credits or plan refusal on the MCP
  upload shows the limit text but never the owner's upgrade action.
- This is arguably more correct than the previous behaviour, which used the selected Workspace's tier. The cheapest fix is a
  billing-link to the signed Workspace via `WorkspaceBillingLink`, as the connector-unavailable view already does.

### Nit
- Opt-out copy and status changed from the original HTML route (`9fed947a:apps/web/app/review/opt-out/route.ts`):
  - The heading "Stop automated review requests?" became "...emails?".
  - Invalid links no longer return HTTP 404 (the page is a static client page).
  - The page now requires JavaScript. A no-JS mail client preview still never unsubscribes, so this is safe.

## Cross-ticket blocker (not a 28 defect)
- The review CSP `connect-src` at HEAD lacked the API origin (`apps/web/next.config.ts` `/review/:path*`). That blocks every guest
  room, media, access and opt-out call, as Sol confirmed in the browser. Ticket 31's uncommitted working tree now adds `${API_ORIGIN}`.
  Verify the production header in 32, including `/review/opt-out` and the report-only policy for `/share/*`.

## Confirmed correct
- The guest Bearer is stored only in `sessionStorage["nf-review-session:<sha256>"]` (`review-client-model.ts:29-46`). It is cleared on
  expiry (timer, focus and visibility checks, plus `getSession`), on `review_session_invalid`/`review_access_invalid`, and on a
  malformed entry. Clearing it also removes the digest's room and media queries. It is never in a URL, a query key or a mutation variable:
  `accessMutation` returns `void`, so the credential never enters the mutation cache.
- The guest client strips `Authorization`/`X-Workspace-Id`, uses `credentials: "omit"` and `redirect: "error"`, and pins the origin.
- API logs record route patterns only (`apps/api/src/http/logging.ts`), so path and query tokens are not logged.
- All user text (comments, names, captions, provider settings) renders as React text. The hostile-text fixture passes.
- The mounted `<video src>` stays stable across background renewal and focus. Expired play or error recovery restores currentTime
  and play state. Share download links follow the refreshed expiry.
- Opt-out: GET previews only, and only an explicit click POSTs. noindex, no-referrer and no-store come from the `/review/:path*` headers.
- Internal panel: `invalidateReviewMutation` refreshes the reviews room, project detail and publishing reads only after
  confirmed success. Guest invalidation is limited to the digest room.
- 26: the confirm, preparation and handoff reads use identity-scoped transports with digest keys. Upload controls send
  `X-Narriflow-Upload-Intent` with the session Bearer, with no fetcher rewrite and no cookies. The billing link navigates only after
  `useWorkspaceSwitch` succeeds. The `(continuation)` group mounts `SessionApiProvider > RequireSignIn > SessionGate`
  without `WorkspaceQueryGate`. `ApiProvider` waits for Clerk `isLoaded`, so signed-in users do not get a sign-in flash.
  The URLs and the `/integrations/mcp/:path*` no-store, noindex and no-referrer headers are unchanged.

## Residual risk
- There is no live W -> A browser evidence yet for guest access, media, share, opt-out, MCP confirm or upload. That remains with ticket 32.

## Resolution (Sol)

M1, fixed. The upload screen freezes its first successful handoff for that signed identity and token. Upload and preparation queries disable focus/reconnect refetches, and a failed reread keeps loaded data. The picker captures its initial resume-only policy rather than rebuilding the adapter when that flag changes. The API still authorizes each control independently.

Regression evidence: the continuation DOM fixture failed before the fix when focus/reconnect after ten minutes reread the handoff. Both the resume-only and failed-reread cases now retain the same file input, uploading phase and active storage PUT without an abort, including an explicit reread. A separate failed preparation reread also reproduced the disappearing confirmation and now preserves its loaded facts.

## Resolution (Sol)

M2, fixed. Guest and internal review commands keep separate intents by command kind and target. Guest edits/deletes do not mint keys. Success clears only the successful command's intent. Internal intents are also scoped to the captured Project, user and Workspace.

Regression evidence: the guest lost-comment/approve/retry, lost-comment/edit/retry and internal lost-create/resolve/retry fixtures all failed with different retry keys before the fix and now reuse the original keys and payload. Additional coverage checks lost-decision/comment/retry and lost-invite/resolve/retry. The existing disposable PostgreSQL receipt suite also passes, including concurrent replay, decision events and atomic round notification intent.

## Resolution (Sol)

M3, fixed in the continuation and matching integrations API. An uncertain Confirm disables Decline for that mounted confirmation and exposes Try again with the same signed token. The API decline path calls the scheduling service's authorized immutable replay lookup and returns an already accepted publication's destination. It never schedules from Decline. Declined-page copy no longer asserts that nothing was scheduled, so opening that URL directly or racing another confirmation cannot make that claim.

Regression evidence: the UI test first reproduced enabled Decline after a lost Confirm response. It now checks that clicking Decline sends nothing and Try again sends the identical confirmation body. The API runtime test first reproduced a declined destination despite an accepted publication; accepted and unaccepted decline cases now return the appropriate destination without scheduling.

## Resolution (Sol)

L1, fixed. Playback errors force a fresh API grant regardless of client-clock expiry, bypassing a still-fresh cached grant. Each mounted URL can trigger only one error renewal; a repeated rejection displays an inline error. Ordinary background renewal still leaves the mounted video URL and playhead alone.

Regression evidence: review and public-share DOM tests first reproduced no renewal for a rejected URL whose advertised expiry was still fifteen minutes away. They now observe one fresh request, preserve the playhead and report a repeated rejection without another renewal. Existing expired-play/error restoration and long-playback/focus tests remain green.

## Resolution (Sol)

L2, fixed. Review downloads reject already-expired refreshed grants. Public-share downloads report failed refreshes, missing download URLs and expired refreshed grants inline. A fresh click clears the prior error before retrying.

Regression evidence: download fixtures first reproduced silent expired-grant results in review and share, plus a silent refused share refresh. All four review/share refusal and expired-grant cases now display an alert and keep the visitor on the page.

## Resolution (Sol)

L3, fixed. The continuation picker uses identity-bootstrap membership facts for the signed Workspace when an upload refusal offers an upgrade. Its owner gets the existing WorkspaceBillingLink with the suggested plan. Selection must validate before billing navigation; other roles retain the ask-owner instruction. The picker replaces the unusable provider-dependent upgrade notice locally, retaining the upload failure message and status panel.

Regression evidence: the credits-refusal fixture first timed out because no billing action existed for the owner. It now verifies selection of the signed Workspace, rather than the unrelated selected Workspace, before billing navigation. The editor case verifies that no billing action is offered. No backend imports, new UpgradeProvider or billing query was added to the continuation shell.

### Verification of all six resolutions

- Web: bun test apps/web/app/review apps/web/app/share "apps/web/app/(continuation)" "apps/web/app/(app)/integrations/mcp" "apps/web/app/(app)/projects/[projectId]/project-share-model.test.ts" apps/web/lib/review-preselection.test.ts: 20 pass, 0 fail. The three isolated DOM fixture processes cover 24 review/share scenarios, 17 MCP scenarios and three continuation-shell scenarios.
- API/client: bun test apps/api/src/domains/reviews apps/api/src/domains/integrations packages/api-client/src/reviews: 64 pass, 8 DB-hook/test skips, 0 fail.
- DB: .scratch/api-extraction/db-gate.sh env ALLOW_REVIEW_REPLAY_DB_TESTS=1 bun test apps/api/src/domains/reviews/guest-replay.db.test.ts: 6 pass, 0 fail against the disposable local PostgreSQL schema. No shared database was used.
- bunx tsc -p apps/web/tsconfig.json --noEmit: exit 0, no diagnostics, including none in the owned-file filter. bun run --cwd apps/api typecheck: exit 0.
- bun run lint: exit 0, with 11 existing warnings and one info outside these fixes. Targeted Biome check of the owned source and tests: clean. Owned git diff --check: clean.
- bun scripts/check-web-backend-imports.ts: passed, including the available client-bundle scan.
- No commits, installs, env-file edits, or termination of other agents' processes. Changes stay in ticket 26/28 files, their trackers, this review, and the explicitly authorized integrations runtime/tests. Concurrent UI, Studio and clips changes were left alone. Live signed-in W -> A evidence remains with ticket 32.
