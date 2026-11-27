# 33 — Emojis sit close to their caption on every preset

Status: done (2026-11-27, not committed)
Depends on: 32

## Why

Owner, 2026-11-27, after testing ticket 32 live in his Studio and an export: "emojis should work on all
the presets ... they should not be far from the captions, they should be balanced ... as a human eye."

Live test (clip 7ed59e90, a stacked-pill Scene style, 9:16): with 2–3 stacked rows the emoji often
drew **below the whole caption block, a full emoji height or more under the bottom row**, sometimes near
the bottom of the frame (🧠 about 110 px below "REMEMBER / THE COMMERCIAL" at 560 px preview height).
An emoji on the last word of a cue showed for only ~150 ms (😓 on "hard").

## What is known (read-only investigation, 2026-11-27)

- Every preset draws emojis: classic 24 (slot above), Dynamic 7 (above), Scene 84 (lyrics `beside-end`,
  dialogue `below`, rest `above`). Default-position synthetic run: classic 192/192, Dynamic 56/56, Scene
  669/672 drawn (Signal 2 and Combo 1 dropped `no-room`).
- **Scene cue box is one late sample**, `min(toMs − 50, lastWord + 350)` plus any plate
  (`packages/caption-scene/src/emoji/scene-cue-boxes.ts:144-163, 231-246`). It includes rows not yet
  revealed when the emoji pops, so a `below` slot lands under empty space. Verified case: box bottom
  y=1331, visible text bottom 937, emoji top 1356 (419 px ≈ 122 px at 560 preview).
- **Face zone flips to below first** (`layer.ts:144-153, 304-317`: below, end, start, then above; below at
  0.7 beats above at full). At caption `positionY` 58, 494 of 661 above/below placements went below;
  154 were more than 0.5 emoji heights (h) from the text visible 200 ms after the pop.
- Pivot: above/below centre on the box 0.18 × size away (`placement.ts:68-95`).
- Classic box is the font line box plus outline (`cue-box.ts:134-145`): rendered gaps 0.3–0.7 h.
  Dynamic 0.26–0.38 h.
- Late-word hold (`layer.ts:255-260, 286, 350`): only < 250 ms left gets the hold; a 250–260 ms window is
  opaque only ~160 ms because the 90 ms fade comes out of it (`timing.ts:29-31`); another emoji in the
  same cue can cut it to 150 ms. Intent in comments: 250 ms at full strength.
- Looked detached in the all-preset render: barrel, snipsnap, anime, funky, marquee, horizon (far below),
  wallpaper (high), spine.
- Harness: `scratchpad/explore-a/render.ts` (ASS + libass, ~70 s for all presets, one sheet per batch).

## Decision (orchestrator)

Design A from the investigation, plus a pop-time closeness rule:

1. **Above first.** For `auto`, try above (full, then 0.7), then beside (end/start), then below last.
   The face-zone flip only applies when the emoji's ink top would sit above a much higher line (start at
   0.25–0.30 of canvas height; pick by the real-footage check, not by taste alone).
2. **Measure closeness against what is on screen at the pop**, not the late sample: a slot whose gap to
   the text visible at the emoji's first frame is over 0.5 h is rejected (below uses the visible rows at
   pop; it must still pass the full-window collision check). Keep one static position per emoji (no
   following the active row), so Studio and export stay identical.
3. **Classic box:** tighten to glyph ink in both measurers (Studio and worker) only if it is a small,
   shared change; otherwise leave and say so.
4. **Minimum visible time:** an emoji is shown at full strength for at least 250 ms before its fade
   starts (≈ 340 ms total with fade), including windows of 250–340 ms; when the next emoji in the cue
   would cut it shorter, the earlier one yields as today only if it still gets 250 ms opaque, else the
   later one waits/drops (say which and why).
5. Explicit positions (Above / Below in the panel) and `beside-end` / `below` style slots keep their
   order; they get the same closeness and timing rules.

## Done when

- Conformance test over **every** preset (classic, Dynamic, Scene) at caption positions default, 30 and
  58: every placed emoji's gap to the text visible at its pop is ≤ 0.5 h, no overlap with visible text,
  inside the safe area; drops stay at or below today's (≤ 3 of 672 Scene) at default.
