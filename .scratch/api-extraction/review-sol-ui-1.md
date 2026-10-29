# Sol UI review 1

Reviewed tickets 06, 09, 10, 12 and 14 against `spec.md`, each ticket's Comments, and the original pages/actions at `9fed947a`. Review includes `a1c2ad41`, `06b089b1`, the integrated progress changes at `8cd992b4`, and the working tree observed during review. HEAD advanced concurrently to `cf06cd146ae6031c3b1c41403c18a9cc91e073ec`. Other agents were editing review/share files. No implementation file was changed by this reviewer.

No blocker established. Two P1 major findings and seven P2 findings remain. P1 means fix before cutover; P2 means a concrete correctness or performance gap against the parity contract. Some findings are old behavior carried through the conversion that the extraction spec explicitly requires changing.

## Spec and behavior findings

### F01. P1 major: Studio retries lose their command identity

- Owning ticket: **14**.
- Locations: `apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/tool-panels/generated-images-panel.tsx:247`; `apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/studio-shell.tsx:1952`.
- Failure scenario: an image job is accepted, its response is lost, and the user presses Generate again with the unchanged prompt. The first failure leaves the prompt in place, but the second attempt generates a different native idempotency key. `generated-media.ts:634` deduplicates by that key, so the retry can create another job and reserve another image allowance. Export likewise mints a new header key on each retry instead of retaining the original receipt identity.
- The spec's caller-key contract requires one key and payload through uncertain acceptance. Retain a scope-bound intent keyed by durable inputs and complete it only after confirmed acceptance. Export's `clipId_fingerprint` upsert does reuse an unchanged export, so this review does **not** claim every export retry creates a duplicate render. It still performs new acceptance instead of receipt replay and can encounter a new limiter/plan refusal after an earlier successful acceptance.

### F02. P1 major: a cached Project bypasses later admission failures

- Owning ticket: **10**.
- Location: `apps/web/app/(app)/projects/[projectId]/project-screen.tsx:65`.
- Failure scenario: load a Project, then delete it elsewhere or change its accessible Workspace, and refetch through focus or the progress provider's recovery path. React Query retains the successful data when the refetch returns `project_not_found`, `active_workspace_mismatch`, or `workspace_restricted`. The `isError && !data` condition makes `failure` null, so none of the missing/mismatch/restricted gates execute. The old Project and its old action permissions stay rendered without a failure notice.
- The original server admission always handled these failures before rendering. Process definitive admission failures even when cached data exists; reserve stale-data rendering for recoverable outages. A direct QueryObserver probe confirmed `isError=true`, retained data, and `projectPageRunsGate=false` after a failed refetch.

### F03. P2: Studio selection-created clips have no replay protection

- Owning tickets: **14**, with the receipt-backed endpoint change required from **11**.
- Locations: `apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/transcript-panel.tsx:1237`; `apps/api/src/domains/clips/routes.ts:122`.
- Failure scenario: Create clip from selection commits but its response is lost. The selection remains available and the user retries. The UI sends no caller key, and the API invokes `clipService.createClipFromSelection` directly with no receipt or native acceptance identity. The service inserts another clip for the same range.
- This is the same retryable range-create class covered by the spec's receipt requirement. Extend the receipt-backed command seam to this source-clip variant and retain its key across retry, including source clip and range in the durable input. The existing API tests cover duplicate and library range creation, but omit this third create path.

### F04. P2: billing serializes every cold route load

- Owning ticket: **06**.
- Locations: `apps/web/app/(app)/_components/app-chrome.tsx:411` and `:416`; `apps/web/app/_components/workspace-query-gate.tsx:265`.
- Failure scenario: a cold Project or Studio navigation waits for identity bootstrap, Workspace bootstrap, billing state, and only then the route aggregate. `WorkspaceShell` does not mount until Workspace bootstrap completes, then returns `ShellPending` until billing answers, so the route query cannot start alongside either scoped shell read. A slow billing request holds the entire page behind the full shell skeleton even though it is used only to word upgrade links.
- The spec requires independent bootstrap/route reads to run concurrently once their inputs are known. Preserve selection adoption first, then start eligible scoped reads together and let billing wording settle without delaying route data. This is a visible loading delay affecting Project detail and Studio despite their individual aggregate endpoints.

