# Narriflow — Product Roadmap & Status (June 2026)

> Canonical, code-accurate roadmap. Supersedes the feature/status framing in
> `plan.md` (which was the now-delivered interactive-caption-editor plan and
> still references the pre-migration stack). Benchmarked against a June 2026
> competitive teardown of OpusClip, Vizard, Klap, Submagic, Veed, Riverside,
> Descript and Captions.ai/Mirage.

_Last updated: 2026-07-09._

---

## 1. Actual stack (source of truth — corrects older docs)

| Concern | **Current (correct)** | Stale doc references to ignore |
| --- | --- | --- |
| Transcription | **AssemblyAI** Universal-3.5 Pro → Universal-2 fallback (18 U3.5 core languages, 99-language fallback, word timing, speaker labels, language detection, opt-in keyterms) | "Deepgram Nova-2/Nova-3", `normalizeDeepgramTranscript`, `DeepgramWord` |
| Clip detection / scoring | **OpenAI Responses API**, `gpt-5.4-mini` (strict JSON schema, reasoning effort) | "GPT-4o-mini `/chat/completions`" |
| Background jobs | **Custom Bun poller** over ingest jobs + `stt` / `moment_detection` / `clip_rendering` workflow runs | "BullMQ" |
| Live events | **Upstash Redis pub/sub** → SSE to the web app | — |
| Storage / delivery | **Cloudflare R2** (multipart upload, presigned download, **$0 egress**) | — |
| Rendering | **FFmpeg** crop/scale + **ASS** caption burn-in (word-level highlight, box, glow, animation, position) | "SRT-only / preview-only highlight" |
| Web / API | Next.js 16 (App Router) + Hono route handlers; Clerk auth; Prisma/Postgres | "Next.js 15" |

**Cost to serve (verified June 2026): ~$0.21–0.38 per source-hour** end-to-end
(AssemblyAI $0.15–0.21/hr · gpt-5.4-mini <$0.02/hr · FFmpeg $0.05–0.20/hr · R2
$0.015/GB-mo, zero egress). All-in cost is **~$0.004–0.006/source-minute**, so a
processing-minutes quota can out-deliver incumbents and still hold 70–90% margin.

---

## 2. Implementation status (June 2026)

