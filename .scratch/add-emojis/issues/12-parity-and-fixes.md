# 12 - Studio and export parity, palette guard, tagger retry

**What to build:** Four fixes the coordinator collected while reviewing tickets 05, 06, 07 and 11.
Rules: [../RULES.md](../RULES.md).

**Blocked by:** [06](06-export.md), [07](07-studio-preview.md)

**Status:** done

## Areas

`apps/media/src/caption-emoji-ass.ts` and its call sites in `caption-ass.ts`,
`packages/caption-scene/src/emoji/{style,cue-box}.ts`,
`apps/web/.../studio/_components/emoji/cue-emoji-boxes.ts` (box maths only),
`packages/validators/src/caption-emojis.ts` (palette), `packages/services/src/clip-emoji-tagging.ts`
and `clip-caption-preset-apply.ts` (retry). Ticket 09 is building the Studio controls in the same
`emoji/` folder at the same time: do not touch its files, and use targeted edits.

## Deliverables

1. **One style derivation.** Ticket 07 added `captionEmojiLayerStyle(preset)`,
   `captionEmojiLayerEmojis(layers)` and `captionEmojiCueDirection(words, language)` in
   `packages/caption-scene/src/emoji/style.ts`. Ticket 06 wrote its own `captionEmojiStyle` in the
   worker with the defaults inline. Make the worker call the shared functions and delete its copy.
   After this, no default for size, position, sticker, slot, shadow colour or direction is written
   in `apps/media` or `apps/web`.
2. **One classic cue box.** The two sides define the classic line's box differently:
   the worker uses the libass line box (`lineTopY` to `2*anchorY - lineTopY`, `lineWidth`), the
   Studio uses the font's line box from layout metrics (measured height x fit, plus outline). Choose
   one definition that both can compute, put its formula in one shared function next to
   `lineCueBox` (inputs: font metrics or a measured line height, font size after fit, outline
   width, anchor, tilt), and have both sides call it with their own measurements. Ticket 07's
   Evidence proposes the font line box
   (`(ascentEm + descentEm) * px` plus stroke); check it against how the classic line is actually
   drawn on both sides before adopting it. `bodyPx` must be the same quantity on both sides for
   all three paths (ticket 06: Dynamic `preset.fontSize * layout.scale`; ticket 07: Dynamic
   `fontSize * layout.scale * roles.body.sizeEm`): pick one and use it on both.
3. **Prove parity.** The Studio's fixture (`emoji/caption-emoji-fixture.ts`, real composition
   plan) feeds the prototype page `/prototype/caption-emojis` (`?only=<preset>[-rtl]`,
   `?pop=<n>&offset=<ms>`). Render the same fixture layers through the worker's caption path at the
   same canvas and times, take the Studio frames with headless Chrome (ticket 07's Evidence says
   how; `agent-browser` could not screenshot on this machine), and compare the emoji's box on each
   of: one classic, one Dynamic, three Scene presets, LTR and RTL. Report the centre and size
   difference in canvas px per case. Target: Scene and Dynamic within 2 px; classic within 6 px
   (HarfBuzz against browser layout). Save side-by-side images to
   `/private/tmp/claude-501/-Users-murtaza-Documents-dev-narriflow/f7147bb1-206f-4f6e-a8fc-276dea0eb55b/scratchpad/emoji-parity/`.
   Fix what exceeds the target, or explain exactly why it cannot be closer.
4. **Palette guard.** On presets whose text is white (Electric, Reveal and others) the automatic
   palette's rim `b` comes out white or near white and merges with the white sticker outline (see
   `.../scratchpad/emoji-export/ltr/closeups-ltr.png`, rows electric and reveal: the flame is a
   white blob with a yellow core). In `captionEmojiPalette`, `b` must also be separated from white
   and from `c`; when it is not, derive it from `a` as the existing "rim from body" rule does. The
   owner's four named palettes and an explicit `preset.emojiPalette` are never altered (Candy has a
   white rim on purpose). Extend the all-presets test with the new invariant and print how many
   presets changed. Regenerate the export close-ups for Electric and Reveal and look at them.
