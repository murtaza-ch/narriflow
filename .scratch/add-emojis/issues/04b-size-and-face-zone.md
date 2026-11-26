# 04b - Emoji size and the face zone

**What to build:** Two refinements to the emoji layer after the coordinator looked at ticket 04's
contact sheets. Rules: [../RULES.md](../RULES.md). Spec D4.

**Blocked by:** [04 - The emoji layer](04-emoji-layer.md)

**Status:** done

## Areas

`packages/caption-scene/src/emoji/**` and its tests only. The exported API must not change
(tickets 06 and 07 are being built against it right now).

## What the sheets showed

- The emoji is too small on most styles. On Boom, Tunnel, Hollow, Punchline, Verified and Velocity
  it is about 9% of the frame's width next to large display text and reads as a badge, not as part
  of the caption. On Gumdrop and Squash (about 14%) it reads right. The owner's prototype draws the
  emoji at nearly three times the caption's text size.
- When the caption sits mid-frame, an emoji above it lands on the speaker's face (Gumdrop: on the
  mouth; Squash and Halftone: chin). The layer has no face data, but faces in talking-head video
  sit in the upper part of the frame.

## Deliverables

1. Size: `1.6 x bodyPx x emojiSize`, clamped to 12.5% to 16% of the canvas's short side before
   `emojiSize` is applied (so S, M, L always differ). Change the constants in `layer.ts`, keep
   `captionEmojiSizePx` the single source. The shrink step (0.7) stays.
2. Face zone, for `emojiPosition: "auto"` only: when the emoji placed above would have its centre
   higher than 42% of the frame's height, try below first, then above. (The existing rule, below
   when the caption anchor is in the top 30%, stays.) An explicit `above` or `below` from the owner
   is always tried first as today. Slots other than `above` (`below`, `beside-end`) are unchanged.
3. Re-run the placement tests and tables on the three canvases with the new size. Keep the drop
   rate on demo cues at or under 1% overall with no style above 10% if you can; where a style gets
   worse because the emoji is bigger, fix the slot logic, not the size. Update thresholds only with
   the measured numbers in Evidence.
4. Regenerate the five contact sheets with the scripts in
   `/private/tmp/claude-501/-Users-murtaza-Documents-dev-narriflow/f7147bb1-206f-4f6e-a8fc-276dea0eb55b/scratchpad/emoji-layer/tools/`
   (run from `apps/media`), into the same folder with a `v2-` prefix, and look at them: the emoji
   should read as part of the caption on every style, and should not sit on a face where below was
   available. In the sheets, give neighbouring tiles different emojis (rocket, fire, money bag,
   laughing face, a hand with a skin tone, a profession) so more of the art is exercised.

## Acceptance

- [x] Deliverables 1 to 4, tables and sheet paths in Evidence.
- [x] `bun run --cwd packages/caption-scene test`, `bun run typecheck`, biome on touched files.

## Evidence

Implemented 2026-11-26. Nothing committed. Exported API unchanged (no export renamed, removed or
re-signed); two constants added (`CAPTION_EMOJI_FACE_ZONE`, `CAPTION_EMOJI_POP_PEAK`).

### Files (all in `packages/caption-scene/src/emoji/`)

- `layer.ts`: size constants `1.6`, `0.125`, `0.16`; `captionEmojiSizePx` clamps first, then multiplies
  by `emojiSize`. Face-zone rule and try order. Side slots try the last row, then the whole cue.
- `placement.ts`: `CAPTION_EMOJI_FACE_ZONE = 0.42`. `slotPivot` keeps an edge-clamped emoji inside at
  the pop's peak scale.
- `timing.ts`: `CAPTION_EMOJI_POP_PEAK` (1.06, sampled from the `outBack` pop).
- `drawing.ts`: `ink` is the union of every part's bounds, not just the outline's.
- `placement-support.ts` (internal, not exported): optional `emojis` list (id and tone) for the sheets.
- Tests: `layer.test.ts` (size, face zone, beside fallback, pop-edge regression),
  `placement.test.ts` (threshold comment with the new numbers; thresholds unchanged).

### Size

`captionEmojiSizePx(bodyPx, size, canvas) = size * clamp(1.6 * bodyPx, 0.125 * short, 0.16 * short)`.
On a 1080 px short side: 135 to 173 px at default size (was 97 to 194 px, mostly the 97 px floor).
S, M and L differ at either bound (tested).

