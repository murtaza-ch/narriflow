# Sol browser verification

Date: 2026-10-29. Branch: `dev`. This report is in progress.

## Session and environment

- Initial shared preview was signed in as `user_3KEzzCh8S0CnyFasFLKJZpld30E`. API port 4000 was down, with a completed SIGTERM drain in `/tmp/api-dev.log`. The orchestrator restored it. No services were started, restarted or stopped by this pass.
- Owner Chrome debugging was unavailable. Both `--cdp 9222` and `--auto-connect` failed. The owner confirmed debugging permission had expired. Shared preview subsequently timed out on snapshots.
- User authorized an isolated headless session. All subsequent flows use agent-browser session `sol-qa`, Clerk QA user `user_3LMNpHHaj1Aa5OrRrD35hCToRDl`, personal Business workspace `d6d06c2a-fa7a-485f-926b-c7b540e366d1`. Sign-in used a short-lived Clerk ticket; no secrets were printed or persisted by the login script.
- API auth optimization is occurring concurrently. Transient reload failures are retried once. Existing source changes are left untouched.

## Results so far

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
| Studio export/delivery/workspace Exports | PASS ready delivery/list/download, live list transition not observed | Export `4a3537f8-75fa-4e2c-aa9f-c16b5bc350f8`, revision 6, 9:16 1080p. Delivery observed at Rendering 5%, later Ready without reload. Workspace Exports lists it. Downloaded video is 1080×1920, 26.08 s. SRT contains `NARRIFLOW SOLQA2 CHECK.`; EDL ZIP includes v6 EDL and SRT. Exports list was already ready at first load, so its processing-to-ready transition is not claimed. |
| Guest review comment and decisions | PASS | Created Round 03 `Sol QA review v6`, with downloads allowed. Separate clean `sol-guest` session, no Clerk user: access exchange 200, comment 201, clip approval 201, round approval 201. Guest API uses its own Bearer credential, no workspace hint and no cookies. No recipient email was sent for the manually created round. |
| Valid opt-out preview and confirmation | PASS | Used the application's `signReviewOptOutToken` helper with the QA workspace and QA email because Resend cannot deliver the development email. Signing secret stayed in the shell. Read-only DB count was 0 before and after preview GET, then 1 after explicit confirmation POST. UI says “You're opted out.” This is a real signed-link/API flow, not a mocked preview. |
| Public share and revocation | PASS | Created a revision-6 share link, loaded and played it in signed-out `sol-guest`. Version 6, 1080p, 26 s. Revoke returned 200; guest reload returned 404 and “This link isn't available.” The test share was revoked. |
| Campaign apply Brand Profile/style to many clips | PASS | Duplicated the clip through UI, selected both, chose project `QA Brand`. Brand preflight and apply returned 200; results 0 changed, 2 unchanged, 0 failed. Attached existing `QA Style` to that profile through Brand Kit, then bulk style preflight/apply returned 200; results 2 changed, 0 failed. Apply calls carried Idempotency-Key. Retry-of was not available because neither operation had failed items; no artificial failure was introduced. |
| Publishing composer to proposal | PARTIAL / BLOCKED at account selection | Composer opens for the chosen clip/export, but the QA workspace has no social accounts. It shows Connect an account and disables submit. No publication or social OAuth consent was attempted. A proposal was not submitted. |
| Stripe billing portal | PASS | POST `/api/billing/portal` 200, real `billing.stripe.com` sandbox portal opens and returns to web billing. No payment method or invoices on this fixture customer. |
| Personal-workspace plan change | BLOCKED by fixture state | UI offers Review Creator, but preview returns 409 `plan_change_conflict`, twice. The existing test fixture's Business tier was seeded directly in DB; read-only inspection confirms its billing account has a customer but no canonical subscription and null provider status. No confirmable quote exists. Pending-workspace checkout is being tested next. |
| Workspace selection while old read is in flight | PASS scope isolation | `network-04.jsonl`: personal explorer GET starts 09:56:14.848, duration 9,028 ms. Selection POST starts 09:56:22.235, duration 1,626 ms, completing about 15 ms before the old explorer response ends. Subsequent explorer reads use `de0cbbc9-8fb7-40af-9aa0-b9760e12ae0b`. UI shows QA Second, its 60-credit Free/pending setup state and no projects; no `qa-speech` data leaks. A later attempted synthetic delay was inconclusive because the transport captures fetch and this CLI lacks its documented runtime `addinitscript` command. The PASS is based on the actual overlapping requests and visible scope result, not that instrumentation. |

## Performance

One measured load per route, warm local development server, headless `sol-qa`. Time starts immediately before CLI navigation and ends when real route data is visible. API count excludes OPTIONS and later preview/media/polling work; total resources includes scripts, CSS and fonts. These are observations, not production benchmarks. Neon latency and concurrent hot reload affect them.