### ✅ Shipped & verified
- **Ingest**: file upload (R2 multipart), YouTube (`yt-dlp`), RSS episode import.
- **Transcription**: AssemblyAI Universal-3.5 Pro → Universal-2 with word-level timing, speaker labels, automatic detection, exact provider language codes, 18 core U3.5 languages and 99-language fallback coverage. Keyterms are explicit environment vocabulary only.
- **AI clip detection + virality scoring**: gpt-5.4-mini, composite score (hook / emotion / story / pacing / duration) + per-platform scores (TikTok / Shorts / Reels), diverse selection, long-transcript chunking, `caption_only` mode.
- **Multi-format render**: 9:16, 1:1, 16:9, **4:5** (all 1080p) with FFmpeg crop/scale + brand-logo overlay.
- **Captions — preview == export** _(fixed June 2026)_: studio HTML word-by-word preview and the burned ASS render now share one cue model (`CAPTION_CHUNK_SIZE`, `CAPTION_POSITION_Y_DEFAULTS`). The export reproduces per-word highlight, highlight box, glow, position and entrance animation; preset fonts are bundled in the worker image (Impact→Anton). Previously every default render fell back to flat SRT.
- **12 caption presets** + interactive studio editor (real video playback, word-synced overlay, drag/resize, transcript editing, autosave).
- **Brand templates** (CRUD, logo, colors, default-per-user) with cross-tenant logo-key hardening _(fixed June 2026)_.
- **Content packs** with mode / language / processing-window / clip-length / platform / tone controls; **upload advanced controls now take effect** _(fixed June 2026)_ and legacy rows regenerate safely.
- Auth (Clerk + multi-provider identities), transcript export (TXT/SRT/VTT).
- **Usage quotas + Stripe billing** _(June 2026)_: processing-minutes metric + per-upload length cap, enforced at every generation path (over-quota → 402). **Stripe billing** shipped — checkout, customer portal, signed webhooks mapping price→tier into `User.pricingTier`, a `/settings/billing` page and dashboard upgrade CTAs. Env-driven price ids; plugs straight into the quota gate.
- **Content-suite repurposing** _(June 2026)_: one-click blog post / X thread / LinkedIn post / show notes / quote cards from the transcript via gpt-5.4-mini, stored per project, with a "Repurpose" panel (copy/regenerate). Output prompts preserve the source language/script and exact requested asset sets are validated before writes.
- **Emoji captions** _(June 2026)_: deterministic keyword→emoji map, shared by the studio preview and the ASS burn-in (Noto Color Emoji bundled in the worker), toggled per caption preset. A 2026 table-stakes style.
- **Audiograms** _(June 2026)_: audio-only sources now render an animated FFmpeg `showwaves` waveform (colored from the caption preset) over a background with burned captions, instead of a black screen — podcast-ready shareable video.
- **Stock B-roll (Pexels)** _(June 2026)_: per clip, derives a visual query from the title/hook → Pexels free video search → downloads the best match → burns a cover-fit cutaway into the render (compatible with reframe + captions + logo). Gated on `PEXELS_API_KEY`; basic placement v1, LLM-cued semantic placement is v1.1.
- **Auto-reframe / speaker tracking** _(June 2026)_: landscape→vertical crops now follow the speaker. Self-hosted **YuNet** face detector (OpenCV, MIT, ~232 KB, CPU-only — zero API fees) samples frames → dead-zone + EMA smoothing → FFmpeg `sendcmd` dynamic crop. Bundled in the worker image; gracefully falls back to a static center crop if unavailable. Multi-speaker active-speaker (LR-ASD) is the planned v1.1.
- **Voiceover dubbing** _(June 2026)_: per-render dub requests create durable `ClipDub` rows, translate the clip transcript when needed, synthesize OpenAI speech (`gpt-4o-mini-tts` default), mux narration over the rendered MP4, upload MP3/MP4 dub assets to R2, and expose audio/video downloads from the project page.
- **Social publishing workflow + platform metrics ingestion** _(June 2026)_: scheduling now advances through a worker-claimable `publishing` state. Users connect native TikTok, YouTube, Instagram, LinkedIn, and X OAuth accounts; due posts publish through the selected account and then reconcile posted/failed outcomes. The legacy publisher webhook remains as a fallback for old posts without an account. Publisher integrations can return or later POST platform metrics (views/likes/comments/shares/saves/watch time), which are persisted and displayed per post.
- **RSS autopilot + MCP server** _(June 2026)_: durable RSS autopilot rules watch feeds, dedupe episode IDs, import unseen episodes, persist generation context before ingest completion, and then flow through the normal generation pipeline. A native stdio MCP server (`apps/mcp`) exposes project inspection and autopilot tools.

### 🟡 Partial / stubbed (do not market as done)
- **Studio tool panels**: editor Export, caption "apply to all", brand-template caption application, automatic/manual B-roll, URL-backed music mix, fade/dip transitions, and arbitrary text layers are wired into persisted clip edits and FFmpeg export. Remaining editor gaps are richer timeline editing, uploaded asset libraries, and non-fade transition families.
- **Dashboard / projects**: stat tiles are data-backed, active projects live-refresh, and the projects list now paginates past the first 50 records.
- **Upload reliability**: R2 parts upload with bounded retries, bounded concurrency, resumable sessions, and generation context is committed atomically with upload completion. Remaining gap: resumable UI controls are still basic.
- **Worker robustness**: workflow and ingest reapers exist, workflow idempotency uses the DB unique constraint, AssemblyAI language codes are centrally validated, and keyterms are bounded to provider limits. Remaining gaps: no retry policy beyond explicit user retry and no persisted language-confidence review state.
- **Social / analytics**: first-party analytics, durable scheduling, native OAuth publishing, webhook fallback delivery, posted/failed reconciliation, and platform metric ingestion are built. Remaining gap: automatic platform metric fetchers that refresh metrics from provider APIs without a webhook/manual ingest.

### ❌ Not built (UI may imply otherwise)
Language-confidence UI and reusable language/glossary profiles, segment-timed dubbing and translated captions, rendered RTL/CJK/Indic cue evaluation, lip-synced dubbing / speaker cloning, multi-speaker active-speaker selection beyond face-follow reframing, automatic provider-side social metric polling, and LLM-cued semantic B-roll placement are still roadmap items.

---

