# Narriflow — Live browser QA findings (main loop, authenticated session)

Environment: `http://localhost:3000`, real Chrome w/ logged-in Clerk session, user `murtazach275@gmail.com`, free tier (0/60 min).
Baseline: `bun run typecheck` = 10/10 green.

---

## B1 — P0: Studio takes 44+ seconds to show any video (measured)

**Measured**: navigating to
`/projects/5bce9b38…/clips/39f0cbe6…/studio` → `loadedmetadata` fired at **44,276 ms**,
with `buffered = 0` seconds even at that point (first *frame* is later still).
A second project (531 MB) still showed `readyState 0 / buffered 0` after ~5 minutes of
observation before eventually painting.

Root cause chain (all verified):
1. `studio/page.tsx:80-89` presigns **the full source object** and hands it to the client.
   Sources measured in this account: **531 MB, 640 MB, 819 MB, 1117 MB**;
   intrinsic resolution **3840×2160** and **3840×1920** (4K).
   The clip being edited was **1.43 s** long.
2. `video-preview.tsx:73-87` assigns that URL to `<video preload="auto">`.
3. `timeline-preview-manager.ts:84-95` creates a **second** `<video>` on the *same*
   object for thumbnail strips → two concurrent full-source readers.
4. One R2 response was captured as **HTTP 503** (Chrome network log) while
   `curl` on the same object returned 206 for 8 concurrent range reads —
   i.e. the browser's media stack is being throttled/failed under this access pattern.

**Fix**: generate a lightweight preview proxy at ingest time (e.g. 540p/720p H.264,
`+faststart`, ~0.4 Mbps) and, better, a per-clip proxy cut to the clip range.
Serve that to the studio and to clip cards. Also fixes B2 and B4.

## B2 — P0: `preload="auto"` + no error/loading/timeout state

`video-preview.tsx:73-87` registers **only** `loadedmetadata`. There is no
`error`, `stalled`, `progress` or timeout handler, so during those 44 s (and forever if
the presign 403s) the user sees the static empty state **"Video preview / No source loaded"**
— visually identical to a broken editor. Captured events on a stalled load:
`loadstart → stalled` and nothing else; `video.error` stayed `null`.

Also: presign TTL is **3600 s** (`studio/page.tsx:84`) with **no refresh**. An editing
session longer than an hour silently loses the video with no message.

## B3 — P1: Clip cards have no preview at all until a render is paid for

`/projects/[id]` clip grid shows a ~400 px empty box reading **"9:16 not rendered"**
for every clip. Competitors (OpusClip, Vizard, Klap) all show an instantly playable
preview of the detected segment. Consequences:
- Users cannot judge a clip without spending a render.
- Wasted FFmpeg compute on clips that get discarded after viewing → direct infra cost.
The studio already contains a word-synced HTML caption overlay; the same component over a
clip proxy gives a real preview for free.

## B4 — P1: Failed projects are a dead end

Project `90248e3b…` ("iiiiiiiii", Google Drive link):
- Banner reads **"Something went wrong. Please try again or contact support."** — but there is
  **no try-again control anywhere on the page**.
- `Start transcription` is `disabled` (verified via DOM) yet still painted in full
  ultramarine at `opacity .5`.
- The **Activity** tab says *"Waiting for workflow updates."* even though **4 persisted
  `WorkflowEvent` rows exist** for that project (124 rows account-wide). The tab renders only
  the live SSE stream and never loads history.
- No delete, no edit-source, no retry.

The real error **is** stored and is actionable:
`IngestJob.lastError = "worker_unhandled_error: The socket connection was closed unexpectedly."`
and `Project.ingestErrorCode = "worker_unhandled_error"`. Neither is surfaced.
`attemptCount = 1` — a single transient socket error permanently kills the project.

## B5 — P1: Clip detection can emit unusable sub-3-second clips

Project `5bce9b38…` ("Google CEO Sundar Pichai…", 24:02 source) produced exactly 2 clips:
- `39f0cbe6…` — `startSec 8.629 → endSec 10.060` = **1.43 s**
- `ba0c0168…` — `startSec 22.130 → endSec 24.923` = **2.79 s**

Both are below any platform's usable floor. No minimum-duration guard is applied to the
detector output. The same account's other projects produced sensible 30–31 s clips, so this
is intermittent, not systemic — but it ships broken output when it happens.

## B6 — P1: Preview crop ≠ export crop

`video-preview.tsx` renders the source with CSS `object-fit: cover` (verified computed
style) = a **static centre crop**. The worker export applies **YuNet face-tracked
auto-reframe**. So the framing the user approves in the studio is not the framing they get.
(Independently confirmed by the studio audit: `video-preview.tsx:26,67-70,272,280-287`.)

## B7 — P2: Autosave fires on mount

The top bar shows **"Saving…"** immediately on studio load with zero user interaction,
settling to "Saved". Wasted writes on every studio open; also widens the window for the
render-deleting bug the studio audit found (`clip.service.ts:885-919`).

## B8 — P2: B-roll search prefills the whole clip title

The B-roll panel's query box is prefilled with the full sentence
*"The magic new catch-all term of the tec…"*. Returned stock (startup desk, hands writing,
blurred white, phone) was unrelated to the clip's actual subject. Result durations offered
included **30 s for a 30 s clip**, which triggers the render-overrun bug found by the
B-roll audit.

## Verified NOT bugs (do not chase)

- The floating "N" bubble over the studio timeline is the **Next.js dev-tools portal**
  (`NEXTJS-PORTAL`), not app UI.
- Enforced CSP is only `frame-ancestors 'none'`; the full policy is **Report-Only** and its
  `media-src`/`img-src` already allow `*.r2.cloudflarestorage.com`, so CSP is not blocking media.
- The ingested MP4 **is** faststart-friendly (`moov` found in the first 1 MB), so moov
  placement is not the cause of the slow load.
- R2 itself is healthy: 8 concurrent range requests all returned `206`.
- `/404` and the studio not-found page render correctly with a working CTA.

## Positives worth keeping

- Dashboard, projects grid, 404 and stage-stepper visuals are genuinely strong.
- Virality scores, category eyebrows, per-clip timecodes, and the filter toolbar are good.
- Caption preset gallery (Minimal / Karaoke / Highlighter / Neon Dreams / Fire / Pastel Cloud …)
  is competitive in breadth.
- Undo/redo, autosave indicator, keyboard-shortcuts affordance all present in the studio top bar.
