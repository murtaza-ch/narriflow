# Add Emojis: caption emojis rebuilt on Narriflow's own art

**Status:** implemented (2026-11-26), not committed, migrated or deployed. Reviewed against the code
by Opus High before building; its findings are folded in below (section 6). Section 7 records where
the build differs from this text. ADR 0022 holds the decisions that are hard to reverse.

## 1. Goal

AI places emojis on caption cues. The owner turns it on when importing a video (like Vizard and
OpusClip) and edits it in the Studio. The art is Narriflow's own vector emoji set, recoloured to the
caption template, drawn the same in the Studio preview and the export, for every caption preset
(84 Scene Styles, 7 Dynamic Styles, 24 classic), in LTR and RTL.

The existing keyword emoji feature is removed in the same change (pre-production policy): the
90-word English `CAPTION_EMOJI_MAP`, the 29-sprite Noto atlas, the FFmpeg overlay chain, the
`skippedEmoji` diagnostics, and the classic-only Studio toggle.

## 2. What research found

- Competitors: OpusClip has an editor toggle and per-word add. Vizard has the toggle at import and
  in the editor, a per-line emoji button in the subtitle list, and an emoji "sticks with the
  previous word". Captions.ai and VEED expose size and position. Submagic ties emojis to themes.
  None documents density control, template-matched colour, RTL behaviour, or tone awareness.
- libass cannot draw colour fonts (issue 381; PRs 915 and 917 closed unmerged in 2026-01). ASS
  vector drawings (`\p1`) work and Narriflow's Scene writer already emits them for `ShapePiece`.
- The emoji pack (`narriflow-emoji-pack.zip`, kept outside the repo since 2026-11-26 in
  `~/Documents/dev/narriflow-emoji-originals/` with the volume zips and the prototype HTML; pass it to
  `bun run --cwd packages/caption-emoji verify -- --pack <path>`): 2,308 SVGs on a 64 grid = 1,008 single designs + 400
  two-emoji "phrase" badges + 900 skin-tone variants of 180 bases. No gradients, masks, filters or
  text. 82% use strokes (round caps and joins). Colour is three palette roles `a` body, `b` accent
  rim, `c` detail, plus fixed ink and literal colours (skin). Every single design maps 1:1 to a
  Unicode emoji. No animation.
- Today's emoji feature draws only on the 24 classic presets and is off by default everywhere.

## 3. Decisions

### D1. Identity: a catalog id, with Unicode as the bridge

An emoji is stored as `{ id, tone? }`: `id` is the catalog slug, `tone` is 1 to 5 for the 180
designs with skin (absent = the default yellow). Unicode is used in three places only: the AI
answers in Unicode, the picker searches by it, and it is the accessible label.
`emojiRefForGlyph(glyph)` normalises (drops U+FE0F, turns a skin-tone modifier into `tone`, falls
back from a gendered ZWJ sequence to the neutral design) and returns a ref or null. A glyph with no
design is dropped, never drawn with a system font.

### D2. Art: compiled once into flat fill layers

`packages/caption-emoji` holds the source SVGs, a compiler, a small index and on-demand art.

- Every element becomes absolute `M/L/C/Z` non-zero fills on the 64 grid: transforms baked, strokes
  expanded to outlines, badge clip applied as an intersect, even-odd rewritten.
- Layers stay in painter order and keep their overlap (a planar partition would show hairline
  seams). Same-colour neighbours merge when order allows.
- A layer's colour is a role (`a`, `b`, `c`, `ink`, `skin`) or a literal hex, plus alpha.
- Each design carries `silhouette` (union of its layers) and `outline` (the silhouette dilated by a
  fixed grid width with round joins) so the sticker outline is a plain fill.
- Skin-tone variants are not stored; `skin` is a role.
- The compiler proves itself with a pixel comparison against the source SVGs.
- Phrase badges are in the catalog, the picker and (since ticket 23) the AI's vocabulary.

### D3. Rendering: one emoji layer above the captions, built from cue boxes

Emojis are not part of a template's scene build and not part of `sceneBuildKey`; an emoji edit must
never rebuild a template's scene.

