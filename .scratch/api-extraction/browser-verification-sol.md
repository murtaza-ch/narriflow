# Sol browser verification

Date: 2026-10-29, started 08:56 UTC. Branch: `dev`, concurrent implementation changes during the pass. Final observed head `98c9103e`. Browser QA is complete with the failures and coverage limits below. No source fixes or commits were made by this tester.

## Session and environment

- Initial shared preview was signed in as `user_3KEzzCh8S0CnyFasFLKJZpld30E`. API port 4000 was down, with a completed SIGTERM drain in `/tmp/api-dev.log`. The orchestrator restored it. No services were started, restarted or stopped by this pass.
- Owner Chrome debugging was unavailable. Both `--cdp 9222` and `--auto-connect` failed. The owner confirmed debugging permission had expired. Shared preview subsequently timed out on snapshots.
- User authorized an isolated headless session. All subsequent flows use agent-browser session `sol-qa`, Clerk QA user `user_3LMNpHHaj1Aa5OrRrD35hCToRDl`, personal Business workspace `d6d06c2a-fa7a-485f-926b-c7b540e366d1`. Sign-in used a short-lived Clerk ticket; no secrets were printed or persisted by the login script.
- API auth optimization is occurring concurrently. Transient reload failures are retried once. Existing source changes are left untouched.

## Results

