# Narriflow Studio / Editor Audit

Read-only analysis. Every finding below was verified by reading the referenced
source; speculative items are marked as such or omitted.

Files covered: all of
`apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/**`, the legacy
`.../clips/[clipId]/edit/**`, `apps/web/app/api/[[...route]]/route.ts`
(clip PATCH + render + apply-preset), `packages/services/src/clip.service.ts`,
`packages/validators/src/{studio-edits,caption-preset,clip,clip-timing}.ts`,
`apps/worker/src/tasks/render-clips.ts`, `apps/worker/Dockerfile`.

---

## 0. Data-flow map (verified)

```
StudioShell state
  captionPreset ──┐
  utterances ─────┤ persistEdits()  3 sequential PATCHes to
  studioEdits ────┘ /api/projects/:id/clips/:clipId   (debounce 1500ms)
                        │
                        ├─ {captionPreset}   → clipService.updateClipCaptionPreset  → clip.captionPreset
                        ├─ {transcriptSlice} → clipService.updateClipTranscriptSlice → clip.transcriptSlice + startSec/endSec + status=edited
                        └─ {studioEdits}     → clipService.updateClipStudioEdits     → clip.studioEdits + status=edited
                                                                                       + DELETE ALL clipRender rows + R2 objects  ← (F1)

  segments        → (nowhere — pure local state)          ← (F2)
  layoutMode      → (nowhere)                             ← (F9)
  aspectRatio     → only POST /clips/render body
  transcriptOnly  → (nowhere)                             ← (F27)

Worker: processClipRenderingRun
  resolveRenderTimingForClip → getEffectiveClipTiming(clip.transcriptSlice, clip.startSec, clip.endSec)
  generateAssFromSlice(utterances, clipStart, aspect, captionPreset)  → .ass
  buildSingleVideoArgs / buildBrollVideoArgs / buildAudiogramArgs
     crop+scale → drawtext(textLayers) → ass(subtitles) → logo → fade(transition)
     audio: [0:a] + music amix
```

---

## 1. Correctness bugs

### F1 — P0. Autosave silently deletes every completed render (and its R2 object)

`packages/services/src/clip.service.ts:885-919`

```ts
const updated = await prisma.$transaction(async (tx) => {
  await tx.clipRender.deleteMany({ where: { clipId } });   // ← ALL rows, any status
  return tx.clip.update({ ... studioEdits: parsed, status: "edited" });
});
await deleteRenderAssets(staleRenderKeys);                  // ← deletes the R2 objects
```

`studio-shell.tsx:311-337` (`persistEdits`) unconditionally sends **all three**
PATCHes on every autosave cycle, including `{ studioEdits }` — even when only
`captionPreset` changed:

```ts
const editsRes = await fetch(base, { method: "PATCH", body: JSON.stringify({ studioEdits }) });
```

**Failure scenario:** user opens the studio on a clip that already has finished
9:16 + 1:1 renders, nudges the caption 1 px, waits 1.5 s. Both finished MP4s are
deleted from Postgres *and* from object storage. Nothing in the UI says so; the
project page just shows the clip as un-rendered again. There is no confirm, no
undo, and the assets are gone.

**Knock-on:** `page.tsx:111` derives the studio's initial aspect ratio from
`clip.renderVariants[0]?.aspectRatio ?? "9:16"`. Because F1 wipes
`renderVariants`, reopening the studio silently resets the format selector to
9:16 even for a clip the user had been exporting as 16:9.

**Second knock-on (race):** `handleExport` (`studio-shell.tsx:356-388`) calls
`persistEdits()` (which deletes renders) and then POSTs `/clips/render` (which
creates a fresh `pending` render). If a debounced autosave timer was already
scheduled before the click, it fires ~1.5 s later and `deleteMany` removes the
`pending`/`rendering` row out from under the worker; `markClipRenderVariantRendering`
/`completeClipRenderVariant` then operate on a deleted id.

**Fix:**
1. Make `persistEdits` send only the payloads that actually changed (track
   dirty flags per slice, or compare against the last persisted snapshot).
2. In `updateClipStudioEdits`, stop deleting renders. Mark them stale instead
   (`status: "stale"` or a `staleAt` column) and let the next explicit render
   replace them, so a user never loses a finished export by editing.
3. If invalidation must stay, scope `deleteMany` to
   `{ clipId, status: { in: ["completed", "failed"] } }` so in-flight renders
   survive, and only run it when `studioEdits` actually differs from the stored
   value.

---

### F2 — P0. Split / delete on the timeline is never persisted and never exported

`studio-shell.tsx:274-299` mutates only local `segments` state.
`packages/validators/src/studio-edits.ts:39-57` — `studioEditsSchema` has exactly
three keys: `textLayers`, `transition`, `music`. There is **no cut/segment
model**. The worker renders one continuous range:

`render-clips.ts:936-943` → `["-ss", startSec, "-t", endSec-startSec, "-i", source]`.

**Failure scenario:** user presses <kbd>D</kbd> at 12 s, selects the second half,
presses <kbd>Backspace</kbd>. The block disappears from the timeline, the
Inspector's "Segments" count drops, undo/redo work — and the exported MP4
contains the deleted footage, at full original length.

**Fix:** add `cuts: z.array(z.object({ startSec, endSec })).default([])` (or
`keptRanges`) to `studioEditsSchema`; persist `segments` into it on every
mutation; in the worker build a `trim/setpts + atrim/asetpts + concat` chain (or
per-range `select='between(t,a,b)+between(...)'`) and offset the ASS/drawtext
timestamps accordingly. Until that lands, the Scissors/Trash buttons and the
`D`/`Backspace` shortcuts should be removed or disabled with an explanatory
tooltip — shipping a no-op destructive control is worse than not having it.

---

### F3 — P0. Timeline click-to-seek lands on the wrong time (two independent offset bugs)

`timeline.tsx:768-776`

```ts
const rect = e.currentTarget.getBoundingClientRect();
const x = e.clientX - rect.left + (stripRef.current?.scrollLeft ?? 0);
const t = xToTime(x);                       // (x - LEFT_GUTTER) / pxPerSec
```

