# AI automation and integrations market scan (competitors, sources, destinations, agents)

Researched 2026-10-24. Evidence only, no architecture advice. Every fact carries a date or is marked "fetched 2026-10-24" (the page showed no date). "unverified" means no primary source confirmed it. Sources are numbered at the end.

Reading notes
- "Primary" = vendor docs, help centers, pricing pages, official blogs, platform developer docs.
- Several vendor pricing pages disagree with their own docs (plan names, API limits). Conflicts are flagged, not resolved.

---

## 1. Competitor automation

### 1.1 Summary table

Legend: T = trigger, C = clip, Cap = caption, S = schedule, P = post. "Native" = built into the vendor's dashboard.

| Product | End-to-end automation (what is actually hands-off) | API / webhook | MCP / agent | Zapier / Make / n8n | API access and price (as stated) |
|---|---|---|---|---|---|
| OpusClip | T: native Auto Import of your own public YouTube channel or chosen playlists (hourly check, videos over 3 min, no RSS) then C+Cap with saved settings. S+P: native scheduler, bulk scheduler (fixed interval, no AI timing), Scheduler API. Zapier can trigger on project completion. | REST API (Bearer key, 30 req/min/key), webhooks (HMAC-SHA256, only a project-creation event documented), brand-template endpoint, social-posting endpoints (publish, schedule, cancel) | Hosted MCP server `mcp.opus.pro/mcp` (27 workflow tools, OAuth), Claude directory connector (publishing needs human approval link), Skill package for Claude Code/Codex/OpenClaw | Zapier app (launched 2025-10-02): 1 trigger, 3 write actions, 4 search actions; Make app is community-built (Codex Solutions), not vendor; no n8n evidence | Pro (Beta), Max, Business. 15 h or 900 credits/month per workspace on Pro Beta/Max, Business by contract. 1 credit = 1 min, 10-credit minimum per API project. No separate API price. |
| Vizard | C+Cap via API; publish endpoint with auto caption; manual calendar scheduling. No documented channel auto-import. | REST API (key header), webhook URL set per workspace or poll every 30 s; `clip_v2` model (2026-07-21, billed 1.25x) | Vizard Agent (announced 2026-08-10) is a brief-to-video editor, not a clip-pipeline automation. No MCP found. A Claude Code/Cursor skill and an n8n template are linked from the API page. | n8n template listed on vizard.ai/api; no Zapier app found | Paid users only. Rate limits by plan: 1/min and 10/h (Free), 3/min and 20/h (Creator), 10/min and 60/h (Business). Price not stated. |
| Klap | T: Zapier/n8n new-upload trigger; C; Cap; S+P through the "Post the best clips" automation (virality-score filter, AI captions, schedule) | REST API v2 (`/v2/video-to-shorts`), OAuth for Zapier/Make/n8n acting on a user's behalf, Managed Users and Embeds (sub-users, embeddable editor) | Hosted MCP, 18 tools (clip, edit, export, publish), OAuth | Zapier: available (triggers New Clip, New Project Ready, Project Failed; actions Create Clips, Export Clip, Schedule Clip, Write Caption). n8n: official node plus trigger (npm `n8n-nodes-klap`, created 2026-10-08). Make: "in review" (13 modules). | Usage-based API: $0.32 Generate Short, $0.44 Video Input, $0.48 Export, per operation, billed monthly. Plans $14/$39/$94 per month billed yearly for 100/300/1000 clips. |
| Submagic | Caption-first. Drive folder watcher auto-edits dropped videos. Auto-publish on Pro and Business. | REST API (`POST /v1/projects`, `x-api-key`, webhooks), rate limits 500/h create, 50/h export | MCP server at `api.submagic.co/mcp` (API-key bearer; docs page `docs.submagic.co/mcp-server`); also lists Claude/Cursor use | Zapier, Make, n8n, Google Drive, Gumloop (integrations page) | Business tier includes API minutes. Credit packs $57 for 250 min ($0.23/min) down to $1,000 for 10,000 min ($0.10/min). Plans $19/$39/$69 monthly. |
| Descript | T: new recording or file (via Zapier, folder, API) then Underlord edits (filler words, Studio Sound, captions, clips, rough cut). No native social posting found. Output is reviewed in Descript. | API (open beta), CLI, tokens scoped to one Drive. Webhooks not documented. Cannot download rendered media without publishing a web link. | Remote MCP "connector" in Claude directory, ChatGPT app directory, Cursor marketplace | Zapier app (beta): Import Media, Edit with AI (Underlord). n8n mentioned in help center. | "Included at no extra cost for paying users." Draws on media minutes and AI credits, 402 when exhausted. |
| Riverside | Magic Clips generated automatically per recording (one set free, extra sets by plan; scores only for clips generated after Oct 2025). Publishing mostly manual. | Business API for "select Business accounts" only, via customer success. Webhooks exist but all 6 events are webinar/registrant events, none for recordings or clips (docs, 2026-10-24) | MCP at `mcp.riverside.com/mcp`, beta, paid plans only (third-party listing, unverified); in-app Co-Creator assistant | Make app is community-maintained; no Zapier evidence | Not public |
| Captions / Mirage | Consumer app plus a narrow API (captions, avatar video). Not a clip-pipeline tool. | API: Add Captions $0.15/min, Mirage Avatar X $0.15/s | none found | none found | Usage-based |
| VEED | MCP wraps Fabric 1.0 avatar-video generation. No clip-pipeline automation evidence. | Fabric on fal.ai queue | MCP server (Make supported; Claude/ChatGPT per page) | Make listed | Credits (AI Playground) |
| CapCut | No official public editing API found (vendor blog dated 2026-10-15, secondary). capcut.com/business reportedly redirects to pippit.ai. | none | none | none | n/a |
| Reap | T: URL/upload; C; Cap; dub; S+P via publisher and content calendar; webhooks on complete/fail/expire | REST + OpenAPI, webhooks, publish/schedule/bulk-schedule endpoints, dubbing endpoint, Agent Skills page | Reap MCP (OAuth) with guides for ChatGPT/Codex, Claude Code, Cursor, VS Code, OpenClaw | not documented | API, CLI, MCP on every paid plan. Creator $9.99/mo, Studio $29/mo (billed annually). |
| Munch (munchstudio.com) | Strategy + repurposing + planner + publishing to IG/FB/LinkedIn/YT/TikTok, performance dashboard on every plan | none listed | none listed | none listed | Essential $38/mo, Premium $60/mo |
| Choppity | C+Cap; scheduler from Starter | API on Creator ($32/mo monthly) and Team | none found | none found | Creator $32 monthly / $22.40 yearly |
| Spikes Studio | C+Cap; direct posting and scheduler to LinkedIn, TikTok, Facebook, YouTube; virality score; clip analytics | "Apply for API" on signup page | none found | none found | PRO+ $32.99/mo or $14.09/mo annual |
| 2short.ai | YouTube link or Drive import (Lite+). No automation features on the page. | none | none | none | Plans $9.90/$19.90/$49.90 |
| Swiftia | C; brand presets; social posting endpoint in API | API: Brand Presets, Jobs, Rendering, Social Posting; webhooks not documented | none found | none found | Pricing not retrievable (unverified) |
| quso.ai (ex vidyo.ai) | C+Cap; scheduling to 7 platforms from Essential ($39); Viddy AI content assistant and analytics on Growth ($49) | No API on pricing page (third-party says future/enterprise, unverified) | Viddy assistant (in-app) | none found | n/a |
| Vugola (new) | Clip; auto-post to TikTok, YouTube, X, LinkedIn, Bluesky (IG/FB/Threads temporarily off); automations | REST API on every paid plan | Hosted MCP + npm MCP on every paid plan | none found | $19.99/$49.99/$99.99 per month on the pricing page; a search snippet quoted $10/$21/$69 (conflict) |
| Restream AI Clips | Add-on to Restream plans; "auto-pilot" setting generates clips for recordings; 7-day trial | none found | none found | none found | Add-on, dollar amounts not on the FAQ page |

Row references (Sources list at the end): OpusClip [C1-C18, C59]; Vizard [C19-C26]; Klap [C27-C31]; Submagic [C32-C34]; Descript [C35-C39]; Riverside [C54-C55] and the Riverside support links; Captions/Mirage [C40]; VEED [C41]; CapCut [C42]; Reap [C43-C44]; Munch [C45]; Choppity [C46]; Spikes [C47]; 2short [C48]; Swiftia [C49]; quso.ai [C50]; Vugola [C51-C52]; Restream [C53].