One pure builder in `packages/caption-scene/src/emoji/`:

```ts
buildCaptionEmojiPieces({ cueBoxes, emojis, art, style, canvas }): Piece[]
// cueBoxes: { cueIndex, box, fromMs, toMs, tiltDeg, direction, obstacles? }[]  (canvas px, clip ms)
```

Each caption path supplies only cue boxes:

- Scene Styles: `sceneCueBoxes(scene, ...)` derives them from the built scene (D4).
- Dynamic Styles: from `layoutCaptionBlock`, which both sides already share.
- Classic presets: from the line geometry (`cueGeometry` in the worker; the Studio measures the
  cue's layout box).
- A Scene Style whose program throws falls back to the classic box for that cue.

Both renderers paint the pieces with what they already have: the worker's `sceneEvents()` and one
`CaptionScenePainter` pass above the captions in the Studio. The FFmpeg overlay chain is deleted.

Every piece of one emoji uses the same drawing box (the scaled 64 grid, pivot at its centre), so
libass moves all layers together during the pop and the writer does not cut one event per frame.
Emoji pieces are outside `SCENE_PIECE_BUDGET` and have their own cap (24 pieces per emoji).

### D4. Placement: next to the text, never on it

- Default slot: centred above the cue's box, gap 0.18 of the emoji height. `emojiPosition` is
  `auto`, `above` or `below`. Auto is above, or below when the caption anchor is in the top 30%.
- Each Scene Style declares a static `emojiSlot` in `packages/validators/src/caption-scene.ts`
  (ADR 0021: static facts are data) for templates whose shape needs another default (a stack that
  keeps neighbour cues on screen, a ticker, a full-height layout). Every style must draw emojis;
  a style may not opt out.
- Size: 1.15 of the cue's body text size times `emojiSize`, clamped to 6% to 18% of the canvas's
  short side.
- Scene reference box: the union of the cue's own non-bleed pieces (id segment 1 is the cue index),
  sampled once at `t* = min(lastOwnPaint - 50, lastWord.startMs + 350)`.
- Collision check over the emoji's window on the export frame grid against: its own cue's live
  non-bleed pieces, pieces that belong to no cue, and other cues' pieces with opacity of 0.5 or more
  (starting only after the previous cue's last paint).
- If the slot leaves the 5% safe area or collides: try the other side, then shrink to 0.7, then
  drop that emoji. A dropped emoji is not an error.
- A placement test runs all 84 styles (demo cues and a fast 12-cue run, fake and real measure, on
  9:16, 1:1 and 16:9) and fails above a drop-rate threshold.
- Sticker look: 7 degree tilt alternating by emoji and mirrored for RTL cues, white outline, one
  hard offset shadow in the template's shadow colour. `emojiSticker: false` draws it flat.
- Piece ids are `emoji:<cue>:<n>:<layer>`, which the occlusion test's word-face pattern cannot match.

### D5. Timing: one slot per live cue

An emoji takes its cue's slot when its anchor word starts and holds it until the next emoji in that
cue or until the cue's own pieces stop painting (not `SceneCue.endMs`: templates shorten windows).
Entrance: scale 0.4 to 1 with `outBack` over 180 ms. Exit: 90 ms fade. If the anchor word leaves
less than 450 ms, the emoji shows from the cue's start. Overlapping speakers each have a slot.

### D6. Colour: follows the template, overridable

`captionEmojiPalette(colours)` returns `{a, b, c}` from `{primary, highlight, accent, shadow}`:
`a` = highlight, `b` = accent, `c` = primary (the owner's prototype mapping). Guards: if `a` is too
close to `c` or to the ink, take the accent or a fallback; if `b` is too close to `a`, derive it
from `a`. A test runs all 115 presets and asserts the separation invariants. Brand colours flow in
through the preset's colours. `preset.emojiPalette?: {a, b, c}` overrides; the Studio offers Match
template (default), the four prototype palettes, and Custom.

### D7. Data model

- Per clip: `studioEdits.captionEmojis?: Record<WordKey, { id, tone? }>` (cap 500), with the same
  helper and reducer pattern as `captionEmphasis` (an empty map is stored as absent).
- A Word Key is source milliseconds. The plan resolves each entry to the kept word whose source
  start is nearest, within 400 ms and inside one utterance. Line rewrites, adds and merges re-time
  words and need no reducer logic. Words that are cut, censored (masked) or outside the clip draw
  nothing; the entry stays stored.
- A cue whose text already contains a typed emoji draws no added emoji.
- Style on the caption preset, all in `CAPTION_PLACEMENT_FIELDS`: `emojis: boolean`,
  `emojiPalette?`, `emojiSize?` (0.8, 1, 1.25), `emojiPosition?`, `emojiSticker?`.
- Import: `ContentPack.addEmojis Boolean @default(false)`, and `addEmojis` on the REST, MCP and
  Recipe generation settings. At import `addEmojis` alone decides the clip preset's `emojis`.
- Plan: `CompositionCaptionVisualLayer.emojis: { id, tone, atSec }[]` (edited time), built in
  `captionLayersForTarget`; `CompositionCaptionWord.emoji` is deleted.
- Subtitle files never contain added emojis.

### D8. AI

One tagger: numbered, keyed caption words in; `{ picks: [{ k, e, s }] }` out (Word Key, glyph,
strength 1 to 3) under a strict schema. The single designs' glyphs are a constant system-prompt
prefix (cacheable). Model `gpt-6-luna`, reasoning none. Chunked like filler tagging. Rules: meaning
over the literal word; at most one per sentence; nothing on names, numbers or filler; nothing for
grief, illness, violence and similar topics; any language.

The server decides in pure code (`packages/validators/src/caption-emojis.ts`): unknown glyphs and
keys dropped; density Light, Balanced (default), Expressive = at least 5 s, 2.5 s, 1.5 s apart in
edited time; the strongest pick wins a conflict; the same emoji does not repeat within 10 s (20 s since ticket 23); a
hook pick in the first 3 s is kept when offered.

Entry points:
- Import: when `addEmojis` is on, selection preparation tags the source next to the AI filler tags
  (`clip-selection-preparation.ts`), under the same deadline, frozen into the capsule as
  `editor.emojiPicks` and dropped first if the capsule is too large. `buildDetectedClipRows`
  filters picks to each clip's kept words, applies density, and writes `studioEdits.captionEmojis`
  and `captionPreset.emojis` into the clip's initial document. A failed tag means no picks, never a
  failed import.
- Studio: `POST .../clips/:clipId/emojis/suggest` (sync, `processing.consume`, actor rate 30,
  prefix `clip-emoji-suggest`) returns picks by Word Key; the Studio applies them as one undo step.
- Apply to all with emojis on: the apply service fills clips that have no emojis using the same
  tagger. A failure leaves the clip without emojis.

No plan gate, no credit charge.

### D9. Studio

- Captions panel: an Emojis section for every preset kind. Switch; Generate with AI with density;
  Regenerate (replaces all in one undo step, confirm when hand-placed emojis exist); Remove all;
  count; "No emojis fit this clip" when the AI returns none; style (colours, size, position,
  sticker).
- "On screen now" word chips: tap a word to add, replace or remove its emoji.
- Transcript panel: each subtitle line shows its emojis as chips; a hover action adds one.
- Picker: search by name, keyword and glyph, group tabs, recents, skin tone, Remove. Art drawn in
  the clip's palette. Virtualised, lazy chunk.
- Upload form, link import, Recipes and the project regenerate form get the Add emojis switch.

### D10. Out of scope

Emoji typed into caption text keeps the monochrome fallback face. Dragging an emoji on the video,
animated art, per-emoji position, and removing `fonts-noto-color-emoji` from the media image.

## 4. Engineering requirements (owner, 2026-11-26)

The owner asked for an efficient, modular, well-organised system and allows restructuring existing
code where that makes the result better. These bind every ticket.

### One implementation of each concern

| Concern | Lives in | Notes |
| --- | --- | --- |
| Art, index, glyph mapping | `packages/caption-emoji` | No workspace dependencies. Index and art are separate entry points. |
| Schemas, palette, density filter, anchor resolution | `packages/validators/src/caption-emojis.ts` | Pure code for browser, Worker and media. |
| Which emoji, which cue, when | `packages/composition-plan` | One function for Studio and export. |
| Pieces, pose, placement, cue boxes | `packages/caption-scene/src/emoji/` | One builder for all three caption paths. |
| AI tagging | `packages/services/src/clip-emoji-tagging.ts` | Import, Studio and Apply to all call the same function. |
| Studio UI | `studio/_components/emoji/` | Picker, panel section, chips and hooks as separate files. Large existing files gain a mount point, not the feature's code. |

- The three caption paths differ only in how they produce cue boxes.
- Where an existing module mixes concerns the feature touches, split it (the grapheme helpers in
  `packages/caption-fonts/src/emoji.ts` move to `caption-fonts/graphemes`).
- New files stay focused (one concern, roughly 300 lines or less unless the content is data).
- Delete what the feature replaces in the same change. No flags, fallbacks or dual paths.

### Performance budgets (measured and recorded in the owning ticket)

- Studio first load: the emoji index and art are not in the Studio's initial chunks. The picker is
  a lazy chunk. Art loads per shard, only for emojis the clip uses or the picker shows.
- Studio playback: emoji pieces are mounted only near the playhead like any piece. No per-frame
  React state. Placement runs once per emoji-layer build.
- An emoji edit rebuilds the emoji layer only, never a template's scene. Report the emoji-layer
  build time for a 60 s clip with 20 emojis.
- Picker: virtualised; report measured open time and search time over 1,408 designs.
- Export: no extra FFmpeg inputs or filters. A test caps ASS events per emoji. Report the render
  time of a 60 s clip with 20 emojis against the same clip without; target under 5% slower.
- API: tagging is chunked with bounded concurrency under the preparation deadline. The Worker
  imports the index only; report the bundle size change.
- Generated art is compact; report total and per-shard bytes.

## 5. Tickets

See `issues/` and `RULES.md`.

| # | Ticket | Blocked by |
| --- | --- | --- |
| 01, 01b | Art package and compiler; outline, tone mapping, layer cap | none; 01 |
| 02 | Contracts and plan | none |
| 03 | Import option `addEmojis` (schema, database, REST, MCP, Recipes) | 02 |
| 04 | Emoji layer: pieces, cue boxes, placement | 01b, 02 |
| 05 | AI tagging: import hook and suggest route | 01b, 02, 03 |
| 06 | Export | 04 |
| 07 | Studio preview | 04 |
| 08 | Import switches (web) | 03 |
| 09 | Studio controls | 05, 07 |
| 10 | Remove old code, docs | 06, 07, 09 |
| 11 | Apply to all fills emojis | 05 |

## 6. What the design review changed

1. Emojis moved out of the scene build into their own layer (a heavy template would otherwise
   rebuild on every emoji tap).
2. The median-of-bounds reference box was replaced: it picked up other cues' pieces in 52 of 84
   templates. Own-cue box, a collision check, and a per-style `emojiSlot` replace it.
3. An emoji ends with its cue's own pieces, not `endMs`.
4. The sticker outline is a precompiled fill, because a shape's shadow follows only its fill; all
   layers share one drawing box so libass scales them together.
5. Anchors resolve by nearest source time in the plan; the re-anchoring reducer was dropped (line
   edits dispatch a whole transcript slice, so a reducer cannot know which line changed).
6. The `undefined` versus `{}` signal was dropped (the emphasis helper stores an empty map as absent).
7. The import-time call runs at selection preparation and is frozen into the capsule, which is
   replay-safe; a post-selection fan-out would put I/O in a pure replay.
8. Kept against the review's cut list, because the owner asked for them: transcript-line chips
   (his Vizard reference shows them), Custom palette (his prototype has it), recents, and filling
   emojis on Apply to all (done in the apply service, not as a new route).

## 7. As built

Tickets 01 to 12 record the evidence. Where they differ from sections 3 and 4:

- **Art (01, 01b, 04).** A layer colour can also be per tone (`{ tone: (hex | null)[6] }`): on 117 face
  designs the pack redraws eyes and mouths for tones 4 and 5, which one `skin` role cannot do. The
  outline closes notches under about 6 grid units and fills small holes; a hole that still holds a
  disc of radius 4 grid units after the outline grows stays open (26 designs, ticket 14). Layers that
  opaque layers above fully cover are dropped (max 19 layers per design, cap 22). `silhouette` was
  removed (nothing reads it). A data-free entry `@narriflow/caption-emoji/draw` (grid, box, path
  parser, roles) keeps the catalog out of the Studio's first chunks. Art: about 3.9 MB in 17 shards.
- **Drawing box (04).** No `box` field: every part's path starts with move points at the two corners
  of one box, which libass and the web painter both count, so each piece is one ASS event. The
  sticker shadow is its own piece, not a shadow paint layer. Neither renderer changed.
- **Size and placement (04, 04b).** Size is `emojiSize × clamp(1.6 × body px, 12.5%, 16% of the short
  side)`, not 1.15 × body within 6 to 18%: smaller emojis read as specks. Auto also tries below first
  when above would put the emoji's top edge in the face zone (top 42% of the frame), and there
  below at 0.7 comes before above at full size. Lyrics declares `beside-end` and Dialogue `below`;
  no other style needed a slot. Obstacle, window and soft-obstacle rules are in ticket 04. Drop
  rates over 84 styles and 3 canvases: demo 0.66%, fast 2.9%, no emoji on a word face.
- **One derivation (07, 12).** `captionEmojiLayerStyle`, `captionEmojiLayerEmojis` and the three box
  functions (`classicLineCueBox`, `captionBlockCueBox`, `captionSceneEmojiCueBoxes`) in
  `caption-scene/src/emoji` serve both renderers; `apps/` measures only. The classic box is the
  faces' Win line box. The plan numbers each target's emojis (`order`) so the tilt alternates the
  same when the Studio builds one cue at a time. Studio and export positions match to 0 px on the
  parity fixture, Bubble in Urdu included since ticket 29.
- **Palette (02, 12).** Distances in OKLab. A rim guard derives the rim from the body when it would
  be white or near the detail (29 presets), which fixed the flame reading as a white blob.
- **AI (05, 12).** `k` is a chunk-local word id that the server maps to a Word Key. The schema has a
  `serious` list before `picks`; picks inside it are dropped (the prompt rule alone failed in Urdu,
  3 of 6 runs). Skin tones from the model are dropped. Chunks of 500 words; one retry per failed
  chunk. About $0.0017 per 1,000 words.
- **Apply to all (11).** The route returns `{ updated, captionEmojis: { added, failed } }`, and the
  Studio says how many clips could not be tagged.
- **Export (06).** No FFmpeg input or filter was added; 20 emojis add about 0.5% render time on a
  58 s clip. `skippedEmoji` left the stored diagnostics, which still parse.
- **Cleanup (10).** `captionGraphemes` and `isCaptionEmojiCluster` moved to
  `@narriflow/caption-fonts/graphemes`. The atlas, `emoji.ts`, the atlas build script,
  `CAPTION_EMOJI_MAP`, `emojiForWord` and `CompositionCaptionWord.emoji` are deleted. The Worker
  bundle no longer carries the atlas (12,041,974 to 12,037,195 bytes).

- **After the reviews (13 to 16).** Two Opus High reviews and a Sol review found no design flaw and
  a list of defects, all fixed with tests:
  - Plan: `cueIndex` is the cue's place in its target. A cue that can never show (zero length) is
    not emitted, and a scene inserted inside a cue splits it into two real cues, each with its own
    words, roles, keys, block and emojis. Both predate this effort (a Dynamic Style with a scene
    inside a cue could not export; a zero-length word rejected a whole render). Plans of normal
    clips are byte-identical (hash over 230 plans).
  - Placement runs on a fixed 30 fps grid on both sides, because the Studio does not know the
    render's rate; the export writes at the render's rate. In the face zone, auto tries below, then
    beside the cue, before going back above. A late anchor with 200 to 450 ms left shows at its
    word with a short entrance. An emoji holds at most 6 s. Classic and Dynamic cues are placed one
    cue at a time on both sides.
  - Palette: a derived rim is a shade of the body (darker, as saturated, hue turned toward red for
    warm bodies and blue-violet for cool ones; yellow gets an orange rim), and a colourless body
    falls back to the accent, then the stock yellow. 57 presets changed.
  - Export: the emoji layer has its own error boundary (`caption_emoji_layer_failed`); it can never
    change captions or fail a render. A failed art shard drops only its own ids.
  - AI: a report with the wrong shape is a failed chunk; the suggest route returns
    `{ emojis, complete }`. Apply to all is rate limited when the preset has emojis on, and skips
    emojis on a clip whose revision changed while it was tagged (counted in `failed`).
  - Studio: the AI run is a per-clip state machine outside React. It needs a successful save,
    drops picks on words that changed, trims to the 500 cap keeping hand edits, and reports what was
    stored. Regenerate confirms when the emojis are not from this session's AI run and keeps them
    when the run was not complete. Line chips seek to their word, can move to another word of the
    line, and dim when their emoji does not draw. Chips use the shared bidi word order.

- **Relevance (20).** The tagger reasons (low), echoes the word it tags, and code rejects a pick whose echo, id, word
  class (number, filler, function word) or sentence (one per sentence, until ticket 30) is wrong; a reply none of whose picks names a
  word is a failed chunk. An emoji never shows before its word: under 250 ms of its cue left it is not drawn; it holds
  at most 2 s from its word. Entries store their word's text (`CaptionEmojiRef.word`) and re-attach only to that word.
  The hook pick wins only ties. Real clips: 60% to 97% of emojis depict their word at Balanced (ticket 20).

- **On its word (21).** The word under a drawn emoji is its cue's hero (`CaptionEmphasisWord.emoji`; an emphasis override
  still wins), so an emoji edit rebuilds a Scene Style's scene when it moves the hero; emoji-free plans are unchanged
  (hash over 2,070 plans). Faces (107 Smileys designs, a flag in the compiled art) kept the pack's yellow body under Match
  template; named and Custom palettes coloured them fully. Ticket 26 removed this face exception on the owner's decision. A
  word leaving 120 to 250 ms of its cue holds its emoji to 400 ms from the word, past the cue, when the slot stays clear;
  the Studio keeps drawing a classic or Dynamic cue's emojis from its box for that time (`HeldCueEmojis`). Density gates
  strength first (Light 3, Balanced 2 and 3; Expressive took every strength until ticket 30, now 2 and 3). Eleven designs that read as something else were kept out of the AI vocabulary; ticket 23
  put them back on the owner's instruction. The prompt states principles with invented examples, never anchors
  a unit of measure, and gives an absent thing no emoji (obeyed only partly).

- **Leaving with its caption (24).** A held emoji is at full strength for 250 ms from its word, then fades and shrinks to
  0.85 over the rest of its hold (`captionEmojiScale`/`captionEmojiOpacity` with `leaveFromMs`; one event per piece, the
  exit is `\t` spans). It yields to the first emoji of a later cue (`nextEmojiAtMs`, `captionEmojiNextAtMs`), and draws
  nothing if that leaves it under 250 ms. A classic or Dynamic feeder passes the next cue's box beside its own (the next
  block's box; a classic line's reach, `classicLineReachBox`, since the Studio lays out only the line on screen), so a held
  emoji takes another slot or is not drawn rather than cover the next caption. The Studio's held mount draws from the
  exact input its cue was placed from (`rememberHeldCue`) and reuses its build (`buildCaptionEmojiLayerOnce`).


- **The whole catalog (23).** Every one of the pack's 2,308 emojis is usable by the AI and by hand. The AI's
  constant prompt lists all 1,008 single designs and then all 400 badges as "pair name" (`CAPTION_EMOJI_AI_BADGES`);
  a badge is picked only when the line says its moment, and sits on the word that names it; `emojiRefForGlyph`
  resolves a badge by its pair. The prefix grew from 3,366 to 6,902 tokens (cached), about $0.0045 to $0.0067 per 1,000 words at list price; the real-clip rate at Balanced held (94% to 98%) and the AI picks a badge only where a line says its moment (0 of 40 on the real clips, 29 of 71 on lines written to say one). Skin tone: the model never
  sets one. The preset's `emojiTone` (1 to 5, absent = yellow, a placement field) is the tone of every entry with no
  `tone`; a pick in the picker stores its tone, 0 for the default yellow, so the setting never moves a hand-picked
  tone (`captionEmojiDrawnTone`, resolved in the plan, so both renderers and the Studio's chips agree). The picker
  opens at the emoji's own tone, else the Skin tone (no per-browser tone memory), finds a variant by its pack name
  ("Waving hand: dark skin tone"), marks designs with skin, and says "Search 2,308 emojis". The same design does
  not repeat within 20 s. A completeness test walks the pack's catalog (`apps/media/src/caption-emoji-catalog.test.ts`).

- **Cursive words across a face change (29).** Bubble's and Wonky's Urdu was laid out apart because Rubik has the Arabic
  letters but not ہ ے ھ ٹ, so one word is drawn by Rubik and Nastaliq together. libass and Chrome shape each face's run
  inside the word, keeping the joining forms; the worker's HarfBuzz measure shaped each run alone (isolated forms:
  `کے` 2.332 em against the 0.892 em drawn), which spread the export's words. `layoutCaptionLine` now passes the line's text
  around each run as HarfBuzz context (`shapeCaptionRun(path, text, rtl, { before, after })`). Letter spacing was not the
  cause: both measurers and both painters already leave joined scripts unspaced. Bubble Urdu cue boxes went from 95.8 px
  apart to 0 (Wonky 193.5 to 0); Arabic was 0 before and after; every Latin, Hindi and Arabic scene and all 230 preset
  tracks are byte-identical. Still apart (older, another cause): a multi-word piece whose requested face lacks the
  script draws its spaces in the fallback face in the export and in the requested face in the Studio (Squash, Tape).

- **Faces follow the template; four new designs (26).** The owner chose "everything follows template": there is no face
  exception. The face flag (`scripts/face.ts`, the shard entry's face bit, `CaptionEmojiArt.face`), `captionEmojiFacePalette`,
  `CAPTION_EMOJI_FACE_BODY`, `CaptionEmojiDrawnPalette`, `captionEmojiArtPalette` and the palette's `face` part are deleted;
  `resolveCaptionEmojiPalette` returns the preset's own palette or the template's, and every design paints with it. One guard
  was added: the template's text is the detail `c` only when it is at least 0.3 ΔEok from the ink
  (`CAPTION_EMOJI_MIN_DETAIL_INK`), else white, so eye whites, teeth and shines keep their ink pupils and lines on the eight
  dark-text templates (Aura, Scribble, Receipt, Crosstape, Dialogue, Dossier, Sticker, Spine; dark text is 0.04 to 0.10 from
  the ink, all other text 0.43 or more). Four designs drawn in the pack's conventions (`source/` and `catalog.json` rows,
  nothing else special): Kitchen knife 🔪, Bird 🐦, Auto rickshaw 🛺, Handshake 🤝. The handshake has the five tones by the
  plain skin swap, as the pack's two-hand designs do; its tone rows name no SVG, and `verify --pack` lists it as not in the
  pack instead of checking variant files. Counts: 1,412 designs (1,012 single, 400 badges), 181 with tones, 2,317 emojis.
  Unicode has no electric fan or squat emoji, so the AI cannot ask for either and nothing was drawn.

- **Fast speech and badge size (28).** When no slot by the text is clear at full size or 0.7, an emoji tries the same
  sides at their edge (`slotPivot(..., edge)`): above or below the cue's reading end, and level with the row at the safe
  area's edge. Edge slots come after every existing try at the same strictness, so an emoji that fitted keeps its slot.
  A phrase badge draws `CAPTION_EMOJI_BADGE_SCALE` (1.2) times an emoji's size (its main emoji at 0.89 of a single),
  and tries a single emoji's shrunk size before it is dropped; the art carries `badge` (set at load from the index).
  Room drops over 84 styles and 3 canvases, real measure: fast 18 to 6 of 3,024, demo 5 to 4 of 1,221; Lyrics 0 and
  Wonky at most 1 of 12 on fast speech; with every other emoji a badge, fast 5 and demo 4. The fast run's other
  1,346 missing emojis are ticket 24's timing rule (a cue's last 100 ms word with no gap), unchanged. Studio and
  export match at 0 px with badges on every parity frame.

