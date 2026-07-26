# Narriflow B-roll — end-to-end audit

Date: 2026-07-26 · Branch: `murtaza/assembly-ai` · Read-only audit, no files modified.

Everything below is verified against source. The FFmpeg behaviour in §3 was verified
empirically by running the real filter graph through `ffmpeg 8.0.1` (see §3.1).

---

## 0. Component map

| Piece | File |
| --- | --- |
| Worker auto-selection (query, placement, file pick, Pexels search) | `/Users/murtaza/Documents/dev/narriflow/apps/worker/src/tasks/broll.ts` |
| Worker orchestration + download | `/Users/murtaza/Documents/dev/narriflow/apps/worker/src/tasks/render-clips.ts:1797-1868` |
| FFmpeg composite | `/Users/murtaza/Documents/dev/narriflow/apps/worker/src/tasks/render-clips.ts:1000-1125` |
| Download helper | `/Users/murtaza/Documents/dev/narriflow/apps/worker/src/tasks/render-clips.ts:1127-1141` |
| Web-side Pexels search service | `/Users/murtaza/Documents/dev/narriflow/packages/services/src/pexels.service.ts` |
| API `GET /broll/search` | `/Users/murtaza/Documents/dev/narriflow/apps/web/app/api/[[...route]]/route.ts:1027-1055` |
| API `PATCH /projects/:id/clips/:clipId` (brollUrl) | `/Users/murtaza/Documents/dev/narriflow/apps/web/app/api/[[...route]]/route.ts:772-781` |
| Persistence | `/Users/murtaza/Documents/dev/narriflow/packages/services/src/clip.service.ts:855-881` |
| Studio panel | `/Users/murtaza/Documents/dev/narriflow/apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/tool-panels/broll-panel.tsx` |
| Schemas | `/Users/murtaza/Documents/dev/narriflow/packages/validators/src/clip.ts:130-138`, `:176` |
| DB | `/Users/murtaza/Documents/dev/narriflow/packages/db/prisma/schema.prisma:559`, migration `packages/db/prisma/migrations/20260502120000_clip_broll_url/migration.sql` |
| Tests | `apps/worker/src/tasks/broll.test.ts`, `apps/worker/src/tasks/render-clips.test.ts:203-227`, `packages/services/src/pexels.service.test.ts` |

Repo hygiene note: `apps/worker/src/tasks/broll.ts`, `packages/services/src/pexels.service.ts`
and the entire `20260502120000_clip_broll_url/` migration directory are **untracked** in git
(`git status --porcelain` → `??`), while `schema.prisma` (which already declares `brollUrl`)
is modified-but-uncommitted. Shipping `schema.prisma` without the migration file would break
`prisma migrate deploy`. **P1 / release hygiene.**

---

## 1. How is b-roll selected?

### 1.1 Query derivation — no LLM anywhere

`brollQueryForClip()` — `apps/worker/src/tasks/broll.ts:49-64`:

```ts
const source = (title && title.trim()) || (hookText && hookText.trim()) || "";
const words = source.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/)
  .filter((w) => w.length > 2 && !STOPWORDS.has(w));
return words.slice(0, 3).join(" ");
```

- Source: `clip.title` first, `clip.hookText` as fallback (`render-clips.ts:1829`).
- Transform: lowercase → strip non-alphanumerics → drop words ≤ 2 chars → drop a
  hardcoded 60-word stopword list (`broll.ts:34-42`) → **take the first 3 surviving words
  in original order** (not by frequency, not by salience).
- **No LLM is involved at any point.** Verified: `grep -rn "broll" packages/services/src apps/worker/src | grep -i "llm\|openai\|anthropic\|prompt"` → no matches. The transcript, the `transcriptSlice`, `payoffText`, `category` and the virality sub-scores are all available on the clip and all unused.

### 1.2 The actual query string, and how good it is

Final URL (`broll.ts:120-122`):

```
https://api.pexels.com/videos/search?query=<3 words>&orientation=portrait|landscape&per_page=10&size=medium
```

Quality assessment (verified against the unit tests at `broll.test.ts:10-27`, which
encode the intended behaviour):

| Clip title | Query sent to Pexels | Verdict |
| --- | --- | --- |
| "How to scale a SaaS startup" | `scale saas startup` | passable |
| "The future of remote teams" | `future remote teams` | passable |
| "Why nobody talks about burnout in med school" | `nobody talks burnout` | **bad** — "nobody"/"talks" are noise; the visual concept ("med school", "burnout") is truncated away by `slice(0,3)` |
| "I lost $2M and here's what happened" | `lost here happened` | **bad** — `$2M` is stripped by the alphanumeric filter, "lost/here/happened" are visually meaningless |
| "3 mistakes killing your ads" | `mistakes killing your ads` → `mistakes killing ads` | **bad** — matches literal violence/knife stock footage |

Structural problems:
1. **Positional truncation, not semantic ranking.** `slice(0, 3)` keeps the *first* three surviving words, which in English hooks are usually function-adjacent filler, not the noun the viewer should see.
2. **Titles are hooks, not visual descriptions.** A hook ("You're doing this wrong") has no visual referent; a b-roll query needs a *depicted subject* ("person typing laptop office"). There is no translation step.
3. **The stopword list is not a concept extractor.** Words like "nobody", "talks", "mistakes", "killing", "money" survive and dominate the Pexels relevance ranking.
4. **One query per clip, one asset per clip.** No fallback query, no query broadening on zero results.
5. **Studio/worker query divergence.** The studio panel seeds its search box from `clipInfo.title`, but `studio/page.tsx:108` sets `title: clip.hookText` — so the panel's default query is derived from the hook while the worker's is derived from `clip.title`. The user sees different suggestions than what auto-render would pick.