## 3. Confirmed competitive edges (bank these in marketing)
- **Virality score** — parity with OpusClip (1–100) and Vizard (0–100).
- **Real-time WYSIWYG word-by-word caption preview** that now matches the export — a defensible edge (CapCut Web openly only "approximates" its export).
- **All four aspect ratios incl. 4:5** — OpusClip and Veed both lack 4:5.
- **Cheapest cost-to-serve** in the category (R2 zero-egress + AssemblyAI/gpt-5.4-mini), enabling a more generous quota at a lower price.

---

## 4. Roadmap — reprioritized for the 2026 market

Tagged **[TS]** table-stakes (parity) / **[DIFF]** differentiator. Cost: cheap
(days–2wk) / medium (2–6wk + pipeline/integration) / expensive (months/new infra).

### Phase 0 — Correctness hardening (in progress, June 2026)
Make every shipped feature 100% accurate. Caption parity, security IDOR, dead
upload controls, legacy content-pack reads, upload reliability, worker
reaper/idempotency, dashboard/project pagination, and functional studio export
actions — **done**.

**July 2026 hardening pass — landed.** App-wide error handling: Next.js error
boundaries (`(app)/error.tsx`, `[projectId]/error.tsx`, studio `error.tsx`,
`not-found.tsx`, root `global-error.tsx`), a shared friendly error-code→message
map (`packages/validators/src/error-messages.ts`) now used across
project/transcript/dubbing/clip-card/render/social views, and previously-silent
fetch failures (render, disconnect, cancel/schedule post, accept/reject clip)
surfaced with user-facing messages + pending/disabled states. Security: response
headers in `apps/web/next.config.ts` (X-Frame-Options DENY, nosniff,
Referrer-Policy, HSTS, Permissions-Policy, CSP `frame-ancestors 'none'`) and an
SSRF guard (`assertPublicHttpUrl`, `packages/services/src/url-guard.ts`) applied
to RSS + YouTube ingestion. Pipeline robustness: bounded the workflow/ingest
claim retry (recursion → capped loop), and made previously-swallowed failures
observable (workflow heartbeat, Redis event publish, post-ingest generation
trigger now log). Studio: guard against losing unsaved caption/transcript edits
on tab-close/navigation (`beforeunload` + unmount flush). DX/testing: added root
`CLAUDE.md`, a GitHub Actions CI workflow (typecheck + test), fixed README's
absolute-path links, and wired the previously no-op `@narriflow/validators` test
script to `bun test` (turning on 20 real tests) — suite now ~83 tests
(validators 20 + services 28 + worker 35), all green.

**Follow-up hardening — landed.** Abuse/robustness: per-user rate limiting on
expensive endpoints (generate/regenerate/render/dubs/content-suite/social-posts/presign)
via a Redis fixed-window limiter that fails open
(`packages/services/src/rate-limit.ts`), a social-post reaper for posts stuck in
`publishing` after a worker crash, and ±20% jitter on the AssemblyAI + social
provider poll loops. Privacy: PII minimization in the Clerk webhook delivery log
(logs only type/eventId/subjectId now). UI polish: route-level `loading.tsx`
skeletons across dashboard/projects/upload/autopilot/settings, friendlier
empty-state copy, and accessibility labels on studio controls. DX: wired the
previously no-op `@narriflow/web` test script (now runs) and adopted a Biome
linter baseline (`biome.json`, `bun run lint:biome`) plus a Report-Only CSP
tightening — suite now ~90 tests, all green.

Remaining: richer editor ergonomics and explicit retry policy for failed
workflow stages, promoting the Report-Only CSP to enforced, re-enabling parked
Biome rules, a pre-commit hook, webhook-log retention, and web/component E2E
coverage. Outstanding deploy step: apply the pending `native_social_oauth` DB
migration in ops.

**July 2026 audit + performance pass — landed.** A six-agent audit (feature
inventory, competitor teardown, studio, B-roll, pipeline/cost, UI/UX) plus live
browser testing against the authenticated app. Suite grew ~90 → **366 tests**,
typecheck 10/10, `biome check` clean across 330 files.

_Correctness (all verified against source and production data):_
- **Autosave was destroying rendered clips.** `updateClipStudioEdits` ran
  `clipRender.deleteMany` + `deleteRenderAssets` unconditionally while the
  studio PATCHed `studioEdits` on every save — so changing a caption style
  wiped every rendered MP4 from Postgres *and* R2. 10 clips in the live DB were
  marked `edited` while only 3 carried an edit payload. Both sides now
  deep-compare first. `updateClipBroll` had the inverse bug (never invalidated →
  stale downloads) and now matches.