5. **Tagger retry.** About one request in 30 to 60 ends `response.failed` or returns text that is
   not JSON (ticket 11 measured it and added a per-clip retry in the apply service). Move the retry
   into the shared path so import, Studio and apply all get it: one retry per failed chunk in
   `tagCaptionEmojis` while the deadline allows, not after a 429 (the request code already retries
   that). Remove the apply service's own retry if it becomes redundant. Tests with a stubbed
   client: a chunk that fails once then succeeds is tagged; a chunk that fails twice is counted
   failed; no retry when the deadline is too near; no second retry after a 429.

## Acceptance

- [x] Deliverables 1 to 5; parity table and image paths in Evidence.
- [x] `git grep -n "emojiSize ??\|emojiPosition ??\|emojiSticker" apps/` finds no inline default.
- [x] `bun run typecheck`; tests of `apps/media`, `packages/caption-scene`, `packages/validators`,
      `packages/services`, and web tests; biome on touched files.

## Evidence

Implemented 2026-11-26. Nothing committed, migrated or deployed.

### Files

- `packages/caption-scene/src/emoji/cue-box.ts`: `CaptionEmojiPlanCue`, `ClassicLineMeasure`,
  `classicLineCueBox(cue, line, canvas)` (the one classic box), `captionBlockCueBox(cue, layout, measured)`.