### 1.3 Zero results / rate limits / missing key

All three collapse into the same silent path:

| Condition | Behaviour | Evidence |
| --- | --- | --- |
| `PEXELS_API_KEY` unset (worker) | `searchPexelsVideos` returns `[]` immediately; `brollEnabled` is false so the block is skipped entirely; render proceeds without b-roll | `broll.ts:117-118`, `render-clips.ts:1800-1801` |
| `PEXELS_API_KEY` unset (web) | `GET /broll/search` returns `200 {configured:false, results:[]}`; panel shows "Stock B-roll search isn't available on your workspace yet." | `route.ts:1039-1041`, `broll-panel.tsx:265-266` |
| HTTP 429 (Pexels rate limit) | `if (!res.ok) return []` — **indistinguishable from "no results"**, no log, no retry, no backoff, no `Retry-After` handling | `broll.ts:126`, `pexels.service.ts:69` |
| Network error / timeout | `catch { return [] }` — **no timeout is set at all**, so a hung Pexels connection blocks the render loop indefinitely | `broll.ts:129-131`, `pexels.service.ts:86-88` |
| Zero results | `selectBrollClip` returns `null` → `downloadUrl` stays null → no b-roll | `broll.ts:165`, `render-clips.ts:1840-1843` |
| No file ≥ target width | `pickBrollFile` falls back to the **largest** available file — can be a 4K asset | `broll.ts:106` |

**F1.1 — P1 — Pexels failures are indistinguishable and untelemetered.**
Failure: Pexels rate-limits the account (free tier is a low hourly cap; the worker issues
*one search per clip per render run*, so a single 20-clip project burns 20 calls). Every
clip silently renders without b-roll and nothing in the logs says why. Support cannot
diagnose "b-roll stopped working".
Fix: distinguish `res.status === 429` from other failures, `log("warn", "broll_search_rate_limited", {...})`, add `AbortSignal.timeout(8000)` to both fetches, and add an in-process/Redis circuit breaker so one 429 short-circuits the rest of the run instead of issuing 19 more doomed calls.

**F1.2 — P1 — Query derivation has no semantic step.**
Failure: shipped clips get b-roll that is visually unrelated or actively wrong
("mistakes killing ads" → knife/violence stock). This is the single biggest *quality*
gap versus competitors and it is user-visible in the exported MP4.
Fix: the clip-detection LLM call already runs over the transcript and already returns
structured JSON. Extend that schema with `brollCues: [{ atSec, query }]` (2–4 entries,
query = a *depicted-subject* noun phrase). Zero extra LLM calls, zero extra cost. Fall
back to the current keyword extractor when the field is absent.

---

## 2. How is placement decided?

`planBrollWindow()` — `apps/worker/src/tasks/broll.ts:70-84`:

```ts
const minClipSec = 12;
const cutawaySec = 3.5;
if (clipDurationSec < minClipSec || brollDurationSec <= 0) return null;
const start  = Math.max(4, Math.min(clipDurationSec * 0.28, clipDurationSec - 6));
const maxLen = Math.min(cutawaySec, brollDurationSec, clipDurationSec - start - 3);
if (maxLen < 1.2) return null;
return { startSec: start, endSec: start + maxLen };
```

| Question | Answer |
| --- | --- |
| How many cutaways per clip? | **Exactly one, always.** `BrollPlan` is a single `{path, window}` (`render-clips.ts:49`, `1799`). |
| Start time | `max(4, min(0.28·d, d−6))` — a pure function of clip duration. |
| Duration | `min(3.5, brollDuration, d − start − 3)`, hard-capped at 3.5 s. |
| Gap rules | N/A — there is only one cutaway, so no inter-cutaway spacing logic exists. |
| Avoids the speaker's face? | **No.** `overlay=0:0` over a full-frame `scale=W:H` b-roll (`render-clips.ts:1042-1043`) — the speaker is **100% replaced** for the whole window. This is a full cutaway, not a PIP/split-screen. |
| Avoids the captions? | **Yes, by z-order.** The subtitle filter is applied to `[comp]` *after* the overlay (`render-clips.ts:1055-1058`), so burned captions sit on top of the b-roll. Logo likewise (`:1059-1064`). |
| Deterministic? | **Within a run, yes** (pure arithmetic on `clipDurationSec`, and `Array.sort` is stable so Pexels relevance order is preserved in `selectBrollClip`, `broll.ts:145-151`). **Across runs, no** — every re-render re-queries Pexels live, so a re-render of the same clip can composite a *different* asset. |
| Overlays during the hook? | **Yes, for short clips.** For `d = 12–14 s`, `start` clamps to exactly **4.0 s** and the cutaway runs to 7.5 s. On a 12 s clip that is 29 % of the runtime, starting inside the window most creators treat as the hook. |
| Runs to the end? | **The *plan* never does** — `maxLen ≤ d − start − 3` guarantees a ≥3 s tail. **The *render* does** — see F3.1 below, where the output video overruns the clip end entirely. |

Additional placement defects:

**F2.1 — P1 — User picks are placed with a fabricated duration.**
`render-clips.ts:1811` hardcodes `let brollDurationSec = 6;` and that value is only
overwritten on the *auto* path (`:1842`). A studio-picked URL is never probed
(`ffprobe` is available and already used for the source at `:1670`). So `planBrollWindow`
plans against a fictional 6 s regardless of whether the user picked a 2 s or a 45 s asset.
Combined with F3.1 this is the trigger for the worst-case overrun.
Fix: `ffprobe` the downloaded b-roll before planning (the download already happens at
`:1852`, just reorder: download → probe → plan), or clamp the window with a filter-level
`trim`.