### F05. P2: Studio freezes the renamed title along with the document seed

- Owning ticket: **14**, integration with **12**'s rename invalidation.
- Locations: `apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/page.tsx:89`; `apps/web/app/(app)/projects/[projectId]/clip-actions-menu.tsx:129`; `apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/top-bar.tsx:341`.
- Failure scenario: rename the open clip using the Studio overflow menu. The PATCH succeeds and invalidates the Studio bootstrap, which refetches, but `seedRef` accepts data only on first load or reset. Both the top-bar label and the menu's title prop continue reading the original `seed.clipInfo`. Reopening Rename also starts with the old title.
- Freeze the editor/session seed, while allowing canonical presentation metadata such as clip title to update independently. Replacing the Editing Session or its dirty document is unnecessary and would violate its ownership contract.

### F06. P2: Studio's initial forbidden gate became an error screen

- Owning ticket: **14**.
- Locations: `apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/page.tsx:56` and `:124`.
- Failure scenario: a viewer in an active Workspace follows a bookmarked Studio URL. The shell allows `content.view`; Studio bootstrap correctly requires `content.edit` and returns `capability_denied`. `recoveryDestination` handles only mismatch/restricted, so this refusal is thrown to the Studio error boundary. Try again repeats the same denial.
- At `9fed947a`, `admitProjectPage(projectId, "content.edit")` sent this person to `/home` with the safe failure query parameters. Preserve that forbidden destination, as the converted Project detail gate already does.

### F07. P2: explorer prefetch skips page-one cache seeding

- Owning ticket: **09**.
- Locations: `apps/web/app/(app)/projects/_lib/api.ts:59`; `apps/web/app/(app)/projects/_components/projects-screen.tsx:84`.
- Failure scenario: hover/focus Home's View all or a folder tile, allow the explorer prefetch to finish, then navigate within its 30-second freshness window. Prefetch uses the plain query factory. Page-one seeding exists only inside the screen's overridden queryFn, which React Query skips for fresh prefetched data. The grid mounts with `ready=true` and an empty list cache, causing another page-one request and a grid loading state despite a successful prefetch.
- A direct QueryObserver probe using the actual project factories produced one explorer request, zero seeding calls, and no list cache after mounting the screen's override. Seed matching aggregate data through a path shared by prefetch and the screen, or initialize the list from the current aggregate. Preserve already loaded pagination when doing so.

### F08. P2: mounted clip previews cannot recover expired grants

- Owning ticket: **12**.
- Location: `apps/web/app/(app)/projects/[projectId]/clip-row.tsx:441`.
- Failure scenario: leave a completed Project open beyond the preview URL's lifetime, return, then play or seek an unbuffered clip. The preview query disables focus refetch, has no expiry timer, and ClipVideo has no grant-refetch callback. The five-minute staleTime only marks the query stale; it does not schedule a request. An unchanged detail refetch leaves readiness unchanged, so its effect does not invalidate previews either.
- The spec requires expired grants to refetch. Preserve a playing URL while valid, but renew on expiry/resume or media failure. The domain preview factory explicitly expects refetch on tab resume; the row overrides that behavior without adding an alternative recovery path. This is a required expiry-recovery gap carried through the conversion.

### F09. P2: Home/explorer/search content refusals do not reach the Workspace gate

