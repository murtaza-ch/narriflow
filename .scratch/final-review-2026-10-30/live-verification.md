# Live verification, deployed stack (2026-10-30, ~16:00-16:16 PKT)

Web https://narriflow-dev.vercel.app, API https://narriflowapi-dev.up.railway.app. Owner's signed-in Chrome, own tab only (closed at end), test account (Business workspace, project 53b0d959...). Screenshots: `.scratch/final-review-2026-10-30/live/` (01-33).
Vercel's newest production build (narriflow-6n7sqn5uq) was Building at start and Ready (11m build) partway through; page loads were re-measured after Ready (see 1).

## Summary

| # | Flow | Result |
|---|------|--------|
| 1 | Home / Projects / Project / Studio load | PASS (P2 perf note) |
| 2a | Folder duplicate (case) + rename conflict, inline | PASS |
| 2b | Caption omission note (Projects card + Studio panel) | PASS |
| 2c | Pending Business workspace: hint, Resume/Discard, return | PASS (P3 notes) |
| 3 | Render on Railway, live page update, download via signed R2 | PASS |
| 4 | Review round, guest comment + approve, shows internally | PASS (P2 suspect) |
| 5 | API key, /api/v1/workspace + list, MCP, revoke -> 401 | PASS |

## 1. Page loads

Method: in-page fetch wrapper + error/CSP listeners installed after load, then SPA navigation; PerformanceResourceTiming for the cold load. Initial-load console errors cannot be hooked from outside (listeners attach after load), so cold-load console/CSP coverage is only for the SPA navigations that followed.

- Errors (window error, unhandledrejection, console.error) and securitypolicyviolation events: none on any page/SPA navigation.
- Every data call goes to the API origin: `/api/session/bootstrap`, `/api/home`, `/api/billing/state`, `/api/projects/explorer`, `/api/projects/:id/detail|clips/previews|social-posts|review-rounds|exports/current`, `/studio`, `/preview-peaks`, `/library/folders`. Zero `/api/*` requests to the web origin (the only web-origin fetches are Next page/RSC prefetches).
- Fetch wrapper saw Authorization + X-Workspace-Id on all API calls it captured (studio, preview-peaks, download, social-posts, exports/current). Mutation calls after the first were not always captured by the wrapper (api-client appears to hold its own fetch reference); resource timing confirmed `POST /api/library/folders 201` etc.
- Cold-load timings (full page load, after Clerk token):

| Page | Last API response end | Notes |
|---|---|---|
| /home | 2.3-2.7 s | bootstrap 0.55-0.67 s, then home 0.5 s + billing/state 0.85 s in parallel |
| /projects | 4.0 s (first load) | bootstrap, then explorer 0.6 s |
| /projects/:id | LCP 6.4 s (first load, while Vercel was building); detail 2.1 s, previews 2.0 s, social-posts 1.9 s, billing/state 1.45 s |
| Studio (full load) | 3.3 s | studio 0.63 s, peaks 0.82 s. SPA nav from project page: text usable 2.2 s |

P2 perf: every page is a waterfall (Clerk token -> bootstrap ~0.6 s -> data). Project page data calls were 1.9-2.1 s each on first load (second measurement of other pages was faster). Not a blocker.

## 2. Follow-ups

- Folder create "QA Zeta" ok (POST /api/library/folders 201). "qa zeta" create: inline red "A folder with this name already exists.", popover stays open, input kept, no toast (06). Created "QA Eta", renamed to "qa ZETA": same inline message, rename input stays open, no toast (07). Both folders deleted via the confirm dialog, verified gone.
- Caption omission: edited word "tonnes" -> "tonnesU+1C5A U+1F9CB" in Studio. Studio Captions panel shows "1 character can't be shown in exported captions and will be left out. Edit the text to replace them: U+1C5A." (17). Emoji U+1F9CB is not flagged. After render, project card shows "1 character couldn't be shown" button; popover: "These characters aren't in the caption fonts, so they were left out of the video. U+1C5A, Edit captions" linking to Studio (20, 21). Worker log has `diagnosticCodes=["caption_glyph_omitted"]`. Restored the word and re-rendered at the end: note gone.
- Pending Business workspace: none existed. "New Business workspace" -> /workspaces/new -> Stripe test checkout (cs_test...), abandoned via browser back. Returned to /projects: sidebar shows "QA Pending Test, Owner - Payment pending", banner "Finish checkout to start using this workspace" + "Complete setup", Resume checkout / Discard workspace links. Discard -> inline "Confirm discard / Keep workspace" -> workspace gone, back in "Murtaza Asghar's workspace, Owner - Business" (08-15). No real payment made.
  - P3: after browser Back from Stripe, /workspaces/new is restored from bfcache with "Continue to secure checkout" stuck disabled (11). A reload fixes it. File: the workspace-create client component under `apps/web/app/(app)/workspaces/new`; reset the pending state on `pageshow` persisted.
  - P3: during discard both buttons go disabled for ~3 s with no spinner before the workspace switches.
  - P3: the unpaid workspace shows the "Projects on this plan are kept for 3 days / Keep my projects" upsell above "No projects yet" (12). Stripe `checkout.session.expired` delivery not verifiable from the browser.

