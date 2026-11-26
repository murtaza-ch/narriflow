# 28 — Fewer dropped emojis on fast speech; phrase badges at a readable size

**Status:** done
**Area:** `packages/caption-scene/src/emoji/**` and its tests; a style's `emojiSlot` if needed. Not the template programs' text layout (ticket 29 is in `templates/bubble.ts`).

## Why

The owner asked for the fixable known limits to be fixed.

1. **Fast speech.** With the real measure the fast run drops 93 of 3,024 emojis (ticket 04
   Evidence, "Placement table"). Two styles carry most of it: Lyrics 5 of 12 (9:16 and 1:1) and
   Wonky 4 of 12 (1:1). Lyrics: a fast line fills the frame's width, the dimmed neighbour lines
   hold the rows above and below, and the stack scrolls during a 300 to 600 ms cue. A user who
   turns Add Emojis on with Lyrics and speaks fast sees almost half of them missing.
2. **Phrase badges.** A badge draws its main emoji at 0.74 of the box (ticket 23 Evidence), so
   beside single emojis it looks small.

## Deliverables

1. Lyrics and Wonky drop at most 1 of 12 on the fast run on every canvas, with the placement
   test's "no problem" rule intact (no emoji ink meets a word face of any cue at opacity 0.1+, or
   leaves the safe area). Choose the smallest honest way: another slot tried before giving up, a
   smaller floor size for these cases, following the line's scroll, or sitting where the style
   leaves room. Re-run the whole table: no other style may get worse, and total fast drops should
   fall well under the current 93.
2. A badge draws so its main emoji is close to a single emoji's size (somewhere near 1.2x the
   box; pick the number by rendering). Placement must use the larger box, so check the drop table
   with badges on fast and demo runs. One place decides the scale; Studio and export share it.
3. Render before and after on real cues (`apps/media/scripts/caption-scene-real-render.ts`, see
   ticket 23 Evidence for a working invocation with a badge placed by hand) for Lyrics on a fast
   passage and for a badge next to a single emoji on three presets. Look at the frames.

## Acceptance

- [x] The placement table before and after for every style (demo and fast, three canvases).
- [x] Frames looked at; Studio and export parity for the changed cases is still 0 px (the parity
      harness from ticket 12).
- [x] Late-word exit (ticket 24) still holds: a held emoji never covers the next caption.
- [x] `bun run --cwd packages/caption-scene test`, `bun run --cwd apps/media test`, the web emoji
      layer tests, typecheck, biome on touched paths. Scene build time for the emoji layer does
      not grow by more than 10% (ticket 04 has the numbers).

Evidence images go in
`/private/tmp/claude-501/-Users-murtaza-Documents-dev-narriflow/f7147bb1-206f-4f6e-a8fc-276dea0eb55b/scratchpad/emoji-fix-layer/`.

## Evidence

Done 2026-11-26. Nothing committed, migrated or deployed. `E` below is
`/private/tmp/claude-501/-Users-murtaza-Documents-dev-narriflow/f7147bb1-206f-4f6e-a8fc-276dea0eb55b/scratchpad/emoji-fix-layer`
(images, plus `E/tools/` with the scripts and the before/after tables as JSON).

### What the fast run loses today (read before the numbers)

The ticket's 93 of 3,024 predates tickets 20, 21 and 24. On the inherited tree the fast run loses 1,364 of 3,024
emojis, but only 18 for want of room (`no-room`); 1,346 are `no-time`: in the fast run each cue's hero is its last
word (100 ms, no gap to the next cue), and ticket 24's rule draws nothing for a word that leaves under 120 ms of its
cue, or that cannot hold 250 ms before the next cue's emoji. That is the timing rule working as specified, not
placement, and this ticket leaves it alone (it would break the late-word exit). Every number below is `no-room`;
`no-time` is identical before and after (1,346 fast, 0 demo) on every run.

### What changed