### Face zone: deviations from the ticket's wording, and why

1. **The emoji's top edge is tested, not its centre.** The first v2 sheet with the centre rule left
   the emoji on the chin on Halftone and Rainbow: centres at 43% to 47%, top edges at 38% to 39%. The
   woman backdrop's chin is at about 40% of the height; the two men's chins are at 32% to 34%. With
   the top edge, Halftone goes below (room at full size), and so do Squash and Rainbow where room exists.
2. **In the face zone, below at 0.7 comes before above at full size.** On Gumdrop the stack reaches
   85% of the height, so below fits only at 0.7. The old order (all sides at full size, then 0.7)
   put it back on her mouth.

Cost: on 1:1 and 16:9 (short frames, captions near mid-height) more emojis go below, some at 0.7
(Tunnel, Aura, Tape), where above would have been on the chest. Without face data this is the safe
side. An explicit `above` or `below`, and the `below` and `beside-end` slots, keep their order (tested).

### Slot fixes found while re-measuring

- **Pop overshoot at an edge.** `outBack` peaks at 1.06. An emoji clamped to the safe area at rest
  scale left it mid-pop, every retry failed, and the emoji was dropped. The bigger size showed it
  (Bulletin fast 9:16: 6 of 12 dropped). `slotPivot` now clamps at the peak; regression test added
  (fails with peak = 1).
- **Ink bounds.** With the sticker on, `ink` counted only the outline. A colour layer's
  control-point bounds can reach about 3 px past it, which the independent check in
  `placement-support` flagged once the clamp was exact. `ink` is now the union of every part.
- **Lyrics `beside-end`.** A 147 px emoji is taller than Lyrics' 50 px gaps to the dim neighbour
  lines, so on fast speech it fit nowhere (7 of 12 dropped). A side slot now also tries level with
  the whole cue, past its widest row, which clears both dim lines. Back to 4 of 12, as in ticket 04.
  Tested.

### Placement totals (one emoji per cue, 84 styles x 3 canvases)

| Run | Ticket 04 (before) | 04b (after) |
| --- | --- | --- |
| Demo, fake measure | 8 / 1,221 (0.66%) | 8 / 1,221 (0.66%) |
| Fast, fake measure | 100 / 3,024 (3.3%) | 89 / 3,024 (2.9%) |
| Demo, HarfBuzz | 6 / 1,221 | 6 / 1,221 |
| Fast, HarfBuzz | 93 / 3,024 | 83 / 3,024 |
| Problems (ink on a word face, or outside the safe area) | 0 | 0 |

The test thresholds are unchanged: demo under 1% and at most half a style's cues; fast under 5% and
at most half. Demo drops (fake measure): Gumdrop 2 of 4 on 1:1 and 16:9, Cascade 1 on each canvas,
Rainbow 1 on 1:1. No style is above 10% on 9:16 demo except Cascade's single cue (1 of 5, the same
as ticket 04). Fast, HarfBuzz, over 25%: only Lyrics 4 of 12 (9:16 and 1:1); Wonky 4 of 12 on 1:1
is gone. Demo over 20%: Gumdrop 1 of 4 (1:1 and 16:9), unchanged.

### Per-style table, before → after (fake measure; cells as in ticket 04: cues above/below/side, shrunk, dropped)

