# 26 — Designs with a face keep their colours; draw the missing designs

**Status:** done
**Area:** `packages/caption-emoji/**` (source, scripts, generated, tests), plus tests and copy anywhere that state the catalog counts.

## Why

The owner read the known limits and said: "Please fix the issues that could be fixed."

1. **Green sun.** Under Match template a face keeps the pack's yellow body (ticket 21, section B:
   `scripts/face.ts`, `isFaceDesign`). The rule only looks at the Smileys group, so sun-with-face
   and the moon faces take the template's colours. On Headline the sun is green and reads as a
   germ: `/private/tmp/claude-501/-Users-murtaza-Documents-dev-narriflow/f7147bb1-206f-4f6e-a8fc-276dea0eb55b/scratchpad/emoji-late-hold/pair-headline-sun.png`.
   Ticket 21 tested that these "keep the template"; that decision is now reversed.
2. **Missing designs.** The AI asks for these and the pack has no art: kitchen knife 🔪, bird 🐦,
   auto rickshaw 🛺, handshake 🤝 (ticket 20 also noted a fan and a squat; check them).

## Owner decision, 2026-11-26 (replaces deliverable 1 below)

The owner opened the Studio picker on a clip with a red template, saw yellow round faces beside red
cats, ogres and monkeys, and asked "Why colors are not matching?". Asked how Match template should
work, he chose: **everything follows the template**. No face exception at all, the way one palette
colours every design in his prototype.

**Deliverable 1 is now: remove the face exception completely.** Under Match template every design
takes the template palette. Delete what ticket 21 section B added and nothing else uses:
`scripts/face.ts` and the `face` bit in the shard encoding (regenerate the art),
`CaptionEmojiArt.face`, `captionEmojiFacePalette`, the `face` part of `resolveCaptionEmojiPalette`,
`captionEmojiArtPalette`, and their callers in caption-scene (`emoji/style.ts`, `emoji/drawing.ts`),
the worker and the Studio (`emoji-glyph.tsx`, `use-caption-emojis.ts`), with their tests. Before
deleting each, grep for other users. No leftover flag, no dead parameter (pre-production policy:
remove the old path in the same change). The palette guards that keep body, rim and detail apart
(ticket 12) stay and must still hold for faces: check the detail (eyes, mouth) stays readable on
every template's body colour, on all templates, and fix the guard if a template gives eyes that
vanish. Ticket 28's builder is editing `packages/caption-scene/src/emoji/` (placement and layer) at
the same time: keep your edits in `style.ts` and `drawing.ts` small and re-read each file just
before you edit it.

Acceptance for it: a sheet of 12 faces, the sun, a cat and an ogre under Match template on
Headline, Bold Pop and two more templates, before and after, looked at; named palettes and Custom
unchanged; the picker, the chips, the Studio video layer and the export all draw a face in the
template's colours (one test each side that fails on the old code); spec section 7 and ADR 0022
say there is no face exception.

## Deliverables

1. **(Replaced by the owner decision above.)** Find every design outside the 107 flagged faces that draws a face (eyes, with or
   without a mouth) on a body the template would recolour: sun with face, the moon faces, and
   whatever else the sources show (cats, monkeys, clown, alien, poo, skull, ghost, robot, snowman,
   animals drawn as heads). Render each candidate under Match template on Headline, Bold Pop and
   two other templates with strong highlight colours, before and after, and look at them. Flag a
   design as keeping its body colour when recolouring it makes it read as something else or as
   sick. Do not flag a design just because it has eyes: a recoloured cat that still reads as a cat
   stays as it is. State the rule in `face.ts` in terms of the art, not a hand list, unless a short
   named list is honestly the smallest correct rule; then say why in the comment. Update the
   tests ticket 21 wrote for sun-with-face and full-moon-face.
2. **Missing designs.** First check each glyph really resolves to nothing (`emojiRefForGlyph`) and
   that no existing design already means it. For each one truly missing, draw a new design in the
   pack's own conventions: study ten neighbours in the same group (64 grid, the `data-role`
   roles, stroke weights, corner radii, how detail and rim are used) and match them. Add the
   source file and its catalog row the way the pack's designs are stored, so the compiler,
   picker search, AI vocabulary and tone handling pick them up with no special case. Handshake:
   give it tones only if the pack's other two-hand designs have them and you can do it in the
   same way; otherwise one design without tones.
3. Keep the additions easy to find and remove: list every added file in this ticket's Evidence.
4. Every test, comment, doc line and UI string that states 1,008 / 1,408 / 2,308 follows the new
   counts (spec section 7, GLOSSARY, ADR 0022, memory is not yours).

## Acceptance

- [x] (Replaced by the owner decision.) Before and after sheet of 12 faces, the sun, the full moon, a
      cat, a monkey, the clown and the alien monster (no ogre design exists; the horned faces stand in)
      on Headline, Bold Pop, Strike and Chrome; every face takes the template; eyes and mouths read on
      every template (one guard added, see Evidence); named palettes and Custom unchanged; a test on
      each side fails on the old code; spec section 7 and ADR 0022 say there is no face exception.