**Bug 3a — `scrollLeft` is double-counted.** The clicked elements
(`timeline.tsx:951` ruler, `:1005` video track, `:1060` waveform) are absolutely
positioned inside the *scrolled content* box. `getBoundingClientRect().left`
already moves with the scroll, so `e.clientX - rect.left` is **already**
content-space X. Adding `scrollLeft` again shifts the result by `scrollLeft`
pixels. At the default 80 px/s, a timeline scrolled 800 px seeks 10 s late.
Any clip longer than the visible strip (≈15 s at zoom 1) hits this.

**Bug 3b — `LEFT_GUTTER` is subtracted twice on two of the three surfaces.**
The video track (`:1008`) and waveform (`:1063`) containers are already offset
with `left={LEFT_GUTTER}px`, so `e.clientX - rect.left` is measured *from* the
gutter. `xToTime` then subtracts `LEFT_GUTTER` again → a constant
`-40/pxPerSec` error (−0.5 s at zoom 1, −1 s at zoom 0.5). The ruler
(`left: 0`) is correct.

Meanwhile `TimelinePlayhead` (`:553-639`) positions itself with the *correct*
`timeToX`, so the playhead visibly jumps away from where the user clicked.

**Fix:** compute against the scroll root once and drop both duplications:

```ts
const root = stripRef.current;
if (!root) return;
const x = e.clientX - root.getBoundingClientRect().left + root.scrollLeft;
const t = xToTime(x);           // xToTime already removes LEFT_GUTTER
```

Also add drag-scrub (`pointerdown` + `pointermove`) — today a single click is the
only way to move the playhead on the timeline.

---

### F4 — P1. Autosave race loses the newest edit on navigation

`studio-shell.tsx:303-337, 545-619`

`hasPendingSaveRef` is a single boolean set on every edit and cleared by *any*
successful `persistEdits`. Sequence:

1. `t=0` edit A → `hasPendingSaveRef = true`, timer for `t=1.5`.
2. `t=1.5` `persistEdits(A)` starts (closure holds A).
3. `t=1.6` edit B → `hasPendingSaveRef = true`, new timer for `t=3.1`.
4. `t=1.9` `persistEdits(A)` resolves → `hasPendingSaveRef = false`. **B is now
   invisible to the flush handlers.**
5. `t=2.2` user navigates away → unmount/`pagehide` see `false` → no flush → **edit B is lost**,
   and `beforeunload` doesn't warn either.

**Fix:** replace the boolean with a monotonically increasing `dirtyVersionRef`;
`persistEdits` captures the version it is writing and only clears when
`dirtyVersionRef.current === capturedVersion`. Also serialize saves through a
single in-flight promise so a later write can't be overtaken by an earlier one.

---

### F5 — P1. `PATCH /clips/:clipId` accepts any unrecognised body and resets `studioEdits`

`apps/web/app/api/[[...route]]/route.ts:783-800` combined with
`packages/validators/src/studio-edits.ts:39-57`.

`studioEditsSchema` carries a top-level `.default({...})`, so
`updateClipStudioEditsSchema.safeParse({})` **succeeds** with the empty default.
Because that branch is last in the dispatch chain, *any* payload that doesn't
match one of the earlier schemas falls through to
`updateClipStudioEdits(..., { textLayers: [], transition: {none}, music: {null} })`
— wiping the clip's text layers, transition and music, deleting its renders
(F1), and returning `200`. The final `return c.json({ error: "Invalid payload" ...})`
at `:794` is unreachable dead code.

**Fix:** make the discriminator explicit — require the key:
`z.object({ studioEdits: studioEditsSchema.removeDefault() })`, or better, split
into four distinct routes (`/caption-preset`, `/transcript`, `/broll`,
`/studio-edits`) instead of shape-sniffing one PATCH.

---

### F6 — P1. An invalid music URL wedges autosave permanently with an unactionable error

`music-panel.tsx:14-25` writes the raw input straight into `studioEdits.music.url`
with no client-side validation. `studioMusicSchema` (`studio-edits.ts:33`)
requires `z.string().url()`.

**Failure scenario:** user types `cdn.example.com/bed.mp3` (no scheme) and clicks
"Apply music". Every subsequent autosave: the caption + transcript PATCHes
succeed, the `studioEdits` PATCH 400s, the shell shows "Autosave failed" forever
(`studio-shell.tsx:564-572`), `hasPendingSaveRef` never clears so
`beforeunload` blocks every navigation, and nothing points at the music field.

**Fix:** validate in `applyMusic` (try `new URL()`, require `http(s):`) and show
a field-level error; additionally have the API return the failing zod path so the
shell can surface *which* edit is rejected instead of a generic toast.

---

### F7 — P1. `amix` halves the dialogue whenever music is added

`render-clips.ts:690-694`

```ts
`[maina]${musicLabel}amix=inputs=2:duration=first:dropout_transition=0[outa]`
```

`amix` defaults to `normalize=1`, which scales every input by `1/nb_inputs`. The
speaker's voice is attenuated 6 dB the moment a music bed is attached, regardless
of the volume slider (which only affects the music branch). The studio gives no
audio preview of this at all.

**Fix:** `amix=inputs=2:normalize=0:duration=first:dropout_transition=0`, and
apply the user's volume to the music branch only (already done at `:684`).
Consider `sidechaincompress` for proper ducking.

---

### F8 — P1. `music.startOffsetSec` is a dead field end-to-end

Declared in `studio-edits.ts:36`, hard-coded to `0` in `music-panel.tsx:22,32`,
and never read by `buildMusicAudioFilter` (`render-clips.ts:674-695`) — the
music always starts at its own t=0 and is `-stream_loop -1`'d.

**Fix:** either expose it in the panel and honour it with
`atrim=start=${startOffsetSec}:duration=...` on the music input, or drop the field.

---

### F9 — P1. `Layout: Fill / Fit / Blur` is preview-only; the export is always "Fill"

`video-preview.tsx:26,67-70,185-196,272,280-287` — `layoutMode` lives only in
React state. It is absent from `studioEditsSchema`, never persisted, never sent
to the worker. `buildCropAndScaleFilter` (`render-clips.ts:800-852`)
unconditionally centre-crops to the target ratio (i.e. always "fill").

Two problems:
1. Choosing "Fit" or "Blur" changes the preview and does nothing to the MP4.
2. The "Blur" preview isn't even a blurred-background letterbox — it's
   `rgba(0,0,0,0.4)` + `backdrop-filter: blur(20px)` over the *entire* frame
   (`:280-287`), so it doesn't represent any plausible export either.