## 3. Render pipeline

Clip 01 (c133d640...) 9:16 became "not rendered" after the caption edit. Render -> confirm dialog -> Queue render at 16:08:26. Worker (Railway) logs: `render_group_claimed` 11:08:31Z (5 s), `clip_render_variant_completed` aspectRatio 9:16 sizeBytes 9257452 encodeMs 7472 uploadMs 2175, `render_group_settled` 11:08:45Z elapsedMs 13077, `clip_rendering_run_completed` renderedVariantCount=1 failed=0. The card flipped rendering -> rendered at 16:08:58 with no page reload (same tab, URL unchanged; ~32 s end to end). Download button: `GET /api/projects/:id/clips/:clipId/download` 200 (Authorization + X-Workspace-Id), browser then fetched the signed R2 URL; saved file `~/Downloads/clip-1-debate-9x16.mp4`, 9257452 bytes (== rendered size), ffprobe h264 1080x1920 + aac, 31.955 s. Signed R2 request is a navigation/media load, so no Authorization header.

## 4. Review link

Review tab -> Start a review round (clip 01, "needs approval") -> round "Round 01 open". Guest link opened in a fresh agent-browser session (`final-guest`, no shared cookies): name/email gate -> room -> comment at 00:00:00 posted -> Approve clip -> Approve round -> "Round approved. The team has your sign-off." Internal Review tab: Round 01 "approved", 1/1 approved, decision approved, thread "QA Guest / Client: Live verification..." (29). Guest session closed.
- Operator slip, not a defect: I clicked a stale ref and sent "Request changes on round" once before approving; the final approve worked afterwards.
- P2 (suspect): immediately after creating the round, both the Review tab ("There is newer finished work.") and the clip Share popover ("Newer edits are ready. Start a new round...") show the round as stale, though the round was created after the render and nothing was edited in between. `newerWorkAvailable` in `packages/services/src/review.service.ts:1009` is true when `clip.editorRevision > item.editorRevision` or the latest ready export's fingerprint differs from the pinned one. Likely cause: the Download I clicked just before the round created another ready export (different fingerprint) or the pinned revision lags. Needs a DB look (db-gate) to confirm which branch fires.

## 5. API key + REST + MCP

Settings -> Developer access -> Create key "qa-live-verification" (scope: Import and clip); one-time "Copy your key" dialog shown; key held only in a shell file, never printed (deleted after). `GET /api/v1/workspace` 200 (0.99 s, business, 1696/1800 credits); `GET /api/v1/projects` 200 and `?limit=2` 200; no auth 401. MCP `POST /mcp` initialize 200 (serverInfo narriflow 0.4.0) and tools/list 200. After Revoke key (confirm dialog): /api/v1/workspace 401, /api/v1/projects 401, /mcp 401.

## Other notes

- Test-data changes: clip 01 caption temporarily edited then restored and re-rendered (9:16 rendered 16:15:10); review Round 01 (approved) left on the project; folders and key removed; "QA Pending Test" workspace discarded.
- Tab handling: mid-run agent-browser's active tab changed and the CDP tab list shifted (my tab ids t38 -> t39/t40 appeared; one `open` printed a dev.moshpit.studio URL, meaning the active tab was briefly another tab). I closed t39/t40 (both narriflow tabs I had loaded) and finished in a new tab t41 (closed). I cannot rule out that one `open` navigated an owner's tab; check for an unexpected narriflow URL in a moshpit tab.
