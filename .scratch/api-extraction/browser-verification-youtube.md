# YouTube end-to-end browser verification (owner session) - BLOCKED at step 1

Date 2026-10-29 ~10:19-10:24 UTC, branch `dev`. Own tab t35 (closed at the end). No source edited. Screenshots: `/Users/murtaza/Documents/dev/narriflow/.scratch/api-extraction/browser-youtube/` (01-upload-metadata, 02-configure, 03-configure-step2, 04-after-commit).

## Result: STOPPED. The local worker is up but has stopped polling, so nothing can be processed.

Project id: `53b0d959-968b-49da-aa75-2bb62a17fe23` ("Macbook PROLED XDR Impressions: They Said They Wouldn't!", 10:54). Left in place (IngestJob `d8de1a0b-d9a3-4a5e-be58-7840d4e5a241`, link_import, status `queued`, attemptCount 0, claimId null). 180 credits were reserved at commit (1,724 -> 1,544).

| Step | Result |
|---|---|
| 1 /upload paste link, metadata | PASS: `GET /api/ingest/link/metadata` 200 in 1.1 s (title, thumbnail, 00:10:54 duration) |
| 1 Configure (auto language, Get AI clips on), commit | PASS (HTTP): `POST /api/ingest/link` 202 in 6.4 s (10:20:38), step-2 settings page loaded, `POST /api/projects/:id/generation/finalize` 200 in 3.0 s (10:20:58) |
| 1 download / transcribe / detect / render / stream | NOT RUN: the ingest job is never claimed. UI sits on "Queued" / "Waiting for import..." |
| 2, 3, 4, 6 | NOT RUN |
| 5 Network rules | partial: upload page requests all went to `localhost:4000`; none to `localhost:3000/api/*`. One CSP defect (below) |

## Blocker (worker)

`GET localhost:4001/health` (worker pid 34182, started 1h26m ago): `youtubeLinkIntake.available: true`, but every poll loop's `lastPollAt` stopped at 10:02:32 or 10:12:11 UTC (ingest/stt/detection/dubbing/export_bundle/notification_retry at 10:12:11; maintenance/render/preview/workflow_lease/etc. at 10:02:32) and has not advanced in 11+ min. `polling:false` everywhere, `processedCount: 0`. The process is alive (HTTP answers, state SN, 0% CPU), so the `setInterval` ticks at `apps/worker/src/index.ts:766` are not firing. `/tmp/worker-dev.log` last real entries: 10:12:27-10:12:59 `worker_poll_failed ... Connection terminated unexpectedly` for ~15 loops (consecutiveFailures 1-2) plus `social_publication_receipt_enrichment_crashed` and `generation_finishing_failed`; nothing after, no `worker_poll_failures_exceeded`. The queued job has no log line. grep of the project id in worker log: none.

Likely trigger: a Neon connection drop at ~10:12 (laptop network or sleep/wake) that left the Bun timers dead. Per instructions I did not restart the worker or call `/poll-once` (that would have masked the defect). Restarting the worker, or `POST localhost:4001/poll-once`, should unblock the queued job; then re-run this pass. Worth a separate fix: a watchdog that exits the process when no loop has ticked for N minutes.

## Defect found: CSP violations on the /upload configure step
Repro: /upload, paste YouTube link, Continue, Import & continue. In-page `securitypolicyviolation` listener recorded `script-src-elem https://www.youtube.com/iframe_api`, `script-src-elem https://www.youtube.com/s/player/.../www-widgetapi.js`, and 9x `frame-src https://www.youtube-nocookie.com`. The embedded YouTube preview player is blocked by the web CSP (fix `87406e57` touched the CSP; check `apps/web` CSP script-src/frame-src for the YouTube player). No `console.error` or page errors.

---

# Part 2 (resumed 10:25-11:12 UTC, own tab t41, closed at end; no source edited)

Screenshots 05-21 in `.scratch/api-extraction/browser-youtube/`. Project `53b0d959` left in place (10 clips; I deleted clip `1722ae5b`, the original of my duplicate, so the remaining "Glowing Logo QA" clip is the duplicate row). Downloads I made were deleted.

## Per-stage wall clock (worker log, project id)
| Stage | Start -> end | Notes |
|---|---|---|
| Ingest (link_import) | 10:24:40 -> 10:26:34 = 114 s | probe 8.6 s, yt-dlp download 35.3 s, R2 upload 66.6 s |
| Transcription (AssemblyAI) | 10:26:49 -> 10:27:19 = 30 s | provider 26.7 s, 147 utterances |
| Detection | 10:27:21 -> 10:32:24 = 5 m 03 s | first attempt died ~10:27:24 (workflow_attempt/lease lost, `reaper_failed Connection terminated unexpectedly` 10:28:31); re-run 10:31:07, candidates 10:32:09, done 10:32:24 (clean pass 77 s) |
| Render | ~10:32:35 -> 10:41:05 first pass | 3 of 10 rendered (~10-22 s encode each), 7 failed `EBADF: bad file descriptor, posix_spawn '/opt/homebrew/bin/ffprobe'` (also `deno` at helper start) 10:33-10:41; run settled `partial` |
UI followed live with no reload: Import -> Transcribe -> Find best moments (20 -> 80%) -> Render (10..28%, progress bar reset on each attempt) -> clips grid. Stream: 24 sequential `GET :4000/api/stream/:id?sinceSeq=N` calls (~46 s each, Bearer + X-Workspace-Id), not one persistent connection. Worker log also shows `workflow_event_publish_failed REDIS_UNAVAILABLE` (UI still updated).