1. **Edge slots** (`placement.ts` `slotPivot(..., nudge, edge)`, `layer.ts` try order). When no slot by the text is
   clear (at full size and at 0.7), an emoji tries the same sides again at their edge: above or below the cue's
   reading end instead of its centre (clear where the neighbour line is shorter), and level with the row at the safe
   area's edge on that side (past shorter neighbour lines). They come after every existing try at the same strictness
   (strict first, then the soft-obstacle pass), so an emoji that fitted before keeps exactly its slot: only emojis
   that used to drop, or to cover a decoration, move. No style slot changed; no second placement system.
2. **Badge size** (`layer.ts` `CAPTION_EMOJI_BADGE_SCALE = 1.2`). A phrase badge draws 1.2 times an emoji's size, so
   its main emoji (0.74 of the art box) is 0.89 of a single emoji. Placement runs on the larger drawing; a badge
   tries its size, then 0.7 of it, then a single emoji's shrunk size (0.7) before it is dropped (without that last
   step a 1.2 badge dropped 1 more on Dialogue 1:1 and 16:9, demo and fast: a bubble stack leaves only room below the
   newest bubble). The one place is the layer's planning step, which both renderers call. The art says what it is:
   `CaptionEmojiArt.badge` (`packages/caption-emoji/src/art.ts`, set at load from the index entry the loader already
   reads; no shard format change, no rebuild).
