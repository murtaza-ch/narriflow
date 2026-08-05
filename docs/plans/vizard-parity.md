# Vizard parity plan for the Narriflow clip studio

Source: hands-on walkthrough of the Vizard.ai clip editor (editor?id=190756133, 2026-08-04),
cross-referenced against a full inventory of the current studio implementation, then
adversarially reviewed by Codex (gpt-5.6-sol, read-only, high effort) against the code.
The build order below is the review-corrected order: **foundation first** — no feature
work before the edit model exists.

## 1. Vizard editor feature inventory (observed)

### 1.1 Transcript panel (left, "Transcript" tab)
- Search within transcript; copy transcript; download transcript; filter view by highlight color.
- Pause chips inline in text (`[1.1s]`) between words/utterances.
- Click word → seek player. Double-click word → inline single-word "Correct" input
  (multi-word correction is deliberately blocked with a toast pointing to batch edit).
- Select any text range → floating toolbar:
  - **Create clip** (⇧⌘C) — spawn a new clip from the selected range.
  - **Delete** (⌫) — text-based ripple delete: text gets strikethrough, audio/video
    segment is removed from the timeline, total duration shrinks. Selecting deleted
    text shows a single **Revert** (R) button; deleted ranges stay visible + recoverable.
  - **Highlight** (H) with 4 colors (yellow/green/blue/purple) — annotation, filterable.
  - **Copy text** (⌘C), context menu with all of the above + Correct + Revert.

### 1.2 Edit subtitles tab
- Per-cue list with editable text and start–end timecodes; active cue highlighted.
- Sentence ↔ cue granularity toggle; **Paragraph batch-edit mode** (whole transcript
  as editable paragraphs with timestamps in the gutter).
- **Translation** popover: original language shown, target language dropdown, Translate.
- **Subtitle settings** toggles: Subtitle display on/off, Punctuation on/off, Emoji on/off.
- Per-cue "add emoji" button.

### 1.3 Right tool sidebar (10 panels)
1. **AI tools**: Remove silence (one-click), Auto-censor (mask style e.g. "F**k",
   optional beep sound effect, editable word list), Add B-rolls (AI), Emphasize
   keywords (highlight + enlarge), Add emojis to subtitle.
2. **Generate** (premium): AI motion graphics / video / image from a text prompt,
   with example gallery.
3. **Brand kit** (premium): saved template, logo image, subtitle style, text style, image.
4. **Template**: Save current look as template; template list; **Apply to all** checkbox.
5. **Subtitles**: preset grid of ~16 animated caption styles (karaoke box, glow, neon…)
   + Settings tab: font family, size, alignment, B/I/U, text color, stroke
   (width + color + none), spoken-word highlight color (red/yellow/green/none);
   **Apply to all**.
6. **Upload**: personal asset library (images/videos/audio), brand assets tab.
7. **Audio**: stock music library (categorized, searchable, preview play, durations)
   + sound-effects tab + upload.
8. **B-roll**: Pexels stock search grid + AI Generate + Upload; insert at playhead.
9. **Transition**: None / Fade to black / Fade to white / Dissolve / Blur / Zoom in
   blur / Zoom out blur / Shift / Paper / Stripes / Film1 / Film2 / Graffiti / Film II /
   Glitch / Smear / Flare / Comic flare; **Apply to all**.
10. **Text**: Add headline / Add body text + ~6 recommended styled presets.

### 1.4 Preview toolbar + canvas
- **Ratio**: 9:16 / 1:1 / 4:5 / 16:9 + Apply.
- **Background**: Color picker (full HSV + eyedropper + RGB + swatch grid) / Image
  presets (gradients, patterns) / Upload; **Apply to all**.
- **Layout**: grid of framing presets (original, single-speaker fill, speaker+screen
  stacked, 2-up, 3-up, grids…); **Apply to all**.
- **Element list**: per-layer visibility/selection (Original video, Speaker crop).
- Canvas is a true object editor: video, captions, and text are selectable boxes with
  drag/resize handles; element toolbar offers duplicate, flip, layer order, opacity,
  crop/fit, delete; preview zoom control (100% dropdown).
- Text elements: floating toolbar (font, size, align, case, color) + right panel with
  shadow / stroke / background / corners / box display.

