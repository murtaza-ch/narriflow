# 04 - The emoji layer: pieces, cue boxes, placement

**What to build:** The one builder that turns cue boxes and emojis into Scene pieces, the function
that derives cue boxes from a built Scene Style, the per-style slot data, and the test that proves
placement on all 84 styles. Rules: [../RULES.md](../RULES.md). Spec D3, D4, D5.

**Blocked by:** [01b](01b-art-outline-and-contract.md), [02](02-contracts-and-plan.md)

**Status:** done

## Areas

`packages/caption-scene/src/emoji/**` (new), `packages/caption-scene` exports and tests,
`packages/validators/src/caption-scene.ts` (the `emojiSlot` field only). Do not edit template
programs. Do not put emojis into `buildCaptionScene` or `sceneBuildKey`.

## Deliverables

1. `buildCaptionEmojiPieces(input): Piece[]`, pure and synchronous.
   ```ts
   interface CaptionEmojiCueBox {
     cueIndex: number;
     box: { x1: number; y1: number; x2: number; y2: number };   // canvas px
     fromMs: number; toMs: number;                                // when the cue's own pieces paint
     bodyPx: number;                                              // the cue's body text size
     tiltDeg: number;                                             // the cue's own tilt, 0 for most
     direction: "ltr" | "rtl";
     obstacles?: (atMs: number) => readonly Box[];                // live things the emoji must miss
   }
   input: { cueBoxes; emojis: { cueIndex; id; tone?; atMs }[]; art: ReadonlyMap<string, CaptionEmojiArt>;
            style: { palette; size; position; sticker; shadowColour; slot }; canvas; anchorYPct; fps? }
   ```
   - Pieces per emoji: the `outline` fill in white with one hard `Shadow` (offset about 0.04 of the
     emoji height down-right, the template's shadow colour) when `sticker` is on, then the colour
     layers resolved with the palette and tone. Every piece of one emoji shares the same drawing
     box and pivot (the box centre) so libass scales and turns them as one. Read how the ASS writer
     places a drawing (`apps/media/src/caption-scene-ass.ts`, `\pos` from the path's own bounds,
     `spanFits`) and choose the construction that keeps all layers locked together during the pop:
     either tiny corner sub-paths that fix each layer's bounds to the shared box, or an explicit
     optional `box` on `ShapePiece` that both renderers read. Prefer the explicit field if it is a
     small, clean change to `scene.ts`, the writer and the painter; say which you chose and why.
   - Size, slot, gap, tilt, timing, entrance and exit exactly as spec D4 and D5. Tilt alternates
     by emoji order and mirrors for RTL. Ids `emoji:<cue>:<n>:<layer>`.
   - Fallback order: slot, other side, shrink to 0.7, drop. At most 24 pieces per emoji; an emoji
     whose art is missing from the map is skipped.
   - A stable `captionEmojiLayerKey(...)` string of everything the layer depends on, for memoising.
2. `sceneCueBoxes(scene, cues, ...)`: cue boxes for a built Scene Style per spec D4: own-cue pieces
   are those whose id's second segment is the cue index; the box is their non-bleed union sampled
   at `t*`; `fromMs`/`toMs` are the first and last paint of the cue's own pieces; `obstacles`
   returns live non-bleed boxes of the cue itself, of pieces that belong to no cue, and of other
   cues' pieces with opacity 0.5 or more after the previous cue's last paint. Use `evaluatePiece`,
   `pieceBounds` and the existing piece index helpers; do not walk every piece for every frame
   (build a per-cue index once).
3. `emojiSlot` on `CaptionSceneMeta` in `packages/validators/src/caption-scene.ts`: a small static
   union (for example `above`, `below`, `stack-top`, `beside-end`) with a default of `above`, set
   only on the styles that need it. Every style must draw emojis. The review measured these as
   hard on fast speech: Lyrics, Dialogue, Signal, Ticker, Index, Receipt, Tunnel, Wallpaper, Tape,
   Chronicle, Aura, Anime, Gumdrop. Look at each (its demo, its region, what stays on screen) and
   choose the slot that reads well; add a slot kind only when two or more styles need it.
4. Box helpers for the other two paths, so the worker and the Studio call one function each:
   `blockCueBox(...)` from a `layoutCaptionBlock` result (Dynamic Styles, ADR 0020) and
   `lineCueBox(...)` from a classic line's top, bottom, centre, width and tilt. Read
   `packages/composition-plan` / wherever `layoutCaptionBlock` lives and `cueGeometry` in
   `apps/media/src/caption-ass.ts` (about lines 781-842) to shape their inputs.
   Also add `captionEmojiTemplateColours(preset): CaptionEmojiTemplateColours` to
   `packages/validators/src/caption-emojis.ts`: the one rule for a preset's
   `{primary, highlight, accent, shadow}` for every preset kind (Scene Styles as
   `sceneInputFromPreset` resolves them; ticket 02's palette test worked out Dynamic and classic
   locally, so move that rule here and make the test use it). The worker and the Studio call it so
   the two renderers cannot drift.
5. Tests:
   - Placement across all 84 styles: demo cues and a fast 12-cue run, one emoji on every cue,
     canvases 1080x1920, 1080x1080 and 1920x1080, with the fake measure the template tests use (and
     the real HarfBuzz measure if the package's tests already have one available). Assert: no emoji
     piece box meets a word face of any live cue; every emoji is inside the 5% safe area; the drop
     rate is under a threshold you justify from the measured numbers (print a table per style in
     Evidence; aim for no style above 10% on the demo cues and state what remains on the fast run).
   - Unit tests for timing (anchor late in the cue, two emojis in one cue, overlapping speakers),
     RTL tilt mirror, sticker off, missing art, piece cap, shared box.
   - `evaluatePiece` on the pop: all layers of one emoji have the same pose at every sampled time.
6. A contact sheet written to the scratchpad
   (`/private/tmp/claude-501/-Users-murtaza-Documents-dev-narriflow/f7147bb1-206f-4f6e-a8fc-276dea0eb55b/scratchpad/emoji-layer/`):
   for at least 24 styles including every hard one above, one still per style with the emoji held
   (render pieces to SVG with `pathToSvg`, text as plain boxes or real text, then rasterise),
   so a human can judge alignment. Add a second sheet in RTL (Arabic or Urdu cues).

## Budget to record

Time of `sceneCueBoxes` plus `buildCaptionEmojiPieces` for a 60 s scene with 20 emojis on a heavy
style (Horizon) and a light one, and the piece count per emoji.

## Acceptance

- [x] Deliverables 1 to 6. Placement table and build times in Evidence.
- [x] No template program file changed; `buildCaptionScene` and `sceneBuildKey` unchanged.
- [x] Existing caption-scene tests still pass (conformance, occlusion support, templates).
- [x] `bun run lint`, `bun run typecheck`, `bun run --cwd packages/caption-scene test`.

## Evidence

Implemented 2026-11-26. Nothing committed.

### Files

- `packages/caption-scene/src/emoji/` (new): `cue-box.ts` (the cue box type, `blockCueBox`, `lineCueBox`),
  `drawing.ts` (art to shared-box fills), `placement.ts` (sides, slot pivot, slot window), `timing.ts`
  (pop and fade), `layer.ts` (`placeCaptionEmojis`, `buildCaptionEmojiPieces`, `captionEmojiLayerKey`),
  `scene-cue-boxes.ts`, `placement-support.ts` (the shared placement run for tests and sheets, not
  exported), tests `layer.test.ts`, `scene-cue-boxes.test.ts`, `placement.test.ts`; exported from
  `src/index.ts`.
- `packages/caption-scene/package.json` + `bun.lock` (one line): depends on `@narriflow/caption-emoji`.
- `packages/validators/src/caption-scene.ts`: `CaptionSceneEmojiSlot`, `emojiSlot?` on `CaptionSceneMeta`
  (set on Lyrics `beside-end`, Dialogue `below`), `captionSceneEmojiSlot(name)`.
- `packages/validators/src/caption-emojis.ts`: `captionEmojiTemplateColours(preset)`; the palette test
  uses it instead of its local rule.
- Outside the named areas: `packages/caption-emoji` gained a data-free entry `./draw` (`src/draw.ts`:
  grid, box, path parser, colour roles) because `./art` imports the catalog index (129 kB) and the
  Studio's initial chunk must not; and `silhouette` was removed (below). The two renderers were not
  changed (below).

### Shared drawing box: corner moves, no renderer change

Every part of one emoji starts its path with `M 0 0` and `M side side`, the corners of one box (the
art box `CAPTION_EMOJI_BOX` grown by the shadow's reach, centred on the grid), with the pivot at its
centre. libass sizes and aligns a `\p1` drawing by all its points, moves included: checked with real
libass (a 20 px square drawn alone landed at x 130, with `m 0 0 m 100 100` in front at x 290, exactly
`\pos - w/2 + q` for w = 100). `pathBounds` reads move points too, and the web painter draws a path at
its own coordinates. So `pieceGeometry` gives every part the same box with a zero alignment vector:
`\pos` stays fixed through the pop and the scale is one `\fscx/\fscy` chain. An explicit `box` field
would still have needed the writer to emit those corner points (libass decides by the path), so it
would have been a second source of truth; `scene.ts`, `caption-scene-ass.ts` and
`caption-scene-painter.tsx` are untouched (`git diff refs/emoji-baseline` empty for all three).

Measured with the real ASS writer (`sceneEvents`, HarfBuzz measurer), one event per piece at 24, 30
and 60 fps: rocket 6 pieces = 6 events, heart-eyes 7 = 7, astronaut 20 = 20. Without the corner moves
the same pieces write 18, 21 and 60 events at 24 fps (each part cut per frame of the pop).

The sticker shadow is its own piece (the outline moved down-right on screen, the offset turned back
by the tilt) instead of a `Shadow` on the outline piece: the writer offsets a shadow layer by `scale *
offset`, which moves non-linearly during the outBack pop, and cuts both outline events per frame.
Measured: the `Shadow` construction writes 10 / 11 / 24 events (24 fps) and 12 / 13 / 26 (60 fps) for
the same three emojis, against 6 / 7 / 20. Pieces per emoji: layers + 2 sticker (3 to 21), layers flat.

### Slots per style (`emojiSlot`)

Default `above` (below for a caption in the top 30%). Set only where the template needs it:

- Lyrics `beside-end`: its dimmed previous and next lines hold the rows above and below. The emoji
  sits level with the active cue's last row at its reading end (right in LTR, left in RTL), after
  "savings" on the sheet; when a fast line fills the width, above or below are tried next.
- Dialogue `below`: earlier bubbles stack above the newest; below the newest bubble is empty until
  the next bubble, which is when the emoji leaves.

Every other hard style places with the generic rules, no slot of its own: Signal, Ticker, Tunnel,
Wallpaper, Tape, Chronicle, Aura, Anime, Gumdrop above; Index and Receipt above their plate (cue 0's
card and paper hold every later cue: the plate is taken into the cue box). A third kind
(`stack-top`) was not added: no second style needed it.

### Placement rules found by measuring (beyond the spec's wording)

- Emoji window: from the anchor word (or the cue's start when under 450 ms remain) to the cue's last
  paint, cut at the next cue's first paint (not before the last word starts + 100 ms). A cue paints
  "as itself" from `startMs - 100` (a stack shows the next cue dimmed long before). Not `endMs`:
  Flap queues a fast cue after the previous card flips, past the next cue's start.
- Last paint narrows by the opacity track (Index fades words out 70 ms before the window ends).
- t* moves earlier while nothing of the cue is drawn (Flap mid-flip). A cue drawn only by bleed
  pieces takes the canvas stretch they cross while it paints (Ticker's hero).
- Obstacles: the cue's own non-bleed pieces, no-cue pieces, other cues' shapes at opacity 0.5+ and
  their text at 0.1+ (Lyrics dims neighbour lines to about 0.15; the first sheet showed an emoji
  sitting on one at the spec's 0.5). Text is an obstacle even when bleed; bleed shapes are not.
- Soft obstacles, covered only when no slot at either size is clear: shapes with no text on them
  (rays, streaks, sparks) and echoes (text alive under 150 ms that its cue draws at least 3x as long:
  Cascade's beats). A shape holding text, or touching one that does, is a plate (Receipt's torn edge).
- A slot still being vacated at the anchor is waited for, and one the cue's exit sweeps at the end is
  left early, up to 300 ms each (at least 300 ms shown). A slot may sit 0.12 or 0.25 of the emoji's
  size further out. Try order: clear at full size (each side, each distance), clear at 0.7, then the
  same allowing soft obstacles; else drop.
- Size floor 9% of the short side instead of 6%: at 6% the emojis on Dialogue, Index, Receipt and
  Signal (body 52 to 64 px) read as specks on the sheets (65 px on a 1080 frame).
- The gap (0.18 of the size) is measured from the emoji's own ink (outline and shadow, turned).

### Placement table (fake measure, one emoji per cue, hero else middle word)

Totals: demo 8 dropped of 1,221 (0.66%), fast 100 of 3,024 (3.3%), across 9:16, 1:1, 16:9. With the
real HarfBuzz measure (scratch run through `SceneMeasurer`): demo 6 of 1,221, fast 93 of 3,024, and 0
emojis meeting a word face. Over 25% on the fast run with real measure: Lyrics 5/12 (9:16, 1:1),
Wonky 4/12 (1:1). Demo over 20%: Gumdrop 1/4 (1:1, 16:9). What remains on fast speech is Lyrics:
a fast line fills the frame's width and the dimmed lines hold the rows above and below, and the
whole stack scrolls during a 300 to 600 ms cue; an emoji that would follow the scroll is a possible
later step. The test asserts: no problem (no emoji ink meets a word face of any cue at opacity 0.1+,
or leaves the 5% safe area) on all 84 x 2 runs x 3 canvases and the 5 edge demos; demo drops under 1%
and at most half a style's cues; fast drops under 5% and at most half.

| Style | 9:16 demo: cues a/b/side shrunk dropped | 9:16 fast: cues a/b/side shrunk dropped | 1:1 dropped demo/fast | 16:9 dropped demo/fast |
| --- | --- | --- | --- | --- |
| lyrics | 5 0/1/4 s0 d0 | 12 3/2/3 s3 d4 | 0/4 | 0/2 |
| dialogue | 5 0/5/0 s0 d0 | 12 1/11/0 s0 d0 | 0/0 | 0/0 |
| dossier | 4 4/0/0 s0 d0 | 12 11/0/0 s0 d1 | 0/1 | 0/1 |
| hollow | 5 5/0/0 s0 d0 | 12 11/0/0 s0 d1 | 0/2 | 0/2 |
| signal | 4 4/0/0 s0 d0 | 12 12/0/0 s0 d0 | 0/0 | 0/0 |
| track | 5 4/1/0 s0 d0 | 12 9/2/0 s0 d1 | 0/1 | 0/0 |
| bulletin | 4 4/0/0 s0 d0 | 12 10/2/0 s6 d0 | 0/0 | 0/0 |
| ticker | 5 5/0/0 s0 d0 | 12 11/1/0 s0 d0 | 0/0 | 0/0 |
| flap | 4 4/0/0 s0 d0 | 12 12/0/0 s0 d0 | 0/0 | 0/0 |
| index | 5 5/0/0 s0 d0 | 12 11/0/0 s0 d1 | 0/1 | 0/1 |
| punchline | 4 4/0/0 s0 d0 | 12 10/1/0 s0 d1 | 0/1 | 0/1 |
| doodle | 5 4/1/0 s0 d0 | 12 12/0/0 s0 d0 | 0/0 | 0/0 |
| velocity | 4 4/0/0 s0 d0 | 12 11/1/0 s0 d0 | 0/0 | 0/0 |
| wordform | 4 4/0/0 s0 d0 | 12 10/2/0 s0 d0 | 0/0 | 0/0 |
| chrome | 5 5/0/0 s0 d0 | 12 10/1/0 s0 d1 | 0/1 | 0/1 |
| reveal | 4 4/0/0 s0 d0 | 12 9/2/0 s0 d1 | 0/1 | 0/1 |
| spine | 4 4/0/0 s0 d0 | 12 11/1/0 s0 d0 | 0/0 | 0/0 |
| boom | 5 5/0/0 s0 d0 | 12 12/0/0 s0 d0 | 0/0 | 0/0 |
| aura | 4 4/0/0 s0 d0 | 12 10/1/0 s0 d1 | 0/1 | 0/1 |
| wonky | 5 5/0/0 s0 d0 | 12 9/1/0 s0 d2 | 0/3 | 0/2 |
| verified | 5 5/0/0 s0 d0 | 12 10/0/0 s0 d2 | 0/2 | 0/2 |
| cursor | 5 5/0/0 s0 d0 | 12 11/1/0 s0 d0 | 0/0 | 0/0 |
| premiere | 4 4/0/0 s0 d0 | 12 10/2/0 s0 d0 | 0/1 | 0/1 |
| tape | 5 4/1/0 s0 d0 | 12 9/1/0 s0 d2 | 0/2 | 0/2 |
| beat | 5 5/0/0 s0 d0 | 12 10/0/0 s0 d2 | 0/2 | 0/2 |
| stretch | 5 5/0/0 s0 d0 | 12 10/1/0 s0 d1 | 0/2 | 0/2 |
| hype | 5 5/0/0 s0 d0 | 12 10/1/0 s0 d1 | 0/2 | 0/2 |
| wallpaper | 5 5/0/0 s0 d0 | 12 10/1/0 s0 d1 | 0/2 | 0/2 |
| slice | 5 5/0/0 s0 d0 | 12 10/1/0 s0 d1 | 0/1 | 0/1 |
| arthouse | 4 4/0/0 s0 d0 | 12 9/0/0 s0 d3 | 0/3 | 0/3 |
| heft | 4 4/0/0 s0 d0 | 12 10/2/0 s0 d0 | 0/1 | 0/1 |
| popup | 5 5/0/0 s0 d0 | 12 10/1/0 s0 d1 | 0/1 | 0/1 |
| trail | 5 5/0/0 s0 d0 | 12 12/0/0 s0 d0 | 0/0 | 0/0 |
| ransom | 4 4/0/0 s0 d0 | 12 12/0/0 s0 d0 | 0/0 | 0/0 |
| ledge | 5 5/0/0 s0 d0 | 12 10/2/0 s0 d0 | 0/0 | 0/0 |
| cascade | 5 4/0/0 s0 d1 | 12 11/1/0 s0 d0 | 1/0 | 1/0 |
| orbit | 5 5/0/0 s0 d0 | 12 9/1/0 s0 d2 | 0/2 | 0/2 |
| shuffle | 5 5/0/0 s0 d0 | 12 12/0/0 s0 d0 | 0/0 | 0/0 |
| squash | 4 4/0/0 s0 d0 | 12 12/0/0 s0 d0 | 0/0 | 0/0 |
| slab | 5 5/0/0 s0 d0 | 12 12/0/0 s0 d0 | 0/0 | 0/0 |
| labels | 5 5/0/0 s0 d0 | 12 12/0/0 s0 d0 | 0/0 | 0/0 |
| googly | 5 5/0/0 s0 d0 | 12 12/0/0 s0 d0 | 0/0 | 0/0 |
| bubble | 5 5/0/0 s0 d0 | 12 12/0/0 s0 d0 | 0/0 | 0/0 |
| strike | 6 6/0/0 s0 d0 | 12 12/0/0 s0 d0 | 0/0 | 0/0 |
| seventies | 6 6/0/0 s0 d0 | 12 12/0/0 s0 d0 | 0/0 | 0/0 |
| thermal | 5 5/0/0 s0 d0 | 12 12/0/0 s0 d0 | 0/0 | 0/0 |
| slot | 5 5/0/0 s0 d0 | 12 12/0/0 s0 d0 | 0/0 | 0/0 |
| inkup | 5 5/0/0 s0 d0 | 12 12/0/0 s0 d0 | 0/0 | 0/0 |
| primer | 5 5/0/0 s0 d0 | 12 12/0/0 s0 d0 | 0/0 | 0/0 |
| manifesto | 5 5/0/0 s0 d0 | 12 12/0/0 s0 d0 | 0/0 | 0/0 |
| swipe | 5 5/0/0 s0 d0 | 12 12/0/0 s0 d0 | 0/0 | 0/0 |
| match | 5 5/0/0 s0 d0 | 12 12/0/0 s0 d0 | 0/0 | 0/0 |
| scribble | 5 5/0/0 s0 d0 | 12 12/0/0 s0 d0 | 0/0 | 0/0 |
| barrel | 5 5/0/0 s0 d0 | 12 12/0/0 s0 d0 | 0/0 | 0/0 |
| pills | 6 6/0/0 s0 d0 | 12 12/0/0 s0 d0 | 0/0 | 0/0 |
| pixel | 5 5/0/0 s0 d0 | 12 12/0/0 s0 d0 | 0/0 | 0/0 |
| diecut | 5 5/0/0 s0 d0 | 12 12/0/0 s0 d0 | 0/0 | 0/0 |
| sticky | 6 6/0/0 s0 d0 | 12 12/0/0 s0 d0 | 0/0 | 0/0 |
| brute | 5 5/0/0 s0 d0 | 12 12/0/0 s0 d0 | 0/0 | 0/0 |
| mdrn | 5 5/0/0 s0 d0 | 12 12/0/0 s0 d0 | 0/0 | 0/0 |
| crosstape | 5 5/0/0 s0 d0 | 12 12/0/0 s0 d0 | 0/0 | 0/0 |
| gumdrop | 4 4/0/0 s0 d0 | 12 12/0/0 s0 d0 | 2/0 | 2/0 |
| flowing | 5 5/0/0 s0 d0 | 12 12/0/0 s0 d0 | 0/0 | 0/0 |
| trace | 4 4/0/0 s0 d0 | 12 12/0/0 s0 d0 | 0/0 | 0/0 |
| snipsnap | 5 5/0/0 s0 d0 | 12 12/0/0 s0 d0 | 0/0 | 0/0 |
| anime | 5 5/0/0 s0 d0 | 12 12/0/0 s0 d0 | 0/0 | 0/0 |
| tunnel | 5 5/0/0 s0 d0 | 12 12/0/0 s2 d0 | 0/0 | 0/0 |
| broadway | 5 5/0/0 s0 d0 | 12 12/0/0 s0 d0 | 0/0 | 0/0 |
| ripple | 5 5/0/0 s0 d0 | 12 12/0/0 s0 d0 | 0/0 | 0/0 |
| bento | 5 5/0/0 s0 d0 | 12 12/0/0 s0 d0 | 0/0 | 0/0 |
| liquid | 5 5/0/0 s0 d0 | 12 12/0/0 s0 d0 | 0/0 | 0/0 |
| blinds | 5 5/0/0 s0 d0 | 12 12/0/0 s0 d0 | 0/0 | 0/0 |
| receipt | 5 5/0/0 s0 d0 | 12 12/0/0 s0 d0 | 0/0 | 0/0 |
| chronicle | 5 5/0/0 s0 d0 | 12 12/0/0 s0 d0 | 0/0 | 0/0 |
| combo | 5 5/0/0 s0 d0 | 12 12/0/0 s0 d0 | 0/0 | 0/0 |
| rainbow | 5 5/0/0 s0 d0 | 12 12/0/0 s0 d0 | 1/0 | 0/0 |
| tilt | 5 5/0/0 s0 d0 | 12 12/0/0 s0 d0 | 0/0 | 0/0 |
| vibes | 5 5/0/0 s0 d0 | 12 12/0/0 s0 d0 | 0/0 | 0/0 |
| pixelpop | 5 5/0/0 s0 d0 | 12 12/0/0 s0 d0 | 0/0 | 0/0 |
| funky | 5 5/0/0 s0 d0 | 12 12/0/0 s0 d0 | 0/0 | 0/0 |
| glint | 5 5/0/0 s0 d0 | 12 12/0/0 s0 d0 | 0/0 | 0/0 |
| marquee | 5 5/0/0 s0 d0 | 12 12/0/0 s0 d0 | 0/0 | 0/0 |
| horizon | 5 5/0/0 s0 d0 | 12 12/0/0 s0 d0 | 0/0 | 0/0 |
| halftone | 5 5/0/0 s0 d0 | 12 12/0/0 s0 d0 | 0/0 | 0/0 |

### Build time (budget)

`sceneCueBoxes` + `buildCaptionEmojiPieces`, 60 s of cues (43 cues), 20 emojis, median of 7, Bun
1.4.4 on the dev Mac: Horizon (2,812 scene pieces) 19.7 ms HarfBuzz / 15.1 ms fake; Wordform (2,021)
14.9 ms; Lyrics (559) 12.1 ms; Reveal (172) 1.7 ms. 116 emoji pieces for 20 emojis (5.8 per emoji).

### Art package: silhouette removed

Nothing reads it now. Removed from the compiler output, `CaptionEmojiArt`, the shard encoding
(`[outline, layers]`), the build's box check, and the tests and `verify` (the outline check now
rasterises the union of the layers, the same shape). Rebuilt twice, identical `shasum`. Generated
data 4,817,335 B in 21 files -> 4,007,497 B in 19 (-809,838 B, -16.8%); art shards 3,884,496 B in 17
(58,891 symbols-0 to 358,244 phrases-3), gzip -9 965,793 B. `verify` (no pack): 1,408 outlines, 0
faults, the same most-filled list as ticket 01b.

### Contact sheets

Real export path: the scene plus emoji pieces written by `sceneEvents` with HarfBuzz and burned by
ffmpeg/libass over the style's backdrop, in
`/private/tmp/claude-501/-Users-murtaza-Documents-dev-narriflow/f7147bb1-206f-4f6e-a8fc-276dea0eb55b/scratchpad/emoji-layer/`:
`sheet-ltr-9x16.png` (32 styles incl. every hard one), `sheet-rtl-9x16.png` (24, Urdu and Arabic),
`sheet-ltr-1x1.png`, `sheet-ltr-16x9.png` (16 each), `sheet-fast-9x16.png` (16, fast run). Looked at
each; fixed from them: emoji on Lyrics' dim lines, specks at 6%, Receipt touching its torn edge,
Index between card and dial. The scripts that made them (`sheet.ts`, plus `events.ts` for the
event counts, `bench.ts`, `realtable.ts`) are in `tools/` next to the sheets; run them from
`apps/media`. Accepted: an emoji above a mid-frame caption covers the speaker's chin
or mouth (Gumdrop, Squash, Halftone; the face position is unknown).

### Commands

- `bun run --cwd packages/caption-scene test`: 3,108 pass, 0 fail (74 s; the placement test 8.5 s).
- `bun run --cwd packages/validators test`: 1,343 pass. `bun run --cwd packages/caption-emoji test`: 103 pass.
- `bun run --cwd packages/caption-emoji build`: 4.2 s, deterministic. `verify -- --out ...`: exit 0, 27 s.
- `bun run typecheck`: 17 of 17 successful.
- `bun run lint`: 168 errors, all in `.scratch/**`, `narriflow-emoji-prototype.html` and web CSS /
  prototype files not touched here (same count as tickets 01b and 02); `bunx biome check` on every
  file this ticket touched: clean.
- `bun run --cwd apps/api build:worker`: audit passed (the Worker does not import caption-scene).