## Findings (worker side, not UI)
1. TWO worker processes run: pid 34182 (started 08:57 UTC, holds :4001, the "wedged" one; it is polling again) and pid 66074 (started 10:24:35, the restart), both `apps/worker` `bun --watch`. They share the queue; this plausibly explains the duplicate `clip_detection_run_started`, attempt-lost, and renders that complete with no log lines in /tmp/worker-dev.log. Also `bun --watch` reloads on every source edit (parallel fix work), which kills in-flight spawns: likely source of the EBADF `posix_spawn` failures. Not stopped, per instructions.
2. 7 of 10 first-pass renders failed; UI shows "Some outputs failed ... Retry only the failed outputs from their rows", per-row "Retry render" works (POST /clips/render 202 with Bearer + X-Workspace-Id), needed 3 rounds; all 10 eventually Ready.

## Clip checks (all requests :4000 with Bearer + X-Workspace-Id, none to :3000/api/*)
- Play: signed R2 `X-Amz-*` URL, plays, readyState 4. PASS.
- Download: `GET /clips/:id/download` 200 (3.0 s) -> R2 URL, file `clip-1-debate-9x16.mp4` 1080x1920 h264+aac 24.7 s, no Authorization header. PASS.
- Rename (dialog) `PATCH` 200 3.3 s, title updated. Duplicate `POST .../duplicate` 201 in 10.8 s; clip count 10 -> 11 only ~15 s later (slow list refresh). Delete 200, count back to 10. PASS.
- Trim/extend: end 00:30.98 -> 00:36.84 (snaps to word), PATCH 200 then `POST /clips/render` 202; clip now 0:32. PASS.
- Bulk: Select all -> "Publish selected" opens the publishing drawer with 10 clips Ready; no social account connected so "Publish now" stays disabled and I stopped before any proposal. Description assistance "Regenerate all" sent no request (nothing to generate for with no account). PARTIAL.

## Studio
Load 8.0 s to last API response (studio 2.8 s, preview-peaks 1.8 s, bootstrap 1.8 s); 4 API calls. Caption word edit ("tons" -> "tonnes"), caption preset (Cinema), scene layout (Speaker top): each one `PUT /clips/:id/editor` 200 (2.5-10.7 s each). Reload: all three persisted, "Saved". Export 9:16 1080p: `POST .../exports` 202 -> navigated to delivery page `/clips/:id/exports/:exportId`, live Rendering 0 -> 5% -> Ready in ~35 s, Download video = signed R2 link, `/exports` page lists it. SRT 200 (contains "we've done tonnes"), VTT 200, Premiere XML zip 200, EDL zip 200. PASS.

## Transcript / repurpose
Transcript tab + Download: txt 14.7 KB, srt 18.7 KB, vtt 18.2 KB (`/transcript/export?format=`, 200, Bearer + workspace). Repurpose "Generate assets": `POST /content-suite` 200, blog post and 4 more formats generated in ~25 s. PASS.

## Network, console, CSP
Per page (home, projects, project, studio, upload, exports, delivery): zero requests to :3000/api/*, zero console errors/page errors, zero `securitypolicyviolation`. Only nit: 4 of 11 `GET /api/session/bootstrap` calls carry Bearer but no X-Workspace-Id header (workspaceId is in the query string; probably by design).
CSP fix verified: /upload, fresh paste of the link, Configure step: `iframe_api`, `www-widgetapi.js` and the `youtube-nocookie.com/embed` iframe all load; 0 violations. Cancelled (no second import; credits still 1,713).

## Time-to-usable (hard load, last :4000 response end, excluding stream) / request counts
| Page | last API response | :4000 calls | slowest |
|---|---|---|---|
| /home | 4.3 s | 3 | bootstrap 1.8 s, /api/home 1.5 s, billing/state 1.5 s |
| /projects | 4.7 s | 3 | bootstrap 2.2 s, projects/explorer 1.5 s |
| project detail | 9.8 s | 5 | detail 3.5 s, billing/state 2.7 s, social-posts 2.5 s |
| Studio | 8.0 s | 4 | studio 2.8 s, preview-peaks 1.8 s |
(Dev server, shared remote Neon; first project-detail load after navigation earlier measured bootstrap 12.3 s and detail 11.8 s.)
