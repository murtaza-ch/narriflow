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
- Layout presets — **design converged 2026-08-05** (recon: reframe recon
  report, this session). **Live-editor recon 2026-08-05 (driven Vizard's
  actual editor on a real clip):** layout controls live in an under-canvas
  toolbar `Ratio | Background | Layout | Element`, not a side panel.
  Layout popover = a grid of 11 VISUAL preset thumbnails (drawn
  mini-mockups: solo fill, solo fit w/ bands, 2-up full-bleed, 2-up
  cards, 1+2, 2×2 full-bleed, 2×2 cards, floating 2+1 cards,
  screen+2-speakers, screen card centered, screen fit) + an
  "Apply to all" checkbox (default UNCHECKED; checking applies each
  SUBSEQUENT preset click project-wide — no immediate effect).
  Background popover = Color | Image (stock gallery incl. video-blur) |
  Upload tabs, its Apply-to-all default CHECKED. Ratio = 9:16/1:1/4:5/16:9
  behind an explicit Apply button (deliberate re-layout, not live).
  Element picker = detected source ELEMENTS (Original video / Speaker /
  Screen) that feed the layouts; on a one-face video the 2-up preset
  renders an EMPTY second tile, and unchecking Speaker falls back to the
  full frame letterboxed. Canvas model: every tile is a free-position
  layer — click selects (resize handles + floating toolbar: mask-ratio
  9:16/1:1/4:5/16:9/Circle/Original, flip-H, corner radius, Duplicate,
  z-order, delete), drag moves it freely over the background. Full
  parity therefore decomposes into: preset-grid presentation (landed —
  below), multi-tile presets (rides the 2-up spike + segment machinery),
  element segmentation (speaker/screen detection), and a free-layer
  canvas compositor (largest; overlaps the dual-video preview cost).
  Two-stage delivery:
  1. **Framing modes (build first, cheap)** — persist
     `studioEdits.framing = { mode: "auto" | "center" | "fit" }`;
     `auto` = today's auto-reframe crop, `center` = static center crop
     (skip `detectFacePath` entirely; the no-sendcmd `crop=` branch of
     `buildCropAndScaleFilter` already exists), `fit` = the landed
     background/fit path. Consolidate the currently scattered mode checks
     (`background.mode` gates at three call sites in `render-clips.ts`)
     into ONE framing-mode dispatch so a fourth mode can't silently
     double-apply. Framing and background are the same radio group in the
     UI (crop-auto / crop-center / fit+background), not independent flags.
     *(Landed 2026-08-05 — `studioEdits.framing = { mode: "auto" | "center" }`
     (`packages/validators/src/studio-edits.ts`); `fit` is deliberately NOT a
     `framing` enum value — it's derived entirely from
     `background.mode !== "off"` so the two fields can't disagree. The single
     dispatch point is the new exported `resolveEffectiveFramingMode(studioEdits)
     → "auto" | "center" | "fit"`, used by both the worker and the studio (no
     forked logic). Worker: `shouldRunAutoReframeDetection` gates the
     `detectFacePath` call in `render-clips.ts` (only "auto" runs detection —
     "center" skips it for a static crop, "fit" skips it because the fit
     branch never crops); the background/fit-plan gate now reads
     `resolveEffectiveFramingMode(studioEdits) === "fit"` instead of the raw
     `background.mode` check (same truth table, one source). The
     `buildFitAndBackgroundFilter` vs `buildCropAndScaleFilter` builder branch
     in both `buildSingleVideoArgs` and `buildBrollVideoArgs` needed no change
     — it already keys off the resolved `BackgroundPlan | null`, which is only
     ever constructed when the effective mode is "fit". Apply-to-all:
     `applyStudioEditsPatchSchema` extended to a 3-way XOR
     (transition|background|framing); the Background tool panel was
     repurposed into a Layout panel (`tool-panels/layout-panel.tsx`, sidebar
     `ToolId` renamed `background`→`layout`) with the framing radio group on
     top and the existing color/image controls revealed only under Fit ("None"
     isn't offered inside Fit — picking Fit with no color set defaults to
     black). Apply-to-all from that panel sends `background` alone for Fit
     (it always wins over `framing` on the receiving clip), or `framing` plus
     a second sequential `background: {mode:"off"}` call for Auto/Center (so a
     receiving clip whose own background is active actually clears it instead
     of silently keeping "fit"). `framing`'s `.default({mode:"auto"})` follows
     the same convention as `background`/`logo`, so old documents don't appear
     dirty on load — `document` and `original` both parse through the same
     updated `studioEditsSchema` at request time in
     `clipService.getClipEditorDocument`, so a stored blob with no `framing`
     key fills in the identical default on both sides.)*
     *(Stage 1.5 landed 2026-08-05 — Vizard-style PRESENTATION on the same
     model: the icon radio became a grid of drawn 9:16 preset thumbnails
     (`tool-panels/framing-preset-thumbnails.tsx` — silhouette + corner
     brackets for Auto, crosshair for Center, mini 16:9 rect w/ bands for
     Fit; 2px `studio.ring` border marks selection, the repo's only
     selection idiom), and the "Apply to all clips" button became a
     header "Apply to all" CHECKBOX with Vizard semantics: session-local,
     default unchecked, no immediate effect — while checked, preset
     clicks / submode switches / color commits / image-URL applies also
     fire the existing bulk endpoint with the unchanged Fit→background
     vs Auto/Center→framing+background-off two-call sequence and
     `excludeClipId`. Color keystrokes/coalesced ticks never fire bulk.
     Verified interactively via the temporary /dev-preview harness,
     since deleted.)*
  2. **Split-screen 2-up (own sub-plan — genuinely large)**. Constraints
     found: `reframe_detect.py` deliberately emits only the largest face
     per frame (multi-face output is a trivial change; tracking/clustering
     is real new work); no face-track identity exists; AssemblyAI
     diarization (`TranscriptUtterance.speaker`/`speakerLabel`) is unwired
     into the render path but is the cheapest region-assignment signal
     (correlate speaker turns with face-cluster positions instead of pure
     visual tracking). Worker filtergraph is a natural
     `buildFitAndBackgroundFilter`-style extension (split → 2× crop/scale →
     vstack → same `[outvbase]` contract). The dominant cost is PREVIEW:
     one `<video>` element can't show two different crops of one frame —
     needs dual clock-synced `<video>` elements (moderate rewrite) or a
     canvas compositor (large rewrite). Sequence: worker spike
     (multi-face emit + diarization-assisted assignment + vstack graph on a
     real 2-speaker video) BEFORE any preview work; single-face stretches
     fall back to single-speaker framing; B-roll cutaway replaces the whole
     2-up frame (simplest defensible policy).
     *(Worker spike DONE 2026-08-05, on real footage — 90s of the dev DB's
     Jensen Huang interview (2 diarized speakers, source pulled from R2;
     note: several older dev projects' R2 sources are gone, 404 — only the
     Jensen + quantum-computing sources still exist). Landed:
     `reframe_detect.py --multi` (additive; default output verified
     byte-identical), pure `apps/worker/src/tasks/two-up.ts`
     (`clusterFaceTracks`, `classifyShotSamples` + segment collapse,
     `assignSpeakersToClusters`, `buildTwoUpFilterChain`) + 21 tests.
     VALIDATED: largest-gap 1-D clustering nails the two seats (host
     cx≈0.34, guest cx≈0.63) and survives 3-face false positives via
     nearest-distance matching; 5-sample majority smoothing + micro-segment
     merge yields sane shot segments (12 over 90s — real interviews cut
     constantly: only ~1/3 of samples are two-shots, so segment-switching
     is the common case, not the edge case); split→2×crop→scale→vstack
     satisfies the `[outvbase]` contract; frames verified — both faces
     correctly seated top/bottom, no half-face crops. GOTCHA: ffmpeg
     `sendcmd` dispatches by filter NAME graph-wide, so the two tile crops
     need distinct names (`TWO_UP_TOP_CROP_NAME`/`TWO_UP_BOTTOM_CROP_NAME`)
     — reusing reframe's single crop name would steer both tiles at once.
     OVERTURNED ASSUMPTION: diarization-assisted assignment via "which
     cluster is solo on screen during this speaker's turns" FAILS as a
     naive majority vote — shot selection is biased toward the star guest
     (Jensen solo in 73% of ALL single-shots regardless of who is
     talking), so both speakers voted for the same cluster. Production
     must baseline-correct (PMI/log-odds vs each cluster's overall solo
     share) and should treat visual active-speaker detection (mouth
     motion × audio energy) as the primary signal with diarization as a
     prior only. ALSO LEARNED: cluster means are NOT laterally stable
     across shots (left seat ranged cx 0.16-0.43) — production needs
     per-segment means, and single-shot fallback segments must route
     through the EXISTING auto-reframe path (the spike's global-mean
     fallback visibly off-centers subjects whose close-up composition
     differs from the wide shot).
     **Packets A/B/C landed (2026-08-05, this diff):** per-segment crop
     centers (`buildSplitLayoutPlan`'s per-window cluster means, not the
     spike's global mean), the segment-aware render-clips.ts machinery
     (multi-face detection → `decideSplitFallback` → per-output
     `buildSplitFilterChain`, with its own `SplitFallbackReason` set:
     `broll_conflict` / `detection_unavailable` / `insufficient_clusters` /
     `empty_plan` / `no_two_up_segments` / `tiles_not_distinct` / `disabled`
     / `null`), and the live dual-`<video>` preview (video-preview.tsx's top
     tile + a second muted `SplitSecondaryTile` for the bottom seat, static
     0%/100% seat positions client-side since no face detection runs in the
     browser). Adversarial review on this landing also fixed a `concat`
     SAR/pixel-format mismatch that hard-failed any mixed two-up+single
     render plan (verified against real ffmpeg 8.0.1) and added the
     per-output `tiles_not_distinct` fallback for aspect ratios (1:1, 16:9,
     or any portrait source) whose tile crop can't seat two laterally
     distinct centers.
     **Remaining for production:** active-speaker assignment (still
     diarization-majority per this function's own doc comment — the
     baseline-correction/visual-active-speaker work above is unbuilt, so
     tile top/bottom assignment stays "whichever cluster's mean cx is
     smaller," not "whoever is credited as speaking"), crossfades on
     segment/mode switches (v1 is hard cuts only, by design), per-segment
     sendcmd smoothing (today's segments are static per-segment crops, not
     sendcmd-driven within a segment), b-roll composition with split (v1
     policy: b-roll always wins the whole frame, `broll_conflict` fallback),
     and VFR source validation (the segment `trim`+`concat` timing assumes
     a constant frame rate; an unusually-VFR source is unverified). Memory:
     a 60s/24-segment 1080p mixed-plan render measured ~683MB peak worker
     RSS vs a ~267MB non-split baseline of the same clip — each segment's
     own `split`+crop+scale branch in the filtergraph adds real memory, not
     just graph-build complexity; worth a headroom check before raising
     `maxSegments` much past today's default of 24.)*
  3. **Screen+speaker layout (screen packet B, own sub-item)** — v1 LANDED
     (2026-08-05, this diff). Honest scope: this is NOT the "element
     segmentation (speaker/screen detection)" work item named above — there
     is no PiP-facecam region detection and no vertical tracking.
     *(Element-segmentation SPIKE done 2026-08-05, on 7 synthetic
     screencast fixtures built from real face footage — full numbers in
     the spike report; headline findings: (1) temporal-motion mapping via
     per-pixel MEDIAN ABSOLUTE frame diff (std is the wrong statistic —
     fooled by slide flips) at 2fps/320-wide recovers the facecam rect at
     IoU 0.93-0.98 for ~0.65s per 40s clip, but ONLY with a
     corner-adjacent + compact-size structural prior — naive
     largest-motion-blob selection picks an embedded video-in-video over
     the facecam (IoU 0.000), a measured failure not a hypothesis; (2)
     face-box expansion alone is NON-functional for wide-framed facecams:
     at production's DETECT_MAX_DIM=320 the PiP face is detected in 0% of
     samples, and even at full resolution (4x runtime) expansion IoU is
     0.09-0.12; it works passably (IoU ~0.5) only for tightly-framed
     cams, and remains the right fallback for the one case motion can't
     see — a frozen/still facecam; (3) classification gate:
     `moving_px_frac` (share of pixels above a small median-diff noise
     floor) separates screencast-like (0.00-0.11 across all fixtures)
     from regular talking-head footage (0.67 on the one real control) —
     threshold ~0.25 proposed but MUST be validated against real library
     sources before hardcoding, and the corner-blob finder must be gated
     BY this classifier (run alone on a talking-head video it still
     "finds" a hand gesture near the frame edge). Recommended production
     design: classify → locate rect via motion+prior → still-speaker
     fallback to boosted-resolution face detection → degrade to today's
     band; within-rect tracking reuses the existing reframe path scoped
     to the sub-rect. Residual risks: short-window stability drops when a
     second strong motion source is in frame (require full-clip
     aggregation), multi-face PiPs untested, single negative control for
     the threshold.)* The bottom
     tile is a face-CENTERED HORIZONTAL crop of the WHOLE source frame, the
     exact same single-face tracking `reframe.ts`'s auto-reframe path
     already uses, just aimed at a half-height tile instead of the full
     output; true speaker/screen element segmentation (locating an actual
     facecam/webcam sub-region within the frame) was, at the time this v1
     landed, that separate, unstarted epic — see the "Element segmentation
     v1" landed-note directly below for its own v1 landing (2026-08-06),
     which upgrades exactly this BOTTOM tile from a face-centered band to
     the actual facecam PiP rectangle when one can be found. Landed:
     `apps/worker/src/tasks/screen-layout.ts`
     (`buildScreenSpeakerFilterChain`/`screenTileGeometry`/
     `screenBottomIsTrackable`), `render-clips.ts`'s
     `applyScreenSpeakerLayout`/`decideScreenFallback`/
     `framingForcesPerOutputRender`, the live two-tile preview
     (video-preview.tsx's `isScreen` block, contain-fit top + centered-cover
     bottom), and a `WORKER_SCREEN_LAYOUT` kill switch (see
     `docs/agent/setup.md`). B-roll always wins the whole frame (v1 policy,
     same as split); no vertical tracking (same policy as split's own
     tiles).
     Adversarial review on this landing (verified against real ffmpeg 8.0.1)
     found and fixed two load-bearing bugs: (1) the naive `Math.round(H / 2)`
     tile-height split produces an ODD height for 4:5 (1080x1350 → 675) —
     `pad`'s yuv420p output floors an odd dimension to even, so the top tile
     silently became 1080x674 while the bottom tile (via `crop`+`scale`,
     which has no such floor) stayed 675, and `vstack`ing 674+675 yields
     1080x1349, which `libx264` refuses to encode outright at 1080p (and
     silently mis-scales at 720p) — every 4:5 screen-layout render failed.
     Fixed by forcing `bottomHeight = 2 * Math.floor(H / 4)` (always even by
     construction) and `topHeight = H - bottomHeight` (also always even,
     since target `H` is itself always even for all four output aspect
     ratios) instead of splitting evenly and hoping. (2) wide/square targets
     (1:1, 16:9 against a landscape source) have no lateral room for the
     bottom tile's crop to move — the tile-aspect crop already consumes the
     full source width, so the sendcmd track driving it is a mathematical
     no-op (every face position clamps to the same `x`), yet a sendcmd
     script was still being built and the log still claimed
     `bottomTracking: "face"`; added `screenBottomIsTrackable` as the gate
     (mirrors split's own `splitTilesAreDistinct`) so those outputs render
     an honest static-center bottom tile with no dead script and an accurate
     log reason (`no_lateral_room`).
  4. **Element segmentation v1 (facecam PiP detection for "screen" mode)** —
     v1 LANDED (2026-08-06), following the spike design above exactly. The
     BOTTOM tile now crops the ACTUAL facecam picture-in-picture rectangle
     (not a face-centered band) when the source is screencast-like AND a
     PiP region was located; otherwise falls straight through to the
     pre-existing whole-frame face-tracked/static-center band, byte-
     identical to before this item. New:
     `apps/worker/scripts/pip_detect.py` (samples ~2fps at a 320-wide
     grayscale downscale, computes the per-pixel MEDIAN ABSOLUTE frame-to-
     frame difference map, emits `movingPxFrac` + connected-component
     candidates each flagged corner-adjacent/area-share/fill-share —
     `reframe_detect.py` untouched); `screen-layout.ts`'s
     `classifyScreencast`/`selectPipRect`/`fitPipCropToTile` (pure TS, the
     corner-adjacent + compact + dense structural prior) and
     `ScreenSpeakerBottomSpec.pipRect` (wins over `cx`/`reframe` — a facecam
     overlay doesn't move, so its crop is always static, never
     sendcmd-driven); `render-clips.ts`'s `detectPipPath` + the PiP-first
     branch inside the "real screen layout" wiring (reuses the SAME
     extracted detection segment `detectFacePath` already used, rather than
     extracting twice); a `WORKER_PIP_DETECT` kill switch and
     env-configurable `WORKER_PIP_MOTION_THRESHOLD` (default `0.12`, see
     `docs/agent/setup.md`).

     Adversarial review on this landing found and fixed several issues, the
     three load-bearing ones first: **(H1) the default threshold was
     calibrated on raw files, not the proxy production actually analyzes.**
     `detectPipPath` never runs against a clip's raw source — it runs
     against `extractFaceDetectionSegment`'s local proxy (`-vf scale=-2:360
     -c:v libx264 -preset ultrafast -crf 30`), built whenever the source is
     an HTTP(S) presigned URL (the common case in production; a local file
     skips the proxy, but a real render's source essentially never is one).
     The original 0.25 default, and the "threshold validation" table it was
     based on, measured `movingPxFrac` on raw files only — never
     re-validated through the actual analysis path. Recalibrated with a new
     script, `apps/worker/scripts/pip_calibrate.sh`, which reproduces
     `extractFaceDetectionSegment`'s exact ffmpeg invocation and runs
     `pip_detect.py` on both the raw file and that proxy, side by side, for
     a list of inputs. Run over the packet's own 7 synthetic screencast
     fixtures + the real talking-head control (`jensen-0-90.mp4`), each over
     its own FULL duration (40s for every fixture, 90s for jensen — a
     uniform "whole file" window, not an arbitrarily chosen sub-clip):

     | file | raw `movingPxFrac` | proxy `movingPxFrac` | proxy/raw ratio |
     |---|---|---|---|
     | screencast-fixture.mp4 | 0.02760 | 0.02759 | 1.00 |
     | screencast-fixture2.mp4 | 0.01889 | 0.01877 | 0.99 |
     | screencast-fixture3-motion.mp4 | 0.04120 | 0.03887 | 0.94 |
     | screencast-fixture4-tightcam.mp4 | 0.03825 | 0.03823 | 1.00 |
     | screencast-fixture5-hardmotion.mp4 | 0.04783 | 0.05087 | 1.06 |
     | screencast-fixture6-stillspeaker.mp4 | 0.0 | 0.0 | n/a |
     | screencast-fixture-portrait.mp4 | 0.02822 | 0.02761 | 0.98 |
     | jensen-0-90.mp4 (full 90s) | 0.26818 | 0.27262 | 1.02 |
     | jensen-0-90.mp4 (first 20s only, for comparison) | 0.57510 | 0.55144 | 0.96 |

     Headline result: the proxy re-encode barely moves `movingPxFrac` for
     this content (ratios 0.94-1.06, i.e. within ~6% of the raw value either
     direction) — CRF-30/360p compression doesn't meaningfully wash out the
     per-pixel motion signal this classifier reads. Worst-case screencast
     fixture (proxy) is 0.0509 (fixture5-hardmotion); worst-case (lowest)
     jensen measurement (proxy) is 0.2726 (the full-90s window — the 20s
     window measures even higher, 0.5514, so the full window is the more
     conservative bound). Ratio 0.2726 / 0.0509 ≈ 5.36 — comfortably over
     this packet's 2x "clean separation" bar. Per the packet's decision
     rule, the new default is the GEOMETRIC MEAN of those two boundary
     values (sqrt(0.0509 × 0.2726) ≈ 0.1178, rounded to **0.12**) rather
     than either boundary itself, and the feature stays **default-ON**
     (`WORKER_PIP_DETECT` unset/anything other than `"0"` still enables it)
     — the (H2) face-confirmation guard below is the second line of defense
     against a misclassification, not the threshold alone.

     *Why this table replaces (not just supplements) the original
     raw-only one, and why the numbers don't match 1:1*: the original
     "threshold validation" note's raw numbers (`movingPxFrac` 0.0000-0.0478
     for the fixtures, 0.2682/0.5751 for jensen) were measured over
     DIFFERENT windows than this table in at least one case (a "first 20s"
     jensen slice existed there but isn't the packet's own full-duration
     convention used here) and were never run through this diff's later
     python-side fixes (H3's `CANDIDATE_MIN_THRESHOLD` floor, M2's
     corner-adjacent compactness check, M5's uint8 memory change) — none of
     which touch `movingPxFrac`'s own computation (`diff_map >
     MOVING_NOISE_FLOOR`, unchanged), so the RAW-file numbers in this new
     table land within noise of the old ones (e.g. fixture5-hardmotion raw
     0.0478 old vs. 0.04783 here) — but they're re-measured here specifically
     so the whole table (raw AND proxy, same script, same run, same
     documented window) is reproducible from one command
     (`apps/worker/scripts/pip_calibrate.sh <files...>`) instead of trusting
     two different ad hoc measurements taken at two different times to
     agree. The marketing-clip numbers in the ORIGINAL note (`broll.mp4`
     0.1640, `caption-loop.mp4` 0.0378, `moment-detect.mp4` 0.0004,
     `real-clip-9x16.mp4` 0.2310, `repurpose-burst.mp4` 0.0217, flagging
     `real-clip-9x16.mp4` as a real talking-head clip sitting just under the
     old 0.25 default) were RAW-only and were not part of this packet's
     required re-validation scope (7 fixtures + jensen); they're kept here
     as a data point but not re-run through the proxy, and — worth noting
     given the new lower 0.12 default — `real-clip-9x16.mp4`'s 0.2310 now
     sits comfortably ABOVE the new threshold (correctly NOT
     screencast-like), where it was only borderline-below the old 0.25 one.

     **(H2) face-confirmation guard against motion segmentation's measured
     false positive.** Before this fix, a selected `pipRect` won
     unconditionally — the packet's own measured false positive (a hand
     gesture near the frame edge on real talking-head footage reads as a
     corner-adjacent, compact, dense motion blob) would have rendered a
     6x-upscaled hand as the "facecam." Fixed by `confirmsFaceInRect`
     (`screen-layout.ts`, pure/unit-tested): `detectFacePath` now runs
     UNCONDITIONALLY on the same extracted segment (restored to its
     pre-PiP-feature behavior — it's also still the whole-frame fallback
     detector), and a candidate rect is only trusted when faces were found
     in ≥25% of ALL samples AND the dominant face's `cx` falls inside the
     rect's `[x, x+w]` span in ≥60% of the face-bearing samples (single-face
     `FaceSample` carries no `cy`, so only horizontal containment is
     checked). `render-clips.ts`'s `decidePipUsage` (M6, pure/exported/
     unit-tested for the full 9-reason ordering: `disabled` →
     `segment_extract_failed` → `detection_unavailable` →
     `insufficient_samples` → `not_screencast_like` → `no_candidate` →
     `face_not_in_rect` → `pip_too_small` → `ok`) is the single decision
     matrix both the clip-level gate and each output's `pip_too_small` check
     (M3: `screen-layout.ts`'s `pipCropTooSmall`, rejecting a fitted crop
     under 40% of its tile's width) run through — replacing what used to be
     an inline if/else chain duplicated across two call sites.

     **(H3) the candidate-mask floor was below the classifier's own noise
     floor.** `CANDIDATE_MIN_THRESHOLD` (1.0) sat under `MOVING_NOISE_FLOOR`
     (4.0, the level the classifier itself treats as sensor noise) — on
     grainy footage where the 92nd-percentile diff is near zero, connected
     components could form from pure noise. Fixed by setting
     `CANDIDATE_MIN_THRESHOLD = MOVING_NOISE_FLOOR`.

     Other fixes from the same review: **(M1)** `pip_detect.py` now emits
     `fillFrac` (pixel area / bbox area) per candidate; `selectPipRect`
     requires `fillFrac >= 0.35`, MERGES overlapping/adjacent
     (IoU > 0 or gap < 2% of frame) corner-qualifying candidates into one
     region before selecting (a real facecam commonly thresholds into 2+
     disconnected components), and picks by highest pixel-area-weighted
     `medianDiffMean` with size as the tiebreak — replacing the old
     raw-smallest-wins rule, whose doc comment incorrectly claimed
     spike validation (the spike validated corner-adjacent + compact, not
     "prefer smallest"). **(M2)** `cornerAdjacent` now also requires the
     component's extent to stay under 50% of the frame on BOTH axes,
     closing a gap where a full-width/full-height motion strip (a ticker, a
     wipe) could pass the edge-margin check alone. **(M4/L4)**
     `pip_detect.py` requires ≥8 samples AND ≥60% coverage of the requested
     duration, emitting `{movingPxFrac: null, insufficientSamples: true}`
     otherwise instead of a misleading `0.0` (which read as "definitely
     screencast-like"); the TS side treats both as "not screencast-like"
     (fails safe). **(M5)** frames are now kept as uint8 (not upcast to
     float32) and diffed via `cv2.absdiff` — smaller peak memory, same
     result; noted in-line that this script and `reframe_detect.py` already
     pay a double-decode cost over the same segment, not restructured here.
     **(L1)** the module doc comment's claim about `reframe_detect.py`'s CLI
     shape was wrong (fps is the 4th positional arg, the model path is 5th,
     not the other way around) — fixed. **(L2)** `fitPipCropToTile` now
     rounds `w`/`h` BEFORE clamping `x`/`y` against them, so `x + w` can
     never exceed the source frame by a rounding pixel. **(L3)** the
     `clip_screen_pip_detected` log now includes the per-OUTPUT fitted
     source-pixel rect (not just the one normalized rect shared across
     outputs), since `fitPipCropToTile`'s result differs by output aspect
     ratio.

     Honest-scope note (M7): the live two-tile PREVIEW (video-preview.tsx's
     `isScreen` block) still renders its bottom tile as a static 50%/50%
     center-cover crop — it has no way to know a `pipRect` exists, since PiP
     detection is a RENDER-time-only step (it needs `pip_detect.py` sampling
     real frames, not something the browser preview can run). This gap
     existed at the original v1 landing too, but now diverges FURTHER: a
     screen-mode clip whose render actually lands a PiP crop shows a visibly
     different bottom tile in the exported video than what the editor
     previewed. Accepted divergence for this v1 (same policy as split's own
     preview-vs-render gaps); candidate future fix, not built:
     persist the selected `pipRect` on the render row (or run a cheap
     preview-resolution PiP check) and expose it via the studio API so the
     preview can draw the same crop the render will use.
- Music/SFX library — **design converged 2026-08-05** from competitor
  research (OpusClip/Vizard/Submagic/Captions.app/Klap/Veed/Descript).
  Market pattern to match: curated self-hosted library filterable by mood
  with preview play; SFX as a separate small one-shot library (click to
  place at playhead), not a looping bed; upload is table stakes;
  auto-ducking under speech is becoming standard (OpusClip, Captions,
  Descript). v1 scope:
  - New `AudioAsset` Prisma model (kind: music|sfx; scope: curated|user;
    R2 key, title, mood tags, durationSec). Curated rows seeded from a
    manifest + admin script; content sourced ONLY from YouTube Audio
    Library no-attribution tracks + Pixabay (skip NCS-style packs — the
    documented Content-ID false-positive risk case). ~120-200 tracks,
    6-10 mood tags; 30-60 SFX. Actual curation is a content/ops task,
    not a code task.
  - Presigned R2 upload (mirror `presignLogoUpload`), MP3/WAV/M4A,
    ~50MB cap. Keep the URL-paste escape hatch.
  - Panel: Music/SFX/Upload tabs, mood filter, preview play, volume +
    startOffset (existing music schema fields); SFX placements are a new
    `studioEdits.sfx[]` (assetRef + startSec in edited seconds, one-shot).
  - Auto-ducking v1: derive speech windows from the transcript word
    timings we already have; duck music via timed volume automation in
    the worker (not sidechain), with the same window math applied to the
    preview gain node so preview and burn-in can't fork.
  - Licensing copy: "royalty-free for use in your videos" — do NOT claim
    "monetization-safe"/"no Content ID claims" (even OpusClip's docs admit
    false positives). Base library free-tier (Submagic pattern); any
    future AI-generated audio goes behind paid credits.
  *(v1 landed 2026-08-05. `AudioAsset` model (one table, `userId NULL` =
  curated; migration 20260805120000 applied), manifest seed script
  (refuses PLACEHOLDER titles without `--allow-placeholders`),
  `audio-asset.service.ts` (list/presign/finalize/playback-url/delete +
  owner-scoped `resolveRenderSource` that filters soft-deleted rows since
  delete also removes the R2 object). Schema: `music.assetId` (wins over
  `url` at render; `url` doubles as preview playback URL and stays the
  paste-a-link escape hatch) + `music.ducking`; `studioEdits.sfx[]`
  one-shots (edited-timeline `startSec`, max 20) — rebased in
  `rebaseStudioEdits` alongside text layers and cleared by
  clip-from-selection, both window-anchored. Ducking math is SHARED from
  validators (`extractSpeechWordIntervals` with utterance fallback →
  `computeSpeechWindows` → `capDuckingWindows` at 40 →
  `duckingGainMultiplierAt`; ramps sit outside the padded window): worker
  builds an ffmpeg `volume=` expression from the same segment list
  (parity-tested via evaluator, verified −10.4 dB plateau against real
  ffmpeg), preview multiplies its per-tick gain by the same function.
  Worker: `buildAudioMixFilter` generalizes dialogue+music+N SFX;
  SFX branches `adelay…apad…atrim` (apad is load-bearing — without it a
  silent-source SFX-only render truncates to the SFX length via
  `-shortest`/`duration=first`); asset downloads bounded to 50MB;
  failures stay log-and-skip. Web: 5 `/audio-assets` routes (uuid-param
  validation, P2002→409, 404s), Music/SFX/Uploads tabs (mood chips filter
  curated rows only, shared preview `<audio>`, place-at-playhead SFX,
  ducking toggle, start-offset slider, 50MB client check + 15s duration
  probe timeout), preview re-resolves stale presigns into local state
  without dirtying the document. Deferred: storage quotas on uploads,
  presign batching/caching in `listAssets`, long-session presign refresh,
  actual track curation (content/ops — manifest is placeholders only, DB
  unseeded).)*
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