### 1.5 Timeline
- Tracks: text overlays, subtitle cues, audio waveform (real), music (via Add audio),
  additional media via **+** (Select from transcript / Brand kit / Upload).
- **Fit to sentence** / **Fit to word** zoom presets; word-level chips per cue on the
  subtitle track; zoom slider; ruler; drag playhead.
- Split (S) at playhead; Hide timeline (⌘.); playback speed cycle
  (1x → 1.25 → 1.5 → 2 → 0.5 → 0.75); current/total timecode.
- Selecting transcript text highlights the matching timeline range and vice versa.

### 1.6 Top bar
- Undo / Redo (buttons + ⌘Z/⇧⌘Z). Undo stack covers **everything observed**:
  element visibility, element moves, transcript corrections, deletes, layout changes.
- **Reset to original**: dedicated button + confirm dialog ("reset the project to the
  original version? All changes you have made will be lost").
- Autosave with cloud icon; hover tooltip "Last saved: <timestamp>".
- Inline title rename + clip switcher dropdown.
- **Save** split button = export: 720p (free) ✓ / 1080p (premium) / Remove watermark
  (premium).

## 2. Current Narriflow studio — relevant state

(Full inventory: internal agent report 2026-08-04. Highlights that drive the plan.)

Strong already: 12 caption presets + 10 animations with burn-in parity discipline,
canvas caption drag/snap/resize, transcript editing with proportional retiming,
proxy-based preview + filmstrip timeline, autosave with dirty-tracking, Pexels B-roll
search, text/music/transition studio edits schema, brand templates, virality score.

Critical gaps vs Vizard:
- **Split/delete segments are cosmetic** — never persisted, never rendered.
- **Undo/redo covers only segments** (i.e. effectively nothing); no reset-to-original.
- No text-based delete/ripple ("delete words → shorter video"), no create-clip-from-selection.
- No in-studio trim; trim lives in a separate project-page dialog.
- Timeline is single-track, synthetic waveform, no word-level track, no trim handles.
- No remove-silence / filler-word removal; no auto-censor; no keyword emphasis.
- Layout/aspect controls are preview-only cosmetics; no layout templates; reframe
  worker exists but has no studio UI.
- No music library/upload (URL paste only); no original-audio volume/mute.
- No logo/watermark UI despite full worker support; no background color/image control.
- Text layers not editable after creation, not draggable on canvas.
- No subtitle translation path into the studio (dubbing exists project-level).
- Export: single aspect ratio, no resolution choice; no per-clip watermark toggle.

## 3. Verified constraints the plan must respect

Review-confirmed hazards, each with file:line evidence:

1. **Post-cut timing drift** — captions subtract `clipStartSec`
   (`use-current-caption.ts:31`), text layers and transitions use uncut output time
   (`render-clips.ts:788,821`), music uses uncut duration. Every consumer must go
   through one shared source↔edited time map or cuts will drift between preview
   and burn-in.
2. **Proxy double mapping** — playback already maps source→proxy
   (`previewStartSec`, `studio-shell.tsx:346`) and clock time linearly
   (`playback-clock.ts:75`); ripple editing adds a second nonlinear map on top.
3. **Render invalidation** — every real `studioEdits` save deletes all completed
   renders + R2 assets (`clip.service.ts:1934`), while caption/transcript saves
   invalidate nothing. Needs an editor-revision / render-revision policy, not
   delete-on-autosave.
4. **Undo/autosave races** — saves are three sequential PATCHes with no revision
   or cancellation (`studio-shell.tsx:529,569`); an older in-flight save can clear
   the dirty flag after a newer edit. Undo must not ship on this persistence model.
5. **Transcript writes silently recompute clip boundaries**
   (`clip.service.ts:2010`) without clearing the now-mismatched proxy or renders.
6. **Reset has no recoverable origin** — boundary edits overwrite
   `startSec`/`endSec`/`transcriptSlice` (`clip.service.ts:566`); the studio seeds
   from the current snapshot (`page.tsx:95`). Reset requires an immutable
   revision-zero snapshot.
7. **Create-from-selection must be atomic** — chaining duplicate + boundary update
   copies render/proxy assets then immediately deletes them
   (`clip.service.ts:813,555`) and can leave an orphan on partial failure.

## 4. Implementation order (canonical)

Single ordered sequence; each step lands independently. No feature step may start
before the foundation steps it depends on.

### Phase A — Foundation (was "P0")
1. **Shared range + time-map helpers** in `packages/validators`
   (`edit-ranges.ts`): normalized `deletedRanges`, bidirectional source↔edited
   mapping, range remapping, with cue-remapping tests. *(landed 2026-08-04)*
2. **One revisioned `EditorDocument`** — single document type (captionPreset +
   transcriptSlice + studioEdits + brollUrl + deletedRanges), monotonic
   `editorRevision`, atomic single-endpoint save with optimistic concurrency,
   explicit render-invalidation policy replacing delete-on-autosave, immutable
   revision-zero snapshot persisted at first studio open.
   *(landed 2026-08-04 — fa2f6d2 EditorDocument type, 095c0d3 atomic
   revision-guarded save endpoint)*
3. **Reducer + full undo/redo history** — all mutations (including B-roll, which
   currently PATCHes immediately from `broll-panel.tsx:110`) flow through one
   reducer with past/present/future history; autosave becomes revision-aware.
   *(landed 2026-08-04 — fa2f6d2 reducer + history in `packages/validators`,
   a38a97d studio wired to the unified document with revision-aware autosave)*
4. **Reset to original** from the revision-zero snapshot (boundaries, transcript,
   preset, studio edits, B-roll). *(landed 2026-08-04 — a38a97d)*
5. **Audio controls** — add `sourceAudio.volume/muted` + explicit music fade
   fields to the schema; apply source gain before `amix` (today unity gain,
   `render-clips.ts:882`); music panel stops resetting `startOffsetSec`
   (`music-panel.tsx:14`); preview audio parity so controls aren't export-only.
   *(landed 2026-08-04)*
6. **Logo/watermark** — decide ownership first (worker reads the project brand
   snapshot, `render-clips.ts:2031`; the studio brand panel copies caption styling
   only). Then persistence + preview overlay. *(landed 2026-08-04 — project brand
   snapshot stays the source of truth for the logo asset; `studioEdits.logo`
   adds per-clip enabled/position/opacity/scale overrides (null = inherit
   snapshot) via a shared `resolveEffectiveLogoSettings` helper in
   `packages/validators` used by both `render-clips.ts` burn-in and the studio
   preview overlay; brand-template-panel.tsx gained a Logo section)*

### Phase B — Text-based editing loop (was "P1")
7. **Worker cut-concat** — video/audio trim+concat from `deletedRanges`; retime
   captions, text layers, B-roll cutaways, transition, and music duration through
   the shared map.
8. **Preview ripple playback** — proxy playback skips deleted ranges; seeking,
   displayed duration, and timeline mapping all use the edited timeline.
9. **Segment split/delete persistence** — wire the existing timeline actions
   (`studio-shell.tsx:468,487`) to `deletedRanges`.
10. **Word-level Correct** — `updateWordText(utteranceIndex, wordIndex, text)`
    changing only that word + rebuilt utterance text (no proportional
    redistribution, which today rewrites every timing, `studio-shell.tsx:411`).
11. **Transcript selection Delete/Revert** — strikethrough metadata, words kept
    intact; selection toolbar (Delete / Revert / Copy / Highlight).
12. **Remove silence** — same range model; specify threshold, retained padding,
    edge treatment, merge-with-manual policy, no-op/fully-deleted guards. Seed UX
    from existing pause detection (`timeline.tsx:756`).
13. **In-studio trim** — reuse word-snapping from `edit-clip-length-dialog.tsx`,
    make studio boundaries mutable (today immutable props,
    `studio-shell.tsx:281`), define rebasing of deleted ranges + timed overlays,
    handle the cleared preview proxy explicitly.
14. **Create clip from selection** — new atomic service op + route (no
    duplicate→retrim chain).
15. **Word chips + fit-to-sentence/word zoom** — cheap; timed words already loaded.
16. **Real waveform peaks** — separate deliverable: worker artifact + storage
    convention + persistence/presigning + UI loader (today randomized,
    `timeline.tsx:261`; preview completion persists video metadata only,
    `clip-preview.ts:978`).

### Phase C — Canvas + tracks polish (was "P2", corrected)
- Editable/draggable text layers on canvas; timeline retiming of layers.
  *(Landed 2026-08-05 — canvas drag/resize/select via `InteractiveTextLayer`
  (`interactive-text-layer.tsx`, new), a per-layer editing surface in the new
  Text tool panel (`tool-panels/text-panel.tsx`) covering font/size/color/
  outline/background/timing, and timeline retiming through the new
  `TextLayerChip` track (`timeline.tsx`) — move + independent start/end
  resize grips, same pointer-capture delta-drag pattern the clip-level
  `TrimHandle` uses.)*
- Background color/image (+ apply-to-all) with render parity. *(per-clip
  color/image landed 2026-08-05 — `studioEdits.background` schema
  (`packages/validators/src/studio-edits.ts`); worker
  `buildFitAndBackgroundFilter` fit+pad (color) / cover-fit-image+overlay
  (image) compose path used instead of `buildCropAndScaleFilter` whenever a
  background is active, in both the single-video and B-roll cutaway
  builders, with auto-reframe bypassed; studio preview stage renders the same
  color/image behind a letterboxed video; new Background tool panel.
  Apply-to-all landed 2026-08-05 — see the transition bullet below, same
  `applyStudioEditsPatchToAllClips` bulk service backs both.)*
- Layout presets — **bigger than it looks**: `layoutMode` is local preview state
  and the worker auto-reframes independently; needs schema + worker contract.
- Music/SFX library (curated CDN + R2 upload; keep URL escape hatch).
- Subtitle visibility / punctuation / per-cue emoji overrides (global emoji
  toggle already exists, `captions-panel.tsx:339`) — distinct schema changes.
  *(Visibility + punctuation landed 2026-08-05 —
  `packages/validators/src/caption-preset.ts` adds `visible`/`punctuation`
  (both optional booleans, absent = shown/kept — same convention as
  `emojis`) plus the shared `formatCaptionWord` helper (strips edge
  punctuation, preserves intra-word apostrophes/hyphens, collapses a
  pure-punctuation token to `""`). Worker: `buildSubtitleFilter`
  (`render-clips.ts`) is the single choke point every render path
  (single-video, fit+background, multi-video, B-roll cutaway, audiogram)
  routes subtitle burn-in through, so gating `visible === false` there turns
  off subtitles everywhere at once; `generateSrtFromSlice` and
  `generateAssFromSlice` route every cue token through `formatCaptionWord`
  when `punctuation === false`, dropping empty tokens/cues instead of
  emitting blank text. Studio preview: `CaptionCue`
  (`caption-style-engine.tsx`) reads `punctuation` off the same preset object
  and calls the identical helper, so preview and burn-in can't fork;
  `InteractiveCaptionOverlay` hides on `visible === false` and deselects the
  caption if it was selected when the toggle flips off. Emoji lookup
  (`emojiForWord`) intentionally still reads the RAW word in both preview and
  worker — its own key normalization already strips every non-a-z character,
  so punctuation stripping can never change which keyword matches. Two new
  toggles in `captions-panel.tsx` ("Subtitles", "Punct.") next to the
  existing emoji toggle, committed through the same `setCaptionPreset` path
  (undoable) and riding `applyCaptionPresetToAllClips` bulk apply for free
  since it carries the whole preset. Per-cue emoji overrides remain
  DEFERRED — not built.)*
- Transition apply-to-all + more styles — **landed 2026-08-05.** Bulk
  invalidation/versioning now exists: `applyCaptionPresetToAllClips`
  (`clip.service.ts`) deletes stale `ClipRender` rows + their R2 assets in
  the same transaction as its `updateMany` (it used to bump
  `editorRevision` without invalidating renders at all — completed renders
  stayed downloadable with a stale caption style); the new
  `applyStudioEditsPatchToAllClips` does the JSON-blob equivalent for
  `studioEdits.transition`/`studioEdits.background` (per-row
  read-parse-merge-write, since a bulk `updateMany` can't touch one field of
  a JSON column). Both accept `excludeClipId` so the studio session that
  originated the change skips itself server-side — that clip already has it
  applied locally via the open editor document and persists it through the
  normal revision-guarded autosave; writing it server-side too would bump
  its `editorRevision` out from under that autosave's `baseRevision` and
  409 it (this was a live bug in the caption flow, fixed the same way here).
  Route: `POST /projects/:id/clips/apply-studio-edits`. Also added the
  previously dead `fade-black` transition style to the Transitions panel,
  with an explicit `:color=black` mapping in the worker's
  `buildTransitionFilter` (exported + unit-tested,
  `apps/worker/src/tasks/render-clips.ts`) alongside `dip-white`'s
  `:color=white` — both used to rely on ffmpeg's `fade` filter defaulting
  to black.
- Export options — **landed 2026-08-05.** Render identity stays
  `[clipId, aspectRatio]` (replace-in-place, not versioned) — a new
  `ClipRender.resolution` string column ("720p" | "1080p", default "1080p")
  records what a render actually targeted, so re-exporting at a different
  resolution goes through the existing delete/recreate flow instead of adding
  a new identity axis. Watermark/1080p gating moved off the hardcoded
  `ownerTier === "free"` check into a real entitlement helper:
  `hasFeature(tier, feature)` in `billing.service.ts`, backed by a single
  `PLAN_FEATURES` matrix (`PlanFeature = "export.1080p" | "export.noWatermark"`;
  free gets neither, every paid tier gets both) — pure, unit-tested,
  re-exported from `@narriflow/services`. `triggerClipRendering` and
  `autoQueueDefaultRenders` both resolve a requested resolution through the
  same `resolveRequestedResolution` clamp (1080p request without the
  entitlement silently clamps to 720p — freemium UX, never an error) and
  persist the resolved value on the created/reset `ClipRender` rows. The
  worker reads `resolution` off each row instead of computing one
  run-level `applyFreeTierTreatment` flag: the old fused
  `buildFreeTierWatermarkFilter` (downscale + drawtext, always paired) split
  into an independent `buildResolutionScaleFilter` (per-row resolution) and
  `buildWatermarkDrawtextFilter` (run-level `hasFeature(ownerTier,
  "export.noWatermark")`), recombined per output via
  `buildExportTreatmentFilter` — so a paid user can pick 720p with no
  watermark, matching the entitlement model instead of a single free/paid
  toggle. `buildMultiVideoArgs` (the shared multi-output batch encode) now
  reads resolution per output while watermark stays uniform for the run.
  UI: the "Render formats" popover (`render-clips-button.tsx`, used by both
  the project page's render button and the ranked-rows "Render selected"
  bulk action) gained a 720p/1080p `SegmentedControl`, defaulting to the
  best the plan allows and disabling 1080p with an upgrade link for tiers
  without the entitlement (`can1080pExport`, computed server-side in
  `page.tsx` via `hasFeature`). A per-clip watermark toggle was intentionally
  **not built** — watermark presence is entitlement-derived, never a user
  choice, per the settled architecture.

### Phase D — AI surface (was "P3")
- Auto-censor (word list → mask via caption pipeline + beep audio filter).
- Emphasize keywords (LLM pick → per-word style overrides).
- AI B-roll multi-cutaway control (planner exists in worker) + timeline chips.
- Subtitle translation in-studio (reuse dubbing services for caption-only path).
- AI hook suggestions (title suggestions already in-studio via `ClipActionsMenu`).
- AI motion-graphic generation — defer; external providers.

## 5. Settled observations for implementers
- Vizard's delete keeps deleted text visible (strikethrough) and recoverable —
  do the same; it makes destructive editing feel safe without undo-stack gymnastics.
- Vizard's undo covers every mutation; ours must move to the single history stack
  (Phase A step 3) before adding more mutation types.
- "Apply to all clips" is a first-class concept on nearly every Vizard panel —
  generalize only after bulk invalidation exists.
- Words-per-cue configurability is NOT a cheap win: `CAPTION_CHUNK_SIZE` is
  intentionally shared across the preview and both worker caption generators
  (`caption-preset.ts:6`, `render-clips.ts:523`); it needs a persisted field and
  shared cue-builder changes.
- Export gating (720p free / 1080p paid / watermark paid) fits our plan model but
  requires the billing-gate + render-identity work noted in Phase C.