- Owning tickets: **09**, shared refusal handling in **06** if centralized.
- Locations: `apps/web/app/(app)/home/home-screen.tsx:19`; `apps/web/app/(app)/projects/_components/projects-screen.tsx:95`; `apps/web/app/(app)/projects/_components/load-failure.tsx:18`; `apps/web/app/(app)/search/library-search.tsx:79`.
- Failure scenario: while a non-owner remains in the app, restrict their selected Workspace and trigger a Home/explorer/search read while the shell bootstrap is still cached. That content read returns `workspace_restricted`, but these screens show an ordinary retry failure. Retrying refetches only the failed route, so it can continue indefinitely without navigating to `/workspace-unavailable`.
- The ticket comment says the shell gate owns this redirect, but the gate observes only its own bootstrap query; transport reports only 401 and selection-changed to global callbacks. Route refusals do not invalidate the bootstrap or notify the gate. Connect definitive content-admission failures to the shared recovery gate, without retrying an old command in a newly selected Workspace.

## Standards review

No additional independent, non-tooling standards findings. The policy mirrors disclosed in ticket 10 currently match the server rules examined. Remaining server-action modules and authenticated-request helper cleanup are assigned to ticket 31; they were not treated as newly introduced client-bundle leaks. Source inspection found no new credential-bearing query keys, Clerk tokens on storage download URLs, unsafe HTML insertion, or production backend value imports in the reviewed client paths. This is source-review evidence, not a bundle/sentinel scan.

## Verification

- Ran `bun test` over `apps/web/app/_components`, `(app)/_components`, Home, Projects including all nested Studio tests, Search, member/workspace settings, Workspace creation, invites and unavailable-page directories, plus clip-media, auth-flow, post-auth-redirect and project-state tests. Result: **634 pass, 1 fail, 635 tests across 74 files**.
- The failing test is `UpgradeProvider dialog: checkout interval choice, plan change review, owner-only action`. Its child `upgrade.browser.fixture.tsx` fails during import with `SyntaxError: Export named 'redirect' not found` from `next/navigation`. The fixture mocks that module with only `useRouter`. Re-running `upgrade.test.tsx` alone reproduced **3 pass, 1 fail**. The suite is not green; no source/test fix was made during this review.
- Ran `bunx tsc -p apps/web/tsconfig.json --noEmit --incremental false`, disabling incremental writes for this read-only review. **No diagnostics in tickets 06/09/10/12/14 files.** Whole-program checking failed on `review/[token]/review-client.tsx` and obsolete `lib/authenticated-request-{action,page}.ts` references to moved policy modules. Review/share files were subsequently changing concurrently; these are the diagnostics from the recorded run.
- Used read-only QueryObserver probes for F02 and F07. Also checked repeated row-level preview invalidation: eight invalidations started eight query functions and cancelled seven. This proves cancellation churn, not eight HTTP requests, because token acquisition can defer fetch until after cancellation. No separate network-storm finding is asserted from that probe.
- The inspected transport captures scope, aborts on switch/sign-out, checks scope through response consumption, and preserves request body/header through the single forced-token retry. Campaign retries pass `Campaign-Retry-Of`; clip and bundle downloads fetch grants and navigate without attaching Clerk credentials. Studio's session remains the draft/revision owner; keepalive uses an in-memory token snapshot, bounds the body, and leaves Device Draft intact when sending is unavailable. Caption cue derivation files were unchanged by the reviewed UI conversion.
- No signed-in browser run, real unload/preflight test, visual capture, production build, DB mutation test or bundle scan was performed. The recorded layout/loading risks are inferred from code. Temporary check logs are at `/tmp/narriflow-review-sol-ui-tests.log`, `/tmp/narriflow-review-sol-ui-tsc.log`, and `/tmp/narriflow-review-sol-ui-upgrade.log`.

Standards: 0 independent findings. Spec/behavior: 9 findings, worst severity P1.

## Resolution

Fixed by Claude Sonnet 5.5 (uncommitted). Verified: web tests for `_components`, `(app)/_components`, home, projects (incl. Studio), search; `packages/api-client/src`; `apps/api/src`; `packages/services` clips-commands and operation-receipt tests; filtered `tsc` for web, api, services and api-client clean; `bun run lint` (no errors); `check-web-backend-imports.ts` passes.