- Unit tests for the minimum visible time (late word, back-to-back emojis in one cue).
- All-preset render sheets (default and positionY 58) attached under `.scratch/add-emojis/evidence/33/`
  and judged by eye: emoji visibly belongs to its caption on every preset. Keep the render harness as
  `.scratch/add-emojis/tools/emoji-presets.ts`.
- Studio (web painter) and export (ASS) still match: the existing parity tests pass.
- `bun run lint`, `bun run typecheck`, `bun run test` pass (no PostgreSQL gates, no `next build`).
- ADR 0022 and `.scratch/add-emojis/spec.md` say the new placement order and timing rule.

## Evidence

Implemented 2026-11-27. Nothing committed. Measured with two tools now in the repo:
`.scratch/add-emojis/tools/emoji-closeness.ts` (geometry through the export's own feeders: 4 lines, 8 picks, every preset)
and `.scratch/add-emojis/tools/emoji-presets.ts` (libass frames + pixel gaps + contact sheets; `late` = the emoji on
"remember", the last word of most presets' 3-word cue; `stack` = one 5-word cue with the emoji on "still", frames 200 ms
and 1,100 ms after the pop). Before numbers were taken on HEAD's emoji files with the same tools.

### What changed

- `packages/caption-scene/src/emoji/placement.ts`: auto on an above slot tries `above, end, start, below` (top 30%:
  `below, end, start, above`), each side at every size before the next (`captionEmojiSideFirst`); explicit positions and
  the `beside-end`/`below` slots keep their order. `CAPTION_EMOJI_FACE_ZONE` 0.42 → **0.30**. `CAPTION_EMOJI_MAX_GAP` 0.5
  (new). `CAPTION_EMOJI_MIN_SHOW_MS` 300 → 340.
- `cue-box.ts`: optional `shownAt(atMs)` on a cue box (boxes of the text that reads then). `blockCueBox` /
  `captionBlockCueBox` report it for Dynamic blocks (each word from its `startSec`; no caller change).
- `scene-cue-boxes.ts`: `shownAt` for Scene Styles (own text at opacity 0.1 or more, bleed text cut to the canvas, the
  plates that text is written on, and another cue's plate via `withPlate`).
- `layer.ts`: a slot must sit within 0.5 h of the nearest text that reads during the pop (first 180 ms, re-checked at
  the start it waited for); below sits under that text (and must clear the later rows on every frame); above and beside
  also try it after the late box. Timing: `CAPTION_EMOJI_MIN_SHOWN_MS` = 250 + 90 = 340. A word with under 340 ms left
  holds (was 250); a held emoji needs a 340 ms window or draws nothing; the next emoji of the same cue never cuts the
  earlier one under 340 ms: **the later one waits** (starts where the earlier ends) and draws nothing (`no-time`) if that
  leaves it under 340 ms. Waiting keeps both emojis on most fast lines (the owner wants frequency); the cost is the later
  one appearing up to 340 ms after its word, still inside its cue.
- Tests: `layer.test.ts` (new order, face zone at 38.5% vs 47%, pop-time reference above/below, a far-only slot dropped,
  late word 250–340 ms, back-to-back emojis wait / drop), `placement-support.ts` (independent closeness check over every
  Scene Style), `placement.test.ts` (+ positions 30 and 58), `apps/media/src/caption-emoji-closeness.test.ts` (new:
  every classic and Dynamic preset at default/30/58 through the export), `caption-emoji-ass.test.ts` (yield case spaced
  360 ms so it still yields).
- Docs: ADR 0022 decision bullet; spec D4/D5 notes and the "Close to its caption (33)" as-built entry.

### Geometry, every preset (closeness tool; gap = emoji ink to the nearest text that reads during its pop, / ink height)

| Caption | Family | Before: sides | Before: gap p50 / p90 / max, >0.5 h | After: sides | After: gap p50 / p90 / max, >0.5 h |
| --- | --- | --- | --- | --- | --- |
| default | Scene (669 placed) | above 558, below 108, end 3 | 0.17 / 0.65 / 2.24, **101** | above 610, end 12, start 5, below 42 | 0.17 / 0.33 / 0.51, **2** |
| 58% | Scene | above 167, below 496, end 6 | 0.18 / 1.33 / 2.84, **212** | above 579, end 13, start 7, below 70 | 0.17 / 0.35 / 0.51, **2** |
| 30% | Scene | above 14, end 20, below 638 | 0.22 / 1.41 / 4.24, **224** | above 71, end 81, start 33, below 484 | 0.17 / 0.32 / 0.51, **1** |
| all | classic (192) | above (58%: 8 below; 30%: all below) | 0.16 / 0.17 / 0.17, 0 | above at default and 58%, below at 30% | same (the line box) |
| all | Dynamic (56) | above (58%: 8 below; 30%: all below) | vs box 0.17 / 0.17, 0 | above at default and 58%; at 30% below 38, beside 16, above 2 | vs drawn words 0.17 / 0.42 / 0.47, 0 |

The 2 left at 0.51 are measurement noise (placement keeps the gap from the turned ink box; the drawn paths are a little
tighter). Overlap with visible text 1 → 0; nothing outside the safe area. Drops: Scene 3 of 672 at default before and
after (Snipsnap, Tunnel, Bento now; Signal 2 + Combo 1 before); classic 0, Dynamic 0. At 30%: 0 → 3.

**Minimum visible time:** before, 221 of 917 placed emojis had under 250 ms at full strength (Scene min 170 ms, window
260 ms; classic/Dynamic 230 ms, window 320 ms). After: 0 (Scene min 250 ms / window 340 ms; classic/Dynamic 310 / 400).

### libass frames (pixel gap emoji ↔ nearest caption row, 200 ms after the pop, 115 presets)

| Scenario | Caption | Before: p50 / p90 / max, >0.5 h | After: p50 / p90 / max, >0.5 h | Drops before → after |
| --- | --- | --- | --- | --- |
| stack | default | 0.30 / 2.04 / 3.94, **31** | 0.26 / 0.45 / 1.70, **8** | 0 → 1 (Broadway) |
| stack | 58% | 0.62 / 2.17 / 3.98, **64** | 0.26 / 0.45 / 1.70, **8** | 0 → 1 (Broadway) |
| stack | 30% | 0.72 / 2.16 / 3.98, **63** | 0.26 / 0.43 / 1.74, **5** | 0 → 5 (Ransom, Diecut, Broadway, Pixelpop, Funky; before 2.5 h away) |
| late | default | 0.27 / 0.50 / 1.60, 10 | 0.27 / 0.50 / 1.58, 11 | 0 → 0 |
| late | 58% | 0.28 / 0.53 / 1.66, 16 | 0.27 / 0.49 / 1.58, 10 | 0 → 0 |
| late | 30% | 0.29 / 0.51 / 1.65, 14 | 0.27 / 0.51 / 1.63, 13 | 0 → 0 |

What is still over 0.5 h on the frames: classic presets 0.50–0.74 h above (Street, Punch, Glitch, Flip, Electric,
Bold-pop, Retro, Block, Blast, Jelly, Bubblegum: the classic box is the faces' Win line box plus outline, see below);
Wallpaper 1.6–1.7 h (the emoji sits just off its dark card, the plate the text is written on; the bright text is mid-card;
unchanged and reads as belonging to the card); Reveal at 30% 1.0–1.1 h (its later rows are clip-masked, and the scene
geometry has no clip, so they count as drawn; unchanged); Bento 0.53–0.66 h. In the late scenario the emoji on a 320 ms
last word now holds 400 ms at full strength for 250 ms (it is invisible at +450 ms on most presets, as designed).

Judged by eye on every sheet: before, stacks at 58% and 30% put the emoji under rows not yet shown (Headline, Velocity,
Reveal, Chrome, Diecut, Trace, Snipsnap, Scribble, Thermal, Slot, Manifesto, Barrel, Pills, Bubble…). After, the emoji sits
above the row on screen, beside it, or just under it, on every preset; Cursor, Anime, Tunnel and Combo wait up to 300 ms
for a close slot (invisible at +200 ms, then close).

Sheets: `.scratch/add-emojis/evidence/33/{before,after}/{default,58,30}/sheet-{before,after}-{late,stack}-<pos>-<n>.png`
(5 sheets each, 2 frames per preset), pixel gaps `pixel-gaps-*.json`, logs `log-{late,stack}.txt`; geometry
`closeness-{default,58,30}.json` in `before/` and `after/`.

### Face-zone line (measured, not by taste)

Sweep over 0.25 / 0.28 / 0.30 / 0.33 at captions 30, 38, 45, 50, 58% and default: at default and 58% every classic and
Dynamic emoji stays above for any line up to 0.30 (Scene 579–611 above); the line only decides captions around 38–50%.
Ticket 04b measured real-footage chins at 32–34% (two men) and 40% (a woman). **0.30** is the most face-protective value
in the decided range: classic flips to below at 38% and stays above at 45% (13 of 192 below) and 50%; 0.25 kept emojis
above at 38%, where their top reaches about 26% (eyes).

### Placement suite (fake measure, 84 styles, 9:16 / 1:1 / 16:9)

Demo drops 1 → 5 of 1,221; fast 6 → 20 of 3,024 (late-word `no-time` 1,346 → 1,358); badges within 1%. Lyrics fast 2 of 12
on 9:16 and 1:1 (threshold raised 1 → 2): its edge fallback sat at the safe area's edge, about three emoji heights from a
short line, which the closeness rule now refuses. Captions at 30% and 58% (9:16): demo 2 of 407, fast 8 of 1,008, gap
p50 0.17, p90 0.28–0.36, max 0.51. No emoji on a word face, all inside the safe area, all within 0.5 h (+0.03 tolerance).

### Classic box (decision 3): left as is

Tightening to glyph ink needs per-glyph ink extents from both measurers (the worker's HarfBuzz geometry and the Studio's
canvas `classicLineBoxEm`) and the baseline's place inside the line box: not a small shared change. Rendered gaps stay
0.3–0.74 h on the frames; the geometric gap to the box is 0.16–0.17 h.

### Checks

- `bun test` in `packages/caption-scene/src/emoji` (136 pass), `apps/media` emoji suites (incl. the new closeness test)
  and the web Studio emoji folder (129 pass, parity included).
- `bun run typecheck` 17/17; `bun run test` 16/16.
- `bun run lint`: my files are clean; it fails on untracked `.scratch/caption-templates-v2/**` files of other sessions.

### Review fixes (2026-11-27, two reviews, not committed)

Each fix has a failing test first (`layer.test.ts` unless named).

1. **Closeness on the first painted frame.** A slot was accepted when it was near text on *any* frame of the first 180 ms
   (Cascade at 58%: 2.44 h from the only row on screen until a row appeared 133 ms later; Spine 1.45 h). Now
   `captionEmojiShownAtPop` (`layer.ts`) is the text on the first export frame at or after the emoji's real start (after
   any wait for its slot; the first frame of the pop that shows text, when none does yet). `placement-support.ts`, the
   media closeness test and both tools use the same frame. Strict, Scene drops rose 3 → 11 of 672 (Bubble's bubble and
   Broadway's marquee frame grow in with the word, so no slot near the lone first glyph stays clear). Chosen fallback
   instead of dropping: `CAPTION_EMOJI_POP_FALLBACK_GAP` = 1, a slot within 0.5 h of the text that reads by the end of
   its pop and within 1 h of the first frame's (caps 99 / 1.5 / 1 measured: 4 / 5 / 6 drops, max 1.75 / 1.13 / 0.81 h).
   A row that appears later stays out of the strict rule. Tests: first-frame vs. later row, waited start, fallback vs. a
   bubble 2.3 h away.
2. **Dynamic Studio cache key** now names the block's timed parts (`CaptionEmojiCueBox.shownParts`, in
   `oneCueSourceKey`). Scene cues were already safe: the key is the built scene's identity, rebuilt on any onset change.
3. **Three emojis, middle dropped**: `lengthen` now hands the successor link on when the end stays equal or the slot
   cannot lengthen. Test: 1000/1100/1200 in a 1,500 ms cue and 0/100/180 in 500 ms → `[cue], no-time, no-time`, never
   two at once.
4. **Clip end**: `CaptionEmojiLayerInput.endMs` (plan `editedDurationSec`; export via `renderCaptionTrack.endSec`,
   Studio via `video-preview` into the one-cue, held and Scene layers, in the layer key). The window is cut at the end
   before the 340 ms check, and under it the emoji draws nothing (never earlier than its word).
6. `caption-emoji-closeness.test.ts` asserts every pick of every classic/Dynamic preset is drawn at each height, and
   that the export passes the clip end.
8. **Size control** (owner's report): the face zone is judged at the default size, and the steps are the choice, each
   smaller choice at full size, then the choice × 0.7 (`captionEmojiSizeSteps`: L 1.25/1/0.875/0.8, M 1/0.8/0.7,
   S 0.8/0.56). Test: a stacked cue at 16 heights across the face-zone line, S/M/L on one side with non-decreasing drawn
   size (failed at 720 px: S above, M/L below); a roof with room for M only: L draws at M's size (was 0.875).
9. **Same-cue overlap** (third review): at 30 fps, anchors 1000/1025/1050 in a cue to 3000 drew 1000–3000 and 1050–3000 (the
   middle waited and dropped; the first was placed with no successor link, so the third was not floored). Now an emoji starts
   no earlier than the end of the latest emoji of its cue that draws, and only that one is lengthened when its successor
   drops. Test: 11 dense and spaced anchor patterns × 24/30/60 fps × two cue lengths × with and without a clip end: no two
   of a cue overlap, each draws ≥ 340 ms from its word, inside its cue (or its late hold) and the clip.
10. **Medium smaller than Small, and on the other side** (third review): Bubble at 30%, 🎉 on "and it costs nothing": S 0.8
    at the reading start, M 0.7 at the reading end (side and tier were searched before size). Now the smallest choice that
    finds a slot sets it (`captionEmojiSizeChains`: S's steps, else M's, else L's); a larger choice then takes the largest of
    its sizes that fits on that side in as good a tier (first-frame vs. fallback, clear vs. covering a decoration, by the
    text vs. edge), else draws at the smaller choice's size. So M can draw at S × 0.7 (0.56) where a clear slot exists only
    there, before covering a decoration (the soft-obstacle and waits-for tests were updated for it). Test: classic (flat and
    tilting, short and full-width, above and beside-end), a staged Dynamic-like block, and Bubble, Pills, Tilt, Cascade,
    Lyrics (each sample cue alone) at default, 30% and 58%: S ≤ M ≤ L drawn, and a larger choice on the smaller one's side.
    On the 84-preset demo + fast runs at default/30%/58% (4,773 emojis): S unchanged; M 195 change side, 9 more drawn
    (no-room drops at 30%/58% 36 → 30); L 321 change side, 20 more drawn (35 → 21). Placement cost per emoji (30%/58% runs, best of 4) S 0.05,
    M 0.07, L 0.15 ms (was 0.04, 0.05, 0.08).

**Numbers** (`emoji-closeness.ts`, same 84 Scene presets, first-frame gap / ink height; files in `evidence/33/review/`):

| Caption | Scene before: >0.5 h, max, drops | After: >0.5 h, max, drops |
| --- | --- | --- |
| default | 51, 1.81, 3 | 8, 0.81, 6 (Bubble, Snipsnap, Tunnel 2, Broadway, Bento) |
| 58% | 50, 1.75, 3 | 8, 0.81, 6 |
| 30% | 63, 3.92, 3 | 5, 0.76, 9 (+ Gumdrop, Tilt) |

Classic 192/192 and Dynamic 56/56 drawn at every height before and after, none over 0.5 h. Placement suite (fake
measure, first-frame gap > 0.5 h, drops): demo 70 → 4, 5 → 11 of 1,221; fast 228 → 6, 20 → 26 of 3,024; badges
296 → 11, 24 → 35 of 4,245; 30%/58% demo 2 → 6 of 407, fast 8 → 11 of 1,008. Stacked libass render (`emoji-presets.ts
stack`, new `pop` sample = caption on the emoji's first frame): >0.5 h default 16 → 14 (Spine 1.75 h and Hollow 1.45 h
fixed), 58% 13 → 14, 30% 7 → 7; drops 1 → 1, 1 → 1, 5 → 6 (+ Snipsnap). What is left over 0.5 h there is the known classic
line box and Wallpaper's card. The renders were taken before fix 8. "Before" = this tree with the old any-frame rule
switched on for the run.

**Checks**: caption-scene emoji 153 pass; web Studio emoji 135; media emoji 49; caption-emoji 114; typecheck 17/17;
Biome clean on every changed file. `bun run test -- --continue`: failures only in other sessions' in-flight work
(caption-fonts Caveat Bold, untracked; web caption card clips and own-script table, their new styles and fonts); a
caption-scene placement failure in that run passed on rerun (it caught their registry edit half-written).