**F2.2 — P1 — A single 3.5 s cutaway is below category baseline.**
Competitors place 3–8 cutaways across a 60 s clip. One 3.5 s insert reads as an accident
rather than a feature, and on a 60 s clip it covers under 6 % of runtime.
Fix: with LLM cues from F1.2, place N cutaways with a `minGapSec` (≈6 s) and a
`maxCoverageRatio` (≈25 % of clip runtime), skipping the first 3 s and last 2 s.

**F2.3 — P2 — Cutaways can land inside the hook on short clips.**
`Math.max(4, ...)` sets a 4 s floor, but 4 s is *inside* the hook for a 12–15 s clip.
Fix: make the floor proportional — `Math.max(Math.min(5, d * 0.30), 4)` — or simply
skip b-roll below ~20 s where a cutaway costs more than it adds.

**F2.4 — P2 — A picked b-roll is silently dropped on clips under 12 s.**
`render-clips.ts:1808` gates the whole block on `clipDurationSec >= 12`, including the
explicit user-pick path. The studio shows a green "B-roll applied to this clip" banner
(`broll-panel.tsx:236-238`) and the export contains no b-roll, with no log line and no
user-facing message.
Fix: either honour user picks below 12 s (shorten the cutaway) or disable/annotate the
panel when `clipInfo.duration < 12`.

---

## 3. FFmpeg compositing

### 3.1 The exact graph

`buildBrollVideoArgs` — `render-clips.ts:1000-1125`. Arguments, in order:

```
-y -ss <clipStart> -t <clipDuration> -i <source> -i <broll> [-i <logo>] [-stream_loop -1 -i <music>]
-filter_complex
  [0:v]<cropScale>[base];
  [1:v]scale=W:H:force_original_aspect_ratio=increase,crop=W:H,setpts=PTS-STARTPTS+<start>/TB,format=yuv420p[broll];
  [base][broll]overlay=0:0:enable='between(t,<start>,<end>)'[comp];
  [ <textlayers> ][ <subtitles/ass> ][ <logo overlay> ][ <transition fade> ]
-map <final>
-map 0:a:0?  -c:a aac -b:a 128k          # (or -map [outa] ... -shortest when music is present)
-c:v libx264 -preset medium -crf 23 -movflags +faststart -max_muxing_queue_size 1024 <out>
```

Assessment of each requested dimension:

| Dimension | Finding |
| --- | --- |
| **Scale/crop mode** | ✅ Correct cover-fit: `scale=W:H:force_original_aspect_ratio=increase,crop=W:H` (`:1042`) — upscales to cover then centre-crops. No letterbox, no squash. |
| **B-roll audio** | ✅ **Muted — not a P0.** Only `0:a:0?` is mapped (`:1105`); stream `1:a` is never referenced. Verified empirically: the output had exactly one audio stream at the source's duration. The music branch maps `[outa]` which is built from `0:a` + the music input only (`buildMusicAudioFilter`). |
| **Transitions in/out** | ❌ **Hard cut both directions.** `enable='between(t,s,e)'` is a binary gate — no fade, dip-to-black, or crossfade. The `appendTransitionFilter` call at `:1066` is the *clip-level* fade in/out, unrelated to the cutaway. |
| **Z-order vs captions/logo** | ✅ Correct. Order is base → b-roll → text layers → subtitles → logo → clip transition (`:1046-1072`). Captions and logo always draw on top. |
| **Aspect ratios 9:16 / 1:1 / 16:9 / 4:5** | ⚠️ Geometrically correct for all four (`W`,`H` come from `aspectRatioConfig`, `:1023`), but the **source asset is fetched for the wrong orientation** in mixed-ratio projects — see F3.2. |
| **CPU cost** | ❌ Measured **+52 % wall / +67 % CPU** versus the same render without b-roll, for a 3.5 s cutaway — see F3.3. |

### 3.1a Empirical verification

Ran the literal production graph against synthetic fixtures (`ffmpeg 8.0.1`, `libx264 -preset medium -crf 23`, 1080×1920 output, 20 s source with audio):

| Case | b-roll length | Output duration | Wall / CPU |
| --- | --- | --- | --- |
| A — no b-roll (`buildSingleVideoArgs` shape) | — | **20.00 s** ✅ | 2.35 s / 10.96 s |
| B — **current** `buildBrollVideoArgs` graph | 25 s | **30.60 s** ❌ | 3.58 s / 18.32 s |
| B′ — same graph, b-roll 5 s | 5 s | 20.00 s ✅ | — |
| B″ — same graph + `-shortest` (the music branch) | 25 s | 20.00 s ✅ | — |
| C — proposed fix: `-t 3.5` on input 1 **and** output `-t 20` | 25 s | **20.00 s** ✅ | 2.30 s / 11.17 s |

Output stream detail for case B: `video duration=30.600000`, `audio duration=20.000000`.

### 3.2 Findings

**F3.1 — P0 — Rendered clips overrun their own end with a frozen, silent tail.**

`buildBrollVideoArgs` puts `-t <duration>` **before `-i <source>`** (`:1078-1081`), i.e. it is
an *input* option that trims input 0 only. Input 1 (the b-roll) is untrimmed, and there is
**no output `-t`** and **no `-shortest`** on the non-music branch (`:1104-1108`).