**Fix:** add `layout: z.enum(["fill","fit","blur"])` to `studioEditsSchema`; in
the worker implement `fit` as
`scale=W:H:force_original_aspect_ratio=decrease,pad=W:H:(ow-iw)/2:(oh-ih)/2` and
`blur` as a `split` → blurred cover background + `overlay` of the contained
foreground. Fix the preview to match. Until then, hide the control.

---

### F10 — P1. Repeated split produces duplicate segment ids

`studio-shell.tsx:281-288`

```ts
return [{ ...s, endSec: currentTime },
        { id: `${s.id}-b`, label: s.label, startSec: currentTime, endSec: s.endSec }];
```

Splitting `seg-0` yields `seg-0` + `seg-0-b`. Splitting `seg-0` again yields a
**second** `seg-0-b`. `timeline.tsx:1019` uses `key={seg.id}`, so React logs a
duplicate-key warning and reconciles wrongly; `selectedSegmentId` then matches
both blocks, and `deleteSelectedSegment` (`:297`) removes both.

**Fix:** `id: crypto.randomUUID()` (or a monotonic counter) for the new half.

---

### F11 — P1. Editing one word rewrites the timing of every word in the utterance

`studio-shell.tsx:211-236` — `updateUtteranceText` re-splits the whole utterance
and redistributes word boundaries **uniformly**:

```ts
const wordDuration = utteranceDuration / newWordTexts.length;
words: newWordTexts.map((word, i) => ({ startSec: utterance.startSec + i*wordDuration, ... }))
```

Fixing a single misheard word at the end of a 12-word sentence destroys the ASR
word timings for all 12, so both the preview highlight and the burned-in
per-word karaoke go out of sync with the audio for that whole sentence.

Additionally, if the user pastes a long sentence into a short utterance,
`wordDuration` can drop below `MIN_WORD_DURATION_SEC` (0.01) and
`normalizeTranscriptSliceForClip` (`clip-timing.ts:416`) **silently drops every
word** — the caption appears in the preview and is missing from the export.

**Fix:** diff old vs new token lists (LCS) and keep the original `startSec`/
`endSec` for unchanged tokens, distributing only across the inserted run.
Clamp/reject edits that would push word durations under the 0.01 s floor and
warn in the UI.

---

### F12 — P1. Clicking a transcript word to seek also drops you into edit mode and wipes the word spans

`transcript-panel.tsx:159-219`. The "not editing" branch renders per-word
`<Box as="span" onClick={onSeek}>` children **inside a `contentEditable` div**.
Clicking a word fires `onSeek` *and* focuses the div → `handleFocus` →
`setIsEditing(true)` → the same div re-renders with plain text
(`:222-243`), destroying the word spans, the active-word highlight and the caret
position.

Rendering React-managed children inside `contentEditable` is also the classic
source of `NotFoundError: Failed to execute 'removeChild'` once the browser
mutates the subtree during typing.

**Fix:** don't make the read-only view `contentEditable`. Enter edit mode from an
explicit affordance (double-click, or a pencil button), render the editable view
as an uncontrolled `<textarea>`/`contentEditable` with `dangerouslySetInnerHTML`
set once, and keep single-click purely as seek.

---

### F13 — P1. `useEffect` dep bug: `showTimeline` toggle is out of sync with the toggle button

`timeline.tsx:836-840` — the "Hide timeline" button always renders the label
`"Hide timeline"` and the `Eye`/`EyeOff` icon derived from `showTimeline`, but
when `showTimeline` is false the whole track area is unmounted (`:926`) while the
control bar stays — so the button reads "Hide timeline" while the timeline is
already hidden. Cosmetic, but the `H` shortcut and the button then disagree with
the label. Low-effort fix: `label={showTimeline ? "Hide timeline" : "Show timeline"}`.

*(P2, listed here because it is in the same component.)*

---

### F14 — P1. B-roll: no placement control, no preview, and a silent 12-second cliff

- `broll-panel.tsx` lets the user pick a Pexels clip or paste a URL and shows
  "B-roll applied to this clip", but there is **no start/end control** — the
  worker picks the window itself via `planBrollWindow(clipDurationSec, brollDurationSec)`
  (`render-clips.ts:1848`).
- The studio preview never composites b-roll, so the user cannot see it.
- `render-clips.ts:1805-1809`:
  ```ts
  if ((brollEnabled || userBrollUrl) && probe.hasVideo && clipDurationSec >= 12) {
  ```
  A user who picks b-roll on an 11-second clip gets a green "applied" chip and an
  export with no b-roll at all, with no warning anywhere.

**Fix:** persist `broll: { url, startSec, endSec }` in `studioEdits`, render it in
`VideoPreview` as a positioned `<video>`/poster over the source between those
times, add a draggable b-roll block on the timeline, and surface the
minimum-duration rule in the panel (disable + explain below 12 s).

---

### F15 — P1. Transitions are never previewed and "Transitions" isn't what the name implies

`transitions-panel.tsx` offers Cut/Fade/Dip-White + duration and writes
`studioEdits.transition`. The worker (`render-clips.ts:646-656`) turns that into

```
fade=t=in:st=0:d=D, fade=t=out:st=(dur-D):d=D
```

i.e. a **clip-level intro/outro fade**, not a transition between cuts (there are
no cuts — see F2). `VideoPreview` renders no fade at all, so the setting is
invisible until export.

Also `studioTransitionSchema` (`studio-edits.ts:28`) allows `"fade-black"` which
the panel never offers and which produces exactly the same filter as `"fade"`.

**Fix:** rename the panel to "Fade in / out" (or implement real per-cut
transitions once F2 lands), drive a CSS opacity/white overlay in `VideoPreview`
from `studioEdits.transition` so the preview matches, and drop the redundant
`fade-black` enum member.

---

### F16 — P1. Text-layer drawtext escaping is the variant this same file documents as broken

`render-clips.ts:603-611` (`escapeDrawtextValue`) escapes `\ : ' [ ] %` and then
wraps the value in single quotes at `:635`:

```ts
`:text='${escapeDrawtextValue(layer.text)}'`
```