- **Caption preview ≠ export.** Presets name Montserrat/Bebas Neue/Impact/
  Oswald/Roboto/Open Sans; the worker bundles them, the browser loaded only
  Archivo. Every preset previewed in a fallback face. Fonts now load in-browser
  (Impact→Anton, mirroring the worker), `preload:false` since they are
  studio-only.
- **Clips overran their own duration.** `-t` sat before `-i` in all four ffmpeg
  builders, trimming input 0 only; overlay framesync ran to the longer input.
  Measured 30.60s output for a 20s clip → now exactly 20.000000s.
- Music `amix` ducked dialogue ~6 dB (no `normalize=0`); `music.startOffsetSec`
  was persisted but never read; B-roll download was unbounded and untimed
  (OOM + SSRF); detection could emit sub-3s clips (1.43s and 2.79s observed).

_Performance (measured, not estimated):_
| Change | Before | After |
| --- | --- | --- |
| Studio preview asset | 531 MB – 1.1 GB @ 4K | **1.06 MB @ 540p** proxy |
| Face detection (YuNet) | 8.37 s | **1.84 s** |
| yt-dlp import | 2.16 GB | **264 MB** (1080p cap) |
| Free-tier render | 3.76 s (two passes) | **1.17 s** (one) |
| B-roll render CPU | 22.03 s user | **9.20 s** |

Also: STT hands AssemblyAI a presigned R2 URL instead of download→transcode→
upload; the poll loop is split into I/O and render queues so a long render no
longer starves ingest; `callOpenAI` (the only external call with no timeout)
gained one plus bounded retry. `reasoning.effort` stays `medium` — `low`
benchmarked 46% faster but showed weaker story-completeness, a bad trade at ~1%
of end-to-end wall clock.

_Cost:_ source media was **never deleted** — no `deleteProject` existed anywhere
and `deleteObject` was only ever called for render outputs, so every source-hour
added ~2.65 GB permanently. Against this repo's own pricing (Pro $24/1800 min =
$0.80 revenue per source-hour) a fully-used seat trends gross-margin-negative
from storage alone between month 12 and 24. Added self-serve project deletion
plus `SOURCE_RETENTION_DAYS` / `WORKFLOW_EVENT_RETENTION_DAYS` purges wired into
the reap tick.

_UX:_ failed projects showed a generic error with no retry despite the cause
being persisted and actionable — now specific copy plus a capped **Retry
ingest**; the Activity tab ignored 124 stored `WorkflowEvent` rows and now
renders full history; clip cards showed a 400px "not rendered" box instead of a
preview; free-tier 720p/watermark is disclosed in-app, not only on marketing.

_B-roll:_ rebuilt from one keyword-derived cutaway to LLM-cued multi-cutaway
placement with caching, attribution, retry/backoff, and a fixed 1:1 orientation
mapping. Cues are persisted (`Clip.brollCues`) and degrade to keyword queries
when absent or malformed.

**Follow-up pass — also landed.** Everything listed as a known follow-up above is
now done, and running the worker for real surfaced a much larger bug underneath.

- **R2 uploads were broken for most file sizes.** Both the single-PUT and the
  multipart paths streamed a Node `ReadStream`, which the AWS SDK wraps in
  aws-chunked framing for its default integrity checksum — R2 rejects that, and a
  consumed stream can't be replayed, so the SDK's retry masked the cause. Single
  PUT failed with _"You did not provide the number of bytes specified by the
  Content-Length HTTP header"_; multipart failed with _"The socket connection was
  closed unexpectedly"_ — **the exact error that was killing link imports**, and
  the original symptom that started this audit. Both now send buffers, verified
  byte-exact at 1.5 MB and 50 MB. A 15-byte file slipped through the old path,
  which is why it stayed hidden.
- **Preview proxies no longer download the source.** They pulled the whole
  531 MB - 1.1 GB object before cutting a ~30s window, on the I/O poll loop, so
  they blocked ingest and STT for the whole download (>5 min, unfinished).
  ffmpeg now range-reads a presigned URL: **11.7s** for a 38s cut, and a real
  3-clip batch end to end in **62.7s**.
- **Audio-only sources get previews.** Podcast sources were skipped entirely.
  Cover-art detection is explicit — an MP3 with embedded artwork presents a video
  stream, and the naive check made ffmpeg fail outright (exit 234), so those
  clips would have retried forever.