3. Prototype `apps/web/app/prototype/caption-emojis/{page,caption-emojis}.tsx`: `?ids=a,b,...` replaces the fixture's
   emojis on the same words (the fixture's existing `emojiIds`), for the parity run with badges. Outside the ticket's
   area, additive, prototype only.

### Placement table (one emoji per cue, hero else middle word; 84 styles x 9:16, 1:1, 16:9)

Totals, `no-room` drops (problems = emoji ink on a word face or outside the safe area):

| Run | Before | After |
| --- | --- | --- |
| Demo, real HarfBuzz measure | 5 / 1,221 | 4 / 1,221 |
| Fast, real HarfBuzz measure | 18 / 3,024 | **6 / 3,024** |
| Demo, fake measure (the test) | 4 / 1,221 | 1 / 1,221 |
| Fast, fake measure (the test) | 12 / 3,024 | 6 / 3,024 |
| Every other emoji a badge, demo, HarfBuzz | 5 / 1,221 (badges at 1.0) | 4 / 1,221 (badges at 1.2) |
| Every other emoji a badge, fast, HarfBuzz | 18 / 3,024 | 5 / 3,024 |
| Every other emoji a badge, demo / fast, fake | n/a | 1 / 4 |
| Problems, every run | 0 | 0 |

Every row that changed, real measure, single emojis (cells: cues above/below/side, shrunk, dropped, late); all other
243 rows are identical:

| Style, canvas, run | Before | After |
| --- | --- | --- |
| lyrics 9:16 fast | 12 1/1/1 s0 d3 late6 | 12 2/1/3 s1 d0 late6 |
| lyrics 1:1 fast | 12 1/1/1 s0 d3 late6 | 12 2/1/3 s1 d0 late6 |
| wonky 1:1 fast | 12 1/0/3 s3 d2 late6 | 12 1/0/4 s3 d1 late6 |
| beat 9:16 fast | 12 5/0/0 s0 d1 late6 | 12 6/0/0 s0 d0 late6 |
| beat 1:1 fast | 12 3/1/1 s1 d1 late6 | 12 4/1/1 s1 d0 late6 |
| beat 16:9 fast | 12 0/1/4 s1 d1 late6 | 12 1/1/4 s1 d0 late6 |
| gumdrop 1:1 fast | 12 2/2/2 s3 d1 late5 | 12 2/2/3 s4 d0 late5 |
| marquee 16:9 fast | 12 0/0/6 s0 d1 late5 | 12 0/0/7 s0 d0 late5 |
| rainbow 1:1 demo | 5 1/1/2 s2 d1 late0 | 5 1/1/3 s2 d0 late0 |

Fake measure, every changed row: lyrics 9:16 and 1:1 fast d1 → d0, wonky 9:16 fast d1 → d0, arthouse 9:16 and 1:1
fast d1 → d0, cascade 1:1 and 16:9 demo d1 → d0, rainbow 1:1 demo d1 → d0, marquee 16:9 fast d1 → d0, tunnel 1:1
fast (no drop) one emoji off its decoration (s5 → s4). Lyrics and Wonky now drop at most 1 of 12 on every canvas
(Lyrics 0 everywhere; Wonky 1 on 1:1 real measure: cue 4, a 250 ms cue whose previous cue's exiting text covers
every slot at its start, so no slot rule can save it). No style got worse in any run.

What still drops (real measure): Cascade demo 1 per canvas, Gumdrop 1:1 demo, Pills fast 9:16, 1:1 and 16:9,
Marquee fast 9:16 and 1:1, Wonky 1:1 fast.

Badges, real measure, rows whose drops changed (badge at 1.0 before, 1.2 after): lyrics 9:16 and 1:1 fast 3 → 0,
wonky 1:1 fast 2 → 1, beat 9:16, 1:1, 16:9 fast 1 → 0, pills 1:1 and 16:9 fast 1 → 0, rainbow 1:1 demo 1 → 0,
marquee 16:9 fast 1 → 0; none rose. The larger drawing shrinks more often (155 rows' shrunk count changed), which is
the cost of the bigger badge. Tables: `E/tools/{before,final}-{hb,fake,hb-badge}.json`, `final-fake-badge.json`;
`bun E/tools/table.ts <out.json> [fake] [badge]` and `bun E/tools/diff.ts a.json b.json` from `apps/media`.

### Real clip renders (looked at)

Source: the 76 s Urdu upload (`.scratch/motion-captions/out/real/urdu-direction/source.mp4`) with the `hi-matte`
document (its Hindi transcript; the other real clips' sources are not on disk). `caption-scene-real-render.ts`, every
render `validateRenderOutput` ok.

- **Lyrics on fast speech** (4.6 words/s, `--presets lyrics,wonky --aspect 9:16|1:1 --emojis 34`: 34 *test* emojis,
  the script's fixed list spread over the words, not picks). Before: Lyrics placed 28, dropped 6 `no-room` on both
  canvases; after: 34 of 34. Wonky 34 of 34 both. Frames at each of the six recovered emojis, before | after:
  `E/lyrics-real-9x16-before-after.png`, `E/lyrics-real-1x1-before-after.png`. Seen: each recovered emoji sits over
  the active line's reading end, right of the shorter dim line above, or level with the line at the frame's right
  edge; none touches a word, dim or active.
- **Badge next to a single emoji**, three presets (Electric classic, Headline Dynamic, Reveal Scene), both placed by
  hand on real words that call for them: 🤯💸 Sticker shock on "लाख" in "नौ लाख के phone" (a nine-lakh phone), then 📱 on
  "phone" (`--add "39720=🤯💸,40120=📱"`). Rendered at 1.0, 1.2 and 1.35: `E/badge-scale-vs-single.png` (columns 1.0 |
  1.2 | 1.35 | the single 📱; rows Electric, Headline, Reveal; full-resolution crops). Chosen 1.2: at 1.0 the exploding
  head is visibly smaller than the phone beside it; at 1.2 it reads about the same size (0.89); at 1.35 the face
  matches but the badge with its disc dominates the caption.

### Parity (ticket 12's harness, Studio minus export)

Studio: the prototype's `?debug=1` JSON in headless Chrome against the owner's dev server on port 3000 (read-only);
export: `renderCaptionTrack` (HarfBuzz) read back from the ASS. Scripts `E/tools/parity/` (`worker.ts plain|badges|long`,
`studio.py`, `compare.py`).

- Badges (`?ids=sticker-shock,bulb,worth-the-price,money-bag`: two badges and two singles on each of the 10 frames,
  classic, Dynamic, Scene, LTR and Urdu): 40 placements, centre dx and dy, size and turn **0.00 px** on every one;
  badges draw 192 px against 160 for a single (209 against 174 on Lyrics; Horizon's and Bubble's badges sit shrunk).
  Windows differ by under one frame (0 to 30 ms, the ASS writer's frame and centisecond snapping, as in ticket 12).
- The plain fixture: 40 placements, all 0.00 px (Bubble Urdu too, now).
- Edge slots: no fixture frame reaches them (the 60 s `long` Lyrics run places 20 of 20 with and without them), so
  the browser harness cannot exercise one. The edge pivot is computed from the cue box and the safe area alone, by
  the same shared function on both sides, so its parity is the cue boxes' parity, which the Lyrics frames show at
  0 px.

### Late-word exit (ticket 24)

The held-emoji tests in `layer.test.ts` ("a held emoji leaves with its caption", 4 tests) pass unchanged. The edge
slots go through the same `slotWindow` with the same obstacles, so a held emoji's edge slot must also miss the next
cue's box that a one-cue feeder passes (`withOtherCues`).

### Build time (budget: +10%)

`sceneCueBoxes` + `buildCaptionEmojiPieces`, 60 s of cues, 20 emojis, real measure (`E/tools/bench.ts`). The machine ran
other builders' suites (load average 20 to 24), so wall time was unusable (one run doubled every number); measured as
CPU time, median of 15, three interleaved before/after runs, mean of the medians:

| Case | Before | After | Emojis drawn before → after |
| --- | --- | --- | --- |
| Horizon | 20.6 ms | 22.5 ms | 20 → 20, identical slots |
| Wordform | 16.6 ms | 15.0 ms | 20 → 20, identical slots |
| Reveal | 2.4 ms | 2.8 ms | 20 → 20, identical slots |
| Lyrics | 16.8 ms | 17.8 ms (+6%) | 10 → 20 |
| Lyrics, fast speech (99 cues) | 12.2 ms | 13.2 ms (+8%) | 12 → 20 |

For Horizon, Wordform and Reveal the edge pass never runs (every emoji fits at its first slots, outcomes identical), so
their differences are noise. Lyrics pays 6 to 8% and draws twice as many emojis: in the 60 s bench it dropped 10 of
20 before (the stack scrolls under an early-word emoji), 0 after.

### Tests added

- `layer.test.ts`: a full-width line between dim lines goes over its reading end past the shorter line above; a short
  line whose longer neighbours crowd its end (stack scrolling 74 px in a 300 ms cue) sits level with it at the safe
  edge, mirrored in RTL; an emoji that fits by the text keeps that slot; a badge draws 1.2 times a single emoji and
  falls back to a single emoji's shrunk size. The first two and the last fail with the change reverted (checked).
- `placement.test.ts`: Lyrics and Wonky drop at most 1 of 12 on the fast run on every canvas; every style also runs
  with every other emoji a phrase badge (demo and fast, three canvases), with no problem and under 1% dropped.

### Commands

- `bun run --cwd packages/caption-scene test`: 3,212 pass, 14 fail, all timeouts while other builders' suites held the
  load average at 42 to 52 (one test took 376 s): Combo conformance (5), Ledge re-check 2, Aura orbs, Trail build-time
  budget, two `templates.test.ts` builds, `sceneBoundsOver`, and three of `placement.test.ts`'s per-style tests. Re-run
  at load 7, every one of those files passes: `placement.test.ts` 87, `trail.test.ts` 79, `combo.test.ts` 40,
  `ledge.test.ts` 40, `aura.test.ts` 14, `templates.test.ts` 253, `scene-bounds-over.test.ts` 2, 0 fail.
- `CAPTION_EMOJI_PLACEMENT_REPORT=1 bun test src/emoji/placement.test.ts`: 87 pass; "demo dropped 1, late 0 of 1221;
  fast dropped 6, late 1346 of 3024". `bun test src/emoji/layer.test.ts`: 38 pass.
- `bun run --cwd packages/caption-emoji test`: 114 pass, 0 fail.
- `bun run --cwd apps/media test`: 1,237 pass, 1 skip, 0 fail (422 s).
- Web emoji layer tests (`bun test` on the Studio `emoji/` folder and `app/prototype`): 111 pass, 0 fail.
- `bun run typecheck`: 17 of 17 successful.
- `bunx biome check` on every touched file (`layer.ts`, `placement.ts`, `layer.test.ts`, `placement.test.ts`,
  `caption-emoji/src/art.ts`, the prototype folder): clean.
- Edits to files another builder was changing at the same time: ticket 26 edited `layer.ts` (palette type) while I
  worked; both sets of edits are in the file. I did not touch `style.ts`, `drawing.ts` or palette code.