FFmpeg's `overlay` filter sets `in[1].after = EXT_INFINITY` under the default
`eof_action=repeat`, so the framesync keeps producing frames until *both* inputs are
exhausted. Because `setpts=PTS-STARTPTS+start/TB` pushes the b-roll's last frame to
`start + brollDuration`, the output video length becomes:

```
max(clipDuration, brollStart + brollDuration)
```

Verified: 20 s clip + 25 s b-roll starting at 5.6 s → **30.6 s output**, the last 10.6 s being
the source's frozen final frame over silence.

Trigger condition: `brollDuration > clipDuration − brollStart`, i.e. roughly
`brollDuration > 0.72 × clipDuration`. Pexels `size=medium` assets are commonly 10–30 s, so
this fires on **most short clips** (12–30 s), which is the dominant output length. It is
masked only when background music is set, because that branch adds `-shortest` (`:1103`).
For a studio-picked URL the fabricated `brollDurationSec = 6` (F2.1) means the plan has no
idea how bad the overrun will be — a user pasting a 3-minute stock URL gets a
`4 + 180 = 184 s` "clip".

Failure scenario: a creator exports a 20 s TikTok, downloads it, and gets a 30 s file with
a 10 s frozen frame and dead audio at the end. Platform auto-play loops on the freeze.
The clip's stored `durationSec` metadata no longer matches the asset.

Fix (one line each, both verified above as case C):
1. Trim the b-roll input: insert `"-t", String(window.endSec - window.startSec)` immediately before `"-i", params.brollPath` at `render-clips.ts:1082-1083`. Ideally also `-ss` into the asset so the cutaway isn't always the first N seconds.
2. Belt-and-braces: append an output `-t String(params.endSec - params.startSec)` in the arg tail at `:1110`, or add `-shortest` unconditionally rather than only on the music branch.

Add a regression test next to `render-clips.test.ts:203` asserting the b-roll input carries a `-t` and that an output duration cap is present.

**F3.2 — P1 — Wrong-orientation stock in mixed-aspect projects, and in the studio.**

`render-clips.ts:1831-1835` picks **one** orientation for the whole clip by majority vote:

```ts
const portraitCount = outputs.filter((o) => o.aspectRatio === "9:16" || o.aspectRatio === "4:5").length;
const orientation = portraitCount >= outputs.length / 2 ? "portrait" : "landscape";
```

- A project rendering both 9:16 and 16:9 gets *one* asset; whichever ratio loses the vote gets a stock clip centre-cropped across orientations, discarding ~70 % of the frame (a landscape asset cropped to 9:16, or vice versa).
- `1:1` is counted as neither, so a square-only project resolves to `landscape` (`0 >= 0.5` is false) and gets a 16:9 asset cropped to square. Pexels supports `orientation=square` and `pexels.service.ts:57` already accepts it — the worker just never asks for it.
- The studio picker searches with the *currently previewed* aspect ratio (`broll-panel.tsx:28-33`) but persists a single `brollUrl` used for **every** render variant, so the same mismatch occurs.

Fix: search per output orientation (cache by `query+orientation`), or store `brollUrl` per aspect ratio. Minimum viable: add the `1:1 → square` branch and prefer the orientation of the *first* requested output rather than a majority vote.

**F3.3 — P1 — B-roll costs +67 % CPU for 3.5 s of footage, for two compounding reasons.**

Measured above: 10.96 s CPU → 18.32 s CPU on a 20 s render.

1. The untrimmed input means FFmpeg decodes, scales, crops and `format`s **the entire b-roll asset** (25 s in the test; potentially a 4K file per `broll.ts:106`) even though only 3.5 s is composited. Case C (trimmed) brought CPU back to 11.17 s — **essentially free**.
2. `render-clips.ts:1962-1966` — when a b-roll plan exists, the render **falls out of the single-pass multi-output path** (`buildMultiVideoArgs`, `:2041`) and loops per output. Rendering 9:16 + 1:1 + 16:9 becomes 3 full source decodes + 3 full b-roll decodes instead of one `split`.

Fix: (1) trim the input as in F3.1 — this alone recovers ~95 % of the overhead. (2) Longer-term, teach `buildMultiVideoArgs` to `split` the composited `[comp]` so b-roll renders keep the single-pass path.

---

## 4. Manual b-roll in the studio

Panel: `broll-panel.tsx` (rendered by `tool-sidebar.tsx:38` under the `broll` tool id).

| Capability | Status | Evidence |
| --- | --- | --- |
| Search | ✅ | `broll-panel.tsx:47-71` → `GET /api/broll/search?query=&orientation=`; auto-runs once on open seeded from the clip title (`:74-78`). |
| Preview | ⚠️ **Static thumbnail only** | `<img src={result.image}>` at `:290-299`. No video preview, no hover-scrub, no playback of the candidate. |
| Pick | ✅ | `apply()` at `:80-102` → `PATCH /api/projects/:pid/clips/:cid` body `{ brollUrl }`. |
| Position (start/duration) | ❌ **Not exposed at all** | The render always uses `planBrollWindow` defaults. No timeline lane: `timeline.tsx` contains zero `broll` references, and `TimelineSegment` (`studio-shell.tsx:51-56`) has only `{id,label,startSec,endSec}` with no type discriminator. |
| Delete | ✅ | The `X` in the applied banner (`:240-250`) → `apply(null)` → `PATCH { brollUrl: null }`. |
| Upload your own file | ❌ | Only a **paste-a-URL** field (`:184-198`, `applyCustomUrl` at `:104-125`). No file input, no R2 upload, no media library. |
| Multiple cutaways | ❌ | `Clip.brollUrl` is a single nullable `String?` (`schema.prisma:559`). |
| Shown in the studio preview | ❌ | `grep -n broll video-preview.tsx` → no matches. `brollUrl` reaches `ClipInfo` (`studio/page.tsx:114`) and is read only by the panel. The player never composites it. |