| Flow | Result | Evidence |
| --- | --- | --- |
| Signed-in offline gate | PASS | `/home` shows the offline error and a working retry. Three identity bootstrap attempts on initial load and three on explicit retry. Bearer present, credentials omit, no workspace hint on identity-only read. |
| Clean console/CSP | FAIL | Shared-preview home logs report-only `connect-src` violations for `https://clerk-telemetry.com/v1/event`. Suspected file `apps/web/next.config.ts:102`. No source fix made. |
| YouTube import and retry | BLOCKED at ingest | POST `/api/ingest/link` 202, project `ce6d25c0-9a55-4d1a-a959-666a643ddf7c`. Source metadata resolves to “Macbook PROLED XDR Impressions: They Said They Wouldn't!”, length 10:54. Provider refused import. One UI retry also failed. No local `ingest_job_started` line for this project; local notification worker did attempt its failure notification. Railway claiming is suspected, not proven. |
| Recipe create | PASS | Created `Sol QA Recipe` through UI. List shows 9:16, 10 clips, Auto, language Auto, hook first. |
| Autopilot rule | PASS create/pause/resume | `Sol QA future-only`, NPR Planet Money RSS, Recipe `Sol QA Recipe`, future-only baseline. Worker checked once and imported 0 existing episodes. Create 201, PATCH pause/resume 200. |
| Review standing grant lifecycle | PASS API/state, FAIL dialog cleanup | Grant `45f1391e-006d-4fca-9238-790ef589fd14`: create 201, pause 200, renew with daily cap 2 returns 200, revoke 200. Review destination uses the QA user's own email; no social account needed. |
| Render existing clip and play/download | PASS | Original QA project `0488562b-45e6-4451-9543-16fc684b6a1e`, clip `bba35048-7897-4d34-adb6-611c7ec49925`. POST clips/render 202 with Idempotency-Key. Card changed to rendered without reload. R2 video reached readyState 4 and currentTime > 1 s. Downloaded 1.0 MB MP4. |
| SSE beyond 60 seconds | PASS | `network-02.jsonl`: connections lasted 60,797 ms, 60,802 ms and 60,853 ms. Subsequent starts were sequential. API heartbeat reauthorization refused expired credentials, then the client reconnected successfully with a fresh token. No simultaneous duplicate stream for this project. |
| Transcript downloads | PASS text, SRT, VTT | Browser downloaded text and VTT artifacts; VTT has valid timestamped cues. SRT menu call also completed. |
| Repurpose generate | PASS | POST content-suite 200 in 15,935 ms, five generated assets with Copy buttons. |
| Dubbing panel | PASS read/configuration | Shows clip/ratio/language/voice selection and 30/30 monthly allowance. No dub provider job started. |
| Studio caption/text/layout autosave and reload | PASS | Changed `quality` to `SolQA`, added `Sol QA overlay`, selected Fit source. GET editor confirmed revision 5 with all changes; reload retained them. |
| Two-tab Studio ownership and stale revision | PASS | Second tab starts read-only with Take over; takeover makes the first tab read-only. New caption `SolQA2` saved as revision 6. A deliberate browser API PUT using captured revision 5 returned 409 `editor_revision_conflict`; revision 6 retained the new caption. |
| Studio export/delivery/workspace Exports | PASS delivery/list/download; FAIL list live updates | Export `4a3537f8-75fa-4e2c-aa9f-c16b5bc350f8`, revision 6, 9:16 1080p. Delivery observed at Rendering 5%, later Ready without reload. Workspace Exports lists it. Downloaded video is 1080×1920, 26.08 s. SRT contains `NARRIFLOW SOLQA2 CHECK.`; EDL ZIP includes v6 EDL and SRT. A later four-format export proves the list's live-update defect below. |
| Guest review comment and decisions | PASS | Created Round 03 `Sol QA review v6`, with downloads allowed. Separate clean `sol-guest` session, no Clerk user: access exchange 200, comment 201, clip approval 201, round approval 201. Guest API uses its own Bearer credential, no workspace hint and no cookies. No recipient email was sent for the manually created round. |
| Valid opt-out preview and confirmation | PASS | Used the application's `signReviewOptOutToken` helper with the QA workspace and QA email because Resend cannot deliver the development email. Signing secret stayed in the shell. Read-only DB count was 0 before and after preview GET, then 1 after explicit confirmation POST. UI says “You're opted out.” This is a real signed-link/API flow, not a mocked preview. |
| Public share and revocation | PASS | Created a revision-6 share link, loaded and played it in signed-out `sol-guest`. Version 6, 1080p, 26 s. Revoke returned 200; guest reload returned 404 and “This link isn't available.” The test share was revoked. |
| Campaign apply Brand Profile/style to many clips | PASS | Duplicated the clip through UI, selected both, chose project `QA Brand`. Brand preflight and apply returned 200; results 0 changed, 2 unchanged, 0 failed. Attached existing `QA Style` to that profile through Brand Kit, then bulk style preflight/apply returned 200; results 2 changed, 0 failed. Apply calls carried Idempotency-Key. Retry-of was not available because neither operation had failed items; no artificial failure was introduced. |
| Publishing composer to proposal | PARTIAL / BLOCKED at account selection | Composer opens for the chosen clip/export, but the QA workspace has no social accounts. It shows Connect an account and disables submit. No publication or social OAuth consent was attempted. A proposal was not submitted. |
| Stripe billing portal | PASS | POST `/api/billing/portal` 200, real `billing.stripe.com` sandbox portal opens and returns to web billing. No payment method or invoices on this fixture customer. |
| Personal-workspace plan change | BLOCKED by fixture state; paid-workspace test PASS below | UI offers Review Creator, but preview returns 409 `plan_change_conflict`, twice. The existing test fixture's Business tier was seeded directly in DB; read-only inspection confirms its billing account has a customer but no canonical subscription and null provider status. No confirmable quote exists on this personal fixture. |
| Workspace selection while old read is in flight | PASS scope isolation | `network-04.jsonl`: personal explorer GET starts 09:56:14.848, duration 9,028 ms. Selection POST starts 09:56:22.235, duration 1,626 ms, completing about 15 ms before the old explorer response ends. Subsequent explorer reads use `de0cbbc9-8fb7-40af-9aa0-b9760e12ae0b`. UI shows QA Second, its 60-credit Free/pending setup state and no projects; no `qa-speech` data leaks. A later attempted synthetic delay was inconclusive because the transport captures fetch and this CLI lacks its documented runtime `addinitscript` command. The PASS is based on the actual overlapping requests and visible scope result, not that instrumentation. |
| Pending workspace Stripe test payment and activation | PASS | Switched QA Second to monthly Business through UI. Checkout URL was verified as `checkout.stripe.com/...cs_test_...` before submitting the provided 4242 test card. Returned to localhost billing. Verified UI shows Business, billed monthly, 1,800 credits, current billing, 0 additional seats, renewal Nov 29. The personal workspace's manually seeded billing state was not altered. |
| Paid-workspace plan change | PASS | QA Second: preview Business → Pro 200, quote shows $0 today and effective Nov 29; cancelled the first quote. Previewed again, confirmed Schedule plan change 200; UI says Switching to Pro while current Business remains active. Keep current plan calls plan-change/cancel 200, followed by reconcile 200. Scheduled downgrade was removed; QA Second remains Business. All Stripe activity was sandbox activity. |
| Autopilot edit/run/delete | PASS operations, FAIL edit-dialog cleanup | Renamed to `Sol QA lifecycle complete` with PATCH 200. Edit close reproduces the same pointer/ARIA lock as grants; reloaded to continue. Run now POST 200. Delete DELETE 200; No autopilot rules yet. No test automation rule remains active. |
| Studio audio upload | PASS | Uploaded a generated 2-second WAV `solqa-tone`: presign-upload 200, direct R2 PUT, audio-assets POST 201, list GET 200. The item appears in Studio uploads. No audio was inserted into the clip and no dubbing provider was used. |
| Close-tab save | PASS cloud delivery and reload | Corrected `Welcome` to `CloseQA`, pressed Enter, and immediately closed the owned Studio tab before the 1,500 ms autosave debounce. Before reopening Studio, read-only DB verification found revision 8 and `CloseQA`. API request `46bfa28c-76c4-412e-863b-245ef75920b9` admitted the QA actor/workspace and PUT completed 200 in 10,685 ms. Reopened Studio retained it. The closed-tab request's completion was not retained in the browser HAR, so the server log and pre-reopen DB read are the delivery evidence. |
| Four-format export and list completion | PASS render/delivery; FAIL list completion | Export `c81b5a99-25dd-4c14-a223-97a2ef7cd7b8`, revision 8, four 1080p ratios. Local worker log proves processing by workflow `5306023d-fbb5-43cd-804b-f721ebd85507`; all variants reached Ready. Delivery offers all four formats. Processing-filtered Exports list remained Rendering 5% more than two minutes after database completion until refocused. |
| Sign-out, cache clearing, cross-tab clearing, sign back in | PASS | Held a read-only reference to the app's real QueryClient through its React context to measure clearing. UI Sign out immediately changed 7 queries → 0, mutations → 0, runtime identity → null. After Clerk sign-out, Narriflow localStorage keys were empty; no old project content remained. The other owned tab redirected to sign-in and had no clip/video. Direct `/home` redirected to `/?auth=sign-in`. Restored the same QA identity via a fresh Clerk sign-in ticket and verified `qa-speech` on home. Both headless test browsers were closed afterward. |

