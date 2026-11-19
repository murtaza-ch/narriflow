# 03c - Studio painter

**What to build:** The Studio previews dynamic cues with an absolute per-word painter driven by the playhead (spec 5.6, 5.7, section 7 last bullets).

**Blocked by:** 03a

**Status:** done

Spec: [../spec.md](../spec.md). Follow the spec; where a ticket and the spec disagree, the spec wins.

## Acceptance

- [x] Canvas `measureText` measurement after fonts load; absolute per-word elements; transforms written imperatively per frame from `timeSec`; no mount-triggered animation for block cues; reduced motion shows settled words.
- [x] The panel preview and thumbnails read the plan / `captionCueBlock`; `useLiveCaption`'s derivation and `getCurrentCaptionState` are deleted.
- [x] `apps/web/app/prototype/caption-parity` loads fixture cases by id and seeks to a time.
- [x] REST snapshot updated; public OpenAPI regenerated with `bun run --cwd apps/api openapi:generate` and `openapi:check` passes. (03c adds no preset, so there was nothing to regenerate; 03a did it for Headline. `openapi:check` passes.)
- [x] `bun run lint`, `bun run typecheck`, `bun run test` pass (Bun 1.4.4). No PostgreSQL or heavy suites.

## Comments

### Opus, 2026-11-19: Studio painter landed

Picked up an interrupted agent's work, reviewed it against the spec, fixed what was left and verified it. Not committed.

**What changed (all in `apps/web`)**

- `studio/_components/caption-block-painter.tsx` (new): the block painter. Each word is measured alone with Canvas `measureText` at 100 px once `document.fonts` reports its faces (and the script fallback chain) loaded. Values are fractional (`width`, `actualBoundingBoxAscent/Descent`); scripts that take no letter spacing are measured without it. `layoutCaptionBlock` gets each word's `startSec` and `cueEndSec = activeRange.endSec`. Each word gets one absolutely placed element per paint layer (shadow incl. the style's `softShadow`, hard and extrude shadows, outer stroke, glow, text), stacked in the worker's layer order. `transform-origin` sits at the word centre, and the transform is `rotate(θ) translate(dx, dy) scale(sx, sy)`. Poses come from a time source (`playbackClock`, a shared looping clock for thumbnails, or a fixed time). They are written to the elements in a layout effect subscription, with no React state per frame and no mount animation. Unspoken words are `visibility: hidden`; reduced motion passes time scale 0 (settled). `CaptionBlockFrame` (frame-positioned) and `CaptionBlockFit` (bounds fitted to a box) wrap it.
- `caption-block-pose.ts` (+test): `captionKeyframeValue` sampling with role keyframes (`captionEntranceKeyframes`, so `hero ?? word`), keyframe times divided by `PlacedWord.entranceTimeScale` (0 = settled), `offsetXEm × motionSign`, and the transform string.
- `caption-cue-at.ts` (+test): picks the plan layer and active word at a time. Both the overlay and the panel read the plan through it.
- `interactive-caption-overlay.tsx`: a layer with a `block` is drawn by the painter, posed from `playbackClock`. The block's bounds are the drag and resize hit area; drag moves the stored anchor by the delta (the left edge for left styles).
- `video-preview.tsx` / `studio-shell.tsx`: the plan's caption layers for the current target are reported as `captionLayers` in Studio state.
- `tool-panels/captions-panel.tsx`: the live preview reads `captionLayers` (block cues through `CaptionBlockFit` on the playback clock, classic cues through `CaptionCue`). Between cues it shows the first cue settled; with no cues, the sample. `useLiveCaption` and `getCurrentCaptionState` (`use-current-caption.ts` + test) are deleted.
- `caption-style-engine.tsx`: classic cues play `captionClassicAnimation(preset)` (a dynamic-only motion renders as `fade`). A few helpers are exported for the painter.
- `_shared/caption-sample-cue.ts` (+test): the sample phrase through `assignCaptionRoles` then `captionCueBlock`. If the gate leaves it without a hero, its last non-minor word gets a `"hero"` override. `_shared/caption-preset-preview.tsx` (gallery, `style-thumb.tsx`, preset cards and brand-kit template form previews) and `tool-panels/brand-template-panel.tsx` use it for dynamic presets.
- `app/prototype/caption-parity`: `?case=<fixture id>&t=<sec>[&scale=][&play]` builds the case's document, runs `planClipComposition` on a 1080x1920 target and paints the layer over the green-studio backdrop. It writes the layout (`activeRange`, block scale, bounds, every `PlacedWord`) to `<script id="metrics">` and sets `data-ready`. `&play` loops the playhead for cost checks. The classic `?preset=` mode is unchanged.
- `apps/web/tsconfig.json`: path for `@narriflow/caption-fonts/caption-block`, so web resolves the subpath like the existing ones.