- `packages/caption-scene/src/emoji/scene-cue-boxes.ts`: `captionSceneEmojiCueBoxes(scene, input, measure)`.
- `packages/caption-scene/src/emoji/style.ts`: `captionEmojiLayerEmojis` passes the plan's `order`.
- `packages/caption-scene/src/emoji/layer.ts`: `CaptionEmojiLayerEmoji.order?`; the tilt alternates by it.
- `packages/caption-scene/src/emoji/drawing.ts`: `CAPTION_EMOJI_STICKER_WHITE` now comes from validators (re-exported).
- `packages/composition-plan/src/{clip-composition-plan,caption-emoji-plan}.ts`: `CompositionCaptionEmoji.order`
  (place among the target's emojis in time order), set in `attachCaptionEmojis`.
- `packages/validators/src/caption-emojis.ts`: `CAPTION_EMOJI_MIN_RIM_APART`, `CAPTION_EMOJI_STICKER_WHITE`;
  the rim guard in `captionEmojiPalette`.
- `packages/services/src/clip-emoji-tagging.ts`: one retry per failed chunk; `retried` in the outcome.
- `packages/services/src/clip-caption-preset-apply.ts`: its own retry removed (one call per clip).
- `apps/media/src/caption-emoji-ass.ts`: `captionEmojiStyle`, `classicEmojiCueBox`, `blockEmojiCueBox`,
  `sceneEmojiCueBoxes` and the direction/timing helpers deleted; uses `captionEmojiLayerStyle` and
  `captionEmojiLayerEmojis`.
- `apps/media/src/caption-ass.ts`: calls the three shared box functions; `CueGeometry.lineHeightEm`;
  `classicLineMeasure` replaces `classicLineBox`.
- Studio `emoji/cue-emoji-boxes.ts`: measurements only (`classicLineBoxEm`, `classicLineEmojiCueBox(layer, line, face)`,
  `blockEmojiCueBox`); `ClassicLineSize` is `{ width, scale }`.
- Studio `emoji/cue-caption-emojis.tsx`: `useClassicLineFace(preset)`. `emoji/scene-caption-emojis.tsx`: calls
  `captionSceneEmojiCueBoxes`; `sceneEmojiGeometry` returns `{ scale, anchorYPct }`.
- `interactive-caption-overlay.tsx`: the line-size state keeps the width only (3 lines).
- Prototype `app/prototype/caption-emojis/{page,caption-emojis}.tsx`: `?debug=1` prints each frame's cue boxes and
  placed emojis (pivot, side, turn, window) as JSON in `data-emoji-debug`.
- Tests: `layer.test.ts` (plan-cue classic and block boxes, one-cue tilt), `scene-cue-boxes.test.ts`, `style.test.ts`,
  `caption-emoji-plan.test.ts` (order), `caption-emojis.test.ts` (rim guard, owner palettes untouched, all-presets
  invariant), `clip-emoji-tagging.test.ts` (4 retry tests), `clip-caption-preset-apply.test.ts`,
  `clip-emoji-suggestion.test.ts`, `caption-emoji-ass.test.ts`, Studio `caption-emoji-layer.test.ts`.

### Style derivation (now one, both sides)

| Input | Classic | Dynamic | Scene |
| --- | --- | --- | --- |
| palette, size, position, sticker, shadow, slot | `captionEmojiLayerStyle(preset)` | same | same |
| emojis | `captionEmojiLayerEmojis(layers)` (with the plan's `order`) | same | same |
| cue box | `classicLineCueBox(layer, { widthEm, heightEm, px }, canvas)` | `captionBlockCueBox(layer, layout, measured)` | `captionSceneEmojiCueBoxes(scene, { preset, cues, canvas, scale }, measure)` |
| bodyPx | `px` = `fontSize × fit` | `fontSize × layout.scale × roles.body.sizeEm` | `captionSceneMeta(scene).bodyPx × scale` |
| direction | `captionEmojiCueDirection(words, language)` | `captionBlockDirection(block.texts, language)` (the layout's) | `captionEmojiCueDirection(cue.words, cue.language)` |
| tilt sign | plan `order` | plan `order` | plan `order` |
| fps | export: render rate; Studio: 30 (unknown) | same | same |

What each side measures: classic `widthEm` (worker HarfBuzz advance, Studio `offsetWidth / scale / fontSize`) and
`heightEm` (worker: its line faces' Win ascent + descent; Studio: `classicLineBoxEm`, the same rule through
`captionWordLineBoxEm`); Dynamic the block layout; Scene the built scene. No default for size, position, sticker,
slot, shadow colour or direction is written in `apps/`.

Classic box, chosen definition: centred on the anchor, the faces' Win line box high (not the browser's
`line-height: normal` box, which for Noto Nastaliq Urdu uses its shorter hhea metrics: 2.5 em measured against
3.29 em, which put the Studio's emoji 33 px lower on Urdu), the advance wide, plus the outline scaled by the fit
on every side (the worker had no outline; the Studio had the unscaled one), turned by the cue tilt about the
anchor. Horizontally the box is centred on the anchor on both sides: libass centres its glyph bbox there, the
Studio its layout box. The worker's old `lineCenterX` centre moved its emoji 3 to 15 px on Urdu lines.

Found while comparing, fixed: the export alternated the sticker tilt by the emoji's index across the target, the
Studio's classic and Dynamic paths build one cue at a time, so every Studio emoji there tilted +7°. The plan now
numbers each target's emojis (`order`) and the layer alternates by it.

### Parity (fixture `caption-emoji-fixture.ts`, 1080x1920, 4 emojis per frame, Studio minus export, canvas px)

Studio: the prototype's `?debug=1` JSON in headless Chrome. Export: `renderCaptionTrack` (HarfBuzz) and each emoji's
`\pos`, drawing box and `\frz` read back from the ASS. Scripts:
`/private/tmp/claude-501/-Users-murtaza-Documents-dev-narriflow/ee42331b-0f01-4327-9483-49cc34caf162/scratchpad/parity/`
(`worker.ts`, `studio.py`, `compare.py`, `images.ts`, `palette-sheet.ts`).

| Frame | Kind | Centre dx, dy (max) | Size | Tilt |
| --- | --- | --- | --- | --- |
| bold-pop | classic | 0.00, 0.00 | 0.00 | 0 |
| bold-pop-rtl (Urdu) | classic | 0.00, 0.00 | 0.00 | 0 |
| headline | Dynamic | 0.00, 0.00 | 0.00 | 0 |
| headline-rtl | Dynamic | 0.00, 0.00 | 0.00 | 0 |
| lyrics, lyrics-rtl | Scene | 0.00, 0.00 | 0.00 | 0 |
| dialogue | Scene | 0.00, 0.00 | 0.00 | 0 |
| horizon | Scene | 0.00, 0.00 | 0.00 | 0 |
| index | Scene | 0.00, 0.00 | 0.00 | 0 |
| bubble-rtl (Urdu) | Scene | 28.27, 3.50 | 0.00 | 0 |

Before the fixes: classic Urdu dy 32 to 33 px and dx up to 15 px; classic and Dynamic dy 0.6 to 1.1 px on every
other emoji (the tilt). Windows: the export starts 0 to 25 ms later and ends 0 to 30 ms earlier (the ASS writer
snaps to the 30 fps grid and centiseconds; under one frame).

Bubble Urdu is not an emoji difference: the two renderers lay Bubble's Urdu words out differently (the cue boxes
themselves differ, for example cue 1 x2 808 in the export against 904 in the Studio; the export frame shows a wider
gap between the words). The emoji sits the same distance from each side's text. Fixing it is a Scene measurement
change (Bubble's plain words are measured with letter spacing in `templates/bubble.ts`; Canvas and HarfBuzz disagree
on these Nastaliq runs), outside this ticket.

Images (looked at; emojis match in place, size, colour and tilt on every frame):
`/private/tmp/claude-501/-Users-murtaza-Documents-dev-narriflow/f7147bb1-206f-4f6e-a8fc-276dea0eb55b/scratchpad/emoji-parity/parity-sheet.png`
(11 cases: Studio | export | close-ups), split views `view-a.png`, `view-b.png`, `view-c.png`, frames in `parts/`.

### Palette guard

29 of 115 presets get a different automatic rim (classic 9: punch, spotlight, electric, focus, highlighter,
afterglow, neon, glitch, typewriter; Dynamic 3: editorial, stack, arc; Scene 17: dossier, track, doodle, wordform,
reveal, spine, stretch, ledge, labels, seventies, slot, mdrn, crosstape, tunnel, receipt, chronicle, glint). Each had
a white or near-white rim; it is now derived from the body (light body: toward the ink, a darker slightly
hue-shifted body colour, e.g. Electric and Reveal `#ffe45c` → rim `#b39f4e`; dark body: toward white, e.g. Dossier
`#d7263d` → `#e57281`). Worst cases over all presets: rim–detail 0.132 (horizon), rim–white 0.147 (horizon),
rim–body 0.138 (dossier), all ≥ 0.12. The owner's four palettes and `preset.emojiPalette` are untouched (tested;
Candy keeps its white rim).

Close-ups through the export path, old rule beside new, Electric, Reveal, Punch, Neon, Afterglow, Stack, Doodle,
Tunnel, Glint, Dossier:
`/private/tmp/claude-501/-Users-murtaza-Documents-dev-narriflow/f7147bb1-206f-4f6e-a8fc-276dea0eb55b/scratchpad/emoji-parity/palette-closeups.png`.
Seen: the flame was a white blob on every white-text preset; now its outer layer reads in the body's hue with the
yellow core inside, and the white outline is separate. Neon and Afterglow lose their pale cyan and pink rims (they
merged with the outline too). Punch's tiles caught the 90 ms exit fade in both columns.

### Tagger retry

`tagCaptionEmojis` sends a failed chunk once more when the reply was not a 429 and at least
`FILLER_TAGGING_DEFAULTS.minStartMs` (5 s) is left and the caller has not aborted. Tests (stubbed fetch): fails once
(`response.failed`, and non-JSON text) → tagged, `retried: 1`; fails twice → `failed`, `retried` counted; 8 s left →
retried, 4 s left → not; a 429 → the request's own retry only (2 calls), `retried: 0`. The apply service now calls
each clip once. No live model call.

### Commands

- `bun run typecheck`: 17 of 17 successful.
- `bun run --cwd packages/caption-scene test`: 3,116 pass, 0 fail.
- `bun run --cwd packages/validators test`: 1,345 pass. `bun run --cwd packages/composition-plan test`: 181 pass.
- `bun run --cwd packages/services test`: 1,680 pass, 1,567 skip (DB), 0 fail.
- `bun run --cwd apps/web test`: 1,309 pass, 0 fail.
- `bun run --cwd apps/media test`: 1,170 pass, 1 skip, 0 fail (218 s).
- `bunx biome check` on the 28 touched files: clean.
- `git grep -n "emojiSize ??\|emojiPosition ??\|emojiSticker" apps/`: no match.
- `bun run check:web-split`: passed. `bun run --cwd apps/api build:worker`: audit passed.

### Found, not mine

- Bubble (Scene) lays Urdu words out differently in the Studio and the export (above).
- Classic Bold Pop LTR: the export draws "MORE MONEY" with the words touching while the Studio keeps the gap. The
  space is in the ASS; the preset's negative letter spacing (`\fsp-0.84`) and the active word's scale close it.
- Classic Urdu lines: the Studio's line box is the browser's (Nastaliq hhea metrics, no `ascent-override` in
  `caption-script-fonts.css`), libass's is the Win box, so the Studio's Urdu text sits at a slightly different
  height than the export's. The emoji now follows the export's box on both sides.
- `next dev` refuses a second server in `apps/web`; I used the one another agent started on port 3100 (read-only
  requests) and stopped nothing.