- **Retry policy**: `WorkflowRun.attemptCount` added; transient failures requeue
  under a cap with exponential backoff derived from `attemptCount` + `updatedAt`
  (no `nextAttemptAt` column needed); both reapers requeue rather than fail.
- **`AutopilotEpisode.projectId`** gained a `SET NULL` foreign key.
- **Timeline thumbnails** read the proxy instead of opening a second full-source
  reader; zoom no longer invalidates the strip cache, a missed `seeked` no longer
  deadlocks the queue, and the canvas cache is released on unmount.
- **Purge guard**: preview proxies are cut lazily from the source, so purging
  first stranded clips on "Preview generating…" forever. Observed for real —
  three projects were purged on a first worker boot before any proxy existed. A
  source is no longer eligible while any clip still needs one.

Suite: **433 tests**, typecheck 10/10, `biome check` clean across 332 files.

**External review pass — also landed.** The work above was then reviewed
independently by **codex (`gpt-5.6-sol`, high reasoning)** for correctness and
optimization, and by **Fable** for UI/UX. Full write-up in
`plans/2026-07-audit/07-external-review.md`.

codex confirmed the ffmpeg duration fix, the `previewStartSec` mapping, the
`JSON.stringify` invalidation comparison, `Buffer.allocUnsafe`, and the 16 MB
part size are all correct — then found real production-grade races. Fixed:

- **The losing worker deleted the winning worker's preview object.** All workers
  uploaded to one deterministic key and claimed afterwards, so the loser's
  cleanup deleted the object the winning row pointed at. Keys are now
  per-attempt; verified end to end against R2.
- **Previews blocked ingest and starved publishing** — a batch of sequential
  ffmpeg cuts ran inside the I/O mutex, reintroducing the head-of-line blocking
  the poller split had removed. Previews now have their own loop.
- **Permanently broken clips poisoned the preview queue forever**; now backed
  off over a wider candidate pool.
- **The R2 fix was treating a symptom** — `requestChecksumCalculation:
  "WHEN_REQUIRED"` is the actual root cause, and a short read no longer returns
  a truncated buffer under a declared `ContentLength`.

Fable found the flagship "Preview generating…" state was a static promise with
no reactive path — the UI told the truth once, then stopped listening. Clip
cards now carry a `hasPreview` signal and the studio polls and swaps the proxy
in live. It also caught that the caption-font fix was only half-made: the engine
asked for weights 900/600 while only 400/700 were loaded, so the two
`bold: false` presets previewed bold and burned at regular — the same
preview-vs-export gap that fix was meant to close. Plus a light-mode studio
contrast failure (~3.2:1, now 6.14:1 via a mode-invariant `studio.danger`).

Suite: **447 tests** (`packages/ui`'s test script was a no-op echo and is now
wired, so its contrast tests actually run).

Still open — see `07-external-review.md` for the full design of each. Six need a
schema change and were deliberately **not** half-implemented: claim lease/attempt
ownership (a reaped worker can complete a newer attempt); a `deleting` project
state to close the deletion TOCTOU; immutable generation-scoped render keys;
clearing a preview when boundaries move beyond its padding; a cutoff filter and
ordering on the source-purge query; and explicit retryability at the error
boundary. Smaller items: orphaned preview objects need a sweeper, preview
backoff is in-process only, audiogram previews use the default waveform colour,
`buildFreeTierPostProcessArgs` is retained but unused, the Chakra/Emotion SSR
hydration mismatch is still live, and the 20 competitor recommendations in
`plans/2026-07-audit/02-competitor-teardown.md` remain unimplemented.