- **Negated and loose picks (27).** Each pick is `{ k, w, p, e, s }`: `p` says whether the line has the thing the word
  names (`"yes"`, `"no"` for absent, lacking, not needed, not happening or to be avoided, `"if"` for imagined or
  conditional), written before the emoji, and `s` may be 1, "only related" (topic, a nearby thing, a metaphor or another
  word). Code drops `p: "no"` (since ticket 30, unless the emoji itself pictures "no") and strength 1; a reply without `p` is malformed (the chunk is retried). The prompt's
  "skip absent things" line is gone. On the negation fixtures (6 runs, Balanced), picks on absent words fall from 28
  to 12 on ticket 21's nine, 13 to 4 on new ones, 4 to 0 on the real clips ("no telephoto camera"). That is not the
  ticket's "at most 1 in 3 runs": "not short of customers but short of profit" in Urdu, Hindi and Arabic still gets 💰
  in about half the runs, and neither a sharper wording, a second keep/drop pass nor more reasoning fixed it.
  Relevance rose (written 93% to 96%, real 95% to 97%) at 8% fewer emojis per minute on written fixtures, 3% on the
  real clips. Double negatives ("my day doesn't start without tea") are now marked absent and dropped. Replies are about 30% longer, so
  `maxOutputTokens` is 4,000 (500-word chunks hit 2,000). $0.0070 to $0.0076 per 1,000 words; prefix 7,015 tokens.