Conflicts and caveats in this table
- OpusClip plan names differ between the pricing page (Free/Starter/Pro/Business) and the API docs (Pro Beta/Max/Business). The pricing page also lists "MCP connector" and "Scheduler API" as Pro features, consistent with the docs gating at Pro Beta.
- One search-result view of the OpusClip Claude-connector docs said "coming soon to the directory"; the fetched copy of the same page (2026-10-24) says it is listed at claude.ai/directory/opusclip. Directory page itself returned 403, so listing is unverified from the directory side.
- Vizard: the API page header shows a Claude Code/Cursor skill and an n8n template; no separate skill documentation page was found. Vizard Agent site (agent.vizard.ai) returned 403.
- Vugola pricing differs between the fetched pricing page ($19.99/$49.99/$99.99) and a search snippet ($10/$21/$69).
- Choppity FAQ (3-seat Team minimum) contradicts its pricing table (unlimited seats).
- Submagic pricing page is internally inconsistent on API minutes (10 vs 100 per month on Starter/Pro).
- Vizard's quickstart says API access is for paid users only, while its pricing page lists API rate limits for the Free plan (1/min, 10/h); not reconciled.
- Descript API is called "beta" by help-center search snippets and third-party reviews; the fetched API help page does not label it.

### 1.2 OpusClip detail (the reference competitor)

Plans and gating (pricing page, fetched 2026-10-24)
- Free $0 (exports expire in 3 days), Starter $15/mo, Pro $29/mo, Business custom.
- Pro adds: Video Editing API, Scheduler API, MCP connector, Zapier (up to 300 credits/month), social posting to Facebook, LinkedIn, X, Pinterest, Threads, Bluesky, scheduler, team workspace (2 users per pack, up to 4), up to 4 brand templates.
- Starter posts to YouTube Shorts, TikTok, Instagram only; no scheduler, no API.
- Business adds CMS integration, unlimited seats, unlimited storage.
- The API docs name the API tiers "Pro (Beta), Max, Business", so the pricing page and docs use different plan names (2026-10-24). Pro Beta and Max accounts get API access automatically; other orgs contact sales.

REST API (help.opus.pro, fetched 2026-10-24)
- 30 requests/minute per API key. Concurrency: 4 parallel projects (Pro Beta, Max), 50 (Business).
- Credits: 1 credit = 1 minute of video; API projects have a 10-credit minimum. Pro Beta/Max: 15 hours or 900 credits per calendar month per workspace. At the cap the API returns 403 `API_MONTHLY_CAP_REACHED`.
- Max video 10 hours / 30 GB. Projects expire after 30 days unless auto-save is on. 20+ languages.
- Endpoints documented: create project (`POST /api/clip-projects`), query clips, brand templates, share project, social posting (list accounts, create social-copy job, publish, schedule, cancel), webhook, edit clips (trim, extend, caption typo fixes).
- Webhook: headers `X-Opus-Signature` (HMAC-SHA256 of body + salt using the account secret key), `X-Opus-Salt`, `X-Opus-Timestamp`. Only a project-creation event is shown; retry behaviour and payload schema are not documented. The timestamp is not part of the signed input.
- Social posting API rate limits: 1 req/s for create/schedule/cancel, 10 req/s for reads. 500 posts per rolling 24 h per workspace. Posting to X costs 3 credits per post per account.
- Platform quotas it publishes for scheduled posts: X 150/day, TikTok 4/min and 15/day, Instagram 40/day, YouTube soft 15 per 24 h.
- SDKs advertised for Node, Python, Go, PHP, Ruby, Java; public OpenAPI spec and `llms.txt` (api page, fetched 2026-10-24). SOC 2 Type II stated.

MCP and agent surfaces
- Hosted MCP `https://mcp.opus.pro/mcp`, OAuth, no API key. Blog dated 2026-07-28 (last modified 2026-10-07) says 27 workflow tools: 13 read, 14 write (submit, edit, censor, collections, social copy, export, post, schedule). Help page says 29 tools including 2 deprecated signposts and 2 thumbnail-generation tools only on the MCP server.
- Claude directory connector (`claude.ai/directory/opusclip`): same workflow tools, no media generation. The four publishing tools (post, schedule, cancel, share project) never commit on their own; they return an approval link the user opens in OpusClip and confirms while signed in. Links expire after 1 hour (immediate posts), until the scheduled time (scheduled posts), 24 hours (share, cancel). Credits are charged at confirmation. `opusclip_edit_clip` has dry-run and a 72-hour undo window.
- Free accounts can connect and browse tools; running render jobs needs Pro Beta, Max or Business.
- Skill package for Claude Code, Codex, OpenClaw and Claude.ai/Cowork (API-key based; repo `opus-pro/opus-skills`).
- Agent Opus is a separate prompt/script/URL-to-video generation agent (not the clipping pipeline); a job posting calls it 0-to-1 stage (secondary sources, unverified date).
- Export includes an Adobe Premiere XML project file (MCP page, fetched 2026-10-24).

Automation without code
- Auto Import: your own public YouTube channel or selected playlists, Pro and Starter only, hourly check, videos over 3 minutes uploaded after setup, excludes private/unlisted/Shorts/livestreams. Manual mode emails you; automatic mode starts a project with saved clip settings and charges the full video length. Fails on downgrade to Free, low credits, or lost YouTube authorisation. No RSS source documented.
- Zapier: launched 2025-10-02. Trigger "New Project Completed"; actions Clip Your Video, Add Captions, Transcribe; searches for clips, transcripts, captioned video. Pro (300 credits/month cap) and Enterprise.
- Import sources: Apple Podcasts, YouTube, Google Drive, Vimeo, Zoom and Zoom Clips, Rumble, Twitch, Facebook, LinkedIn, X, Dropbox, Riverside, Loom, Frame.io, StreamYard, Kick, Medal.tv, public MP4 URLs, local files up to 10 GB (links must be public or unlisted).

### 1.3 Other notable facts

- Vizard Agent (blog by CEO, 2026-08-10, at agent.vizard.ai): takes a brief and returns a finished video, multi-round revision. Announcement does not mention scheduling or publishing. Product Hunt page: 119 points, day rank #8; a top comment asks for calendar integration to schedule posts after editing. Vizard's pricing page lists "auto-schedule social posts" on Creator and Business, social accounts 1/6/20 (Free/Creator/Business).
- Vizard API: `clipModel` `clip_v1` (default) or `clip_v2`, `clip_v2` billed 1.25x (blog 2026-07-21). Sources accepted: remote file, YouTube, Google Drive, Vimeo, StreamYard. Rate limit for `/project/create`: 3/min and 20/h; higher by emailing support.
- Klap API pricing is per operation, not per minute: Generate Short $0.32, Video Input $0.44, Export $0.48 (docs.klap.app/pricing, fetched 2026-10-24). Operation-to-video mapping not stated.
- Reap bundles API, CLI and MCP into every paid plan, including a $9.99 tier (pricing page, fetched 2026-10-24). Vugola does the same. This shows the "API + MCP on every paid plan" pricing pattern at the low end, versus OpusClip/Submagic/Choppity gating API to higher tiers.
- Descript's Underlord was extended to accept instructions from Claude/ChatGPT and workflows (article 2026-08-25). Descript's own example automations: podcast episode to captioned social clips by next morning, webinar to rough cut, blog post to video teaser, sales call to highlight reel.
- Promotional (author sells Postiz) walkthrough dated 2026-05-19: a Telegram message to the open-source Hermes Agent calls the Vugola MCP to clip and the Postiz MCP to schedule across 28+ networks, claimed 15 to 25 minutes end to end. Revenue claims in that article are anecdotal (weak evidence).

---

## 2. Sources of long recordings: can a new recording trigger an auto-clip?