### Persistence trace (verified end to end)

`broll-panel.tsx:85-92` → `PATCH /projects/:id/clips/:clipId` → `route.ts:772-781`
→ `updateClipBrollSchema` (`validators/src/clip.ts:130-133`, `z.string().url().nullable()`)
→ `clipService.updateClipBroll` (`clip.service.ts:856-881`): `assertPublicHttpUrl(brollUrl)`
then `prisma.clip.update({ data: { brollUrl } })`
→ read back by the worker at `render-clips.ts:1804` (`clip.brollUrl`), re-validated at
`:1815`, and **preferred over auto-search** (`:1826-1828`), even when `WORKER_BROLL=0`
(`:1806`). So yes — the pick is persisted and honoured by the render.

### Findings

**F4.1 — P1 — Picking b-roll does not invalidate existing renders or mark the clip edited.**

`updateClipBroll` (`clip.service.ts:856-881`) neither deletes `clipRender` rows nor sets
`status: "edited"`. Compare `updateClipStudioEdits` (`:884-921`), which does both
(`tx.clipRender.deleteMany`, `status: "edited"`, `deleteRenderAssets`). And
`triggerClipRendering` explicitly **skips** renders already in `pending`/`rendering`
(`clip.service.ts:632-638`).

Failure scenario: a user opens an already-rendered clip, picks a b-roll, sees "B-roll
applied to this clip", navigates back to the project page, and downloads the **stale
pre-b-roll MP4**. Only if they happen to press *Export* in the studio (`studio-shell.tsx:355-372`)
does the render re-run — and even then, the pick is not part of `persistEdits()`
(`:328-337` sends caption preset, utterances and `studioEdits` only), so the b-roll write
and the export are two independent, unordered writes.

Fix: mirror `updateClipStudioEdits` — wrap in a transaction that deletes `clipRender` rows,
calls `deleteRenderAssets(staleRenderKeys)`, and sets `status: "edited"`.

**F4.2 — P1 — Persisting a raw third-party CDN URL is fragile (link rot).**

The stored `brollUrl` is whatever Pexels returned in `video_files[].link`
(`pexels.service.ts:82`). Those are signed/opaque CDN URLs on a host we do not control.
Weeks later the render fetches it once (`downloadUrlToFile`, no retry) and on a non-2xx
throws → caught by the bare `catch { brollPlan = null }` at `render-clips.ts:1863-1865`
→ **no log, no user signal**, the clip just renders without the b-roll the user chose.
Fix: on pick, mirror the asset into R2 (`putFileFromPath` / `headObject` /
`downloadObjectToFile` are all exported from `packages/services/src/r2-storage.ts`) and
store the R2 key. Also fixes §8 caching and §6 provenance in one move.

**F4.3 — P2 — The "custom URL" field is a footgun disguised as an upload.**
Users expect a file picker. What they get is a field that makes the render worker fetch an
arbitrary internet URL (see F5.1/F5.2). There is no MIME check, no duration check, and no
validation that the URL is even a video.
Fix: replace with a real upload to R2 via the existing presigned single-upload path
(`presignSingleUploadUrl`, `r2-storage.ts:378`), and keep the URL field behind an
"advanced" disclosure at most.

**F4.4 — P2 — Dead code suggesting a b-roll timeline lane was planned.**
`TranscriptItem.type: "speech" | "broll"` (`studio-shell.tsx:44`) — the `"broll"` variant is
never constructed; `derivedTranscript` hardcodes `type: "speech" as const` (`:178`).
Fix: either build the lane (see §7) or drop the variant so it stops implying capability.

---

## 5. Failure modes

The single choke point is `downloadUrlToFile` — `render-clips.ts:1127-1141`:

```ts
async function downloadUrlToFile(url, filePath, errorCode = "remote_media_download_failed") {
  const res = await fetch(url);
  if (!res.ok) throw new WorkflowWorkerError(errorCode, `...status ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  await writeFile(filePath, buffer);
}
```

| Concern | Status |
| --- | --- |
| Download timeout | ❌ **None.** No `AbortSignal`, no `signal:`. A slowloris host hangs the render worker forever; the only recovery is the stall reaper (`WORKER_REAP_STALL_TIMEOUT_MS`, default 30 min per README:213), which fails the **entire** workflow run. |
| Size limit | ❌ **None.** `await res.arrayBuffer()` buffers the whole body in RSS before touching disk. |
| Content-type / magic-byte check | ❌ None. |
| SSRF guard | ⚠️ **Partial and bypassable** — see F5.2. |
| Redirect validation | ❌ **None.** `fetch` defaults to `redirect: "follow"`. |
| Retries | ❌ None, on any path (search or download). |
| Disk cleanup | ✅ `tempDir` is `mkdtemp`'d at `render-clips.ts:1540` and `rm(tempDir, {recursive:true, force:true})` in the `finally` at `:2147-2148`. ⚠️ But every clip's b-roll is written to the **shared run tempdir** as `broll-<clipId>.mp4` (`:1850`) and nothing is deleted until the whole run ends — a 20-clip run holds 20 assets + the source + all outputs simultaneously. |
| Download fails mid-render | ✅ **Correct** — `catch { brollPlan = null }` (`:1863-1865`), the render continues without b-roll. ⚠️ But with **zero logging** (contrast the music path at `:1895-1902`, which logs `clip_music_download_failed`), and `error-messages.ts:50`'s `broll_download_failed` copy is unreachable dead code because the error never propagates. |

**F5.1 — P0 — Unbounded, untimed download of a user-supplied URL can OOM/hang the render worker.**

`Buffer.from(await res.arrayBuffer())` with no `content-length` check and no byte cap.
Failure scenario: a user pastes `https://<anything>/huge.bin` into the custom-URL field
(`broll-panel.tsx:184-198`). The worker allocates the whole body in memory. A multi-GB
response OOM-kills the Bun process; **every clip in that run and any concurrently claimed
run dies**, recovered only by the reaper. A slow-drip response instead pins a worker slot
for 30 minutes. One user, one paste, one worker down.