### Phase 1 — Table-stakes parity gaps (do first)
1. **Auto-reframe / active-speaker tracking** — **[TS] medium.** ✅ v1 shipped: YuNet face detection (CPU, MIT) → smoothed FFmpeg `sendcmd` crop following the dominant speaker, landscape→vertical. **Remaining:** multi-speaker active-speaker selection (LR-ASD, MIT, gated to ≥2 faces) + scene-cut reset; 3+ speaker layouts are a Phase-3 moat.
2. **Stock B-roll auto-insertion** — **[TS] cheap–medium.** ✅ Shipped: Pexels video search → cover-fit FFmpeg overlay cutaway burned into the render (gated on `PEXELS_API_KEY`, graceful fallback), **plus an interactive studio picker** — live `GET /broll/search`, thumbnail grid, click-to-apply, persisted per clip (`Clip.brollUrl`, the render prefers it over auto). **Remaining:** LLM-cued semantic placement (keyword + timestamp per moment); optional Pixabay secondary source. ⚠️ Needs `prisma migrate deploy` (adds `Clip.brollUrl`).
3. **Emoji captions + richer animated preset library** — **[TS] cheap.** ✅ Emoji captions shipped (shared keyword→emoji map, preview == burn-in, Noto Color Emoji bundled, per-preset toggle). **Remaining (optional):** more creator-style animated caption presets.
4. **Brand kit finish** — **[TS] cheap.** Already in progress; complete intro/outro + apply-per-clip + the studio brand panel.
5. **Direct social posting + scheduling** — **[TS] medium.** ✅ Shipped: connected social accounts, native OAuth start/callback flows, account-targeted scheduling UI, and worker-side TikTok / YouTube Shorts / Instagram Reels / LinkedIn / X publishing clients. Legacy publisher webhook remains as fallback for posts without an account. **Remaining:** automatic provider metric fetchers and provider review/approval in each deployment.
6. **Usage quotas + Stripe billing** — **[TS] medium.** ✅ Shipped: quota enforcement (processing-minutes + per-upload length cap, dashboard usage bar) **and** Stripe billing — checkout + customer portal + signed webhooks that map price→tier and set `User.pricingTier`, wired to the `/settings/billing` page and dashboard upgrade CTAs. Env-driven price ids; integrates with the quota gate automatically. Pricing in §5.

### Phase 2 — Cheap, high-leverage differentiators
7. **Content-suite repurposing** — **[DIFF] cheap.** ✅ Shipped: blog post + X thread + LinkedIn post + show notes + quote cards from the transcript (gpt-5.4-mini), stored per project, "Repurpose" panel with copy/regenerate. **Remaining (optional):** carousel slides + audiograms (FFmpeg waveform over a still).
8. **Translated subtitles → AI dubbing** — **[DIFF→TS] cheap→medium.** ✅ Basic voiceover dubbing shipped: transcript translation + OpenAI TTS + FFmpeg audio replacement + R2 audio/video assets. **Remaining:** translated timed captions, segment-level duration alignment, lip sync, speaker cloning, and per-speaker voice assignment.
9. **Feed-driven autopilot + native MCP server** — **[DIFF] medium.** ✅ RSS feed autopilot shipped with episode dedupe and saved generation settings; ✅ native stdio MCP server shipped for project and autopilot tools. **Remaining:** YouTube channel watcher and MCP tools for fine-grained studio edits.
10. **AI chat copilot in the studio** — **[DIFF] medium.** "Remove filler", "add a zoom at 0:12", "make captions bigger" acting on real studio actions.

### Phase 3 — Later / heavier
11. Performance analytics — first-party render/download/schedule analytics and platform metric ingestion shipped. Remaining: native OAuth fetchers that pull platform metrics automatically rather than receiving them from publisher integrations.
12. 3+ speaker multi-layout reframing (a real moat; even leaders fail here) — expensive.
13. Generative B-roll (Veo 3.1 / Kling) — medium.
14. Mobile app — expensive.

---

## 5. Pricing & quota model (recommended)

**Metric: processing minutes / month** (1 credit = 1 minute of *source* video),
plus a per-tier max-upload-length cap to bound worst-case render cost.

| | Free | Starter | Creator | Pro |
| --- | --- | --- | --- | --- |
| Monthly | $0 | **$7** | **$12** | **$24** |
| Annual (eff.) | $0 | **$5** | **$8** | **$16** |
| Minutes / mo | 60 | 300 (5 hr) | 600 (10 hr) | 1,800 (30 hr) |
| Watermark | Yes | No | No | No |
| Quality | 720p | 1080p | 1080p | 1080p (+4K opt.) |
| Max upload | 30 min | 60 min | 90 min | 3 hr |
| Storage | 3 days | 30 days | 30 days | While subscribed |

Dubbing is gated to Pro; content-suite repurposing is gated to Creator and above
(both enforced in the quota/entitlement gate). Gate the cost-heavier
differentiators (4K, generative B-roll) to Pro / add-ons. Watermark removal is
the #1 proven conversion lever across the category. Positioning: _"More
minutes, no watermark, for less — the honest clipping tool."_
