# 14 - Fixes from review B (layer, export, Studio) and the palette's look

**What to build:** The defects, parity gaps and design points an independent Opus High review found
in the emoji layer, the export and the Studio. Rules: [../RULES.md](../RULES.md).

**Blocked by:** [09b](09b-controls-polish.md), [12](12-parity-and-fixes.md)

Items 2, 8, 14 and 15 below moved to [16](16-studio-fixes.md) (Studio UI state). This ticket owns
the layer, the export, the art, the palette, and the Studio's three layer feeder files.

**Status:** done (items 2, 14 and 15 are ticket 16's)

## Areas

`packages/caption-scene/src/emoji/**`, `packages/validators/src/caption-emojis.ts` (palette
functions only; ticket 13 is editing `resolveCaptionEmojiAnchors` in the same file),
`packages/caption-emoji/**`, `apps/media/src/{caption-ass,caption-emoji-ass}.ts`, and in the Studio
only `emoji/{caption-emoji-layer.tsx,cue-caption-emojis.tsx,scene-caption-emojis.tsx,cue-emoji-boxes.ts,use-caption-emoji-art.ts}`
plus the emoji mount in `interactive-caption-overlay.tsx` and `interactive-scene-overlay.tsx`.
Ticket 16 owns every other file in the Studio `emoji/` folder.
Each defect needs a test that fails before the fix where a test is possible.

## Defects

1. **Error isolation in the export.** `apps/media/src/caption-ass.ts` (about lines 289-291):
   `captionSceneEmojiCueBoxes(...)` runs inside the same `try` as `renderCaptionScene`, so an emoji
   bug would burn a Scene Style as classic lines and record `caption_scene_failed`. And
   `captionEmojiEvents` runs with no `try`, so a throw there fails the whole render. Compute the
   scene cue boxes after the scene's `try`; wrap the whole emoji layer in its own `try` that logs
   once (structured, `caption_emoji_layer_failed`, with the error message) and returns no events.
   An emoji problem must never change captions or fail a render. Tests: a cue-box function that
   throws leaves the scene's events identical and yields no emoji events; same for a throwing
   placement.
2. **The AI run reads and writes through the hook instance that started it.**
   `emoji/use-caption-emojis.ts` (about lines 96-104) uses `latest.current`; when the Captions
   panel closes mid-run that instance unmounts and the ref goes stale, so an emoji added from a
   transcript chip during the run is overwritten when the answer arrives; and there is no clip
   guard. Keep the live source (current entries, words, dispatchers, clip id) in the per-clip run
   state in `caption-emoji-runs.ts`, updated by every mounted editor for that clip; the answer is
   merged against that, and dropped if the clip changed or no editor for the clip is mounted and
   no dispatcher is available. Tests in the runs module with fake sources: panel closed mid-run
   then a hand edit then the answer (hand edit survives); clip switched mid-run (answer dropped);
   two editors mounted (one dispatch).
3. **The Studio places at 30 fps, the export at the render's rate.** `caption-emoji-layer.tsx`
   never passes `fps`; the worker passes the render's rate. Placement checks collisions and trims
   windows on the frame grid, so the two can choose different slots. Pass the clip's output frame
   rate to the Studio layer (find where the Studio knows the clip's or export's frame rate; the
   Scene painter's build input has an `fps` for programs that plan by frames) and put it in the
   layer key. If the Studio cannot know the rate, make both sides place on one fixed grid instead
   and say why. Test: the same input at 30 and 60 fps through both feeders gives the same slots.
4. **Emojis stay behind while a caption is dragged.** `interactive-caption-overlay.tsx` (about
   lines 424-427): the drag moves `motionX/motionY` on the caption wrapper; the emoji layer stays
   at the old anchor and jumps on drop. Apply the same motion offset to the emoji wrapper (one
   shared motion value, no React state per frame), for classic and Dynamic captions, and check the
   Scene overlay's drag does the same.
5. **The layer key leaves out `order`**, which sets the tilt sign.
   `packages/caption-scene/src/emoji/layer.ts` (`captionEmojiLayerKey`, about line 257). Add it.
   While there, make the key honest: either key on source plus emojis plus style, and document
   that the source key covers the boxes, or include what it claims to include.
6. **A later emoji that is dropped still cuts the earlier one short.** `layer.ts` (`windows()`,
   about lines 121-133) ends each emoji at the next emoji of its cue before placement runs. End it
   at the next emoji that was actually placed; an unknown id or a dropped emoji does not shorten
   its neighbour. Test it.
7. **One failed shard drops every emoji.** `packages/caption-emoji/src/art.ts` (about line 57)
   uses `Promise.all` over shards. Settle per shard; ids in a failed shard are simply missing from
   the map (the layer counts them as `no-art`), and a failed shard is not cached as loaded.
8. **A failed art load is never retried in the Studio.** `emoji/use-caption-emoji-art.ts`: after a
   failure nothing reloads until the id set changes. Retry on the next mount and once after a
   short backoff; no retry loop.
9. **Per-cue against whole-target placement.** Classic and Dynamic captions are placed one cue at
   a time in the Studio and all of a target's cues together in the export, so overlapping
   speakers' emojis avoid each other only in the export. Make the two sides do the same thing with
   the cheapest change (the review suggests it; choose after reading both feeders) and add a
   parity test with two overlapping cues.
10. **An emoji edit recomputes Scene cue boxes** (12 to 27 ms each time). Memoise cue boxes per
    scene source key in the Studio so an emoji or palette edit reuses them. Record the build time
    before and after for a 60 s clip with 20 emojis on Horizon.

## Palette look (packages/validators/src/caption-emojis.ts, automatic palette only)

The owner's four named palettes and an explicit `preset.emojiPalette` are never altered.

11. **The derived rim is muddy.** When the rim is derived from the body (ticket 12's guard), a
    yellow body gets an olive rim (`#b39f4e`). Derive it the way illustrators shade: darker, at
    least as saturated, with the hue shifted, warm bodies toward red (yellow gets an orange rim,
    as emoji usually have), cool bodies toward blue-violet. Work in OKLCH; state the rule and the
    numbers in a comment.
12. **Colourless bodies.** A grey or near-grey body (Punch) or a body near the sticker white makes
    the emoji stop reading as an emoji. Add to the invariants: the body's chroma is above a floor
    and the body is separated from the sticker white; otherwise use the stock body colour the
    existing fallback uses.
13. Keep every existing invariant, extend the all-presets test with the new ones, and print how
    many presets changed. Then regenerate close-ups through the real export path for at least 12
    presets that changed (use `.../scratchpad/emoji-parity/` and ticket 12's script), old beside
    new, save as `palette-closeups-v2.png`, and look at it: the rim should read as a clean shade
    of the body on every one, and no emoji should look monochrome or dirty.

## Studio details

14. The Add with AI button turns bright white while running and is grey when idle; keep one
    surface and show progress inside it.
15. The picker popover can hang past the bottom of the Captions panel and the window. Position it
    with collision handling (flip above its trigger, shift inside the viewport, cap its height to
    the space available and scroll inside), using the positioning the Studio's other popovers and
    menus use.

## Quality

16. One rotation-bounds helper and one box-union helper in the emoji folder instead of `turned`
    (`layer.ts`), `turnedBounds` (`cue-box.ts`), `union`, `lastRow`, `withPlate`.
17. The placement test's checker only checks text that belongs to cues. Also check text pieces
    that belong to no cue (Index dial labels, Chronicle timeline) against emoji boxes.
18. `caption-emoji-ass.ts` builds a `SceneMeasurer` per target only to satisfy `sceneEvents`' 
    signature; use one shape-only measurer constant.

## From the Sol review

19. **Auto placement returns into the face zone.** On square Gumdrop the sticker lands on the
    speaker's eye: below is tried first but the fallback goes back above. For `auto`, when above
    is in the face zone and below does not fit, try a side slot (level with the cue, at its
    reading end, then the other end) before going back into the face zone.
20. **A late anchor telegraphs the punchline.** When the anchor word leaves less than 450 ms, the
    emoji shows from the cue's start, before the word is spoken. Instead: with 200 ms or more left,
    show it at the word with a short entrance (90 ms ease, no overshoot); only under 200 ms fall
    back to the cue's start. Update the timing tests.
21. **Cap how long an emoji holds.** A sticker that sits for the whole of a very long cue reads as
    stuck, and the ASS writer's cost grows steeply with the hold (measured: one 20-piece emoji
    costs 23 ms of event building over 5 s, 292 ms over 30 s, 5.1 s over 120 s). An emoji holds at
    most 6 s, then fades out as it does at a cue's end. Record event-build time for a 30 s cue
    before and after.
22. **The outline fills every hole.** Heart hands and chain links lose their shape at phone size
    because the sticker backing fills the cutout (`.../scratchpad/emoji-art/sheets/sticker-closeups.png`).
    Keep holes that are still large after the outline is grown (state the area or width threshold
    on the 64 grid; small holes stay filled, which is what stops slivers and rings), make the
    outline check accept them, rebuild, report how many designs changed and the bytes, and
    regenerate the sticker close-ups.

## Acceptance

- [x] Items 1, 3 to 7, 9 to 13 and 16 to 22 (and 8), each with its test, measurement or image.
- [x] Ticket 12's parity check still passes (re-run its comparison on classic, Dynamic and Scene,
      LTR and RTL) after items 3, 5, 6 and 9.
- [x] `bun run typecheck`; tests of `packages/caption-scene`, `packages/caption-emoji`,
      `packages/validators`, `apps/media` and `apps/web`; `bun run check:web-split`; biome on
      touched files.

## Evidence

Implemented 2026-11-26. Nothing committed, migrated or deployed.

### Files

- `apps/media/src/caption-emoji-ass.ts`: `CaptionEmojiGroup`; `captionEmojiEvents({ groups, art, canvas, fps })` places
  each group, finds cue boxes inside its own guard, logs `caption_emoji_layer_failed`; one `SHAPES_ONLY` measurer.
- `apps/media/src/caption-ass.ts`: the collector holds emoji groups (`emojiGroups`, each with a lazy `cueBoxes`); the
  Scene cue boxes are added after the scene's `try`.
- `packages/caption-scene/src/emoji/`: `box.ts` (new: `turnedBox`, `unionBox`); `layer.ts` (placement loop rewritten:
  `plan`, per-emoji `Placed` records, `lengthen`; fixed placement grid; hold cap; face-zone side slots; honest key);
  `timing.ts` (quick entrance); `placement.ts` (`slotWindow` takes `entrance`); `cue-box.ts`, `scene-cue-boxes.ts`,
  `drawing.ts` (use `box.ts`); `placement-support.ts` (checks no-cue text); tests `layer.test.ts`, `placement.test.ts`.
- `packages/validators/src/caption-emojis.ts` (palette section only): OKLCH helpers, body chroma and white guards, rim
  shade rule; tests in `caption-emojis.test.ts`.
- `packages/caption-emoji`: `src/art.ts` (`Promise.allSettled`), `src/art-load.test.ts` (new), `src/geometry.ts`
  (`CAPTION_EMOJI_KEPT_HOLE_GRID = 4`), `scripts/outline.ts` (kept holes), `scripts/raster.ts` (new: mask and distance
  transform, moved out of `outline-check.ts`), `scripts/outline-check.ts` (`kept`), `scripts/verify.ts` (kept holes reported,
  close-ups include them, sticker shadow at the renderers' 2.56 grid units), `src/art.test.ts`, regenerated `src/generated/`.
- Studio: `emoji/caption-emoji-layer.tsx` (key), `emoji/scene-caption-emojis.tsx` (boxes kept per built scene),
  `emoji/cue-caption-emojis.tsx` (`dragOffset`), `emoji/use-caption-emoji-art.ts` (`loadCaptionEmojiArtWithRetry`),
  `emoji/caption-emoji-layer.test.ts`, and three lines in `interactive-caption-overlay.tsx` (the shared motion values).

### Public API changed

```ts
// caption-scene
export function turnedBox(box: Box, deg: number, pivot?: { x: number; y: number }): Box;
export function unionBox(boxes: readonly Box[]): Box | null;
export const CAPTION_EMOJI_QUICK_HOLD_MS = 450;   // under it: quick entrance
export const CAPTION_EMOJI_MIN_HOLD_MS = 200;     // was 450; under it: from the cue's start
export const CAPTION_EMOJI_MAX_HOLD_MS = 6000;
export const CAPTION_EMOJI_PLACEMENT_FPS = SCENE_DEFAULT_FPS; // 30
// CaptionEmojiLayerInput lost `fps`
export function captionEmojiLayerKey(input: Omit<CaptionEmojiLayerInput, "cueBoxes">, source: string): string;
export const CAPTION_EMOJI_QUICK_FROM = 0.7, CAPTION_EMOJI_QUICK_MS = 90;
export type CaptionEmojiEntrance = "pop" | "quick";
export function captionEmojiScale(fromMs: number, toMs: number, entrance?: CaptionEmojiEntrance): Frames;
export function captionEmojiOpacity(fromMs: number, toMs: number, entrance?: CaptionEmojiEntrance): Frames;
// validators
export const CAPTION_EMOJI_MIN_BODY_CHROMA = 0.07, CAPTION_EMOJI_MIN_BODY_WHITE = 0.12;
export function captionEmojiColourLch(hex: string): { l: number; c: number; h: number };
// apps/media
export interface CaptionEmojiGroup { layers: readonly CompositionCaptionVisualLayer[]; cueBoxes: () => readonly CaptionEmojiCueBox[] }
export function captionEmojiEvents(input: { groups: readonly CaptionEmojiGroup[]; art; canvas; fps? }): { events; summary };
// Studio
export function loadCaptionEmojiArtWithRetry(cache, ids, onAnswer, retryMs?, timers?): () => void; // CAPTION_EMOJI_ART_RETRY_MS = 3000
```

### Per item

1. **Export isolation.** `caption-emoji-ass.test.ts` "an emoji layer that throws": a throwing `captionSceneEmojiCueBoxes`
   (reveal), `classicLineCueBox` (electric), `captionBlockCueBox` (headline) and `placeCaptionEmojis` (reveal, electric)
   each leave the notices and every caption Dialogue identical to the healthy track, draw no emoji, and log exactly one
   `{ level: "warn", message: "caption_emoji_layer_failed", error }`. All 5 failed before the fix (the Scene case recorded
   `caption_scene_failed`; the others threw).
3. **Frame rate.** The browser never receives the clip's frame rate: the Studio's scene build input has no `fps` (the
   Scene painter plans at `SCENE_DEFAULT_FPS`, 30), and neither the plan nor any API-client shape carries one (only the
   worker's media probe has it). So both sides place on one fixed grid, `CAPTION_EMOJI_PLACEMENT_FPS = 30`; the export
   only writes at its render rate. Test "on one frame grid whatever the render's rate": an 8 ms obstacle between two 30 fps
   frames but on a 60 fps frame; slots equal at 24, 30 and 60 fps, windows differ only by the writer's frame snap; whole
   tracks of electric, headline and reveal give equal poses at 24/30/60. On the old code the same input chose `above` at
   24 and 30 fps and `below` at 60 (checked against a copy of the old layer).
4. **Drag.** `ClassicCaptionEmojis` and `BlockCaptionEmojis` take `dragOffset` (the overlay's `motionX/motionY`, one
   memoised object); the emoji wrapper is a `motion.div` on the same values, so no React state per frame. Scene overlay:
   its drag moves only the selection frame (the scene and its emojis both stay until the drop), so nothing to change.
   Not unit-testable without a DOM; typecheck and web tests pass.
5. **Key.** Keyed on source + emojis (with `order`) + art loaded + style + canvas + anchor; documented that the source
   stands for the boxes, and the input type no longer takes boxes. Test: `order` changes the key, boxes do not.
6. **Dropped neighbours.** A window ends at the next emoji of its cue that is not dropped; unknown art and over-cap
   designs never cut; an emoji dropped for room or time gives its time back to the one before (same slot, re-checked
   against everything placed since; kept only if it stays clear). Test "an emoji that is not drawn does not cut the one
   before it short" (no-art and piece-cap: first runs to 3000; no-room: first runs to 2767 instead of 2700).
7. **Shard failure.** `art-load.test.ts`: smileys shard rejects → `heart-eyes` missing, `rocket` loaded; next call loads
   both (loader called twice). Failed before (the whole call rejected).
8. **Studio retry.** `loadCaptionEmojiArtWithRetry`: one retry after 3 s, none after that, a later mount asks again,
   cancel clears the timer. Two tests with fake timers.
9. **Per cue vs whole target.** The Studio draws one classic or Dynamic cue at a time and a Scene Style's cues as one
   scene; the export now places the same groups (`CaptionEmojiGroup`). Finding: the plan ends a classic cue where the
   next starts, so two speakers' classic lines never share time and the difference could only show where a Scene target
   mixes scene cues with classic fallback lines. Test "each classic or Dynamic cue is placed alone…": two overlapping cue
   boxes in separate groups place exactly as each alone; in one group the second moves off the first; plus the plan's
   non-overlap.
10. **Scene cue boxes kept.** Boxes cached per built scene (`WeakMap<MeasuredScene, …>`). Test: three layer builds (emoji
    removed, palette changed) call `captionSceneEmojiCueBoxes` once; a rebuilt scene computes again (failed before: 3
    calls). Bench (Bun, Horizon, 60 s, 43 cues, 2,812 scene pieces, 20 emojis, one emoji changed per build, median of 9):
    before 14.0 ms (HarfBuzz) / 12.0 ms (fake), after 0.5 / 0.3 ms.
11. **Rim.** Derived rim = the body shaded in OKLCH: L down 0.18 (then 0.24, 0.30, 0.36; then up 0.16, 0.22 when a dark
    detail leaves no room), chroma × 1.15 and at least 0.12 cut to the gamut, hue turned halfway (at most 35°) toward red
    25° for warm bodies (330° to 115°) or blue-violet 285° for cool ones. `#ffe45c` now gets `#f28e00` (was `#b39f4e`).
12. **Colourless bodies.** Body must have chroma ≥ 0.07 and ΔEok ≥ 0.12 from the sticker white, else the existing chain
    (accent, then stock). Changes: halftone (cream → its accent `#e8402a`), premiere (cream → stock yellow), block and
    street (white → stock), chrome (silver-blue C 0.058 → its blue accent).
13. **Invariants.** All-presets test asserts the new two plus the old five; worst: body–white 0.146 and body chroma 0.076
    (wordform), body–ink 0.315 (tape), body–detail 0.133 (broadway), rim–body 0.178 (orbit), rim–detail 0.132 and
    rim–white 0.147 (horizon). **57 of 115 presets changed** (classic 24, Dynamic 6, Scene 27; body changed on 5, rim on
    57); the owner's four palettes and `preset.emojiPalette` untouched (tested). Close-ups through the export path, old |
    new, 16 presets (electric, reveal, punch, neon, afterglow, stack, doodle, tunnel, glint, dossier, headline, lyrics,
    horizon, and classic bold-pop, groove, frosted-glass), 14 changed:
    `/private/tmp/claude-501/-Users-murtaza-Documents-dev-narriflow/f7147bb1-206f-4f6e-a8fc-276dea0eb55b/scratchpad/emoji-parity/v3-palette-closeups.png`. Looked at: every yellow body has an orange rim (flame reads orange with a
    yellow core); pinks get crimson or rose, red gets deep red, greens and mint get teal, lime gets green; nothing olive,
    grey or white-blob. Horizon unchanged (its accent separates).
16. `box.ts` replaces `turned`, `turnedBounds`, `union`, the union in `lastRow`, `withPlate` and `drawing.ts`'s ink.
17. The placement checker also tests text that belongs to no cue: 0 problems over 84 styles × 2 runs × 3 canvases, fake
    and HarfBuzz, and the 5 edge demos.
18. One module-level `SHAPES_ONLY` measurer.
19. **Face zone.** Auto in the face zone tries below, then end, then start (level with the cue), then above. Test (end,
    end in RTL, start, then above). Square Gumdrop demo: 2 dropped → 0; on the 1:1 sheet 4 of its 5 emojis sit beside the
    stack, one stays above where its widest word fills the width. Urdu Gumdrop now sits beside the stack, off her face.
20. **Late anchor.** 200 to 450 ms left: at the word, scale 0.7 → 1 over 90 ms with `out`, never above 1; under 200 ms:
    from the cue's start. Test updated.
21. **Hold cap.** 6 s, then the normal 90 ms fade; a later emoji of the cue still takes over. Event building for one
    20-piece emoji (astronaut) on a 30 s cue, real writer, median of 7: **251.9 ms → 11.2 ms** (window 29.8 s → 6 s).
22. **Kept holes.** Rule: after the outline grows into a hole and is closed, the hole stays open when it still holds a disc
    of radius 4 grid units (measured exactly on a 1,024 px raster with a distance transform); smaller holes stay filled.
    Measured radii: heart-hands 9.35, link 6.3/6.7, safety-pin 7.25, chains 4.2 to 4.6; snowflake 2.38, the 100's zeros
    1.25 to 2.08, roller coaster 1.0 stay filled. Designs without a kept hole get their exact old outline. **26 designs
    changed**: infinity, link, paperclip, bucket, shopping-bags, microscope, safety-pin, chains, pretzel, takeout-box, lock,
    handbag, locked-with-key, locked-with-pen, reschedule, jellyfish, dotted-line-face, revolving-hearts, anger-symbol,
    counterclockwise-arrows-button, seeing-stars, anchor, basket, airplane-departure, pinching-hand, heart-hands; layers
    unchanged. **Bytes**: generated 4,007,497 → 4,023,077 (+15,580); shards that changed: symbols-0 58,891 → 60,273,
    smileys-0 322,738 → 328,039, objects-0 225,871 → 226,768, objects-1 174,986 → 178,571, food-and-drink-0 195,994 →
    197,353, travel-and-places-0 177,259 → 178,100, animals-and-nature-0 227,335 → 227,726, hands-0 121,308 → 122,367,
    phrases-3 358,244 → 359,009. Build twice: identical `shasum`. `verify --pack`: exit 0, 1,408 designs 0 over, 900 tones
    0 over, outline faults 0, kept holes 26. Sheets `/private/tmp/claude-501/-Users-murtaza-Documents-dev-narriflow/f7147bb1-206f-4f6e-a8fc-276dea0eb55b/scratchpad/emoji-art/sheets/v3/` (all regenerated) and
    `/private/tmp/claude-501/-Users-murtaza-Documents-dev-narriflow/f7147bb1-206f-4f6e-a8fc-276dea0eb55b/scratchpad/emoji-art/sheets/v3/kept-holes.png` (the 26 on light and dark at 150 px and phone-size 60 px): cut-outs read, the
    shadow shows as a thin crescent inside large holes, no specks anywhere; snowflake and 100 stay filled.

### Placement tables (84 styles × 3 canvases, one emoji per cue)

Before = a copy of the pre-change layer in the scratchpad, same scenes, same checker.

| Run | Before | After |
| --- | --- | --- |
| Demo, fake | 8 / 1,221 | 4 / 1,221 |
| Fast, fake | 89 / 3,024 | 64 / 3,024 |
| Demo, HarfBuzz | 6 / 1,221 | 5 / 1,221 |
| Fast, HarfBuzz | 83 / 3,024 | 64 / 3,024 |
| Problems (ink on a word face incl. no-cue text, or outside the safe area) | 0 | 0 |

Remaining demo drops (fake): Cascade 1 on each canvas, Rainbow 1 on 1:1. Fast over 25%: Lyrics 4 of 12 (9:16, 1:1).

Per style, fake measure (cells: cues above/below/side, shrunk, dropped), rows whose cells changed:

| Style | 9:16 demo before → after | 9:16 fast before → after | 1:1 dropped demo/fast | 16:9 dropped demo/fast |
| --- | --- | --- | --- | --- |
| lyrics | 5 0/2/3 s2 d0 | 12 3/0/5 s1 d4 | 0/4 | 0/2 → 0/1 |
| hollow | 5 3/2/0 s1 d0 | 12 11/0/0 s0 d1 → 12 10/1/0 s0 d1 | 0/2 → 0/1 | 0/2 → 0/1 |
| track | 5 4/1/0 s0 d0 | 12 10/2/0 s0 d0 → 12 9/3/0 s0 d0 | 0/1 | 0/0 |
| punchline | 4 4/0/0 s0 d0 | 12 10/2/0 s0 d0 → 12 11/1/0 s0 d0 | 0/0 | 0/0 |
| velocity | 4 4/0/0 s0 d0 | 12 11/1/0 s1 d0 → 12 12/0/0 s1 d0 | 0/0 | 0/0 |
| wordform | 4 4/0/0 s0 d0 | 12 10/2/0 s0 d0 → 12 11/1/0 s0 d0 | 0/0 | 0/0 |
| reveal | 4 4/0/0 s0 d0 | 12 9/2/0 s0 d1 → 12 11/0/0 s0 d1 | 0/1 | 0/1 |
| spine | 4 3/1/0 s0 d0 | 12 8/4/0 s0 d0 → 12 6/5/1 s0 d0 | 0/0 | 0/0 |
| aura | 4 4/0/0 s0 d0 | 12 10/1/0 s0 d1 → 12 11/0/0 s0 d1 | 0/1 | 0/1 |
| wonky | 5 5/0/0 s0 d0 | 12 7/3/0 s2 d2 | 0/3 → 0/1 | 0/3 → 0/1 |
| verified | 5 5/0/0 s0 d0 | 12 10/1/0 s0 d1 → 12 11/0/0 s0 d1 | 0/2 → 0/1 | 0/2 → 0/1 |
| cursor | 5 5/0/0 s0 d0 | 12 11/1/0 s0 d0 → 12 12/0/0 s0 d0 | 0/0 | 0/0 |
| premiere | 4 2/2/0 s0 d0 | 12 6/5/0 s0 d1 → 12 7/4/0 s0 d1 | 0/2 → 0/1 | 0/2 → 0/1 |
| tape | 5 4/1/0 s0 d0 | 12 10/1/0 s0 d1 → 12 11/0/0 s0 d1 | 0/2 → 0/1 | 0/2 → 0/1 |
| stretch | 5 5/0/0 s0 d0 | 12 10/1/0 s0 d1 → 12 11/0/0 s0 d1 | 0/2 → 0/1 | 0/2 → 0/1 |
| hype | 5 5/0/0 s0 d0 | 12 10/1/0 s0 d1 → 12 10/0/1 s1 d1 | 0/2 → 0/1 | 0/2 → 0/1 |
| wallpaper | 5 5/0/0 s0 d0 | 12 10/1/0 s0 d1 → 12 11/0/0 s0 d1 | 0/2 → 0/1 | 0/2 → 0/1 |
| slice | 5 5/0/0 s0 d0 | 12 10/2/0 s0 d0 → 12 11/1/0 s0 d0 | 0/1 | 0/1 |
| arthouse | 4 1/3/0 s1 d0 | 12 4/5/0 s0 d3 | 0/3 | 0/3 → 0/1 |
| heft | 4 4/0/0 s0 d0 | 12 10/2/0 s0 d0 → 12 11/1/0 s0 d0 | 0/1 | 0/1 |
| popup | 5 5/0/0 s0 d0 | 12 10/1/0 s0 d1 → 12 11/0/0 s0 d1 | 0/2 → 0/1 | 0/2 → 0/1 |
| orbit | 5 5/0/0 s0 d0 | 12 10/1/0 s0 d1 → 12 11/0/0 s0 d1 | 0/2 → 0/1 | 0/2 → 0/1 |
| gumdrop | 4 1/3/0 s3 d0 | 12 4/8/0 s2 d0 | 2/0 → 0/0 | 2/0 → 0/0 |
| anime | 5 4/1/0 s0 d0 → 5 0/1/4 s2 d0 | 12 8/4/0 s3 d0 → 12 6/4/2 s5 d0 | 0/0 | 0/0 |
| tunnel | 5 5/0/0 s0 d0 | 12 9/3/0 s4 d0 → 12 8/3/1 s5 d0 | 0/0 | 0/0 |
| chronicle | 5 5/0/0 s0 d0 → 5 4/0/1 s0 d0 | 12 12/0/0 s0 d0 | 0/0 | 0/0 |
| tilt | 5 4/1/0 s1 d0 → 5 2/1/2 s3 d0 | 12 7/5/0 s4 d0 → 12 4/5/3 s6 d0 | 0/0 | 0/0 |

Unchanged in these cells (57): dialogue, dossier, signal, bulletin, ticker, flap, index, doodle, chrome, boom, beat, trail, ransom, ledge, cascade, shuffle, squash, slab, labels, googly, bubble, strike, seventies, thermal, slot, inkup, primer, manifesto, swipe, match, scribble, barrel, pills, pixel, diecut, sticky, brute, mdrn, crosstape, flowing, trace, snipsnap, broadway, ripple, bento, liquid, blinds, receipt, combo, rainbow, vibes, pixelpop, funky, glint, marquee, horizon, halftone

### Parity (ticket 12's comparison re-run; Studio = prototype `?debug=1` in headless Chrome on the running dev server,
### which served the new layer chunk; export = `renderCaptionTrack` read back from the ASS)

| Frame | Kind | dx, dy | size | tilt |
| --- | --- | --- | --- | --- |
| bold-pop, bold-pop-rtl | classic | 0, 0 | 0 | 0 |
| headline, headline-rtl | Dynamic | 0, 0 | 0 | 0 |
| lyrics, lyrics-rtl, dialogue, horizon, index | Scene | 0, 0 | 0 | 0 |
| bubble-rtl | Scene | up to 28.27, 3.50 | 0 | 0 |

Windows within 0 to 30 ms (writer's frame and centisecond snap), as in ticket 12. Bubble in Urdu: the same Scene
measurement difference ticket 12 recorded. Table `/private/tmp/claude-501/-Users-murtaza-Documents-dev-narriflow/f7147bb1-206f-4f6e-a8fc-276dea0eb55b/scratchpad/emoji-parity/v3-parity-table.txt`, images
`/private/tmp/claude-501/-Users-murtaza-Documents-dev-narriflow/f7147bb1-206f-4f6e-a8fc-276dea0eb55b/scratchpad/emoji-parity/v3-parity-sheet.png` (looked at: same place, size, colour and tilt; bold-pop's rocket now has an
orange rim on both sides).

### Contact sheets (real export path)

`/private/tmp/claude-501/-Users-murtaza-Documents-dev-narriflow/f7147bb1-206f-4f6e-a8fc-276dea0eb55b/scratchpad/emoji-layer/v3-sheet-ltr-9x16.png` (32 styles), `v3-sheet-rtl-9x16.png` (24), `v3-sheet-ltr-1x1.png`,
`v3-sheet-ltr-16x9.png`, `v3-sheet-fast-9x16.png` (16 each). Looked at: Anime, Tilt, Halftone (1:1) and Gumdrop now
use side slots where above was the face; colours follow the new palette.

### Commands

- `bun run typecheck`: 17 of 17 successful.
- `bun run --cwd packages/caption-scene test`: 3,118 pass, 0 fail. `packages/caption-emoji`: 104 pass. `packages/validators`:
  1,348 pass. `apps/web`: 1,343 pass. `apps/media`: 1,180 pass, 1 skip, 0 fail.
- `bun run check:web-split`: passed. `bunx biome check` on all 67 touched files (incl. generated art): clean.
- `bun run --cwd packages/caption-emoji build` twice: identical; `verify -- --pack … --out …/sheets/v3`: exit 0.
- Scripts (scratchpad `/private/tmp/claude-501/-Users-murtaza-Documents-dev-narriflow/be191afb-89dd-45f0-86d7-ed6dd2a3aa7b/scratchpad`): `tools/table.ts` + `compare-tables.py` (placement tables), `before/` (old layer copy),
  `tools/hold-bench.ts`, `tools/edit-bench.ts`, `tools/fps-before.ts`, `palette/palette-sheet-v3.ts` + `count.ts`,
  `outline/diff.ts`, `parity-v3/` (worker.ts, studio.py, compare.py, images.ts).

### Deviations

- Item 3: a fixed 30 fps placement grid instead of the clip's rate (the browser has no frame rate; reaching it would
  mean new API fields, outside this ticket). At a faster render an emoji can graze an obstacle on a frame between grid
  frames; 8 ms or less.
- Item 9: the export follows the Studio's grouping (cheapest; the Studio cannot measure classic lines it does not mount).
- Item 12: a failing highlight falls to the accent before the stock body (the existing chain), so Halftone gets a red
  body and Chrome a blue one.
- `verify`'s sticker sheets now offset the shadow by the renderers' 2.56 units (it used 1.4, 1.8).