## Performance

One measured load per route, warm local development server, headless `sol-qa`. Time starts immediately before CLI navigation and ends when real route data is visible. API counts include requests started before readiness, including an open stream and unfinished preview requests, and exclude OPTIONS. Total resources is the browser's completed-resource count at readiness and includes scripts, CSS and fonts. These are observations, not production benchmarks. Neon latency and concurrent hot reload affect them.

| Page | Time to usable | API starts before usable | Completed resources at readiness |
| --- | --- | --- | --- |
| Home | 4.91 s | 3 | 64 |
| Projects | 4.24 s | 3 | 62 |
| Project detail | 9.27 s | 6 | 82 |
| Studio editor | 8.70 s | 4 | 88 |

`performance.jsonl` records completed-resource timing, and `performance-request-counts.json` reconciles request starts against the HAR. Home and Projects have identity bootstrap followed by route aggregate and billing in parallel. Project detail has three main reads, then social-posts, stream, and clip-previews follow at about 9.1 s. Studio has three main reads, then preview-peaks at 8.46 s. No duplicated aggregate was observed. Studio readiness means editing controls and transcript are usable; source preview initially still said Preparing preview.

Performance flag: Project detail's immediate social-posts poll is a secondary request after the aggregate already supplied `initialPosts`, even when there are no posts. `publishing-provider.tsx:212` starts a staleTime-0 query immediately rather than seeding or delaying the idle poll. This adds a request after the detail response. The stream and waveform/media-grant reads have separate transport purposes; they are counted, not presented as duplicate aggregates.

## Network evidence

`network-01.jsonl` through `network-07.jsonl` and the two guest traces contain sanitized request lines. Final captured totals: 415 API requests excluding OPTIONS, zero missing Bearer headers on first-party signed-in calls, zero missing Workspace hints on scoped calls, zero Cookie headers to API, zero Access-Control-Allow-Credentials, and zero requests to `localhost:3000/api/*`. Identity bootstrap/selection correctly omit the hint; guest access and public share use independent trust. There are 54 captured R2 requests, including one audio PUT, with zero Clerk Bearer or Cookie headers. Signed query strings are removed. Raw HAR files were deleted after sanitization. This count excludes the closed-tab save completion that was verified separately from server logs and DB state. See `network-summary.json`.