- [x] Each new design passes the package's fidelity and outline checks, draws in the Studio glyph
      path and the export writer (the catalog completeness test walks it), and is found by glyph
      and by name.
- [x] A sheet of the new designs beside six neighbours each at caption size (default palette and
      two template palettes, with and without sticker outline). Look at it as the owner would. If
      a design does not hold up beside its neighbours, redraw it; if it still does not, leave it
      out and say so.
- [x] `bun run --cwd packages/caption-emoji test`, the media catalog test, typecheck, biome on
      touched paths.

Evidence images go in
`/private/tmp/claude-501/-Users-murtaza-Documents-dev-narriflow/f7147bb1-206f-4f6e-a8fc-276dea0eb55b/scratchpad/emoji-fix-art/`.

## Evidence

Done 2026-11-26. Nothing committed, migrated or deployed. `E` = the evidence folder above.

### 1. No face exception (owner decision)

- Deleted: `packages/caption-emoji/scripts/face.ts`; the shard entry's face bit (`ShardEntry` is now
  `[outline, layers]`); `CaptionEmojiArt.face`; `CaptionEmojiPalette.face` and `captionEmojiArtPalette`
  (caption-emoji `colour.ts`, `draw.ts`); `captionEmojiFacePalette`, `CAPTION_EMOJI_FACE_BODY`,
  `CaptionEmojiDrawnPalette` (validators). `resolveCaptionEmojiPalette(preset, colours): CaptionEmojiPalette`
  is `preset.emojiPalette ?? captionEmojiPalette(colours)`. Callers: caption-scene `emoji/drawing.ts`
  (paints with the palette it is given), `emoji/layer.ts` (style type, layer key without the face
  palette), `emoji/style.ts` unchanged; Studio `emoji-glyph.tsx` (`EmojiArtSvg`,
  `captionEmojiSvgMarkup`) and `use-caption-emojis.ts` (palette is `CaptionEmojiLook`). The worker
  draws through caption-scene; no media source changed. Docs: `caption-styles.mdx` no longer says faces
  keep their yellow.
- **Guard added.** Rendering faces on the lowest-contrast templates (`E/faces-weakest-templates-before-guard.png`)
  showed ink eyes and mouths readable on every body (lowest body–ink 0.315, Tape), but on dark-text
  templates the detail `c` is the near-black text, so side-eye's eye whites, laugh-tears' tears and
  the robot's eye dots went black and their ink pupils vanished (Dossier, Scribble). This predates the
  change (the old face palette used the same `c`). New rule in `captionEmojiPalette`: the text is the
  detail only when it is at least `CAPTION_EMOJI_MIN_DETAIL_INK = 0.3` ΔEok from the ink, else white.
  Dark text measures 0.04 to 0.10 (8 presets: aura, scribble, receipt, crosstape, dialogue, dossier,
  sticker, spine); the next nearest text is 0.43 (tilt). After: `E/faces-weakest-templates-after-guard.png`.
- Sheets (looked at): `E/faces-before-after.png`: 18 designs, before (yellow round faces) and after on
  Headline, Bold Pop, Strike, Chrome. After, faces match the cats, monkey, clown and alien on each
  template; nothing reads as missing a feature. On Strike the blush and heart eyes are darker reds on
  the red body (rim role, guard 0.12 to 0.18), visible.
- Tests that fail on the old code: caption-scene `style.test.ts` (heart-eyes and sun-with-face bodies
  are Headline's `a`); web `emoji-glyph.test.ts` (the glyph's SVG has Headline's body and rim, no
  `#ffe45c`); media `caption-emoji-catalog.test.ts` "the export draws a face in the template's
  colours" (ASS events carry Headline's body in BGR, never the yellow); validators "under Match
  template every design takes the template palette" (for all 115 presets the resolver equals
  `captionEmojiPalette`); caption-emoji `art.test.ts` (art keys are `badge id layers outline`).
  Validators also gained "dark caption text never becomes the detail" and the detail–ink check in the
  separation-invariants walk.

### 2. Missing designs

- Checked with `emojiRefForGlyph` and index search: 🔪 🐦 🛺 🤝 resolve to null and no design means them
  (🍴 fork-and-knife and 🍽️ exist; no badge draws a handshake: "We have a deal" uses 🙌). 🪭 (Folding
  hand fan) and 🏋️ / 🧎 exist. Unicode has no electric or ceiling fan and no squat, so the AI cannot ask
  for those; nothing to draw.