The codebase **already has every primitive to fix this**, unused on this path:
`guardedFetch` (`packages/services/src/url-guard.ts:302-370` — manual per-hop redirect
validation, `AbortSignal.timeout`, 15 s default), `assertResponseContentLength` (`:372`),
`readResponseBodyBounded` (`:388`), `createByteLimitTransform` (`:452`).

Fix: rewrite `downloadUrlToFile` as
`guardedFetch(url, {timeoutMs}) → assertResponseContentLength(res, MAX) → stream via
createByteLimitTransform(MAX) into createWriteStream(filePath)`.
Suggested `MAX_BROLL_BYTES = 150 * 1024 * 1024`. Note the same helper is used for the
music download at `:1886`, so one fix covers both.

**F5.2 — P1 — SSRF: the URL guard is structural only, and redirects are unvalidated.**

`assertPublicHttpUrl` (`url-guard.ts:242-270`) is explicitly documented as *"Performs
structural validation without network I/O"*. It only rejects `localhost`/`.local`, embedded
credentials, non-http schemes, and **IP literals**. It does **not** resolve DNS. The
resolving variant `assertPublicHttpUrlResolved` (`:273-299`) exists and is not called on
this path.

Two live bypasses against `render-clips.ts:1815` → `:1852`:
1. **DNS-based.** `https://evil.example.com/x.mp4` where `evil.example.com` A-records to `127.0.0.1` or `169.254.169.254`. The literal-IP check at `:264-267` never fires because the hostname is not an IP.
2. **Redirect-based.** A benign public URL replies `302 Location: http://169.254.169.254/latest/meta-data/...`. `fetch` follows it by default; no hop is re-validated.

Impact: blind SSRF from inside the worker's network — internal admin endpoints, cloud
metadata, side-effectful GETs, port/latency scanning. Narrow exfil is also possible: if an
internal endpoint returns something FFmpeg can decode (an image or video), it is
composited into a clip the attacker then downloads.
The same weakness applies verbatim to the studio music URL (`:1874`) and to
`clip.service.ts:863` (which validates on write with the same non-resolving function).

Fix: swap the raw `fetch` in `downloadUrlToFile` for the existing `guardedFetch`, which
already does per-hop `assertPublicHttpUrlResolved` + `redirect: "manual"` + timeout + auth
header stripping on cross-origin hops. This is a one-import change.

**F5.3 — P2 — B-roll download failure is completely silent.**
`catch { brollPlan = null; }` at `:1863-1865` swallows the error with no `log()` call, unlike
every sibling path. `error-messages.ts:50` (`broll_download_failed`) is unreachable.
Fix: `log("warn", "clip_broll_download_failed", { workflowRunId, clipId, source, message })`.

**F5.4 — P2 — Peak disk usage scales with clip count.**
Each clip's asset persists in the shared run tempdir until `finally`.
Fix: `rm(brollPath, {force:true})` at the end of each clip-group iteration, or (better)
switch to the R2 cache from F4.2/F8.1 and keep one copy per distinct asset.

---

## 6. Licensing & attribution

**What we store: nothing.** The worker's `PexelsVideo` interface
(`broll.ts:18-24`) carries `id, width, height, duration, video_files` only. The web service's
`PexelsVid` (`pexels.service.ts:25-32`) adds `image` (the thumbnail). Neither requests nor
retains the Pexels response's `user` object (photographer name + profile URL) or the video's
`url` (its page on pexels.com). `Clip.brollUrl` (`schema.prisma:559`) is a bare `String?` —
no author, no source page, no license snapshot, no fetch timestamp.

**The claim in the code is about the license, but the API has separate obligations.**
`broll.ts:2` asserts *"free, commercial-OK, no attribution required"*. That describes the
Pexels **content license**. The Pexels **API Guidelines** are a distinct agreement and
require API consumers to show a prominent link back to Pexels and to credit the
photographer/creator wherever their media is displayed. Narriflow is an API consumer
(`api.pexels.com/videos/search`) and displays the media in two places — the studio result
grid (`broll-panel.tsx:290`) and the burned-in export.

**F6.1 — P1 (legal/ToS) — No attribution data is captured, so compliance is currently impossible.**
Failure scenario: Pexels reviews the integration and revokes the API key. Because the
attribution fields were never stored, retrofitting credit for already-rendered clips is
impossible — we cannot say which asset came from which creator. There is also no record of
*which* asset went into *which* export (the auto path stores nothing at all; only the
studio-pick path leaves a URL).
Fix, in priority order:
1. Capture `video.url` and `video.user.{name,url}` in both `PexelsVideo`/`PexelsVid` and persist them alongside the asset (a small `ClipBrollAsset` row, or JSON on the clip). Do this **now** — it is cheap and unblocks everything else.
2. Add a "Video from Pexels" link in the studio panel footer, and credit the creator on the result card.
3. Have counsel confirm the current API Guidelines text before relying on the "no attribution required" comment; update `broll.ts:2` either way.