`render-clips.ts:1374-1385` contains the corrected helper `escapeDrawtextText`
with an explicit comment: *"Verified against ffmpeg 8 — quoting the value instead
breaks on embedded `'`"*. Inside a single-quoted ffmpeg token a backslash is not
an escape, so a text layer containing an apostrophe emits a stray backslash /
truncates, and `[`/`]` leak their backslashes too. The watermark path uses the
correct helper; the user-facing text-layer path does not.

**Fix:** use `escapeDrawtextText(layer.text)` unquoted in
`buildTextLayerFilters`, exactly as `buildFreeTierPostProcessArgs` does. Same for
`layer.fontName`.

---

### F17 — P1. Text layers: 12-layer schema cap is not enforced in the UI

`studio-edits.ts:41` caps `textLayers` at 12; `text-panel.tsx:26-59` has no
guard. Adding a 13th layer makes every subsequent `studioEdits` PATCH 400
forever, with the same unrecoverable "Autosave failed" loop as F6.

**Fix:** disable "Add text overlay" at 12 and show the limit.

---

### F18 — P2. `sourceDurationSec` is passed in the studio but not in the worker

`page.tsx:91-96` calls `getEffectiveClipTiming({ ..., sourceDurationSec })`;
`render-clips.ts:106-110` calls it **without** `sourceDurationSec`, so the worker
uses `Number.POSITIVE_INFINITY` (`clip-timing.ts:307-310`). For the last clip in
a video the studio clamps `endSec` to the source duration and the worker does
not — the preview duration and the export duration disagree.

Separately, `resolveRenderTimingForClip` short-circuits entirely for
`llmModel === "caption-only"` (`render-clips.ts:91-104`) using raw
`startSec/endSec`, while the studio *always* runs the sentence-snapping
`getEffectiveClipTiming`. For caption-only clips the studio previews a different
window than it exports.

**Fix:** extract one `resolveClipTiming(clip, project)` helper in
`packages/validators` and call it from both `page.tsx` and the worker, including
the `caption-only` branch and `sourceDurationSec`.

---

### F19 — P2. `handleExport` only ever exports the one selected aspect ratio

`studio-shell.tsx:369-371` sends `aspectRatios: [aspectRatio]`. There is no
multi-format export in the studio even though `triggerClipRenderSchema` accepts
up to four and the worker has an optimised `buildMultiVideoArgs` split path.

---

## 2. Preview-vs-export parity