## Evidence files

All screenshots are indexed with absolute paths below. The same directory contains sanitized network JSONL, `network-summary.json`, `performance.jsonl`, `performance-request-counts.json`, `exports-live-evidence.json`, `signout-immediate.json`, and the initial offline request evidence. Download artifacts include two MP4s, transcript text/VTT, export SRT and an EDL ZIP. The MP4 dimensions and duration were verified with ffprobe; the ZIP contains a revision-6 EDL and SRT.

## Defects and observations

1. LOW: Clerk telemetry violates report-only CSP on signed-in home. Repro: open `/home`, inspect console. The policy allows Clerk account/com hosts but omits `clerk-telemetry.com`. It does not block API calls. Reconcile Clerk telemetry configuration with the intended policy before enforcing it. No change made because adding a telemetry destination is a product policy choice.
2. ENV: initial API shutdown blocked all flows. Restored by orchestrator; not counted as a product defect.
3. ENV: local notification delivery for the failed import reports that `narriflow.app` is not a verified Resend domain. Failure notification could not be delivered. This is separate from the import failure.
4. HIGH: closing conditionally mounted dialogs leaves the application locked. Reproduced on automation grant Create, Cancel after reload, Renew, Autopilot Edit Save, and the clip render confirmation. After the dialog disappears, the root remains `aria-hidden="true"`; `document.body.style` is `overflow: hidden; pointer-events: none;`, with no visible dialog. The page looks normal but mouse clicks do nothing and the accessibility tree loses the app controls. A full navigation/reload restores access. Repro: create an RSS rule with a Recipe, open its Manage grants link, cancel the New automation grant dialog, inspect body styles, try a sidebar link. Suspect `apps/web/app/(app)/settings/automation-grants/grants-panel.tsx:164` and its conditional mount at line 535; Autopilot's keyed EditRuleDialog in `autopilot-panel.tsx`; the `clip-row.tsx` render-confirm caller when row state swaps. The shared `useConfirm` already tries to retain its closed dialog, so fix caller lifecycle rather than removing global body styles manually. Billing quote Cancel and campaign preview Close both clean up correctly. No source fix made. Screenshots `07-review-grant-created.png`, `11-render-progress.png`, `40-autopilot-dialog-lock.png` show visible pages whose root remained hidden and pointer-disabled.
5. ENV: local worker reports `youtube_link_intake_unavailable`, token-server startup failed because `127.0.0.1:4416` is already in use. Both ingest rows have `source_provider_access_denied: YouTube blocked this import. Upload the video file instead.` Read-only DB inspection confirmed two failed jobs, one per user intent, attemptCount 1 each. No extra retries were submitted.
6. MEDIUM: creating a new review round keeps the prior round selected. The new round supersedes it, so immediately using Copy link/Open room sends a reviewer to a room that now refuses access. Repro: open existing project Review tab, create `Sol QA review v6`, then Open room without selecting the new Round 03 row. Guest access returns “Review access is invalid or expired.” Selecting Round 03 first yields the working link. `ReviewPanel.createRound` at `apps/web/app/(app)/projects/[projectId]/review-panel.tsx:379` closes the form but never changes `activeRoundId`, which was initialized from the previous round. No fix made.
7. MEDIUM: Exports list does not update active work. Repro: export four formats, open `/exports?status=processing`, leave that tab active. Export `c81b5a99-25dd-4c14-a223-97a2ef7cd7b8` completed at 10:26:35.097 UTC. At 10:28:39.259 UTC the same document still showed Rendering 5%, with exactly one list request since document load. Baseline and current `performance.timeOrigin` matched, ruling out a reload. Switching away and back caused a refetch and the item correctly disappeared from the Processing filter. `exports-screen.tsx:201` has a list useQuery without an interval or event subscription. Evidence: `exports-live-evidence.json`, screenshots 44–47. No fix made.

## Coverage limits and handoff