| Page | Time to usable | Initial API reads | Total resources at readiness |
| --- | --- | --- | --- |
| Home | 4.91 s | 3 | 64 |
| Projects | 4.24 s | 3 | 62 |
| Project detail | 9.27 s | 3 | 82 |
| Studio editor | 8.70 s | 3 | 88 |

`performance.jsonl` records request starts/durations. Home and Projects have identity bootstrap followed by route aggregate and billing in parallel. Project detail uses one detail aggregate; Studio uses one bootstrap aggregate, with preview-peaks/media later. No duplicated aggregate in these measured loads. Studio readiness means editing controls and transcript are usable; source preview initially still said Preparing preview.

## Network evidence

`network-01.jsonl` and `network-02.jsonl` contain sanitized request lines. Across these segments: 132 API requests excluding OPTIONS, zero Cookie headers to API, zero Access-Control-Allow-Credentials, zero requests to `localhost:3000/api/*`. All captured signed-in API requests had Bearer auth; workspace-scoped calls had the QA workspace hint. Identity bootstrap correctly omitted the hint. R2 requests are recorded without their signed query strings and had no Clerk Authorization or Cookie header. Raw HAR files were deleted after sanitization.

## Evidence files

- `/Users/murtaza/Documents/dev/narriflow/.scratch/api-extraction/browser-sol/01-home-api-offline.png`
- `/Users/murtaza/Documents/dev/narriflow/.scratch/api-extraction/browser-sol/02-home-offline-repro.png`
- `/Users/murtaza/Documents/dev/narriflow/.scratch/api-extraction/browser-sol/03-link-config.png`
- `/Users/murtaza/Documents/dev/narriflow/.scratch/api-extraction/browser-sol/04-link-provider-failed.png`
- `/Users/murtaza/Documents/dev/narriflow/.scratch/api-extraction/browser-sol/05-link-retry-failed.png`
- `/Users/murtaza/Documents/dev/narriflow/.scratch/api-extraction/browser-sol/06-recipes-after-create.png`
- `/Users/murtaza/Documents/dev/narriflow/.scratch/api-extraction/browser-sol/network-evidence.json` contains the initial offline retry evidence, with header booleans rather than credentials.

## Defects and observations

1. LOW: Clerk telemetry violates report-only CSP on signed-in home. Repro: open `/home`, inspect console. The policy allows Clerk account/com hosts but omits `clerk-telemetry.com`. It does not block API calls. Reconcile Clerk telemetry configuration with the intended policy before enforcing it. No change made because adding a telemetry destination is a product policy choice.
2. ENV: initial API shutdown blocked all flows. Restored by orchestrator; not counted as a product defect.
3. ENV: local notification delivery for the failed import reports that `narriflow.app` is not a verified Resend domain. Failure notification could not be delivered. This is separate from the import failure.
4. HIGH: closing conditionally mounted dialogs leaves the application locked. Reproduced on automation grant Create, Cancel after reload, Renew, and the clip render confirmation. After the dialog disappears, the root remains `aria-hidden="true"`; `document.body.style` is `overflow: hidden; pointer-events: none;`, with no visible dialog. The page looks normal but mouse clicks do nothing and the accessibility tree loses the app controls. A full navigation/reload restores access. Repro: open `/settings/automation-grants?rule=361f4a59-4e24-4634-8b42-34bddd0ade65`, cancel the New automation grant dialog, inspect body styles, try a sidebar link. Suspect `apps/web/app/(app)/settings/automation-grants/grants-panel.tsx:164` and its conditional mount at line 535, plus the shared confirmation-dialog lifecycle. No source fix yet. Screenshots `07-review-grant-created.png` and `11-render-progress.png` show visible pages whose root remained hidden and pointer-disabled.
5. ENV: local worker reports `youtube_link_intake_unavailable`, token-server startup failed because `127.0.0.1:4416` is already in use. Both ingest rows have `source_provider_access_denied: YouTube blocked this import. Upload the video file instead.` Read-only DB inspection confirmed two failed jobs, one per user intent, attemptCount 1 each. No extra retries were submitted.
6. MEDIUM: creating a new review round keeps the prior round selected. The new round supersedes it, so immediately using Copy link/Open room sends a reviewer to a room that now refuses access. Repro: open existing project Review tab, create `Sol QA review v6`, then Open room without selecting the new Round 03 row. Guest access returns “Review access is invalid or expired.” Selecting Round 03 first yields the working link. `ReviewPanel.createRound` at `apps/web/app/(app)/projects/[projectId]/review-panel.tsx:379` closes the form but never changes `activeRoundId`, which was initialized from the previous round. No fix made.

No commits, environment edits, installs, or source fixes made.