**Fixes made in this pass:** the Captions panel hook no longer suppresses `useExhaustiveDependencies` (the read is a plain function). `caption-sample-cue.ts` already used a loop, not `findLastIndex`, so `lib` is unchanged. The probe below lands the DOM baseline on the layout. The classic thumbnail sample now takes its timings from `CAPTION_SAMPLE_WORDS`.

**Baseline probe (finding).** Chrome rounds a face's ascent to whole pixels at each size: Inter SemiBold at 80 px puts the baseline 88 px below the box top, not 88.63. Placing the box top at `ascent × px` left DOM baselines 0.36 to 0.64 px above the layout. The painter now probes the real offset per face and display size (cached; it runs only once a paint exists), as the proof page did. Measured DOM against layout over all 9 cases and 5 moments: baseline |Δ| ≤ 0.02 px; pen x / advance-box left |Δ| ≤ 0.02 px, RTL included (Urdu boxes within 0.01 px).

**Visual check.** `next dev -p 3217` in the worktree; agent-browser at a 1080x1920 viewport, scale 1; Next dev badge removed before each shot. Frames for every Headline case at cue onset, onset +100 ms, hero onset +1 frame, hero +100 ms and settled are in `/private/tmp/claude-501/-Users-murtaza-Documents-dev-narriflow/49bb75c5-29c7-4a2e-aa64-a5b996ebf64f/scratchpad/03c/` (`<case>-<moment>.png`). Contact sheets: `sheet-headline-en.png`, `sheet-headline-number-unit.png`, `sheet-headline-long-hero-fit.png`, `sheet-settled.png`, and `sheet-vs-proof.png` (proof HTML frames on top, ours below). Poses read back from the DOM match `slide`: −0.18 em × 80 = −14.4 px at onset; hero +25.38 px and opacity 0.8325 at +33 ms; +10.86 px at +100 ms. Against `html-frame-*.jpg`: same hierarchy, ink-tight stacking, soft shadow, 0.80 hero fill and entrance blur. Differences: the hero is flat `#36B780` (gradient is phase 2), and the block sits lower because the Headline preset's default position is lower than the proof's y 60 %. Gate, Urdu (Nastaliq fallback, bidi order `فیصد 50`), Japanese, the fit clamp and both overrides look right. A temporary page (deleted afterwards) showed the Headline gallery card with a hero ("make it / pop"), Bold Pop unchanged, and both fitted previews (`thumbs.png`).

**Per-frame cost** (`&play`, `headline-long-hero-fit`, 5 words × 2 layers, Chrome trace over 6 s, headless, this M1 Pro): rAF callback (poses plus style writes) median 0.037 ms, p95 0.066 ms, max 0.84 ms. No Layout events during playback; UpdateLayoutTree ran 12 times in 6 s (median 0.16 ms); rAF interval median 16.67 ms (60 fps). In the Studio the clock ticks per video frame (`requestVideoFrameCallback`), and a pose that did not change writes nothing.

**Interpretations**

1. "Shadow element incl. style `softShadow`": the style's soft shadow replaces `CAPTION_SOFT_SHADOW` when the preset's `shadow` is `soft`, as the worker's `stackEvents` does. CSS `blur()` takes a standard deviation, which matches `blurEm`.
2. Visibility runs from `word.startSec` to `activeRange.endSec` inclusive. The overlay mounts only while the layer is active, so the end is never drawn early.
3. Between cues, the panel preview shows the first plan cue settled; with no caption layers, the style's sample (the block sample for dynamic presets).
4. Thumbnails: dynamic samples loop on one shared rAF clock that stops when no card listens (off screen or reduced motion). The Studio template thumb and the panel fallback show the sample settled.
5. Gallery cards lay the block out on a virtual canvas `1080 / boost` wide with the card's aspect, so the hero fills its share of the card as the classic samples are boosted.
6. Fallback faces inside one word are not probed separately; the box's line height is the requested face's line box. Latin, Arabic and CJK cases above land within 0.02 px.
7. No REST snapshot or OpenAPI regeneration: 03c adds no catalog preset (03a regenerated them for Headline). `openapi:check` passes.

**Not verified:** the live Studio overlay and panel need a signed-in session, so playback in the real Studio (drag, resize, pause, seek) was not driven in a browser. The same painter, time source contract and plan layers were exercised through the harness, and `playbackClock` provides the same `getSnapshot`/`subscribe` contract. Worker frames for the same cases are 03b's.

**Verification** (Bun 1.4.4, worktree root)

- `bun test` on the touched web files: 33 pass.
- `bun run lint`: 0 errors (20 warnings and 1 info, the 03a baseline, none in changed web files).
- `bun run typecheck`: 15 of 15 tasks pass.
- `bun run test`: exit 0. web 1140, validators 889, composition-plan 127, caption-fonts 115, services 1629, api 984, api-client 232, media 1015, the rest pass; 0 failures.
- `bun run check:web-split`: passed. `bun run --cwd apps/api openapi:check`: matches all 32 REST operations.