- Full YouTube ingest → transcription → detection → renders is not passed by this run. Both permitted link attempts failed at provider access. The separate concurrent owner-session YouTube pass also reports a worker polling blocker in `browser-verification-youtube.md`; its findings are not counted as this tester's results. Do not infer a successful full link pipeline from the successful existing-project renders.
- Campaign retry-of was not run because both tested operations completed with zero failures, so no retry control was offered.
- A publishing proposal was not submitted because the test workspace has no connected social account. No social network was published to.
- Second-user invite acceptance and local Stripe webhook receipt were skipped as allowed by the task. A second mailbox/identity was not used; Stripe events are routed to Railway, not the local API.
- No paid dub job, Drive/Dropbox/Zoom provider consent or return, restricted-member identity, or multipart video-upload pause/resume pass was performed. Those are still separate coverage gaps, not PASS results.
- No source fixes, repository test/lint run, environment-file edits, dependency installs, commits, deployments, or service termination by this tester. Verification used browser actions, sanitized network traces, API/worker logs, read-only DB checks and ffprobe. The orchestrator committed concurrent work while this report was being written; unrelated changes were left alone.

## Remaining test data

- Personal QA workspace: failed YouTube project `ce6d25c0-9a55-4d1a-a959-666a643ddf7c`; existing `qa-speech` now has two clips, QA Brand and QA Style applied, the original clip at editor revision 8, two new exports, Round 03 with guest feedback/approval, `Sol QA Recipe`, and uploaded `solqa-tone` audio. The new public share was revoked. The QA email has opted out of automated review requests. The test rule was deleted; its grant was revoked.
- QA Second `de0cbbc9-8fb7-40af-9aa0-b9760e12ae0b`: now has a verified monthly Business sandbox subscription and a 4242 test payment method. The scheduled Pro downgrade was removed. No real payment method was used.
- Signed-in QA session was restored before closing the isolated browsers. Owner Chrome tabs were not driven. All owned shared-preview tabs and both headless test browsers are closed.

No commits, environment edits, installs, or source fixes made.

## Screenshot manifest