Fetched 2026-10-24 unless a date is given. `(snip)` = only seen in a search snippet. Codes [S#] are in the Sources list.

| Source | "New recording ready" trigger | How a third party gets the media | Approval / review hurdle | Refs |
|---|---|---|---|---|
| Zoom cloud recordings | Yes: `recording.completed` webhook, payload carries a `download_token` | `download_url` + token as Bearer, token valid 24 h, then fall back to OAuth access token; query-string tokens rejected since 2023-02-14. Needs Pro+ plan for cloud recording. Granular scopes `cloud_recording:read:*` | Public/unlisted Marketplace app review (functionality, branding, then security with OWASP Top 10 and a design doc). Private/beta apps skip it. No official SLA; third parties say 5-7 business days (2026-06-16), a forum poster says 4+ weeks (2026-07-22) | [S1-S7] |
| Riverside | No recording event. The 6 webhook events are all webinar/registrant events; scheduled studio sessions emit nothing (docs, fetched 2026-10-24) | `GET /api/v3/download/file/{id}` redirects (301) to a signed URL; 1 req/s | Business API for "select Business accounts" only, key via customer success; v1/v2 sunset 2026-02-24 | [S8-S10] |
| StreamYard | No recording trigger found (Zapier covers On-Air webinar registrations/attendance) | Dashboard download; help center says no public API (snip, undated) | n/a | [S11-S12] |
| Restream | No webhooks in docs index; WebSocket "Streaming Updates" exists; poll event recordings | OAuth scope `storage.read`; `POST /v2/user/events/{id}/recordings/download-url` returns a temporary link; Storage Files and Clips APIs exist | Register app, Client ID/Secret; no review page found | [S13-S14] |
| Descript | Not a source: Zapier app has actions/searches but no triggers | API is import-first; rendered media only retrievable by publishing (signed URLs) | Per-Drive token | [S15-S17] |
| Google Drive | Yes: `changes.watch` max 7 days, `files.watch` max 1 day, no auto-renew, empty POST body so you call `changes.list` | `files.get alt=media` | `drive.file` is non-sensitive (picker/app-created files only). `drive.readonly`/`drive` are restricted: verification plus annual CASA assessment ("several weeks" per Google; sensitive scopes 3-5 business days). CASA lab prices only from third parties (unverified) | [S18-S21, S79] |
| Dropbox | Yes: webhook (`files.metadata.read`), payload lists changed accounts only, so poll `list_folder/continue` | Files API (`files.content.read`) | Development status up to 500 linked users. At 50 linked users you have 2 weeks to get production approval or linking freezes; no stated SLA | [S22-S23] |
| Frame.io V4 | Yes: workspace webhooks incl. `file.upload.completed`, `file.ready` (stable since May 2025 release, posted 2025-06-03). Only account admins create them | `media_links.original` signed S3 URL, null until transcoded | Adobe Developer Console project (user OAuth or server-to-server). V2 removal 2026-12-01 claimed in staff post (snip, unverified) | [S24-S27] |
| Box | Yes: webhooks v2 (`FILE.UPLOADED`) on a file or folder; needs "Manage Webhooks" scope | `GET /files/{id}/content` 302 to expiring URL | Enterprise admin must approve the app; App Center listing is a separate partner review, no timeframe | [S28-S31] |
| Loom | No. Loom help: "does not offer an open API" | Public share link only (OpusClip imports Loom links) | No developer path | [S32] |
| Microsoft Teams (Graph) | Yes: change notifications for `callRecording` created (doc updated 2026-06-29) | `recordingContentUrl` then GET `/content` | Tenant-wide needs app-only `OnlineMeetingRecording.Read.All`, tenant admin consent | [S33, S35] |
| OneDrive/SharePoint | Yes but only "something changed": use `delta` with a sync token | Graph `driveItem` content | Admin consent for `*.All` scopes (unverified) | [S34] |
| Google Meet | Yes: Workspace Events `google.workspace.meet.recording.v2.fileGenerated`, only for the space owner | Meet `recordings.get` returns a Drive export URI; download needs Drive scopes | Download scopes `drive.readonly`, `drive.meet.readonly` are restricted, so CASA applies | [S36-S38] |
| Vimeo | No transcode-complete webhook per help center (poll `transcode.status`); newer webhook docs unverified | `download` field needs `video_files` scope on a paid plan | Unverified | [S39-S40] |
| Wistia | Yes: `media.ready`, `media.created`, `media.failed` etc., HMAC `X-Wistia-Signature`, at-least-once | Data API `OriginalFile` asset | Account-level; no review | [S41-S42] |
| Mux / Cloudflare Stream / Bunny | Yes: Mux `video.asset.ready`; Cloudflare webhook on `state: ready`; Bunny status 3 | Mux temporary master MP4 (24 h); Cloudflare original not retrievable (encoded MP4 via `/downloads`) | Customer's own account | [S43-S47] |
| Transistor | Yes: `episode_created`, `episode_published` via `POST /v1/webhooks` (max 50) | `media_url` MP3 in episode JSON | API key | [S48] |
| Acast | Yes: `episodePublished` with `audioUrl` (doc 2023-05-17) | `audioUrl` | none documented | [S49] |
| Buzzsprout | API only, no webhook section | API doc does not describe the audio URL field | Token | [S50] |
| Captivate | Native webhooks unverified; IFTTT polling trigger | Unverified | API access by emailing api@captivate.fm | [S51] |
| RSS.com | Webhooks not mentioned | API key | API is Network plan only, public beta since 2026-02-20 | [S52] |
| Libsyn | llms.txt lists "Public REST API" and "Webhooks", no details | Unverified | Unverified | [S53] |
| Megaphone / Simplecast / Podbean | Webhooks unverified (Podbean: none found) | Per-account API token / OAuth app | App registration | [S54-S55, S80] |
| Spotify for Creators | No public API found (unverified) | RSS only | n/a | none |

Standards-based signals
- WebSub: Pocket Casts (2024-04-26) names Buzzsprout, Simplecast, Captivate, RSS.com, Transistor, Podigee and Audioboom as supporting WebSub or Podping. 2024-dated; unverified for 2026 [S60].
- YouTube channel push: documented PubSubHubbub topic `youtube.com/xml/feeds/videos.xml?channel_id=...` for new uploads and metadata edits (page updated 2026-10-15) [S61].
- Video in podcast feeds: Apple Podcasts HLS video announced 2026-02-16 (beta in iOS 26.4; launch hosts Acast, ART19, Omny, SiriusXM/Simplecast), Transistor says 48 shows live as of 2026-03-24. It is HLS, not an MP4 enclosure; how it appears in RSS is not documented in fetched pages [S57-S58]. Spotify video is not delivered through RSS but via its Distribution API, live 2026-05-14 on Libsyn, Podigee, Audioboom, Audiomeans, Podspace [S56].
- Feeds for audio-only shows give nothing to clip visually; video-podcast availability in RSS is the open question for an RSS autopilot.

YouTube policy check (2026)
- Developer Policies revision history has three 2025-2026 entries: 2025-07-07 (embedded player credentials), 2026-05-04 and 2026-06-01 (derived metrics and data storage for audited analytics developers). Nothing on downloads, AI training, derivative works or clipping [S62].
- Baseline clauses unchanged in the fetched policy text: III.E.1.a (no download/caching of audiovisual content without prior written approval), III.I.7 (no separating audio from video), III.E.6 and III.I.14 (no scraping/non-API access); ToS effective 2022-01-05 [S63-S64].
- Data API v3: no download or file-access change in 2026 [S65].
- yt-dlp churn: external JS runtime required (issue opened 2025-09-23); release 2026.06.09 raised minimums to Deno 2.3.0+ / Node 22+; PO-token guide (edited 2026-07-12) says the `web` client is SABR-only and `tv` is DRM'd without cookies; clients rotate every release (2026.08.19 dropped `android_vr`, 2026.10.21 added `tv_samsung`) [S66-S69].
- Competitor behavior (their docs): OpusClip accepts public/unlisted YouTube links with no ownership requirement stated, attributes failures to "YouTube's download policy updates" and offers local upload (up to 10 GB) as the workaround; its status page logged a YouTube-download incident 2026-03-11 to 2026-03-17 [S70-S73]. Vizard API docs list YouTube, Drive, Vimeo, StreamYard as sources, API paid only [S74]. Descript's API says YouTube URLs are unsupported for import [C35]. Klap: no primary evidence on ownership checks (unverified).
- Zoom changelog 2026-06-01 added four external-storage fields to Cloud Recording GET endpoints [S6].

---

## 3. Destination and publishing APIs (state at 2026-10-24)

Source codes [T/M/Y/L/X/TH/B/P/S/RD/A] are in the Sources list. Dates are page "last updated" or changelog entries.

| Platform | Publish method and approval hurdle | Quota / limits | Native scheduling | Analytics read-back | 2025-2026 change |
|---|---|---|---|---|---|
| TikTok | Direct Post (`video.publish`) or inbox draft (`video.upload`, creator finishes in app). "All content posted by unaudited clients will be restricted to private viewing mode"; lifting it requires an audit (page updated 2026-08-04) [T1]. Per the sharing/direct-post references, unaudited clients are also capped at 5 users per 24 h (not shown on the get-started page) [T2,T3]. No official audit SLA; vendors say weeks (secondary) | Init 6 req/min per user token; creator cap about 15 posts/day shared across clients; inbox max 5 pending shares per 24 h; file up to 4 GB; MP4/WebM/MOV; video up to 10 min via API [T3-T6] | No | Display API `video.list`: views, likes, comments, shares only. Watch time/retention only via the separate Business API organic endpoints (secondary, unverified) [T7,T8] | Changelog shows no Content Posting entries in 2025-2026; docs refreshed 2026-08-04 to cover photo posting; strict UX rules (call `creator_info` before each publish, explicit consent, no default privacy) |
| Instagram Reels | Container (`media_type=REELS`, public `video_url`) then `media_publish`. Instagram Login or Facebook Login; Advanced Access needs App Review + Business Verification (secondary: 2-4 weeks; a Meta forum thread 2026-04 reports verification in review 10+ days) [M1,M2,M4] | 100 API posts per rolling 24 h (the same page's carousel section says 50; inconsistent); status polling at most 1/min; container expires after 24 h | No scheduling parameter documented: the app must hold the job | `views`, `reach`, `likes`, `comments`, `shares`, `saved`, `reposts`, `ig_reels_avg_watch_time`, `ig_reels_video_view_total_time`, `reels_skip_rate`; no retention curve; kept up to 2 years [M3] | 2025-01-21 `plays`/`impressions` deprecated, `views` added; 2025-12-03 Trial Reels via `trial_params`, `reels_skip_rate`; 2026-04-22 partnership label; 2026-06-22 `is_ai_generated`; 2026-07-30 `media_url` omitted for copyrighted-audio reels [M4] |
| Facebook Page Reels | `POST /{page-id}/video_reels` (start, upload, finish); Page token | 30 API posts/24 h; 3-90 s, 9:16 | Yes: `video_state=SCHEDULED`, 10 min to 29 days out [M5] | `fb_reels_total_plays`, `post_video_avg_time_watched`, `post_video_retention_graph` (40 intervals) [M6] | 2025-11-15 `page_impressions` and `post_impressions*` return invalid-metric errors, use `*_media_view`; Graph v26.0 shipped 2026-07-29 [M7,M8] |
| YouTube | `videos.insert` (`youtube.upload`, resumable, up to 256 GB). Shorts have no API flag (3 min or less since 2024-10-15, square/vertical) | Verified 2026-10-24: `videos.insert` costs 1 unit in its own "Video Uploads" bucket, default 100 calls/day; `search.list` also 100/day; all other methods 10,000 units/day; extensions need a compliance audit first (page updated 2026-10-15) [Y1,Y3,Y4]. Revision history: upload cost cut from about 1,600 to about 100 units on 2025-12-04; granular buckets from 2026-06-01 [Y2] | Yes (`status.publishAt`) | Analytics API (`yt-analytics.readonly`): audience-retention report, `averageViewDuration`, `estimatedMinutesWatched`, `engagedViews`; Data API `videos.list` stats 1 unit; `videos.batchGetStats` added 2026-06-03 (10,000/day, own bucket) [Y5,Y6] | 2025-03-31 Shorts views count every start/replay; 2026-08-27 public views count from first frame in all formats; 2026-01-15 thumbnail impressions/CTR in Analytics |
| LinkedIn | Videos API then Posts API (`/rest/posts`, `Linkedin-Version`). Member posting `w_member_social`; organization posting and analytics sit in the vetted Community Management API (Development then Standard tier, Standard needs a screencast; no lead time stated) [L1-L3] | Video 3 s-30 min; size listed as 500 MB in one table and 5 GB in a field note (page contradicts itself); Development tier 500 app / 100 member calls per day | No (only `PUBLISHED` accepted) | Video analytics for orgs and members via Community Management API | Marketing version 202511 sunsets 2026-11-16 |
| X | Pay-per-use credits since Feb 2026; free tier gone; legacy Basic $200/mo and Pro $5,000/mo kept for existing subscribers (secondary) [X1,X4] | Post create $0.015, with a URL $0.20 (secondary for the URL surcharge); media v2 chunked upload; `tweet_video` up to 8 GB / 20 min per docs.x.com (a secondary source says 512 MB / 140 s; conflict) [X2] | Unverified | Own posts, last 30 days: `public_metrics` incl. `view_count`, `non_public_metrics` incl. `playback_0_count`..`playback_100_count` [X3] | Pay-per-use became default Feb 2026 |
| Threads | `threads_content_publish`; Advanced access beyond testers [TH1] | 250 posts/24 h; video up to 300 s / 1 GB | Not documented | views, likes, replies, reposts, quotes, shares; no watch time [TH2] | 2025-12-22 posts with more than 5 links fail; 2026-03-25 cross-share to Instagram Stories [TH3] |
| Bluesky | `video.bsky.app` upload via service auth, `app.bsky.embed.video` record; no platform approval | Limits raised to 10 min and 300 MB (announced 2026-08-25, Engadget 2026-08-26), from 3 min; per-user quota via `getUploadLimits` [B1,B3] | No | Likes, reposts, replies, quotes, bookmarks; no views/impressions [B2] | Aug 2026 limit increase |
| Pinterest v5 | `POST /v5/media`, upload, poll, `POST /v5/pins`. Trial pins visible only to the creator; Standard needs OAuth demo video and manual review [P1] | Trial: daily per-app limit | Not documented | `VIDEO_MRC_VIEW`, `VIDEO_AVG_WATCH_TIME`, quartile views, saves, clicks [P2] | Apps registered on or after 2026-09-14 may get 403 `PINNER_DATA_ACCESS_DENIED` for non-business users; community reports Standard upgrade reviews pending 25+ days (secondary) [P3] |
| Snapchat | Public Profile API (Marketing API) for Stories/Spotlight; gated, partner-style [S1x,S2x] | Spotlight 5-60 s, 500 MB (secondary) | Via vendor only | Views, unique viewers, shares (secondary) | none found |
| Reddit / Mastodon | Reddit video API: no primary source found (unverified). Mastodon: async `/api/v2/media`, instance-set limits [RD1,RD2] | n/a | n/a | n/a | none found |

Verified changes worth acting on
- YouTube: the `videos.insert` reference (updated 2026-10-15) now says "Videos uploaded from unverified API projects are not restricted to private viewing mode" and that upload costs 1 unit in a 100-calls/day bucket. This contradicts the 2020-era rule that older mirrors and vendor blogs still quote, and the revision history has no entry explaining it. Treat as primary-source text but not field-tested [Y3]. The quota/compliance page still ties quota extensions to a compliance audit [Y4].
- TikTok remains the only major platform where a first-party-API client is visibly forced private until audited [T1]; several vendors sell pre-audited access (bundle.social blog 2026-08-04, secondary).
- Analytics read-back by platform: YouTube (retention curve, views, watch time) and Facebook Reels (retention graph, avg watch time) are the richest; Instagram gives avg watch time and skip rate but no curve; TikTok Display API gives counts only; X gives 30-day window; Bluesky gives no views.
- Meta metrics keep being removed (IG 2025-01, FB 2025-11-15), so any read-back loop needs metric-name versioning.
- Buffer reopened a public GraphQL API (api.buffer.com) on every plan including Free; no analytics and unclear video support (pricing tracker 2026-07-02, secondary) [A7].

Unified-posting vendors (signal for how competitors absorb audit burden)

| Vendor | 2026 price (as stated) | Analytics | Notes |
|---|---|---|---|
| Ayrshare | $149/mo (1 profile), $299 (10), $599 (30); Enterprise custom [A1] | Basic on Premium, advanced above | Page contradicts itself on account counts |
| Zernio (formerly Late/getlate.dev) | per connected account/month: 1-2 free, 3-10 at $6, 11-100 at $3, 101+ at $1 [A2,A3] | Included | Snapchat in closed beta; rebrand date secondary |
| Upload-Post | Free (2 profiles); $24 to $438/mo for 5 to 225 profiles [A4] | Paid plans | from its `llms-full.txt` |
| bundle.social | Free (3 accounts); $100 and $400/mo [A5] | All tiers | Sells pre-audited TikTok; X billed separately |
| Postiz | Cloud $29/$39/$49/$99 for 5/10/30/100 channels; AGPL self-host [A6] | Included | API, MCP, CLI on every plan; plans include clipping minutes (60-600/mo), so it overlaps with clippers; 37,643 GitHub stars (2026-10-23) |
| Buffer | API on all plans: Free 1 key / 3,000 requests/mo, Essentials 3 keys / 7,500, Team 5 keys / 15,000 [A7] | none via API | 100 requests per 15 min per key |
| Publer | API on Business/Enterprise only; about $10/mo per account (secondary) [A8] | Yes | 100 requests per 2 min |
| Hootsuite, Metricool, Blotato | unverified | unverified | Metricool ships an official MCP (`ai.metricool.com/mcp`, all plans incl. Free, per help center); Blotato sells hosted MCP and pre-audited TikTok (secondary) |

Unverified or conflicting in section 3: TikTok Business API organic fields and access, audit duration; Instagram Reels specs, the 100 vs 50 cap, App Review lead times; LinkedIn video size cap and review lead time; X scheduling and video limits; scheduling for Threads/Bluesky/Pinterest; Pinterest video specs; Reddit; Snap costs.

---

## 4. AI-agent automation trends (2026)

### 4.1 MCP ecosystem

| Topic | Evidence | Date / ref |
|---|---|---|
| Claude connectors directory | Portal at claude.ai/directory/manage, any paid Claude plan can submit, free, no expedited track. Needs remote HTTPS MCP, OAuth 2.0 for account-acting tools, a `title` plus `readOnlyHint` or `destructiveHint` on every tool, a reviewer test account, privacy policy and docs. Automated scan lists a connector as "Community" by default; some get human review with no stated timeline; "Verified" is a separate label. Local MCPB packages no longer accepted. Ranking is usage-based. "Over 950 MCP servers" | Anthropic, 2026-07-28 [E1,E2] |
| Anthropic creative connectors | Adobe (50+ Creative Cloud tools incl. Premiere and Express), Affinity by Canva, Blender, Ableton, Autodesk Fusion, Resolume, SketchUp, Splice | 2026-04-28 [E3] |
| ChatGPT apps | App directory opened to submissions around 2025-12-17/18 (secondary). On 2026-07-09 OpenAI folded apps into a "plugin directory" (an MCP server plus optional skills, works in ChatGPT and Codex). Submission needs individual/business verification, domain verification, a public HTTPS server (no API-key auth in the portal), 5 positive and 3 negative test cases, demo video; hosted servers scanned daily. Monetization policy not stated on the submission page. Listing counts conflict (900 in May 2026 vs 4,000+ on 2026-09-19, both secondary) | [E4,E5] |
| MCP spec 2026-07-28 | Stateless core (no `initialize`, no `Mcp-Session-Id`, `server/discover`). Tasks moved out of core into official extension `io.modelcontextprotocol/tasks` (server returns a task handle on `tools/call`, client polls `tasks/get`). `input_required` results replace server-initiated requests. MCP Apps (SEP-1865) = interactive UI in a sandboxed iframe, accepted by Claude's directory. Dynamic Client Registration deprecated in favour of Client ID Metadata Documents; clients must validate `iss` (RFC 9207). Deprecated: HTTP+SSE, Roots, Sampling, Logging (12-month policy) | spec changelog + RC post [E6,E7] |
| Tasks in clients | Anthropic says Tasks and MCP Apps "rolling out soon" with no per-surface matrix (2026-07-28) [E2]. A user-filed Claude Code issue (2026-10-15) says Tasks are not supported yet and claims claude.ai connectors time out near 240 s (one user's observation, unverified) [E8] | |
| How video vendors handle long jobs today | Async submit-and-poll tools: OpusClip `analyze_video` returns a `task_id` re-called until done, `edit_clip` returns `render_pending`, publishing tools return `requires_approval` plus an approval URL, credits charged at confirmation [C8] | |

Video/media vendors with MCP servers (Registry date = published to the official MCP Registry, not launch):

| Vendor | Evidence | Date |
|---|---|---|
| OpusClip | Hosted `mcp.opus.pro/mcp`, OAuth, 27 workflow tools; Claude, Cursor, VS Code, ChatGPT listed | Registry 2026-07-02; blog 2026-07-28 |
| Descript | Connector for Claude, ChatGPT, Cursor; import, Underlord edits, publish link, transcript export; no extra charge, uses AI credits; no MP4 export | undated |
| Canva | `mcp.canva.com/mcp` | Registry 2026-09-25 |
| Adobe | Connector for Claude (Premiere, Express among 50+ tools); help text (snip) says ChatGPT, Claude, M365 Copilot live | 2026-04-28 |
| Riverside | `mcp.riverside.com/mcp`, beta, paid plans only (third-party listing) | undated |
| Submagic | `api.submagic.co/mcp`, API key bearer | undated |
| Reap | `mcp.reap.video/mcp`, OAuth; included on every paid plan from $9.99/mo | undated |
| Klap | Hosted MCP at `api.klap.app/mcp/agents`, 18 tools, OAuth; free to connect, work draws on the plan | undated |
| Vugola | npm + hosted MCP on every paid plan | undated |
| VEED | `io.veed/fabric-mcp` (avatar-video generation, not clipping) | Registry 2026-04-02 |
| ElevenLabs | `io.elevenlabs/mcp` | Registry 2026-09-08 |
| Metricool, Blotato, Postiz | Social/analytics MCPs (Metricool all plans; Blotato Registry 2026-09-10) | |
| Vizard | No MCP found; Claude Code/Cursor skill and n8n template instead [C19] | |
| CapCut | No official API or MCP (one competing vendor's blog, 2026-10-15) [C42] | |

Not found: Gemini app connectors and Copilot Studio MCP availability (no primary source); Synthesia MCP; Runway and HeyGen only via secondary or failed fetches.

### 4.2 n8n / Zapier / Make

- n8n: MCP Server Trigger and MCP Client Tool date from 2025. Verified community nodes go through the Creator Portal (creators.n8n.io/nodes); from 2026-05-01 nodes must be published from GitHub Actions with provenance, no runtime dependencies, one service per package, and n8n may reject nodes that compete with its paid features; review time not stated [E9]. n8n.io lists 13,649 templates, repo 208k GitHub stars (2026-10-23).
- n8n template counts and page views (api.n8n.io, 2026-10-24; views are page views, not installs):

| Query | Templates | Top views |
|---|---|---|
| "tiktok" | 125 | 214,907 (Seedance AI viral videos + upload); 45,458 (Drive to IG/TikTok/YouTube) |
| "blotato" | 82 | 71,279 |
| "shorts" | 61 | 24,339 (AI-generated ASMR Shorts) |
| "youtube shorts" | 42 | 24,339 / 14,048 / 8,136 |
| "clips" | 39 | 2,970 (YouTube Shorts Automation); 2,669 (Vizard auto-clip) |
| "vizard" | 4 | 2,669; Vizard's own template (2026-03-14) 0 views |
| "klap" | 2 | 1,599 and 131 |
| "opusclip" | 1 | 0 (third-party, 2026-07-30) |
| "submagic" | 4 | max 56 |

  Read-through: n8n demand is for AI-generated video plus auto-publish; long-to-short clipping templates top out near 3k views. Community nodes on npm: `n8n-nodes-klap` (maintained by `klap_ai`, created 2026-10-08, 345 downloads last month), `n8n-nodes-vizard` (third-party, created 2026-07-20, 25 downloads); no OpusClip or Submagic node found.
- Zapier: blog (April 2026, updated May 2026) describes Zapier MCP (30,000+ actions across 9,000+ apps), Zapier SDK (TypeScript, Beta on CLI page) and Zapier CLI. Zapier Agents listed as GA, no dated 2026 announcement found. Public-app review: docs say a developer reaches out within about 1 week; a June 2026 community post reports 28 days pending; a third-party guide says 2-4 weeks [E10]. Clip-tool coverage: OpusClip (1 trigger, 3 actions, 4 searches [C16]); Klap (triggers New Clip, New Project Ready, Project Failed; actions Create Clips, Export Clip, Schedule Clip, Write Caption; 2 searches); Vizard: no Zapier app found; Descript Zapier beta; Submagic via Zapier (integrations page).
- Make: its 2025 recap lists a Make MCP server, Make AI Agents (spring 2025) and MCP tools inside agents; Make Grid reached all paid users in 2025. No 2026-dated announcement found. Public-app review is QA-based, service must not already be integrated, later changes need Make approval, no lead time stated [E11]. OpusClip's Make app is community-built, not vendor-built [C59]. Make template counts not obtainable (JS-rendered page).

### 4.3 AI content agents: shipped vs hype

| Item | Status | Evidence |
|---|---|---|
| YouTube Test & Compare | Shipped, limited | Up to 3 titles and/or thumbnails, winner by watch-time share; desktop only, Advanced features needed, not for Shorts, Premieres or scheduled Lives; broad-rollout date unverified [E12] |
| TikTok / Meta native hook A/B for organic clips | Not found | Only agency blog on ad-creative testing |
| OpusClip virality score | Shipped | Secondary reviews |
| OpusClip MCP "schedule a month of videos" | Shipped (vendor page) | Agent ranks unposted clips by virality, drafts a calendar, one confirmation; Pro Beta, Max or Business [E13] |
| OpusClip "test three hook variations" | Vendor showcase only | Listed in the MCP inspiration gallery [C18]; no performance feedback loop documented |
| OpusClip performance feedback into scoring | No evidence | vendor changelog not found |
| quso.ai | Shipped | AI Content Planner, scheduler to 7 platforms, analytics with AI insights, Viddy assistant on Growth ($49/mo) [C50] |
| Reap, Munch, Spikes Studio | Shipped | Content calendars/planners; Munch performance dashboard; Spikes clip analytics [C43,C45,C47] |
| Submagic MCP | Shipped | Reads publishing stats (views, engagement, follower growth) |
| Klap "Post the best clips" | Shipped | Virality-score threshold, AI captions, schedule, via Zapier/n8n [C31] |
| Gumloop social agent | Vendor page | Ranks posts by engagement, builds a 2-week calendar in Sheets; date unverified |
| Analytics-driven re-clipping / "learn from what performed" | Hype | Only generic blog descriptions; no shipped product found |
| Autonomous weekly planners from Hootsuite, Sprout, Later, Predis, Castmagic | No evidence found | Not exhaustive |

### 4.4 Agentic video editing: adoption evidence only

- Descript Underlord opened to Claude/ChatGPT and workflows (article 2026-08-25) [C39]; API included for paying users [C37].
- Adobe Firefly AI Assistant in public beta for Photoshop, Premiere, Illustrator, InDesign, Frame.io (ProPakistani 2026-06-19, secondary).
- GitHub stars on 2026-10-23 (stars are not usage): remotion-dev/remotion 66,673; remotion-dev/skills 5,573; heygen-com/hyperframes 70,675; openclaw/openclaw 392,872; awesome-openclaw-skills 53,290; Postiz 37,643; n8n 208k.
- OpusClip uptake signals are small: `@opusclip/mcp` 287 npm downloads in the month ending 2026-10-18; `opus-pro/opusclip-mcp` repo 8 stars; no hosted-usage figure.
- Open-source agent stacks (Postiz walkthrough 2026-05-19: Telegram message to Hermes Agent, Vugola MCP clips, Postiz MCP schedules) are promotional; revenue claims anecdotal [C52].
- RSS-triggered clipping is rare. OpusClip Auto Import is YouTube-channel only. Podsqueeze says you can "connect your podcast RSS feed" and "We process everything automatically" (page updated 2026-10-22) but lists audiograms/show notes, not vertical clips, and does not say how new episodes are detected [C57]. Headliner's "RSS" feature auto-uploads exports, it does not say it auto-creates videos [C58]. An Apify actor polls RSS and outputs timestamps only (audio enclosures, no video). Nothing found that does RSS to captioned vertical video end to end with publishing.

### 4.5 Adoption evidence vs hype

Adoption evidence
- Anthropic directory 950+ servers (2026-07-28); OpenAI plugin directory unified 2026-07-09.
- Several clip/video vendors run hosted OAuth MCP servers; OpusClip gates MCP calls to paid tiers (it sells the integration); Descript bills MCP use against existing AI credits; Reap and Vugola include API and MCP in every paid plan.
- Zapier apps exist for OpusClip and Klap; Klap ships an official n8n node.
- Big n8n view counts exist for AI-video generation + auto-publish (214,907; 71,279).

Weak or no adoption evidence
- OpusClip MCP npm/GitHub numbers are tiny; clipping-specific n8n templates top near 3k views and the official OpusClip and Vizard templates have 0 views; Klap node 345 monthly downloads, Vizard third-party node 25.

Hype or unconfirmed
- MCP Tasks in clients ("rolling out soon"); analytics-driven re-clipping; hook A/B for organic Shorts (YouTube's tool excludes Shorts); ChatGPT directory sizes; Buffer MCP date; Runway MCP; Adobe AI Assistant beta date; Make 2026 announcements (none found).

---

## 5. Creative-tool and workflow integrations that competitors ship

| Competitor | NLE / editor export | Cloud and source integrations | Review / team | Chat-ops, calendar, CMS |
|---|---|---|---|---|
| OpusClip | Premiere XML + original video + SRT (captions arrive as overlays, not editable in Premiere); Resolve import guide; Final Cut not recommended (help.opus.pro) | Sources: YouTube, Vimeo, Zoom, Drive, Dropbox, Riverside, Loom, Frame.io, StreamYard, Twitch, Rumble, X, LinkedIn, Apple Podcasts [C12]; Zapier lists a Frame.io V4 + OpusClip pairing (no native importer found); beehiiv MCP combo shown in showcase | Share project (gated by an approval link in the Claude connector); team workspace (Pro, 2-4 users); Business has CMS integration | No native Slack/Teams/Notion/Airtable found; Zapier reaches 30 popular apps incl. Notion, Slack-class tools, Sheets |
| Vizard | not found | Sources: YouTube, Drive, Vimeo, StreamYard | Team workspace + share previews/links with clients | Content calendar; n8n template; no Zapier |
| Klap | not found | YouTube, Vimeo, Twitch, Drive | none advertised | Zapier/n8n/Make; MCP |
| Submagic | not mentioned | Drive folder watcher, Gumloop brand-kit sync | seats 1/3/unlimited | Zapier/Make/n8n |
| Descript | Premiere, Final Cut, Resolve, AAF, EDL, SESX | Imports from Riverside, Zoom, Ecamm, Restream, SquadCast; publishes to YouTube, Drive, Wistia, podcast hosts | MCP publishes share links | Zapier, Raycast |
| Riverside | exports to Premiere and Final Cut | HubSpot, Salesforce, Spotify | none found | Co-Creator (in-app assistant) |
| Reap | not mentioned | URL imports (YouTube, Twitch, X, Vimeo) | none found | Content calendar, bulk schedule |
| Quso.ai | not found | Drive, Dropbox, URLs | none found | Content planner, 7 platforms |
| Choppity | not found | none found | Owner/Editor roles; caption review before publish | none |
| Spikes Studio | not found | none found | Team workspaces, multi-client | Analytics dashboard |
| 2short, Swiftia, Munch, Captions, Repurpose.io, VEED clipping | unverified | | | |
| CapCut | Community draft-file writers only | | | No official API |

Not found for any clip tool (coverage not exhaustive): native Slack/Teams/Discord approval apps, native Notion/Airtable, Canva app, Chrome extension, Vimeo Review/Wipster/Filestage integrations, WordPress/Webflow/HubSpot publishing (only Riverside HubSpot registration sync, Descript Wistia). Canva's public integrations need Canva Apps team review.

---

## 6. Signals (evidence-based, not recommendations)

1. API plus MCP is now table stakes at the low end. Reap ($9.99), Vugola, Klap (usage-priced API, free MCP connect) and Descript (included with any paid plan) bundle it; OpusClip, Submagic, Choppity gate API to $29 to $69 tiers. Free accounts can usually connect and browse tools, rendering needs a paid plan.
2. OpusClip is the benchmark and is moving fast: MCP (blog 2026-07-28), Claude directory connector with human approval links for post/schedule/cancel/share, Skill package for Claude Code/Codex/OpenClaw, Scheduler API, hourly YouTube Auto Import, Zapier (2025-10-02). Its publishing in agent flows is deliberately human-confirmed in the Claude connector, direct in the IDE MCP.
3. Triggers are thin. The only clipper-native auto triggers found are OpusClip's own-channel YouTube Auto Import, Klap via Zapier/n8n, and Restream's auto-pilot. No clipper documents Zoom/Drive/Dropbox watchers natively (Submagic has a Drive folder watcher). No clipper does RSS-to-vertical-clips end to end.
4. Source-side hurdles are heaviest for Google (Drive/Meet restricted scopes need CASA), Zoom (Marketplace review), Dropbox (50-user production gate), Box (enterprise admin approval). Riverside has no recording webhook and a gated API; Loom has no API; Frame.io V4, Wistia, Mux, Transistor and Acast have usable "ready" webhooks.
5. Podcast-host side: only Transistor and Acast document new-episode webhooks; others rely on RSS polling/WebSub (2024-dated host list). Video in feeds is shifting to Apple HLS (2026-02-16) and Spotify's Distribution API, not MP4 enclosures.
6. YouTube: no 2026 policy change on downloading found; download-side friction is technical (yt-dlp PO tokens/JS runtime/SABR) and OpusClip had a 6-day YouTube-download incident in March 2026. On the publish side the docs now state unverified projects are not forced private and uploads cost 1 unit/100 per day.
7. TikTok still forces unaudited clients to private; Meta keeps removing metrics; X is pay-per-call; Pinterest and Snap are slow-approval; Bluesky raised video to 10 min / 300 MB. Unified-posting vendors (Ayrshare, Zernio, Upload-Post, bundle.social, Postiz) sell audit burden as a service; Postiz bundles clipping.
8. Read-back for a feedback loop is feasible on YouTube (retention), Facebook Reels (retention graph), Instagram (avg watch time, skip rate), thinner on TikTok (counts), X (30 days). No competitor documents an analytics-to-re-clipping loop; vendor content on hook testing is a showcase prompt, not a product.
9. MCP: spec 2026-07-28 moves long-running work to a Tasks extension, but client support is not confirmed; vendors use submit-and-poll tools. MCP Apps (UI) accepted by Claude's directory. DCR deprecated for CIMD.
10. Workflow-platform demand is for AI-generated video and auto-publish (n8n tens to hundreds of thousands of views), not long-to-short clipping (about 3k top). Zapier public-app review 1 to 4 weeks; n8n verified nodes need GitHub-Actions provenance.
11. Agentic general video editors (Vizard Agent 2026-08-10, Agent Opus, Descript Underlord via MCP) are brief-to-video; none of the announcements mention scheduling or publishing, and one Product Hunt commenter asked Vizard for calendar integration.

---

## Sources

Section 1 and 4 vendor pages (fetched 2026-10-24 unless dated)
- [C1] https://www.opus.pro/pricing
- [C2] https://help.opus.pro/api-reference/overview.md
- [C3] https://help.opus.pro/api-reference/limitation.md
- [C4] https://help.opus.pro/api-reference/webhook.md
- [C5] https://help.opus.pro/api-reference/endpoints/social-posting/overview.md
- [C6] https://help.opus.pro/docs/article/posting-rate-limits.md
- [C7] https://help.opus.pro/api-reference/agent-setup.md
- [C8] https://help.opus.pro/api-reference/claude-connector.md
- [C9] https://help.opus.pro/api-reference/skill.md
- [C10] https://help.opus.pro/docs/article/auto-import.md
- [C11] https://help.opus.pro/docs/article/zapier-integration.md
- [C12] https://help.opus.pro/docs/article/what-import-sources-does-opusclip-support.md
- [C13] https://www.opus.pro/mcp
- [C14] https://www.opus.pro/blog/claude-video-editing-mcp (published 2026-07-28, modified 2026-10-07)
- [C15] https://www.opus.pro/blog/introducing-our-new-zapier-integration (launch 2025-10-02 per search snippet)
- [C16] https://zapier.com/apps/opusclip/integrations
- [C17] https://help.opus.pro/docs/article/bulk-scheduler.md ; https://help.opus.pro/docs/article/how-to-add-a-brand-template.md ; https://help.opus.pro/llms.txt
- [C18] https://www.opus.pro/mcp/inspiration
- [C19] https://vizard.ai/api ; https://docs.vizard.ai (index)
- [C20] https://vizard.ai/pricing
- [C21] https://docs.vizard.ai/docs/quickstart ; https://docs.vizard.ai/reference/rate-limit
- [C23] https://vizard.ai/blog/the-next-shift-in-ai-is-coming-to-video (2026-08-10)
- [C24] https://www.producthunt.com/posts/1214347
- [C25] https://vizard.ai/blog/api-update-vizard-now-supports-the-v2-ai-clipping-model (2026-07-21)
- [C26] https://vizard.ai/tools/content-calendar
- [C27] https://klap.app/pricing ; [C28] https://klap.app/api ; [C29] https://docs.klap.app/pricing ; [C30] https://klap.app/mcp ; [C31] https://klap.app/integrations ; https://docs.klap.app
- [C32] https://submagic.co/integrations ; [C33] https://www.submagic.co/pricing ; [C34] https://docs.submagic.co
- [C35] https://help.descript.com/api-and-mcp/api ; [C36] https://help.descript.com/api-and-mcp/mcp ; [C37] https://www.descript.com/api ; [C38] https://www.descript.com/pricing ; https://www.descript.com/blog/article/mcp-connectors (updated 2026-09-04)
- [C39] https://www.createwith.com/tool/descript/updates/descript-underlord-brings-natural-language-video-editing-to-automated-workflows (2026-08-25, secondary)
- [C40] https://captions.ai/help/docs/api/pricing
- [C41] https://www.veed.io/tools/veed-mcp
- [C42] https://www.wireflow.ai/blog/capcut-api (2026-10-15, vendor with competing product)
- [C43] https://www.reap.video/pricing ; [C44] https://docs.reap.video/llms.txt
- [C45] https://www.munchstudio.com/pricing ; [C46] https://www.choppity.com/pricing ; [C47] https://spikes.studio/pricing ; [C48] https://2short.ai ; [C49] https://app.swiftia.io/docs ; [C50] https://quso.ai/pricing
- [C51] https://www.vugolaai.com/pricing ; search snippet for conflicting $10/$21/$69 figures
- [C52] https://postiz.com/blog/ai-video-clipping-agent-postiz-stack (2026-05-19, promotional)
- [C53] https://support.restream.io/en/articles/10559070-ai-clips-pricing-faqs
- [C54] https://docs.riverside.fm/webhooks/event-types.md ; [C55] https://docs.riverside.fm/webhooks/overview.md
- [C57] https://podsqueeze.com/video-repurposing-tool/ ; https://podsqueeze.com/podcast-automation/ (updated 2026-10-22)
- [C58] https://www.headliner.app/features/
- [C59] https://apps.make.com/opus-qvbvfu (search result, community-maintained)
- Riverside Business API and MCP: https://support.riverside.com/hc/en-us/articles/9068592900381 (snip) ; https://support.riverside.com/hc/en-us/articles/12124048765981 (Magic Clips, snip)
- Third-party pricing summaries used only as pointers: creatify.ai/blog/opusclip-pricing-plans-and-what-you-ll-actually-pay-in-2026 ; quso.ai/blog/opus-clip-pricing

Section 2 (recording sources)
- [S1] https://developers.zoom.us/blog/meeting-api-querying-tips-part4/ ; [S2] https://developers.zoom.us/docs/platform/announcements/ ; [S3] https://developers.zoom.us/docs/distribute/app-review-process/ ; [S4] https://www.recall.ai/blog/explaining-the-zoom-app-submission-process ; [S5] https://devforum.zoom.us/t/expediting-app-review/144937.md ; [S6] https://developers.zoom.us/changelog/meetings/june-01-2026/ ; [S7] https://developers.zoom.us/docs/integrations/oauth-scopes-granular/
- [S8] https://docs.riverside.fm/webhooks/event-types.md ; [S9] https://docs.riverside.fm/quickstart.md ; [S10] https://docs.riverside.fm/endpoints-reference/v3/download-file.md
- [S11] https://support.streamyard.com/hc/en-us/articles/4402082361364-Does-StreamYard-have-an-open-API ; [S12] https://support.streamyard.com/hc/articles/21211769916308-How-to-Integrate-StreamYard-On-Air-with-Zapier
- [S13] https://developers.restream.io/llms.txt ; [S14] https://developers.restream.io/events/events-recording-download-url
- [S15] https://help.descript.com/api-and-mcp/api ; [S16] https://help.descript.com/developers.md ; [S17] https://help.descript.com/api-and-mcp/zapier.md
- [S18] https://developers.google.com/workspace/drive/api/guides/push ; [S19] https://developers.google.com/workspace/drive/api/guides/api-specific-auth (2026-09-03) ; [S20] https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification (2026-08-19) ; [S21] https://developers.google.com/identity/protocols/oauth2/production-readiness/sensitive-scope-verification (2026-08-19)
- [S22] https://docs.dropboxapi.com/dropbox-api/docs/webhooks ; [S23] https://docs.dropboxapi.com/dropbox-api/docs/developer-resources/developer-guide
- [S24] https://forum.frame.io/t/frame-io-v4-api-release-notes/2527 ; [S25] https://developer.frame.io/platform/docs/resources/migration ; [S26] https://next.developer.frame.io/platform/docs/guides/media-links ; [S27] https://forum.frame.io/t/v4-api-migration-questions-discussion/3368
- [S28] https://developer.box.com/guides/webhooks/v2/create-v2 ; [S29] https://developer.box.com/guides/authorization/platform-app-approval/ ; [S30] https://developer.box.com/guides/downloads/file ; [S31] https://developer.box.com/guides/getting-started/publish-app
- [S32] https://support.atlassian.com/loom/docs/does-loom-have-an-open-api/
- [S33] https://learn.microsoft.com/en-us/graph/teams-changenotifications-callrecording-and-calltranscript (2026-06-29) ; [S34] https://learn.microsoft.com/en-us/onedrive/developer/rest-api/concepts/using-webhooks (2026-05-14) ; [S35] https://learn.microsoft.com/en-us/graph/teams-licenses
- [S36] https://developers.google.com/workspace/events/guides/events-meet (2026-09-03) ; [S37] https://developers.google.com/meet/api/guides/artifacts ; [S38] https://developers.google.com/workspace/meet/api/guides/authenticate-authorize
- [S39] https://help.vimeo.com/hc/en-us/articles/12427776744593-Get-video-transcode-status-from-the-API ; [S40] https://help.vimeo.com/hc/en-us/articles/12427806914577-Get-video-file-and-download-links-from-the-API
- [S41] https://docs.wistia.com/docs/webhooks ; [S42] https://docs.wistia.com/docs/asset-urls
- [S43] https://www.mux.com/docs/core/listen-for-webhooks ; [S44] https://www.mux.com/docs/guides/download-for-offline-editing ; [S45] https://developers.cloudflare.com/stream/manage-video-library/using-webhooks/ ; [S46] https://developers.cloudflare.com/stream/viewing-videos/download-videos ; [S47] https://docs.bunny.net/stream/webhooks
- [S48] https://developers.transistor.fm/ ; [S49] https://learn.acast.com/en/articles/3505461-what-is-a-webhook ; [S50] https://github.com/buzzsprout/buzzsprout-api ; [S51] https://api.captivate.fm/ ; [S52] https://rss.com/blog/rss-com-launches-public-api/ (2026-02-24) ; [S53] https://libsyn.com/llms.txt ; [S54] https://support.megaphone.fm/en/articles/2247461-megaphone-api ; [S55] https://apidocs.simplecast.com/ ; [S80] https://help.podbean.com/support/solutions/articles/25000008051-publishing-a-new-podcast-episode-via-podbean-api
- [S56] https://creators.spotify.com/resources/news/expanding-video-partners-and-platforms ; [S57] https://www.apple.com/newsroom/2026/02/apple-introduces-a-new-video-podcast-experience-on-apple-podcasts/ ; [S58] https://transistor.fm/apple-podcasts-video/ ; [S59] https://help.podcast.co/en/articles/7942251-youtube-rss-ingestion-overview ; [S60] https://blog.pocketcasts.com/2024/04/26/websub-and-podping-support/ ; [S61] https://developers.google.com/youtube/v3/guides/push_notifications
- [S62] https://developers.google.com/youtube/terms/revision-history ; [S63] https://developers.google.com/youtube/terms/developer-policies ; [S64] https://www.youtube.com/t/terms?hl=en ; [S65] https://developers.google.com/youtube/v3/revision_history
- [S66] https://github.com/yt-dlp/yt-dlp/issues/14404 ; [S67] https://github.com/yt-dlp/yt-dlp/wiki/PO-Token-Guide ; [S68] https://github.com/yt-dlp/yt-dlp/wiki/EJS ; [S69] https://github.com/yt-dlp/yt-dlp/releases
- [S70] https://help.opus.pro/docs/article/resolving-youtube-upload-issues ; [S71] https://help.opus.pro/docs/article/what-import-sources-does-opusclip-support.md ; [S72] https://help.opus.pro/docs/article/auto-import ; [S73] https://status.opus.pro/cmmlz2see09w7stpr68955tcu ; [S74] https://docs.vizard.ai/docs/quickstart
- [S79] https://www.switchlabs.dev/post/casa-tier-2-tier-3-security-review-providers-pricing-and-the-cheapest-option (third-party CASA estimates)

Section 3 (destinations)
- [T1] https://developers.tiktok.com/doc/content-posting-api-get-started (2026-08-04) ; [T2] https://developers.tiktok.com/doc/content-sharing-guidelines ; [T3] https://developers.tiktok.com/doc/content-posting-api-reference-direct-post ; [T4] .../content-posting-api-reference-upload-video ; [T5] .../content-posting-api-media-transfer-guide ; [T6] https://developers.tiktok.com/doc/tiktok-api-v2-rate-limit ; [T7] https://developers.tiktok.com/doc/changelog ; [T8] https://developers.tiktok.com/doc/tiktok-api-v2-video-object ; https://bundle.social/blog/tiktok-api-approval (2026-08-04, secondary) ; https://docs.adverity.com/reference/connectors/connector-tiktok-business.html (secondary)
- [M1] https://developers.facebook.com/docs/instagram-platform/content-publishing ; [M2] .../instagram-api-with-instagram-login/content-publishing ; [M3] https://developers.facebook.com/docs/instagram-platform/reference/instagram-media/insights ; [M4] https://developers.facebook.com/docs/instagram-platform/changelog ; https://communityforums.atmeta.com/questions-and-discussions-26/business-verification-in-review-10-days-blocking-app-review-submission-177498
- [M5] https://developers.facebook.com/docs/video-api/guides/reels-publishing ; [M6] https://developers.facebook.com/docs/graph-api/reference/video/video_insights/ ; [M7] https://developers.facebook.com/documentation/pages-api/changelog ; [M8] https://developers.facebook.com/docs/graph-api/changelog
- [Y1] https://developers.google.com/youtube/v3/determine_quota_cost (2026-10-15, re-verified) ; [Y2] https://developers.google.com/youtube/v3/revision_history (re-verified) ; [Y3] https://developers.google.com/youtube/v3/docs/videos/insert (re-verified) ; [Y4] https://developers.google.com/youtube/v3/guides/quota_and_compliance_audits (re-verified) ; [Y5] https://developers.google.com/youtube/analytics/channel_reports ; [Y6] https://developers.google.com/youtube/analytics/revision_history ; https://www.getphyllo.com/post/is-the-youtube-api-free-in-2026-quota-limits-costs-when-to-pay (2026-06-25, secondary)
- [L1] https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/videos-api (2026-03-02) ; [L2] .../shares/posts-api (2026-05-13) ; [L3] .../community-management/community-management-overview (2026-05-15)
- [X1] https://docs.x.com/x-api/getting-started/pricing ; [X2] https://docs.x.com/x-api/media/quickstart/media-upload-chunked ; [X3] https://docs.x.com/x-api/fundamentals/metrics ; [X4] https://bundle.social/blog/x-api-pricing-2026-costs-limits (secondary)
- [TH1] https://developers.facebook.com/docs/threads/posts ; [TH2] .../threads/insights ; [TH3] .../threads/changelog
- [B1] https://engadget.com/2244638/bluesky-now-supports-10-minute-videos-larger-file-sizes/ (2026-08-26) ; [B2] https://raw.githubusercontent.com/bluesky-social/atproto/main/packages/bsky/lexicons/app/bsky/feed/defs.json ; [B3] .../app/bsky/video/getUploadLimits.json
- [P1] https://developers.pinterest.com/docs/key-concepts/access-tiers/ ; [P2] https://raw.githubusercontent.com/pinterest/api-description/main/v5/openapi.yaml ; [P3] https://community.pinterest.biz/t/update-developer-app-approvals/45527
- [S1x] https://developers.snap.com/marketing-api/Public-Profile-API/Introduction ; [S2x] https://docs.zernio.com/platforms/snapchat (secondary)
- [RD1] https://docs.joinmastodon.org/methods/media/ ; [RD2] https://www.techloy.com/reddit-api-pricing-in-2026-complete-guide-for-developers-and-businesses/ (secondary)
- [A1] https://www.ayrshare.com/pricing/ ; [A2] https://zernio.com/pricing ; [A3] https://zernio.com/rebrand ; [A4] https://www.upload-post.com/llms-full.txt ; [A5] https://bundle.social/pricing ; [A6] https://postiz.com/pricing ; [A7] https://buffer.com/developer-api ; https://pricingsaas.com/companies/buffer/diffs/2026Q2 ; [A8] https://publer.com/docs

Section 4 and 5
- [E1] https://claude.com/docs/connectors/building/submission ; [E2] https://claude.com/blog/bringing-mcp-2026-07-28-to-claude (2026-07-28) ; [E3] https://www.anthropic.com/news/claude-for-creative-work (2026-04-28)
- [E4] https://developers.openai.com/apps-sdk/deploy/submission ; [E5] https://manufact.com/blog/openai-codex-chatgpt-mcp (secondary) ; https://venturebeat.com/technology/openai-now-accepting-chatgpt-app-submissions-from-third-party-devs-launches (secondary)
- [E6] https://modelcontextprotocol.io/specification/2026-07-28/changelog ; [E7] https://blog.modelcontextprotocol.io/posts/2026-07-28-release-candidate/ ; [E8] https://claudeissues.com/issue/102347-feature-support-the-mcp-tasks-extension-io-modelcontextprotocol-tasks-spec-2026 (2026-10-15, user report)
- [E9] https://docs.n8n.io/connect/create-nodes/deploy-your-node/submit-community-nodes.md ; n8n template counts from api.n8n.io/templates/search queried 2026-10-24 ; registry.npmjs.org / api.npmjs.org / api.github.com / registry.modelcontextprotocol.io queried 2026-10-23/24
- [E10] https://zapier.com/blog/zapier-mcp-vs-sdk/ ; https://docs.zapier.com/platform/publish/integration-publishing-requirements ; https://community.zapier.com/general-discussion-13/viaim-app-review-pending-for-28-days-no-blocking-validation-issues-53532 ; https://zapier.com/apps/klap/integrations
- [E11] https://www.make.com/blog/2025-reflections-2026-predictions ; https://developers.make.com/custom-apps-documentation/app-review/request-app-review
- [E12] https://support.google.com/youtube/answer/13861714 ; https://www.tubefilter.com/2025/07/16/youtube-feature-test-and-compare-titles-thumbnails/ (secondary)
- [E13] https://www.opus.pro/mcp/inspiration/schedule-a-month-of-videos-in-one-command
- Other: https://www.descript.com/mcp ; https://www.descript.com/integrations ; https://help.opus.pro/docs/article/import-to-davinci-resolve ; https://www.canva.dev/docs/apps/submission-checklist ; https://help.metricool.com/it/domande-frequenti-sul-metricool-mcp-1i3w0 ; https://www.blotato.com/blog/best-social-media-mcp-servers ; https://www.gumloop.com/use-cases/ai-social-media-agent ; https://propakistani.pk/2026/06/19/photoshop-and-premiere-get-ai-assistants-to-save-you-time/ ; https://zapier.com/apps/frameio-v4/integrations/opusclip ; https://blog.frame.io/?p=8198