**F6.2 — P2 — Arbitrary user URLs have no provenance or rights record.**
The custom-URL field lets a user paste any video into a rendered, downloadable, publishable
export with no terms acceptance and no stored provenance. If that clip is auto-published via
the social publisher, Narriflow is the distributor.
Fix: capture an explicit "I have the rights to this media" acknowledgement, store the source
URL + timestamp, and prefer the R2-upload flow from F4.3.

---

## 7. Competitive gap

⚠️ This is the one section not verified against Narriflow source — it reflects the
capability set the category has converged on. Treat vendor specifics as directional.

Category baseline (OpusClip, Submagic, Vizard):
- Auto-placed b-roll with **multiple cutaways** per clip, timed to transcript semantics rather than a fixed percentage.
- **AI-generated** b-roll (text-to-video) alongside stock, for concepts with no good stock match.
- **Multiple stock sources** (Pexels + Pixabay + Storyblocks/Giphy) so a miss on one is covered by another.
- **User uploads** and a persistent per-workspace **media library**.
- A dedicated **b-roll lane on the timeline** with drag-to-move, trim handles, and per-cutaway swap.
- **Live preview** of the cutaway in the editor before export.

Top 6 gaps, ranked by impact on perceived product quality:

| # | Gap | Narriflow today (evidence) | Why it matters |
| --- | --- | --- | --- |
| 1 | **Only one 3.5 s cutaway per clip** | `BrollPlan` is a single window; `cutawaySec = 3.5`, `render-clips.ts:1799`, `broll.ts:76` | A lone insert reads as noise. Competitors' clips *look* produced because b-roll recurs. |
| 2 | **No semantic/LLM placement** | Stopword strip + `slice(0,3)`, `broll.ts:56-63`; no LLM anywhere in the path | The single biggest quality delta. Wrong-subject b-roll is worse than none. The clip-detection LLM call is already there and free to extend. |
| 3 | **No b-roll timeline lane and no preview** | `timeline.tsx` has zero `broll` refs; `video-preview.tsx` has zero `broll` refs; `TimelineSegment` has no type field | Users cannot see, move, trim, or trust the cutaway. Every export is a blind guess. |
| 4 | **No real user upload / media library** | Paste-a-URL only, `broll-panel.tsx:184-198`; no upload route, no library model | Brand/product footage — the highest-value b-roll — cannot be used at all. |
| 5 | **Single stock source, no AI generation** | `PEXELS_VIDEO_SEARCH_URL` is the only provider; `grep -i "pixabay\|unsplash\|storyblocks\|giphy"` → no matches | Niche verticals (B2B SaaS, finance, medical) get near-zero usable Pexels results, so the feature silently no-ops for them. |
| 6 | **Hard cuts, no transition or motion** | `overlay=...enable='between(...)'`, `render-clips.ts:1043` — binary gate, no fade, no Ken Burns/zoom | Even correct b-roll looks cheap. A 0.2 s crossfade plus a slow push-in is ~2 filter changes and closes most of the perceptual gap. |

Honourable mentions: no per-project or per-user b-roll toggle (only the global
`WORKER_BROLL` env kill switch at `render-clips.ts:1801`, which is undocumented in both
`apps/worker/.env.example` and `README.md`); no b-roll intensity slider (light/medium/heavy);
no "regenerate b-roll" action.

---

## 8. Cost & performance

### Bandwidth per render

- **API calls:** 1 Pexels search per clip per render run (`render-clips.ts:1838`). A 20-clip project = 20 searches. There is **no global budget or circuit breaker** — the only limiter is a per-user web rate limit of 60 searches/60 s on the *studio* endpoint (`route.ts:1031`), which does not cover the worker at all. Pexels' free tier hourly cap is easy to exhaust with a handful of concurrent projects, and when it trips the failure is invisible (F1.1).
- **Asset download:** `pickBrollFile` targets `targetWidth = 1080` (portrait) or `1920` (landscape) and falls back to the **largest** file when nothing reaches the target (`broll.ts:101-106`). Typical Pexels `size=medium` h264 files at those widths run ~5–40 MB for 10–30 s. So roughly **5–40 MB per clip**, **100–800 MB per 20-clip run**, all discarded when `tempDir` is removed.
- Egress from Pexels is free to us; the cost is worker bandwidth, worker disk, and the +67 % CPU from F3.3.

### Caching — there is none, anywhere

**F8.1 — P1 — Every clip re-searches and re-downloads; nothing is cached across clips, runs, or users.**

Evidence: the path is `join(tempDir, \`broll-${clip.id}.mp4\`)` (`render-clips.ts:1850`),
inside the per-clip-group loop, with `downloadUrlToFile` called unconditionally at `:1852`.
There is no URL→file memo, no `headObject` check, no R2 lookup.

Concrete waste:
1. **Within a run:** two clips from the same video often produce overlapping 3-word queries and land on the same Pexels asset — downloaded twice, to two different paths.
2. **Across runs:** re-rendering a clip for a second aspect ratio triggers a **fresh search** (`:1838`) — so the second render may composite a *different* asset than the first (the non-determinism noted in §2), and re-downloads regardless.
3. **Across users:** the same popular query ("startup office team") is fetched from scratch for every user, forever.

Fix — R2 cache, ~30 lines, all primitives already exported from
`packages/services/src/r2-storage.ts` and already imported by the worker
(`render-clips.ts:7-14` imports `downloadObjectToFile` and `putFileFromPath`):