- [01-home-api-offline.png](/Users/murtaza/Documents/dev/narriflow/.scratch/api-extraction/browser-sol/01-home-api-offline.png)
- [02-home-offline-repro.png](/Users/murtaza/Documents/dev/narriflow/.scratch/api-extraction/browser-sol/02-home-offline-repro.png)
- [03-link-config.png](/Users/murtaza/Documents/dev/narriflow/.scratch/api-extraction/browser-sol/03-link-config.png)
- [04-link-provider-failed.png](/Users/murtaza/Documents/dev/narriflow/.scratch/api-extraction/browser-sol/04-link-provider-failed.png)
- [05-link-retry-failed.png](/Users/murtaza/Documents/dev/narriflow/.scratch/api-extraction/browser-sol/05-link-retry-failed.png)
- [06-recipes-after-create.png](/Users/murtaza/Documents/dev/narriflow/.scratch/api-extraction/browser-sol/06-recipes-after-create.png)
- [07-review-grant-created.png](/Users/murtaza/Documents/dev/narriflow/.scratch/api-extraction/browser-sol/07-review-grant-created.png)
- [08-grant-paused.png](/Users/murtaza/Documents/dev/narriflow/.scratch/api-extraction/browser-sol/08-grant-paused.png)
- [10-grant-revoked.png](/Users/murtaza/Documents/dev/narriflow/.scratch/api-extraction/browser-sol/10-grant-revoked.png)
- [11-render-progress.png](/Users/murtaza/Documents/dev/narriflow/.scratch/api-extraction/browser-sol/11-render-progress.png)
- [12-clip-playback.png](/Users/murtaza/Documents/dev/narriflow/.scratch/api-extraction/browser-sol/12-clip-playback.png)
- [13-repurpose-generated.png](/Users/murtaza/Documents/dev/narriflow/.scratch/api-extraction/browser-sol/13-repurpose-generated.png)
- [14-dubbing-panel.png](/Users/murtaza/Documents/dev/narriflow/.scratch/api-extraction/browser-sol/14-dubbing-panel.png)
- [15-studio-edits.png](/Users/murtaza/Documents/dev/narriflow/.scratch/api-extraction/browser-sol/15-studio-edits.png)
- [16-studio-reloaded.png](/Users/murtaza/Documents/dev/narriflow/.scratch/api-extraction/browser-sol/16-studio-reloaded.png)
- [17-studio-second-tab-readonly.png](/Users/murtaza/Documents/dev/narriflow/.scratch/api-extraction/browser-sol/17-studio-second-tab-readonly.png)
- [18-studio-first-tab-lost-lease.png](/Users/murtaza/Documents/dev/narriflow/.scratch/api-extraction/browser-sol/18-studio-first-tab-lost-lease.png)
- [19-export-rendering.png](/Users/murtaza/Documents/dev/narriflow/.scratch/api-extraction/browser-sol/19-export-rendering.png)
- [20-exports-list.png](/Users/murtaza/Documents/dev/narriflow/.scratch/api-extraction/browser-sol/20-exports-list.png)
- [21-export-ready.png](/Users/murtaza/Documents/dev/narriflow/.scratch/api-extraction/browser-sol/21-export-ready.png)
- [22-guest-approved.png](/Users/murtaza/Documents/dev/narriflow/.scratch/api-extraction/browser-sol/22-guest-approved.png)
- [23-optout-preview.png](/Users/murtaza/Documents/dev/narriflow/.scratch/api-extraction/browser-sol/23-optout-preview.png)
- [24-optout-confirmed.png](/Users/murtaza/Documents/dev/narriflow/.scratch/api-extraction/browser-sol/24-optout-confirmed.png)
- [25-public-share.png](/Users/murtaza/Documents/dev/narriflow/.scratch/api-extraction/browser-sol/25-public-share.png)
- [26-share-revoked.png](/Users/murtaza/Documents/dev/narriflow/.scratch/api-extraction/browser-sol/26-share-revoked.png)
- [27-campaign-brand-preflight.png](/Users/murtaza/Documents/dev/narriflow/.scratch/api-extraction/browser-sol/27-campaign-brand-preflight.png)
- [28-campaign-brand-result.png](/Users/murtaza/Documents/dev/narriflow/.scratch/api-extraction/browser-sol/28-campaign-brand-result.png)
- [29-style-preflight.png](/Users/murtaza/Documents/dev/narriflow/.scratch/api-extraction/browser-sol/29-style-preflight.png)
- [30-style-applied.png](/Users/murtaza/Documents/dev/narriflow/.scratch/api-extraction/browser-sol/30-style-applied.png)
- [31-publishing-no-account.png](/Users/murtaza/Documents/dev/narriflow/.scratch/api-extraction/browser-sol/31-publishing-no-account.png)
- [32-stripe-test-portal.png](/Users/murtaza/Documents/dev/narriflow/.scratch/api-extraction/browser-sol/32-stripe-test-portal.png)
- [33-plan-change-fixture.png](/Users/murtaza/Documents/dev/narriflow/.scratch/api-extraction/browser-sol/33-plan-change-fixture.png)
- [34-workspace-switch-mid-response.png](/Users/murtaza/Documents/dev/narriflow/.scratch/api-extraction/browser-sol/34-workspace-switch-mid-response.png)
- [35-stripe-test-checkout.png](/Users/murtaza/Documents/dev/narriflow/.scratch/api-extraction/browser-sol/35-stripe-test-checkout.png)
- [36-billing-activated.png](/Users/murtaza/Documents/dev/narriflow/.scratch/api-extraction/browser-sol/36-billing-activated.png)
- [37-plan-change-quote.png](/Users/murtaza/Documents/dev/narriflow/.scratch/api-extraction/browser-sol/37-plan-change-quote.png)
- [38-plan-change-scheduled.png](/Users/murtaza/Documents/dev/narriflow/.scratch/api-extraction/browser-sol/38-plan-change-scheduled.png)
- [39-plan-change-removed.png](/Users/murtaza/Documents/dev/narriflow/.scratch/api-extraction/browser-sol/39-plan-change-removed.png)
- [40-autopilot-dialog-lock.png](/Users/murtaza/Documents/dev/narriflow/.scratch/api-extraction/browser-sol/40-autopilot-dialog-lock.png)
- [41-rule-deleted.png](/Users/murtaza/Documents/dev/narriflow/.scratch/api-extraction/browser-sol/41-rule-deleted.png)
- [42-audio-upload.png](/Users/murtaza/Documents/dev/narriflow/.scratch/api-extraction/browser-sol/42-audio-upload.png)
- [43-close-time-save-restored.png](/Users/murtaza/Documents/dev/narriflow/.scratch/api-extraction/browser-sol/43-close-time-save-restored.png)
- [44-exports-processing.png](/Users/murtaza/Documents/dev/narriflow/.scratch/api-extraction/browser-sol/44-exports-processing.png)
- [45-exports-stale-after-ready.png](/Users/murtaza/Documents/dev/narriflow/.scratch/api-extraction/browser-sol/45-exports-stale-after-ready.png)
- [46-four-format-export-ready.png](/Users/murtaza/Documents/dev/narriflow/.scratch/api-extraction/browser-sol/46-four-format-export-ready.png)
- [47-exports-refocus-recovered.png](/Users/murtaza/Documents/dev/narriflow/.scratch/api-extraction/browser-sol/47-exports-refocus-recovered.png)
- [48-signed-out.png](/Users/murtaza/Documents/dev/narriflow/.scratch/api-extraction/browser-sol/48-signed-out.png)
- [49-other-tab-signed-out.png](/Users/murtaza/Documents/dev/narriflow/.scratch/api-extraction/browser-sol/49-other-tab-signed-out.png)
- [50-session-restored.png](/Users/murtaza/Documents/dev/narriflow/.scratch/api-extraction/browser-sol/50-session-restored.png)
- [perf-home.png](/Users/murtaza/Documents/dev/narriflow/.scratch/api-extraction/browser-sol/perf-home.png)
- [perf-project.png](/Users/murtaza/Documents/dev/narriflow/.scratch/api-extraction/browser-sol/perf-project.png)
- [perf-projects.png](/Users/murtaza/Documents/dev/narriflow/.scratch/api-extraction/browser-sol/perf-projects.png)
- [perf-studio.png](/Users/murtaza/Documents/dev/narriflow/.scratch/api-extraction/browser-sol/perf-studio.png)

