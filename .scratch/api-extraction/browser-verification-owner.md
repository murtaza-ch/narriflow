# Owner-session browser verification (ticket 32, owner pass)

Date 2026-10-29, branch `dev`. Owner's signed-in Chrome (Clerk dev session, workspace `eac6cb57-...`, Business, 1,725 credits) driven over CDP via `agent-browser --cdp ws://127.0.0.1:9222/devtools/browser`, in my OWN tab (t54, closed at the end; other tabs never touched). Web `next dev` :3000 -> API :4000. Local->Neon RTT ~245 ms inflates every wait. Screenshots: `.scratch/api-extraction/browser-owner/*.png`. No tokens/cookies recorded.

Caveat on method: `agent-browser network requests`/`console` are browser-wide (they show LinkedIn, TikTok, etc. from the owner's other tabs). Network claims below use my project ids, `performance` entries of my tab, and an in-page error/CSP hook (`console.error`, `error`, `unhandledrejection`, `securitypolicyviolation`).

## Results

| # | Flow | Result | Notes |
|---|---|---|---|
| 1a | Link import `youtube.com/watch?v=2reQut8WNGc` (auto language, commit) | FAIL (env) | metadata `GET /api/ingest/link/metadata` 200 (title/thumbnail ok); `POST /api/ingest/link` 202; IngestJob failed `source_provider_access_denied: YouTube blocked this import`; typed UI ("Import failed ... Upload the video file instead", Retry import, Upload video instead) correct. One retry (`POST /api/ingest/:id/retry` 200) failed the same. Worker not identifiable (IngestJob has no owner column; local worker logged nothing). Local worker cannot run YouTube intake at all: `youtube_link_intake_unavailable ... EADDRINUSE 127.0.0.1:4416`, held by a stale `deno` pid 34759 (not killed). |
| 1b | Pipeline via file upload (`/tmp/qa/qa-speech.mp4`, 28 s) | PASS after retry | see timings; UI went ingest -> transcribe -> detect -> render -> clips with NO reload; 1 clip, virality 68. First auto STT run FAILED (D1). |
| 2 | Clips: play | PASS | R2 GET 206, no Authorization/cookie |
| 2 | Download | PASS | `GET .../clips/:id/download?aspectRatio=9:16` 200 (API, Bearer+X-Workspace-Id) -> R2 signed GET, no auth headers, `Content-Disposition: attachment` |
| 2 | Rename | PASS | `PATCH .../clips/:id` 200; new name visible ~7 s later (waits on detail refetch, no optimistic update) |
| 2 | Duplicate | PASS (slow) | `POST .../duplicate` 201 after 10.5 s (D5) |
| 2 | Trim/extend | PASS | `PATCH clips/:id` 200 then `POST /clips/render` 202; re-render completed; Studio shows 0:18 (end 27.00 requested, snapped) |
| 2 | Render (stale clip) | PASS | confirm dialog, `POST /clips/render` 202, Running 10% -> Completed "Took 9s" live via stream |
| 2 | Campaign "apply to several clips" (10-clip project "Did the AI bubble just pop?") | PARTIAL | Apply Brand Profile / Apply style preset disabled ("Choose a Project Brand Profile", "No member styles": project has none; nothing created). "Apply motion" (Fade) to 10 clips: preview 200 then `POST .../campaign-operations/apply-motion` 200 after **81.5 s** (D4). Changed owner's project "Did the AI bubble just pop?" (motion on 10 clips). |
| 3 | Studio open/edit/autosave/reload | PASS | word edit "Second," -> "Firstly,", preset Spotlight, layout "Source bottom 1 speaker": each a `PUT .../clips/:id/editor` 200, header "Saving..." -> "Saved"; reload shows all three persisted |
| 3 | Export -> delivery page -> live update | PASS | `POST .../exports` 202, redirect to `/exports/:id` (~9 s), 5% -> Ready in ~30 s without reload, 872 KB 9:16 |
| 3 | Export download / subtitle / timeline downloads | PASS | video link direct R2; `GET .../exports/:id/subtitle` (SRT, VTT) 200; `timeline/xmeml`, `fcpxml`, `edl` 200 application/zip with Bearer; `timeline-source` 200 then R2 (no auth) |
| 3 | Exports page lists export | PASS | 1:1 export done before page loaded, so live updates on /exports itself NOT exercised |
| 4 | Transcript tab + .txt/.srt/.vtt | PASS | `GET .../transcript/export?format=` 200, correct content types (filename uses project UUID, cosmetic) |
| 4 | Repurpose "Generate assets" | PASS | `POST .../content-suite` 200, summary/blog text rendered ~40 s |
| 4 | Publishing composer to proposal | NOT RUN beyond composer | drawer opens (`GET exports/current` 200); "No accounts yet" so no target/proposal possible; nothing published. Description assistance panel opens; "Regenerate all" did no request without accounts |
| 4 | Other tabs (Review, Dubbing, Posts, Analytics, Activity) and pages /home /projects /search /exports /calendar /performance /autopilot /recipes /brand-kit /integrations /whats-new | PASS (load only) | one GET each, 200; zero errors, zero CSP violations |
| 5 | Network rules | PASS | all first-party data -> `http://localhost:4000` with `Authorization: Bearer` + `X-Workspace-Id` (exempt by design: `/api/session/bootstrap?workspaceId=`); zero requests to `localhost:3000/api/*`; fetch uses `credentials:"omit"`, unauthenticated `GET /api/home` -> 401, no ACAC header; R2 GET/PUT carry no auth. Only non-API POSTs to :3000 are Clerk's `POST /home` server actions. Console/CSP hook: `[]` on every page walked incl. Studio. |
| delete | Delete projects (both test projects) | PASS | `DELETE /api/projects/:id` 200 |

## Pipeline timings (upload project 8f5dbd3d; times from WorkflowEvent)

- Upload: click -> `upload-sessions/open` 200 -> R2 PUT 200 (starts +8.8 s, no auth header) -> `finalize` 200 at +10 s -> project page at +19 s (dev compile included).
- Ingest 09:26:17 -> ready 09:26:23 (6 s). Auto-handoff STT queued 09:26:47 (+24 s gap).
- Auto STT attempts 1, 2, 3: each fails ~1.5 s after reaching progress 30 (09:26:53, 09:27:25, 09:28:28; backoff 31 s then 61 s) -> `workflow_retries_exhausted`. Same as the earlier QA user's first run.
- Manual "Retry transcription" (09:30:14, `POST /generate` 202): STT queued 09:30:22 (+8 s), completed 09:30:31 (9 s); detection 09:30:32 -> 09:30:57 (25 s); render 09:30:54 -> 09:31:14 (20 s). Click to clips ready: 60 s.
- Stream: opened once per page, then reconnects about every 46-61 s (D2): 3 `GET /api/stream/:id` in 2 minutes, each with a CORS preflight.

## Speed (first load after Next compile; `performance` entries, ms from navigation start)

| Page | FCP | API requests (serial waves) | Time to data |
|---|---|---|---|
| /home | 412 | `session/bootstrap` 0.9-2.7 s -> `home` + `billing/state` parallel 2.9-5.0 s | ~5.0 s, 3 requests |
| /projects | 1396 | bootstrap 2.0-4.1 -> `projects/explorer` + `billing/state` 4.3-5.9 -> late `GET /api/projects?` at 12.0 s (1.8 s) | ~5.9 s, 4 requests |
| Project detail (10 clips) | 560 | bootstrap 1.1-3.1 -> `detail?tab=clips` 3.3-7.5 (4.2 s) -> `social-posts` + `clips/previews` 8.1-10.4 | clips at ~7.5 s, complete ~10.4 s, 5 requests (D3) |
| Studio | 976 | bootstrap 1.6-3.7 -> `/studio` 3.8-6.4 -> `preview-peaks` 6.6-9.0 | usable ~6.4 s, peaks 9.0 s, 4 requests |
| /exports | 876 | bootstrap 1.4-3.6 -> exports + export-projects + billing parallel 3.8-6.0 | ~6.0 s, 4 requests |

Bootstrap alone is ~2 s (about 8 RTT) and gates everything on every cold page load.

## Defects and observations (no source changed)

D1 MEDIUM, first auto-transcription fails three times then succeeds on a manual retry, reproduced on a second user. Repro: upload a file with AI clipping, wait for ingest ready. Events 5-7 show STT running to progress 30 then `stt queued` again, three times, then `stt failed workflow_retries_exhausted` (project 8f5dbd3d, 09:26:51-09:28:28). `POST /generate` retry with the same project succeeded in 9 s. Cause not visible in `/tmp/worker-dev.log` (no STT lines), so the Railway worker (older code) may be claiming these runs; check `WorkflowRun.leaseOwner` on a fresh run and Railway logs. Suspect handoff-created run vs `/generate`-created run difference: `packages/services/src/workflow-run-lifecycle.ts` / `apps/worker/src/tasks/` stt.

D2 LOW/INFO, progress stream is not "exactly one request" for long sessions. The API closes it when the 60 s Clerk Bearer expires (per-beat re-authorization, `apps/api/src/domains/progress/routes.ts:70-90`) and the client reconnects with `sinceSeq`, forever, even for a finished project (seq 33 reconnects at ~46 s intervals; each reconnect also does an OPTIONS). Fine functionally; costs a preflight + admission every minute per open tab. Consider closing the stream when the Project has no active run, or fetching a fresh token before expiry.

D3 LOW, request waterfalls: (a) every cold page waits ~2 s on `session/bootstrap` before any data request; (b) project detail fires `social-posts` and `clips/previews` only after `detail?tab=clips` finishes (+~1 s to +3 s); (c) Studio `preview-peaks` after `/studio`; (d) Repurpose tab: `detail?tab=repurpose` then `content-suite`; (e) `/projects` fires a second list `GET /api/projects?` ~6 s after the explorer. Idle project page polls `social-posts?active=1&tracked=` every ~33 s with nothing tracked (3 s each). Trim save causes two back-to-back `previews`+`detail` refetches; many actions refetch `workspace/bootstrap`.

D4 MEDIUM, bulk actions are very slow: `apply-motion` 10 clips 81.5 s; `apply-style` 20.6 s and `preview-editor-action` 18.5 s were seen in the log for the same kind of call; `clips/render` ~10 s; `duplicate` 10.5 s; `content-suite` 14-16 s. Likely per-clip sequential DB round trips at 245 ms. Not extraction-specific but the HTTP request is held open the whole time (UI shows a spinner only). Suspect `packages/services` campaign-operations apply loop.

D5 LOW, no optimistic feedback: rename visible after ~7 s, duplicate card after ~25 s.

D6 UNCERTAIN, UI lag of ~15-20 s on the first run: with STT queued/running at 09:26:47-53 (Redis publish within ~1 s per `redisPublishedAt`), the project page still showed "AI Transcription / Start transcription" until ~09:27:10, when it switched to "Transcription queued". Detail refetches ran at 09:26:39 and 09:27:05 only. Suggests a stream event (or its invalidation) was missed or throttled to the 15 s fallback poll for this run. Did not reproduce on later runs (render/export updated within a few seconds). Check `packages/api-client/src/progress/*` invalidation and `PROGRESS_FALLBACK_POLL_MS`.

D7 ENV, local worker YouTube helper cannot start: `EADDRINUSE 127.0.0.1:4416` held by stale `deno` (pid 34759). Local worker therefore cannot import links; Railway IPs are blocked. YouTube link import cannot be verified in this setup.

D8 INFO/LOW, Resend: `notification_delivery_failed ... narriflow.app domain is not verified` (403) for import_failed/clips_ready emails (3 attempts each). Dev env only.

D9 INFO, `GET /*` 404 requests on the API (217 in the log, not from my tab), and the Clerk `POST /home` server actions on every page load are expected.

D10 COSMETIC, transcript download filename is `<projectId>-...` rather than the title.

## Not covered
Brand-profile apply (no profile on the project; none created), social accounts / publish proposal (none connected), live updates on /exports itself, Dubbing, Review round, Share links, two-tab Studio, close-tab keepalive, link import success.

## Data created and removed
Project `074b38c9-...` (failed YouTube import) and `8f5dbd3d-...` (owner-e2e speech, 2 clips, 2 exports, content pack) were deleted through the UI (`DELETE` 200). The 10-clip project "Did the AI bubble just pop?" now has a Fade transition applied to its 10 clips (revisions bumped). Credits: 1,725 -> 1,724 left.