- Drawn in the pack's conventions after studying neighbours (render `n-*.png` in my scratchpad): 64 grid,
  `a` main body, `b` secondary, `c` white highlights, `ink` wheels and eyes, round caps, objects tilted
  27 to 40 degrees, vehicles side-on with r7 ink wheels and r3 white hubs at y≈48.
  - Kitchen knife (Food & drink): yellow blade with white shine, ink bolster, pink handle, two rivets.
  - Bird (Animals & nature): pink body like the penguin and owl (so it does not repeat the chick),
    yellow wing and beak, white belly, ink eye and legs.
  - Auto rickshaw (Travel & places): pink dome canopy, open side with an ink bench, windshield, yellow
    body rising to the driver's cowl, headlamp, front wheel smaller. Three drafts (the first two read as
    a van).
  - Handshake (Hands): two sleeves (pink, yellow, as Folded hands), one hand's four fingers over the
    other with crease lines, the other's thumb on top. Skin `#ffc759` and creases `#8d603f`, as the
    pack's hands; five tones by the plain skin swap (all 41 of the pack's hand designs have tones, and
    the two-hand ones do it this way). Four drafts; the first three read as one lump at caption size.
    It is the weakest of the four: narrower than its neighbours. Kept because the last draft reads as a
    handshake beside Folded, Clapping and Open hands at caption size and in all six tones.
- Per design (`newstats.ts`): layers knife 4, bird 4, rickshaw 6, handshake 5 (one `skin`); 0 wrong
  pixels against the source at 128 px; outline check 0 missing, uncovered, slivers, holes; no hole kept.
- Sheets (looked at): `E/new-designs-beside-neighbours.png` (each design with six neighbours, 64 px:
  default, Headline and Strike palettes, with and without the sticker outline), `E/handshake-tones.png`
  (six tones beside Clapping, Folded and Open hands). All four hold up; none left out.
- `verify --pack`: the pack has no handshake variant files; `scripts/verify.ts` now lists a design whose
  base file is not in the pack under `tones.notInPack` instead of throwing.

### Counts and bytes

1,412 designs (1,012 single, 400 badges), 181 with tones, `CAPTION_EMOJI_COUNT` 2,317. Picker
placeholder reads "Search 2,317 emojis" (computed). Generated: art 3,909,243 B in 17 shards (shard
counts unchanged; hands-0 125,971, smileys-0 328,039, 214 B smaller without the face bits), index
122,143 B. Layers per design 1 / 5 / 19, total 8,301.

### Commands and results

- `bun run --cwd packages/caption-emoji build`: 1,412 compiled, 0 failures, 0 warnings, nothing outside
  the box; run twice, `shasum` of every generated file identical.
- `bun run --cwd packages/caption-emoji verify -- --pack <S>/emoji-art/pack`: exit 0; 1,412 designs, 0
  over threshold (mean error median 0.065, max 0.681); outlines 1,412 checked, 0 faults, 26 kept holes
  (unchanged); tones 900 checked, 0 over, `notInPack: ["handshake"]`.
- `bun run --cwd packages/caption-emoji test`: 106 pass (fidelity and outline tests now include the
  four new designs).
- `bun test apps/media/src/caption-emoji-catalog.test.ts`: 8 pass, "2317 emojis resolved by glyph and by
  name", "2317 emojis drawn by the export writer", "AI vocabulary 1012 single designs + 400 badges",
  "181 designs with skin x 5 Skin tones planned".
- `bun run --cwd apps/media test`: 1,235 pass, 1 skip, 1 fail (`worker-process` "samples worker and
  command memory", passes alone 78/78: the load flake ticket 23 recorded).
- `bun run --cwd packages/validators test`: 1,366 pass, 1 fail in `emoji-tagging.test.ts` (pick strength
  enum `[1, 2, 3]` against `[2, 3]`): ticket 27's file, not touched here. `caption-emojis.test.ts` 29 pass.
- `bun run --cwd packages/caption-scene test`: 3,223 pass, 3 timeouts under parallel load
  (`scene-bounds-over`, `funky`, `emoji/placement` badges); those three files alone: 133 pass.
- `bun test` web `studio/_components/emoji`: 111 pass. services `clip-emoji-tagging.test.ts`: 13 pass.
- Biome on every touched file: clean. `bun run typecheck`: 17 of 17 successful (25 min, shared machine).

### Files

Added: `packages/caption-emoji/source/food-and-drink/kitchen-knife.svg`,
`source/animals-and-nature/bird.svg`, `source/travel-and-places/auto-rickshaw.svg`,
`source/hands/handshake.svg`; nine rows at the end of `source/catalog.json` (Kitchen knife, Bird, Auto
rickshaw, Handshake, and Handshake's five skin-tone rows). Removing the designs is deleting those four
files and nine rows and rebuilding.
Deleted: `packages/caption-emoji/scripts/face.ts`.
Changed: caption-emoji `scripts/build.ts`, `scripts/verify.ts`, `src/{encoding,art,colour,draw}.ts`,
`src/{art,index,fidelity}.test.ts`, `src/generated/**`; validators `src/caption-emojis{,.test}.ts`;
caption-scene `src/emoji/{drawing,layer}.ts`, `src/emoji/style.test.ts`; web Studio
`emoji/{emoji-glyph.tsx,emoji-glyph.test.ts,use-caption-emojis.ts,emoji-picker.tsx,emoji-picker-model.test.ts}`,
`content/docs/caption-styles.mdx`; services `src/clip-emoji-tagging.test.ts` (count); media
`src/caption-emoji-catalog.test.ts`; `docs/adr/0022-caption-emojis.md`; spec section 7.
Sheet scripts: `E/tools/`.