| Style | 9:16 demo before → after | 9:16 fast before → after | 1:1 dropped demo/fast before → after | 16:9 dropped demo/fast before → after |
| --- | --- | --- | --- | --- |
| lyrics | 5 0/1/4 s0 d0 → 5 0/2/3 s2 d0 | 12 3/2/3 s3 d4 → 12 3/0/5 s1 d4 | 0/4 | 0/2 |
| dialogue | 5 0/5/0 s0 d0 | 12 1/11/0 s0 d0 → 12 0/12/0 s0 d0 | 0/0 | 0/0 |
| dossier | 4 4/0/0 s0 d0 | 12 11/0/0 s0 d1 → 12 12/0/0 s0 d0 | 0/1 → 0/0 | 0/1 → 0/0 |
| hollow | 5 5/0/0 s0 d0 → 5 3/2/0 s1 d0 | 12 11/0/0 s0 d1 | 0/2 | 0/2 |
| signal | 4 4/0/0 s0 d0 | 12 12/0/0 s0 d0 → 12 7/5/0 s0 d0 | 0/0 | 0/0 |
| track | 5 4/1/0 s0 d0 | 12 9/2/0 s0 d1 → 12 10/2/0 s0 d0 | 0/1 | 0/0 |
| bulletin | 4 4/0/0 s0 d0 | 12 10/2/0 s6 d0 → 12 11/1/0 s0 d0 | 0/0 | 0/0 |
| index | 5 5/0/0 s0 d0 | 12 11/0/0 s0 d1 → 12 12/0/0 s0 d0 | 0/1 → 0/0 | 0/1 → 0/0 |
| punchline | 4 4/0/0 s0 d0 | 12 10/1/0 s0 d1 → 12 10/2/0 s0 d0 | 0/1 → 0/0 | 0/1 → 0/0 |
| doodle | 5 4/1/0 s0 d0 → 5 5/0/0 s0 d0 | 12 12/0/0 s0 d0 | 0/0 | 0/0 |
| velocity | 4 4/0/0 s0 d0 | 12 11/1/0 s0 d0 → 12 11/1/0 s1 d0 | 0/0 | 0/0 |
| spine | 4 4/0/0 s0 d0 → 4 3/1/0 s0 d0 | 12 11/1/0 s0 d0 → 12 8/4/0 s0 d0 | 0/0 | 0/0 |
| wonky | 5 5/0/0 s0 d0 | 12 9/1/0 s0 d2 → 12 7/3/0 s2 d2 | 0/3 | 0/2 → 0/3 |
| verified | 5 5/0/0 s0 d0 | 12 10/0/0 s0 d2 → 12 10/1/0 s0 d1 | 0/2 | 0/2 |
| premiere | 4 4/0/0 s0 d0 → 4 2/2/0 s0 d0 | 12 10/2/0 s0 d0 → 12 6/5/0 s0 d1 | 0/1 → 0/2 | 0/1 → 0/2 |
| tape | 5 4/1/0 s0 d0 | 12 9/1/0 s0 d2 → 12 10/1/0 s0 d1 | 0/2 | 0/2 |
| beat | 5 5/0/0 s0 d0 | 12 10/0/0 s0 d2 → 12 11/0/0 s0 d1 | 0/2 → 0/1 | 0/2 → 0/1 |
| slice | 5 5/0/0 s0 d0 | 12 10/1/0 s0 d1 → 12 10/2/0 s0 d0 | 0/1 | 0/1 |
| arthouse | 4 4/0/0 s0 d0 → 4 1/3/0 s1 d0 | 12 9/0/0 s0 d3 → 12 4/5/0 s0 d3 | 0/3 | 0/3 |
| popup | 5 5/0/0 s0 d0 | 12 10/1/0 s0 d1 | 0/1 → 0/2 | 0/1 → 0/2 |
| trail | 5 5/0/0 s0 d0 | 12 12/0/0 s0 d0 → 12 11/1/0 s0 d0 | 0/0 | 0/0 |
| ransom | 4 4/0/0 s0 d0 → 4 2/2/0 s0 d0 | 12 12/0/0 s0 d0 → 12 10/2/0 s0 d0 | 0/0 | 0/0 |
| ledge | 5 5/0/0 s0 d0 | 12 10/2/0 s0 d0 → 12 11/1/0 s0 d0 | 0/0 | 0/0 |
| orbit | 5 5/0/0 s0 d0 | 12 9/1/0 s0 d2 → 12 10/1/0 s0 d1 | 0/2 | 0/2 |
| squash | 4 4/0/0 s0 d0 → 4 2/2/0 s0 d0 | 12 12/0/0 s0 d0 → 12 7/5/0 s0 d0 | 0/0 | 0/0 |
| bubble | 5 5/0/0 s0 d0 → 5 4/1/0 s0 d0 | 12 12/0/0 s0 d0 → 12 8/4/0 s0 d0 | 0/0 | 0/0 |
| manifesto | 5 5/0/0 s0 d0 → 5 1/4/0 s0 d0 | 12 12/0/0 s0 d0 → 12 8/4/0 s2 d0 | 0/0 | 0/0 |
| swipe | 5 5/0/0 s0 d0 | 12 12/0/0 s0 d0 → 12 11/1/0 s0 d0 | 0/0 | 0/0 |
| scribble | 5 5/0/0 s0 d0 → 5 4/1/0 s0 d0 | 12 12/0/0 s0 d0 | 0/0 | 0/0 |
| barrel | 5 5/0/0 s0 d0 → 5 0/5/0 s0 d0 | 12 12/0/0 s0 d0 → 12 0/12/0 s0 d0 | 0/0 | 0/0 |
| diecut | 5 5/0/0 s0 d0 → 5 3/2/0 s0 d0 | 12 12/0/0 s0 d0 → 12 11/1/0 s0 d0 | 0/0 | 0/0 |
| gumdrop | 4 4/0/0 s0 d0 → 4 1/3/0 s3 d0 | 12 12/0/0 s0 d0 → 12 4/8/0 s2 d0 | 2/0 | 2/0 |
| trace | 4 4/0/0 s0 d0 → 4 3/1/0 s1 d0 | 12 12/0/0 s0 d0 → 12 9/3/0 s3 d0 | 0/0 | 0/0 |
| snipsnap | 5 5/0/0 s0 d0 → 5 2/3/0 s1 d0 | 12 12/0/0 s0 d0 → 12 7/5/0 s1 d0 | 0/0 | 0/0 |
| anime | 5 5/0/0 s0 d0 → 5 4/1/0 s0 d0 | 12 12/0/0 s0 d0 → 12 8/4/0 s3 d0 | 0/0 | 0/0 |
| tunnel | 5 5/0/0 s0 d0 | 12 12/0/0 s2 d0 → 12 9/3/0 s4 d0 | 0/0 | 0/0 |
| broadway | 5 5/0/0 s0 d0 → 5 1/4/0 s3 d0 | 12 12/0/0 s0 d0 → 12 6/6/0 s5 d0 | 0/0 | 0/0 |
| bento | 5 5/0/0 s0 d0 → 5 3/2/0 s0 d0 | 12 12/0/0 s0 d0 | 0/0 | 0/0 |
| blinds | 5 5/0/0 s0 d0 | 12 12/0/0 s0 d0 → 12 10/2/0 s2 d0 | 0/0 | 0/0 |
| receipt | 5 5/0/0 s0 d0 → 5 4/1/0 s0 d0 | 12 12/0/0 s0 d0 → 12 9/3/0 s0 d0 | 0/0 | 0/0 |
| rainbow | 5 5/0/0 s0 d0 → 5 3/2/0 s1 d0 | 12 12/0/0 s0 d0 → 12 7/5/0 s2 d0 | 1/0 | 0/0 |
| tilt | 5 5/0/0 s0 d0 → 5 4/1/0 s1 d0 | 12 12/0/0 s0 d0 → 12 7/5/0 s4 d0 | 0/0 | 0/0 |
| vibes | 5 5/0/0 s0 d0 → 5 4/1/0 s0 d0 | 12 12/0/0 s0 d0 → 12 10/2/0 s0 d0 | 0/0 | 0/0 |
| pixelpop | 5 5/0/0 s0 d0 → 5 1/4/0 s0 d0 | 12 12/0/0 s0 d0 → 12 2/10/0 s1 d0 | 0/0 | 0/0 |
| funky | 5 5/0/0 s0 d0 → 5 2/3/0 s3 d0 | 12 12/0/0 s0 d0 → 12 5/7/0 s5 d0 | 0/0 | 0/0 |
| glint | 5 5/0/0 s0 d0 → 5 4/1/0 s1 d0 | 12 12/0/0 s0 d0 → 12 9/3/0 s3 d0 | 0/0 | 0/0 |
| marquee | 5 5/0/0 s0 d0 → 5 1/4/0 s0 d0 | 12 12/0/0 s0 d0 → 12 2/10/0 s0 d0 | 0/0 | 0/0 |
| horizon | 5 5/0/0 s0 d0 → 5 3/2/0 s0 d0 | 12 12/0/0 s0 d0 → 12 1/11/0 s0 d0 | 0/0 | 0/0 |
| halftone | 5 5/0/0 s0 d0 | 12 12/0/0 s0 d0 → 12 8/4/0 s2 d0 | 0/0 | 0/0 |