The project claims (CLAUDE.md, and literally on screen at
`edit/caption-preset-form.tsx:250-253`: *"Preview uses the shared cue model, so
burned-in captions match exactly"*). Verified divergences, ordered by visual impact:

| # | Property | Preview | Export | Sev |
|---|---|---|---|---|
| P1 | **Font family** | `"${fontName}", Impact, sans-serif` (`caption-style-engine.tsx:303`) with **no webfont loaded** — `apps/web/app/layout.tsx` only loads Archivo/Geist | Real Bebas Neue / Oswald / Montserrat / Roboto / Open Sans, baked into `apps/worker/Dockerfile:26-38` | **P0** |
| P2 | `Impact` preset | Real Impact (macOS/Windows local font) | Aliased to **Anton** (`render-clips.ts:401-403`) | P1 |
| P3 | Outline / shadow / glow scale | `buildCaptionTextShadow(preset, scale)`; the on-video overlay passes `scale={1}` (`interactive-caption-overlay.tsx:353`) so `outlineWidth: 3` is 3 **display** px | ASS `Outline=3` in **render** px on a 1080-wide frame; with a ~360 px preview the export outline is ~3× thicker than previewed | P1 |
| P4 | Same, across previews | Overlay `scale=1`, panel `scale=max(0.3, w/renderWidth*1.6)` (`captions-panel.tsx:202`), preset card `scale=0.6` (`preset-card.tsx:81`) — three different values for the same preset | one value | P1 |
| P5 | Panel preview font size | `fontSize * scale * 1.6` (`captions-panel.tsx:180`) — an arbitrary 1.6× magnification | proportional | P1 |
| P6 | Inter-word gap | fixed `gap: 6px` in **display** px (`caption-style-engine.tsx:259`, default `gapPx=6`); does not scale with `fontSize` or render width | a literal `" "` whose width comes from the font (`render-clips.ts:564`) | P1 |
| P7 | **Caption visibility during pauses** | `getCurrentCaptionState` falls back to `upcoming-1` when between words, so the chunk **stays on screen** (`use-current-caption.ts:54-63`) | each word emits its own Dialogue ending at the next word's start; the last of a chunk ends at `groupEnd`. A gap to the next chunk → **captions blink out** (`render-clips.ts:551-570`) | P1 |
| P8 | After the last utterance | clamps to the last utterance and keeps showing the final chunk (`use-current-caption.ts:37-44`) — this covers the 0.25 s `tailPad` every clip gets | no Dialogue → nothing | P2 |
| P9 | Animation model | per-word framer-motion with `delay = index * 0.08` and springs (`caption-style-engine.tsx:50-120`) | one whole-cue entrance applied only to `j === 0`: `\fad(60,0)` + optional `\fscx82\fscy82\t(0,160,...)` (`render-clips.ts:524-538`) | P1 |
| P10 | Animations with **no** export equivalent | `breathe` (infinite pulse), `glitch` (x/skew jitter), `karaoke`/`word-by-word` in preview mode | `entranceFor` handles only grow/bounce/seamless-bounce/soft-landing/blur-in; everything else gets bare `\fad(60,0)` | P1 |
| P11 | `blur-in` + glow | both applied | `\blur` entrance suppressed when `glowColor` is set (`render-clips.ts:534`) | P2 |
| P12 | Highlight box | filled rounded rect behind the active word (`caption-style-engine.tsx:279-292`) | approximated with a thick `\bord`/`\3c` border (`render-clips.ts:514-520`) — square-ish, hugs glyph outlines | P1 |
| P13 | Backdrop | one rounded box behind the whole cue, `inset -6px -10px`, `radius 6px` | ASS `BorderStyle=3` opaque box — square corners, per-line, and it **replaces the glyph outline** | P2 |
| P14 | Glow | symmetric `text-shadow 0 0 Npx` ×2 | directional `\shad(N/4)` + `\blur(N/2)` in `\4c` (`render-clips.ts:475-481`) | P2 |
| P15 | Drop shadow | `0 2px 8px rgba(0,0,0,0.9)` | ASS `Shadow=1` (1 px offset, colour = `BackColour`, which becomes the *backdrop* colour when a backdrop is set) | P2 |
| P16 | Letter spacing | `${letterSpacing}em` (fractional) | `Math.round(letterSpacing * fontSize)` px (`render-clips.ts:460`) — `Minimal` (0.01 × 32 = 0.32) rounds to **0** | P2 |
| P17 | Emoji placement | appended inside the word span, so it inherits the active-word highlight colour (`caption-style-engine.tsx:314-316`) | appended *after* the colour-reset tag, so it renders in `primaryColor` (`render-clips.ts:561-563`) | P2 |
| P18 | Line breaking / max chars | `flexWrap="nowrap"`, `width: max-content`, clipped by the container's `overflow: hidden` | `WrapStyle: 2` + `\pos` + zero margins — also no wrap, but clipped at `PlayResX`. Neither side has a max-chars-per-line rule, so a 3-word chunk at `fontSize: 46` can run off a 1080-wide frame in both | P2 |
| P19 | Safe area | none — `CAPTION_POSITION_Y_DEFAULTS.bottom = 88` and `snap-guides.ts` offers 0/33/50/67/100 with no platform-UI guides | none | P2 |
| P20 | RTL | no `dir`/`unicode-bidi` anywhere in `caption-style-engine.tsx` | ASS has no bidi handling either; the `resolveFontName` allow-list `[^A-Za-z0-9 -]` strips non-Latin font names entirely (`render-clips.ts:410`) | P2 |
| P21 | Position rounding | `left: ${posX}%` (sub-pixel) | `Math.round(posXPct/100 * resX)` (`render-clips.ts:445-446`) — ≤0.5 px, negligible | — |
| P22 | Font size scaling | `fontSize * (containerWidth / renderWidth)` where `renderWidth` comes from the selected ratio (`interactive-caption-overlay.tsx:160-182`) | raw `fontSize` at `PlayResX = config.width` — **this one is correct** | ✅ |
| P23 | Cue chunking | `CAPTION_CHUNK_SIZE` shared | same constant imported in the worker | ✅ |
| P24 | Centre anchor | `translate(-50%,-50%)` | `\an5\pos(x,y)` | ✅ |

### Text-layer parity (separate renderer, separate bugs)

| # | Property | Preview (`video-preview.tsx:289-333`) | Export (`render-clips.ts:613-644`) | Sev |
|---|---|---|---|---|
| T1 | Font scale | `layer.fontSize * (previewWidth / **1080**)` — hard-coded | `fontsize = layer.fontSize` at the output's real width, which is **1920** for 16:9 (`clip.ts:60-90`) → export text is ~44 % smaller relative to frame | P1 |
| T2 | Wrapping | `maxW="88%"` → the browser wraps | `drawtext` never wraps → long text runs off frame | P1 |
| T3 | Outline | `WebkitTextStroke: ${outlineWidth}px` in display px | `borderw=${outlineWidth}` in render px | P1 |
| T4 | X anchor | `left: X%` + `translate(-50%,-50%)` = centre-anchored | `x=(w-text_w)*X` = left-edge interpolation; identical only at X=50 (which is the only value the UI produces today — latent) | P2 |
| T5 | Y anchor | centre of the box at `Y%` | `y=(h-text_h)*Y` — top of the box interpolated; ~25 px off for a 62 px title on 9:16 | P2 |
| T6 | Background box | `px 10px / py 5px`, `borderRadius 6px` | `box=1:boxborderw=10`, square corners | P2 |
| T7 | Shadow | `0 2px 10px rgba(0,0,0,0.45)` only when `outlineWidth > 0` | `shadowcolor=black@0.45:shadowy=2` always | P2 |
| T8 | Font | `"${fontName}", Arial, sans-serif` — real Arial locally | fontconfig substitutes Liberation Sans (metric-compatible) | P2 |

### F20 — P1. The legacy `/edit` page forks the cue engine and asserts parity it doesn't have

`edit/caption-preset-form.tsx` defines **local copies** of `hexToRgba` (`:423`),
`getWordMotionProps` (`:436`), the text-shadow builder (`:524-541`) and the cue
renderer (`:492-`), instead of importing `caption-style-engine.tsx`. This
directly violates the CLAUDE.md rule *"Caption preview and burn-in share one cue
model … never fork it"*.

Concrete divergences already present in the fork: `RENDER_WIDTH = 1080` is
hard-coded (`:413`, wrong for 16:9), `gap="4px"` vs the engine's `6px`,
`maxW="94%"` vs the overlay's `max-content`, and `word-by-word` **accumulates**
words one at a time (`:546-547`) whereas both the studio overlay and the ASS
output show all three words of the chunk with colour-only highlighting. The
on-screen copy at `:250-253` tells the user the opposite.

**Fix:** delete the fork, render `<CaptionCue>` from `caption-style-engine.tsx`,
or retire the `/edit` route entirely now that the studio supersedes it.

---

## 3. State-management smells

`timeline.tsx` is 1097 lines; `studio-shell.tsx` is 664 with a 28-field context.

### F21 — P1. `VideoPreview` re-renders on every playback frame

`video-preview.tsx:89-91`

```ts
useEffect(() => playbackClock.subscribe(() => {
  setCurrentTime(playbackClock.getSnapshot());
}), [playbackClock]);
```

`currentTime` is used for exactly one thing — gating text-layer visibility
(`:291`) — but the state update re-renders the whole `VideoPreview` at the
clock's rate (`requestVideoFrameCallback`, i.e. video fps). That subtree
includes the aspect-ratio `Menu.Root` + `Portal`, the video element, every text
layer, and **`InteractiveCaptionOverlay`**, which is not `memo`'d, so the entire
framer-motion caption tree (plus `CaptionResizeHandles`, `SnapGuideLines`) is
reconciled every frame. `CaptionCue` also rebuilds the text-shadow string on
every render — for `outlineWidth: 4` that is `9×9−1 = 80` shadow segments
concatenated 60×/s (`caption-style-engine.tsx:124-154`).

**Fix:**
- Extract `<TextLayerOverlay>` and let it own the clock subscription; keep
  `VideoPreview` clock-free.
- `memo` `InteractiveCaptionOverlay` and `CaptionCue`.
- `useMemo` `buildCaptionTextShadow(preset, scale)` on
  `[outlineWidth, outlineColor, shadow, glowColor, glowIntensity, scale]`.
- For the visibility gate, prefer CSS: emit all layers once and toggle
  `opacity`/`visibility` from a `subscribe` callback writing directly to
  `style`, as `TimelinePlayhead` already does correctly.

### F22 — P2. `handleWheel` calls `preventDefault()` inside a passive listener

`timeline.tsx:778-787`. React 17+ (this repo is React 19,
`apps/web/package.json:39`) registers `wheel` on the root container as
**passive**, so `e.preventDefault()` is a no-op and logs
`Unable to preventDefault inside passive event listener`. Wheel-over-timeline
therefore zooms *and* horizontally scrolls the strip.

**Fix:** attach the listener imperatively:
`el.addEventListener("wheel", handler, { passive: false })` in an effect on
`stripRef`. While there: use `ctrl/⌘ + wheel` for zoom and plain wheel for
scroll, which is what every NLE does.

### F23 — P2. Concrete decomposition seams for `timeline.tsx`

Already-independent units that should be separate modules:

| Lines | Extract to |
|---|---|
| `30-44` | `timeline/format.ts` (`formatTimecode`, `formatRulerLabel`) |
| `46-219` | `timeline/segment-thumbnails.tsx` |
| `221-324` | `timeline/waveform-canvas.tsx` |
| `326-365` | `timeline/ctrl-btn.tsx` |
| `376-415` | `timeline/use-timeline-viewport.ts` |
| `417-523` | `timeline/segment-block.tsx` |
| `525-639` | `timeline/playhead.tsx` + `timeline/timecode.tsx` |
| `824-923` | `timeline/control-bar.tsx` (currently re-renders on every scroll tick) |
| `676-756` | `timeline/use-timeline-geometry.ts` (ticks / visibleRange / visibleSegments / pause markers) |

The control bar is the biggest win: it sits in the same component as the
scroll-driven `viewport` state, so the zoom slider, play button and timecode all
re-render on every scroll frame.

### F24 — P2. Prop drilling / context shape

`StudioContextValue` (`studio-shell.tsx:93-126`) is one object with 28 members
rebuilt **unmemoized** on every shell render (`:621-634`), so every `useStudio()`
consumer re-renders whenever *any* studio state changes — e.g. typing in the
music URL field re-renders the timeline. Split into `StudioDataContext`
(clipInfo, utterances, refs — near-static), `StudioUiContext` (activeTool,
zoom, selection) and `StudioActionsContext` (stable callbacks), and wrap each
value in `useMemo`.

### F25 — P2. Duplicated local state that can desync

- `captions-panel.tsx:266` `localAnimation` mirrors `captionPreset.animation`.
- `transitions-panel.tsx:16-17` `selected`/`duration` mirror `studioEdits.transition`
  and are only committed by an explicit button — navigating away loses them.
- `music-panel.tsx:10-12` same pattern; `clearMusic` (`:27-34`) resets the
  persisted volume to 35 but leaves the local slider where it was.

### F26 — P2. Ref mutated during render

`timeline.tsx:257-262` regenerates `seedRef.current` inside the render body when
`canvasWidth` changes. Under concurrent rendering the discarded render still
mutates the ref, so the waveform seed can change without a commit.

### F27 — P2. `transcriptOnly` is a dead control

Wired through the whole context (`studio-shell.tsx:83,199,624`) and rendered as a
checkbox (`transcript-panel.tsx:350-363`), but no consumer reads it. Either
implement it (hide the video, widen the transcript) or delete it.

---

## 4. Missing editor features vs. industry standard

| Capability | State in Narriflow | Notes |
|---|---|---|
| Undo / redo | **Segments only** (`studio-shell.tsx:390-404`) | Caption preset, text layers, transitions, music, transcript edits are all un-undoable. The TopBar buttons look global. **P1** |
| Undo of destructive ops | none | "Apply to all clips" and "Delete segment" have no undo *and* no confirm |
| Keyboard shortcuts | 16 bindings (`studio-shell.tsx:417-491`), documented honestly in the modal | Missing: `J/K/L` shuttle, `I/O` in/out points, `S`/`Cmd+K` split (only `D`/`Cmd+B`), `Cmd+C/V` copy-paste, `Cmd+D` duplicate, `M` marker, `Cmd+S` explicit save, `,`/`.` nudge |
| Multi-select | **none** | `selectedSegmentId: string \| null` — single selection only, no shift-click, no marquee |
| Snapping | Caption position only, to 5 fixed % lines (`snap-guides.ts`) | No timeline snapping (playhead, segment edges, markers), no safe-area guides, no snap to other text layers |
| Timeline zoom | ✅ 0.5–4× slider + `+`/`-`/`\` + wheel | but wheel is broken (F22) and there is no "fit to window" (the `\` key resets to 1×, not fit) |
| Ripple delete | **none** | `deleteSelectedSegment` leaves a hole; nothing shifts |
| Split at playhead | UI exists, **no export effect** (F2) | |
| Trim handles on segments | **none** | `TimelineSegmentBlock` has no edge handles; segments cannot be resized or dragged |
| Per-word caption editing | **none** | Only whole-utterance text, which destroys word timings (F11) |
| Speaker labels | Displayed (`transcript-panel.tsx:402`) | Not editable, not burned into captions, not used for diarised colouring |
| Filler-word removal | **none** | No detection, no "remove ums" action |
| Silence removal | **Markers only** | Pauses ≥0.4 s are drawn on the timeline (`timeline.tsx:730-756`) and in the transcript (`:311-320`), but there is no "remove all pauses" action |
| Waveform | **Synthetic** (F28) | |
| Layer / track model | **Single video track + one fake audio track** | Text layers, b-roll and music have no timeline representation at all — they are list-only in side panels |
| Copy-paste of styles | Partial: "Apply to all clips" for the caption preset only (`captions-panel.tsx:725-749`) | No per-clip copy/paste, no studioEdits propagation, no confirm, no undo, no "apply to selected" |
| "Apply to all clips" | ✅ captions only | `applyCaptionPresetToAllClips` (`clip.service.ts:924-943`) overwrites every clip in the project unconditionally, including ones the user hand-tuned |
| Brand template | ✅ (`brand-template-panel.tsx`) | Applies caption preset only; logo/colours come from the project snapshot server-side |
| Zoom on the *video* (Ken Burns / punch-in) | none | |
| Audio ducking under music | none (F7 makes it worse) | |
| Chapters / markers | none | |

---

## 5. Performance

### How timeline frames are produced

`timeline-preview-manager.ts` maintains a module-global singleton: one hidden
`<video>` per `sourcePreviewId` (`:84-99`), a 1-deep job queue (`:126-142`), and
an `HTMLCanvasElement` LRU capped at `MAX_CACHE_ITEMS = 80` (`:30`). Each job
seeks the hidden video 4 times (coarse, `MAX_COARSE_WIDTH 720`) or up to 10 times
(refined, `MAX_REFINED_WIDTH 1800`) and `drawImage`s each frame into a strip
(`:208-227`). `SegmentThumbnails` (`timeline.tsx:65-219`) requests coarse
immediately and refined after 60–180 ms.

**Network requests per interaction:** scrubbing the playhead does *not* hit the
thumbnail path (it only sets `video.currentTime` on the main element), so a
scrub is 0 extra thumbnail requests — good. But:

### F28 — P1. The waveform is fake

`timeline.tsx:225-324`. Amplitude is `Math.random()` seeded per pixel
(`:257-262`) and gated by word/utterance ranges (`:288-311`). No audio is ever
decoded. It looks exactly like a real waveform, and users will make silence /
filler-word decisions from it.

**Fix:** either render a real peak envelope (precompute peaks in the worker
during STT and store them alongside the transcript — cheapest), or restyle it as
an obvious "speech activity" band so it doesn't masquerade as amplitude.

### F29 — P1. Zoom invalidates the entire thumbnail cache and re-seeks everything

`timeline-preview-manager.ts:41-51` — the cache key includes
`Math.round(width)`, and `width` is `(endSec-startSec) * 80 * timelineZoom`
(`timeline.tsx:492`). The zoom slider has `step={0.05}` and the wheel handler
moves ±0.15, so **every zoom tick produces a completely new key set**. A 20-utterance
clip is ~20 segments × 2 qualities = 40 entries per zoom level; the 80-entry LRU
holds two zoom levels, then thrashes. Each miss costs 4–10 serialized
`video.currentTime = t` seeks, each of which can be an HTTP range request against
the presigned R2 URL.

**Fix:** quantize the cache key to a small set of width buckets (e.g. round to
the nearest 64 px, or key on `segStart/segEnd` + a fixed strip resolution and
scale on draw — `drawCachedStrip` already scales). Debounce zoom-driven
re-requests by ~200 ms.

### F30 — P1. A missed `seeked` event deadlocks the whole thumbnail queue

`timeline-preview-manager.ts:64-82` — `waitForVideoEvent` has **no timeout**.
`seekVideo` (`:162-169`) awaits it, `runJob` awaits `seekVideo`, and
`scheduleNextJob` (`:126-142`) only advances in `runJob(...).finally()`. If the
browser coalesces or drops a `seeked` (common when seeking a media element
that is mid-buffer, or when the tab is backgrounded), the promise never settles,
`activeJob` never clears, and **no further thumbnails render for the lifetime of
the page**. Cancelling the component's job sets `job.cancelled = true` but does
not unblock the awaiting promise.

**Fix:** race `waitForVideoEvent` against a `setTimeout` reject (~3 s), and add
an overall per-job timeout in `scheduleNextJob`.

### F31 — P1. Thumbnail cache and hidden `<video>` elements are never released

`thumbnailCache` and `videoSlots` are module-level `Map`s (`:33-34`) with no
teardown hook. Leaving the studio keeps up to 80 canvases alive — a refined strip
is `1800 × 61` ≈ 440 KB of RGBA backing store, so worst case ≈ 35 MB — plus a
`<video>` element still holding the presigned source URL, for the rest of the SPA
session. There is no `URL.createObjectURL` anywhere in the studio, so object-URL
revocation is a non-issue; the leak is the retained canvases + media elements.

**Fix:** export `releaseTimelinePreviews(sourcePreviewId)` that clears matching
cache entries and calls `video.removeAttribute("src"); video.load()`, and call it
from a `Timeline` unmount effect.

### F32 — P2. Thumbnails are aspect-distorted

`timeline-preview-manager.ts:218-224` draws the full video frame into a
`frameWidth × renderHeight` box with no source rect, so a 16:9 frame is squashed
into a ~60×61 cell.

**Fix:** compute a centred source crop (`sx, sy, sw, sh`) matching the cell
aspect and pass the 9-argument `drawImage`.

### F33 — P2. Waveform canvas is stretched at high zoom

`timeline.tsx:223,239-242` — the canvas backing store is capped at
`MAX_WAVEFORM_CANVAS_WIDTH = 2400` while CSS width is `totalWidth`. A 60 s clip
at 4× zoom is 19 200 CSS px on a 2400 px canvas: 8× horizontal stretch.

**Fix:** virtualize the waveform to the visible range (it already has
`visibleRange`), same as ticks and segments.

### F34 — P2. `TimelineTimecode` re-renders at clock rate

`timeline.tsx:525-551` uses `usePlaybackTime` → `useSyncExternalStore`, so it
re-renders on every clock notification. It's small, but it's the only component
that does — `TimelinePlayhead` correctly writes `style.transform` from a
subscription without setState (`:568-596`). Mirror that approach.

### F35 — P2. `sortedInsert` re-sorts the whole queue per insert

`timeline-preview-manager.ts:117-124`. O(n log n) per request with n = 2× segment
count. Negligible today; a binary insert would be cleaner.

---

## 6. Accessibility + UX

### F36 — P1. The studio is unusable below ~900 px and says nothing about it

`transcript-panel.tsx:331` — `display={{ base: "none", lg: "flex" }}`; the
transcript simply vanishes below 1024 px with no alternative.
`tool-sidebar.tsx:120` — `w={{ base: "260px", md: "300px" }}`, **never hidden**.
`layout.tsx:10-25` is `position: fixed; inset: 0`, so the app shell is replaced
entirely. At 375 px the inspector takes 260 px and the video preview gets ~115 px.
No breakpoint guard, no "open on a larger screen" message.

**Fix:** below `lg`, collapse the inspector into a bottom sheet and the
transcript into a tab, or gate the route with an explicit desktop-only notice.

### F37 — P1. "Apply to all clips" is destructive with no confirm and no undo

`captions-panel.tsx:725-749` → `clipService.applyCaptionPresetToAllClips`
(`clip.service.ts:924-943`) runs `updateMany` over every clip in the project,
overwriting per-clip caption styling the user may have hand-tuned. One click, no
dialog, no way back.

**Fix:** confirm dialog naming the affected count, and/or snapshot the previous
presets so the action is reversible.

### F38 — P2. Keyboard shortcuts stay live behind the modal

`studio-shell.tsx:417-491` registers on `window` and only skips
`INPUT/TEXTAREA/SELECT/contentEditable`. With the shortcuts dialog open,
<kbd>Space</kbd> toggles playback, arrows scrub, <kbd>D</kbd> splits and
<kbd>Backspace</kbd> deletes — all behind the modal. Same applies to the Chakra
`Menu`/`ColorPicker` popovers.

**Fix:** bail out when `showShortcuts` is true or when
`document.querySelector('[data-scope="dialog"][data-state="open"]')` matches;
better, scope the listener to the studio root element.

### F39 — P2. Timeline scrub surfaces are mouse-only

`timeline.tsx:951-1002` (ruler), `:1005-1057` (video track), `:1060-1083`
(waveform) each carry `onClick` + `cursor="pointer"` with **no** `role`,
`tabIndex`, `aria-label` or key handler. Segment blocks are correctly
keyboard-operable (`:478-484`), but the playhead cannot be moved from the
keyboard other than via the global arrow shortcuts.

Also: `timeline.tsx:898-914` — the zoom `Slider.Root` has **no `aria-label`**,
unlike every slider in the tool panels.

### F40 — P2. The caption object cannot be selected or moved from the keyboard

`interactive-caption-overlay.tsx:290-311` — the draggable `motion.div` has
`onClick` but no `role="button"`, no `tabIndex`, no key handling. Resize handles
(`:105-126`) are `Box`es with `onPointerDown` only. `Escape` deselects
(`studio-shell.tsx:483-486`) but there is no way to *select*, nudge, or resize
without a pointer.

### F41 — P2. Tab semantics are incomplete

`tool-sidebar.tsx:135-179`, `captions-panel.tsx:754-782`,
`text-panel.tsx:71-99` use `role="tablist"` + `role="tab"` + `aria-selected`,
but there is no `aria-controls`, the panel container has no `role="tabpanel"`,
and there is no roving-tabindex / arrow-key navigation. Screen readers announce
tabs that don't behave like tabs.

### F42 — P2. Autosave indicator says "Saved" before anything has been saved

`top-bar.tsx:65-84` — `saveState === "idle"` (the initial value) renders the
"Saved" dot and label. On first load the studio claims a save that never happened.

**Fix:** add an `"unsaved" | "clean"` distinction, or render nothing in `idle`
until the first successful write.

### F43 — P2. No error state for a failed video load

`video-preview.tsx:73-87` listens only for `loadedmetadata`. If the presigned R2
URL 403s (it expires after 3600 s — `page.tsx:84`) or the network drops, the
ghost stage stays on "No source loaded" forever with no error, no retry, and no
hint that the session simply expired.

**Fix:** add an `error` listener and a `stalled` timeout; on failure show a retry
that re-fetches a fresh presigned URL.

### F44 — P2. Delete has no confirm

`timeline.tsx:847-852` and the `Backspace`/`Delete` shortcut
(`studio-shell.tsx:448-451`) delete a segment immediately. It's undoable via
`Cmd+Z`, which is acceptable — but the same key path is one of the two operations
that *appear* to change the export and don't (F2).

### F45 — P2. Type sizes below the practical floor

10 px / 10.5 px / 11 px text appears in the ruler labels (`timeline.tsx:973`),
segment labels (`:511`), pause badges (`transcript-panel.tsx:426`), text-layer
rows (`text-panel.tsx:257`) and preset names (`preset-card.tsx:90`). Contrast
itself checks out — `studio.fgSubtle #828D9C` on `studio.surface #171B21` ≈ 5.1:1,
on `studio.raised #242A33` ≈ 4.1:1 (the theme comment at
`packages/ui/src/theme.ts:481-484` already acknowledges the latter) — but at
10 px the effective legibility is worse than the ratio suggests.

Minor: `studio.border` and `studio.raised` are the same value (`#242A33`,
`theme.ts:474-475`), so a raised chip on a surface background has an invisible
border.

### F46 — P2. Empty / loading states

`loading.tsx` is a good shell-shaped skeleton and `error.tsx` is solid.
`broll-panel.tsx:332-361` has a proper empty hint. Gaps: the transcript panel
renders nothing at all when `utterances` is empty (no "no transcript yet" state),
and `text-panel.tsx` gives no feedback when "Add text overlay" is clicked with an
empty textarea (`addLayer` silently returns at `:30`).

---

## 7. Suggested fix order

1. **F1** — stop autosave from deleting renders (silent, irreversible data loss).
2. **F3** — fix the scrubber offsets (core interaction, one-line-ish fix).
3. **F2** — either persist cuts or remove the split/delete affordances.
4. **P1 font** — self-host Bebas Neue / Anton / Oswald / Montserrat / Roboto /
   Open Sans via `next/font/local` and drop the `Impact → Anton` alias by
   removing Impact from the picker. This alone closes the largest parity gap.
5. **F5, F6, F17** — payload discrimination + client-side validation so autosave
   can never wedge.
6. **F4** — dirty-version tracking for the flush handlers.
7. **F21, F29, F30, F31** — the four confirmed performance/leak issues.
8. **P3/P4/P6/P7/P9** — one `renderScale` passed through `CaptionCue` for
   outline/shadow/glow/gap, plus emitting a "hold" Dialogue across intra-chunk
   pauses in the ASS generator.
9. **F20** — delete the `/edit` fork.
10. Everything else.

A regression test worth adding: a shared fixture that runs
`getCurrentCaptionState` and `generateAssFromSlice` over the same utterances and
asserts that, for a dense sample of timestamps, both produce the same visible
word set and the same active-word index. That single test would have caught P7,
P8 and P16.