```
key = `cache/broll/pexels/${videoId}/${sha1(fileLink)}.mp4`
headObject(key) ? downloadObjectToFile({key, filePath}) : (guardedFetch → putFileFromPath → use)
```

Second-order wins: (a) `Clip.brollUrl` can store the stable R2 key instead of a rotting
Pexels CDN URL, fixing F4.2; (b) the auto path becomes reproducible across re-renders by
persisting the chosen key on first render; (c) attribution metadata (F6.1) has a natural
home as an R2 object tag or a sidecar row keyed by the same id; (d) Pexels API call volume
drops to one per *distinct query*, which is the difference between the free tier working
and not.

**F8.2 — P2 — Re-renders are non-deterministic.**
Because the auto path re-queries Pexels on every run and never persists what it chose, the
"same" clip re-rendered tomorrow can contain different footage. That breaks A/B comparison
and makes support reports unreproducible.
Fix: persist the resolved asset (id + R2 key) on the clip at first render and reuse it.

---

## Findings index

| ID | Sev | Title | Location |
| --- | --- | --- | --- |
| F3.1 | **P0** | Rendered clip overruns its end with a frozen silent tail when the b-roll asset is long | `render-clips.ts:1078-1084`, `:1104-1108`, `:1042-1043` |
| F5.1 | **P0** | Unbounded, untimed download of a user-supplied URL — worker OOM / 30-min hang | `render-clips.ts:1127-1141` |
| F1.1 | P1 | Pexels 429 / timeout / zero-results are indistinguishable and untelemetered; no timeout | `broll.ts:124-131`, `pexels.service.ts:67-88` |
| F1.2 | P1 | Query derivation is `slice(0,3)` of stopword-stripped title — no semantic step | `broll.ts:49-64` |
| F2.1 | P1 | User-picked b-roll is planned against a hardcoded `brollDurationSec = 6`; never probed | `render-clips.ts:1811` |
| F2.2 | P1 | Exactly one 3.5 s cutaway per clip — below category baseline | `render-clips.ts:1799`, `broll.ts:76` |
| F3.2 | P1 | Wrong-orientation stock in mixed-aspect projects; `1:1` resolves to landscape | `render-clips.ts:1831-1835` |
| F3.3 | P1 | +67 % CPU: untrimmed b-roll decode + loss of the single-pass multi-output path | measured; `render-clips.ts:1962-1966` |
| F4.1 | P1 | Picking b-roll does not invalidate renders or set `status:"edited"` → stale download | `clip.service.ts:856-881` vs `:884-921` |
| F4.2 | P1 | Persisting a raw Pexels CDN URL — link rot, silent b-roll loss on re-render | `pexels.service.ts:82`, `clip.service.ts:877` |
| F5.2 | P1 | SSRF: `assertPublicHttpUrl` does no DNS resolution; redirects unvalidated | `url-guard.ts:242-270`, `render-clips.ts:1132` |
| F6.1 | P1 | No Pexels author/source stored — API-Guidelines attribution is impossible to comply with | `broll.ts:18-24`, `pexels.service.ts:25-32`, `schema.prisma:559` |
| F8.1 | P1 | Zero caching — re-search + re-download per clip, per run, per user | `render-clips.ts:1838`, `:1850-1856` |
| — | P1 | `broll.ts`, `pexels.service.ts` and the `clip_broll_url` migration are untracked in git | `git status --porcelain` |
| F2.3 | P2 | Cutaway can land inside the hook on 12–15 s clips (4 s floor) | `broll.ts:80` |
| F2.4 | P2 | User pick silently dropped on clips < 12 s while the UI says "applied" | `render-clips.ts:1808`, `broll-panel.tsx:236` |
| F4.3 | P2 | "Custom URL" masquerades as upload; no MIME/duration validation | `broll-panel.tsx:184-198` |
| F4.4 | P2 | Dead `TranscriptItem.type === "broll"` variant implying a lane that does not exist | `studio-shell.tsx:44`, `:178` |
| F5.3 | P2 | B-roll download failure logged nowhere; `broll_download_failed` copy unreachable | `render-clips.ts:1863-1865`, `error-messages.ts:50` |
| F5.4 | P2 | Peak temp-disk scales with clip count (assets held until run end) | `render-clips.ts:1850`, `:2147` |
| F6.2 | P2 | No provenance or rights acknowledgement for user-supplied URLs | `broll-panel.tsx:104-125` |
| F8.2 | P2 | Auto b-roll is non-deterministic across re-renders | `render-clips.ts:1838` |
| — | P2 | `WORKER_BROLL` kill switch undocumented in `.env.example` and `README.md` | `render-clips.ts:1801` |

### Suggested order of work

1. **F3.1 + F5.1** (one PR, ~15 lines): add `-t` to the b-roll input and an output duration cap; rewrite `downloadUrlToFile` on top of `guardedFetch` + `createByteLimitTransform`. This also lands F5.2 and ~95 % of F3.3 for free, and is empirically verified above (case C: correct duration, CPU back to baseline).
2. **F4.1 + F6.1** (small): invalidate renders on b-roll change; capture and persist Pexels `user`/`url`.
3. **F8.1** (medium): R2 asset cache — unlocks F4.2, F8.2 and the Pexels quota problem.
4. **F1.2 + F2.2** (the product bet): LLM-cued multi-cutaway placement via the existing clip-detection call.
5. **§7 gaps 3–6**: timeline lane + preview, real upload, second stock provider, crossfade + push-in.