Unchanged (35): ticker, flap, wordform, chrome, reveal, boom, aura, cursor, stretch, hype, wallpaper, heft, cascade, shuffle, slab, labels, googly, strike, seventies, thermal, slot, inkup, primer, match, pills, pixel, sticky, brute, mdrn, crosstape, flowing, ripple, liquid, chronicle, combo

### Build time (re-run of ticket 04's bench)

60 s, 20 emojis, median of 7: Horizon 15.9 ms HarfBuzz / 12.4 ms fake (was 19.7 / 15.1), Wordform
12.2 ms, Lyrics 10.8 ms, Reveal 1.6 ms. Unchanged within noise despite the extra tries.

### Contact sheets (v2)

Real export path (`sceneEvents` with HarfBuzz, burned by ffmpeg/libass). Neighbouring tiles start at
different emojis from a set of 20: rocket, flame, money bag, laugh tears, thumbs up (tone 3),
technologist (tone 5), exploding head, waving hand (tone 4), cook (tone 1), hundred, flexed biceps
(tone 2), woman astronaut, brain, clapping hands (tone 1), crown, artist (tone 4), bulb, raising hands
(tone 4), star struck, man scientist (tone 3). Each tile's label names the emoji shown.

- `/private/tmp/claude-501/-Users-murtaza-Documents-dev-narriflow/f7147bb1-206f-4f6e-a8fc-276dea0eb55b/scratchpad/emoji-layer/v2-sheet-ltr-9x16.png` (32 styles, the same as v1)
- `/private/tmp/claude-501/-Users-murtaza-Documents-dev-narriflow/f7147bb1-206f-4f6e-a8fc-276dea0eb55b/scratchpad/emoji-layer/v2-sheet-rtl-9x16.png` (24, Urdu and Arabic)
- `/private/tmp/claude-501/-Users-murtaza-Documents-dev-narriflow/f7147bb1-206f-4f6e-a8fc-276dea0eb55b/scratchpad/emoji-layer/v2-sheet-ltr-1x1.png` and `/private/tmp/claude-501/-Users-murtaza-Documents-dev-narriflow/f7147bb1-206f-4f6e-a8fc-276dea0eb55b/scratchpad/emoji-layer/v2-sheet-ltr-16x9.png` (16 each)
- `/private/tmp/claude-501/-Users-murtaza-Documents-dev-narriflow/f7147bb1-206f-4f6e-a8fc-276dea0eb55b/scratchpad/emoji-layer/v2-sheet-fast-9x16.png` (16, fast run)