- **F01 FIXED.** Image generation and Export now hold one `Intent` (`runtime.createIntent`, scope-bound) per panel/shell, keyed by the full durable input and completed only after a confirmed 2xx. The panel no longer mints `crypto.randomUUID()` per press; `createGeneratedImagesBrowserApi(projectId, api, intent)` adds `idempotencyKey` from the intent. Export goes through `createStudioExport` in `studio-api.ts`. Tests: `generated-images-browser.test.ts` "a retry after a lost response keeps the paid job's idempotency key until accepted"; `studio-api.test.ts` "a retry after a lost response replays the original Idempotency-Key until accepted" (both also prove a changed input or an accepted command mints a new key).
- **F02 FIXED (already in HEAD `6b9f6c41`).** `projectAccessLost` makes gone, forbidden, restricted and foreign answers replace cached data, while transport/5xx/429 failures keep it. Existing test: `project-load-error.test.ts` "gone, forbidden, restricted and foreign answers replace a cached page; outages and throttles keep it". The screen wiring is the single `failure` expression in `project-screen.tsx`.
- **F03 FIXED.** New receipt command `create_clip_from_selection` (`clips-receipt-commands.ts`, `clips-commands.ts`; `ClipService.createClipFromSelection` accepts the acceptance), route requires `Idempotency-Key`, defers the rate refusal and returns `Idempotent-Replayed`; `clipCommands.createFromSelection` takes the key; Studio uses an intent via `createClipFromStudioSelection`. Source clip and range are in the fingerprint. Tests: `clips-commands.test.ts` "a selection create retried after a lost response returns the accepted clip, never a second"; `routes.test.ts` "create-from-selection needs a key and replays through the receipt command"; `studio-api.test.ts` "pressing Create clip again after a lost response reuses the key; a new selection does not". No DB gate was run (no schema change; command names are text).
- **F04 FIXED for billing, DISAGREE for the bootstrap.** `WorkspaceShell` no longer returns `ShellPending` while billing is pending; upgrade wording stays "billing" until the read answers. Test: `app-shell.browser.fixture.tsx` (verified red against the old gate). The Workspace bootstrap still gates the screens: the capability, paused-Workspace and membership checks live there and children read it (`useWorkspaceBootstrap`), so starting route reads before it answers would issue content requests the gate may redirect away from. Left as designed.
- **F05 FIXED.** `withLiveClipTitle` overlays the latest bootstrap title on the frozen seed's `clipInfo` (memoized; same object while unchanged); the document seed and session are untouched. Test: `studio-api.test.ts` "a rename shows on the frozen seed without replacing anything else".
- **F06 FIXED.** Studio's bootstrap failure now uses the Project page's `projectGateDestination` through `studioBootstrapFailure` (viewer goes to `/home` with the safe parameters; the duplicated local mapping is deleted). Tests: `studio-api.test.ts` "studio bootstrap failures".
- **F07 FIXED.** `explorerQueryOptions(queryClient, api, filters)` in `projects/_lib/api.ts` seeds page one of the paged list inside its `queryFn`; the screen and `usePrefetchExplorer` share it, and an already loaded list is left alone. Tests: `projects/_lib/api.test.ts`.
- **F08 FIXED.** `ClipVideo` moved to `clip-video.tsx`. A media failure asks the row to renew the grant (rate-limited to once per 10 s so truly missing media cannot loop) and switches to it at once; a renewed URL never replaces a playing clip and lands on pause. Window-focus refetch is back on (still gated by the 5-minute stale time). Tests: `clip-video.browser.fixture.tsx` (run by `clip-video.test.ts`).
- **F09 FIXED.** `WorkspaceBootstrapView` subscribes to the query cache and sends any `workspace_restricted` error of the selected Workspace to the same destination as a restricted bootstrap (owner to billing, others to `/workspace-unavailable`). This covers Home, explorer, search and every other read in one place, with no per-screen handling and no replayed command. Test: `workspace-query-gate.browser.fixture.tsx` "a content read refused as paused sends the person to the recovery page without a retry loop" (verified red first).
- **Upgrade fixture failure FIXED (already in HEAD `07fac7a4`).** The fixture now spreads the real `next/navigation` exports; `upgrade.test.tsx` passes 4/4.