## Fixes (Claude)

- Defect 4 (dialogs lock the page): FIXED. Root cause: a Chakra/Zag Dialog that mounts already open under React StrictMode (the dev default) leaves `pointer-events: none` on the body and `aria-hidden` on the root after it closes. Mounting closed and opening one effect later avoids it. New hook `packages/ui/src/components/use-open-after-mount.tsx` (`useOpenAfterMount`) applied to the shared `ConfirmDialog` (its first `useConfirm` question mounts open: the clip render confirmation), `GrantDialog`, Autopilot `EditRuleDialog`, `RecipeDialog`, `PublishingCover` and the passkey reverification dialog. Tests: `apps/web/app/(app)/_components/dialog-unmount.test.ts` (runs `dialog-unmount.browser.fixture.tsx` in happy-dom under StrictMode: "a conditionally mounted Dialog leaves the page clickable after it closes" and "the first useConfirm question unlocks the page on Cancel"; the second failed before the `ConfirmDialog` change). Not changed: `auth-modal.tsx` (its hook would sit after an early return, so it cannot use the hook; not reported).
- Defect 6 (new review round keeps the old round selected): FIXED. `ReviewPanel` stores a pick as `{ id, newestId }` and `shownRound` (`projects/[projectId]/project-share-model.ts`) ignores a pick once a newer round exists. Test: `project-share-model.test.ts` "moves to a newly sent round instead of keeping the superseded one selected".
- Defect 7 (Exports list stale after render completes): FIXED. `exportQueries.workspaceList` polls every 5 s (`ACTIVE_EXPORT_POLL_MS`, foreground only) while any listed export is `queued` or `rendering` and stops when all are settled (`partial_ready` and `failed` count as settled). Test: `packages/api-client/src/exports/exports.test.ts` "the Workspace list polls while an export is rendering and stops once all have settled".
- Defect 1 (Clerk telemetry CSP violation): FIXED by disabling it, `<ClerkProvider telemetry={false}>` in `apps/web/app/layout.tsx`; the CSP is unchanged. Test: `apps/web/next-config-csp.test.ts` "Clerk browser telemetry is disabled rather than admitted by the CSP".
- Verification: `bun test packages/api-client/src` (232 pass); web tests under `(app)/projects`, `autopilot`, `recipes`, `settings`, `_components` plus `next-config-csp.test.ts` (647 pass); `bunx tsc -p apps/web/tsconfig.json --noEmit` filtered to touched files (clean); `bunx tsc -p packages/api-client/tsconfig.json --noEmit` (clean); `bun run lint` (no errors; 11 pre-existing warnings in unrelated css/regex files); `bun scripts/check-web-backend-imports.ts` (passes). No browser pass was done for these fixes.