The scripts are in `/private/tmp/claude-501/-Users-murtaza-Documents-dev-narriflow/f7147bb1-206f-4f6e-a8fc-276dea0eb55b/scratchpad/emoji-layer/tools-v2/` (`sheet.ts` plus `sheet-at.ts`, which takes `T_MS` for a chosen
frame); run them from `apps/media`.

Looked at each sheet:
- The emoji reads as part of the caption on Boom, Tunnel, Hollow, Punchline, Verified and Velocity.
- Gumdrop, Squash, Halftone and Rainbow (9:16) and Receipt (RTL) now sit below, off the face.
- Lyrics sits at the reading end, on the left in RTL.

What remains:
- Where a style's own text fills the frame's height (Gumdrop on 1:1 and 16:9, Gumdrop RTL, Receipt
  1:1), no slot is off the face, so the emoji goes above.
- Below-at-0.7 emojis on short frames sit over Tape's bleed decoration.
- Arthouse's tilted lines leave a below emoji a little further from the words (the box is the tilted
  text's bounding box).

### Commands

- `bun run --cwd packages/caption-scene test`: 3,111 pass, 0 fail (83 s).
- `CAPTION_EMOJI_PLACEMENT_REPORT=1 bun test packages/caption-scene/src/emoji/`: 114 pass.
- `bun run typecheck`: 17 of 17 successful. The first run failed in `@narriflow/media#typecheck` and
  then passed alone and on re-run: the other agent was mid-edit.
- `bunx biome check packages/caption-scene/src/emoji/`: 12 files, clean.
- During the run the sheet tool briefly failed to import `apps/media/src/caption-emoji-ass.ts`
  (`@narriflow/caption-emoji/art` did not resolve from `apps/media`); it worked again minutes later.