- **Coverage (30).** Tickets 20 to 27 tuned only the share of picks that fit, and a clip got 3.1 to 3.4 emojis a
  minute at Balanced, with none on 9 to 12% of runs. The prompt now asks for what a short-form editor would put on
  each phrase of three to six words, about one candidate per 8 words, and allows two fits: the emoji pictures its
  word (strength 3), or it pictures what the phrase says, on the word that completes it (strength 2: ❌ on "work"
  in "it doesn't work", 🤷 on "know" in "nobody knew"); 1 is "only related", dropped. It forbids a similar object
  standing in for one the lists lack and an idiom pictured word by word. A sentence may keep several picks; two on
  one word keep the stronger. A pick marked `p: "no"` is kept when its emoji pictures "no" itself
  (`CAPTION_EMOJI_NEGATION_IDS`: ❌ 🚫 ⛔ 🙅 🙅‍♂️ 🙅‍♀️ 🤷 👎 ❎ 🤐), since the model answers `p` by the line's grammar.
  Expressive keeps strengths 2 and 3, as Balanced; gaps stay 5 / 2.5 / 1.5 s. A chunk of at least 30 words whose
  report lists no serious passage and keeps no pick is sent once more (`EMOJI_TAGGING_EMPTY_RETRY_WORDS`), within
  the one retry a chunk has. On 34 real dev clips (3 runs): Balanced 8.0 a minute (English 9.6, Hindi 11.4, Urdu
  5.4), Light 3.3, Expressive 9.3; none on 6 of 102 runs, all on Urdu clips the model marked serious (a death,
  an extortion, an addiction breakdown). The strict relevance judge rates 73% of real-clip Balanced picks A
  (ticket 27: 97%), mostly because it grades phrase pictures C; read by hand about 88% fit. About $0.0042 per
  1,000 words on 500-word chunks; a Studio clip takes about 4 s.

Open at hand-off: the `ContentPack.addEmojis` migration is not applied; the media image changed,
so the Worker's `MEDIA_*_TOOLCHAIN_FINGERPRINT` must be updated at deploy; golden render baselines
need re-capture on the pinned toolchain; no clip selection may be in flight at deploy (a capsule
saved before this change refuses to restore); the Captions panel's preview card draws no emojis;
a signed-in Studio
session and a full import have not been exercised end to end.
