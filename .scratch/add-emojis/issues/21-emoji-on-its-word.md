# 21 - Relevance: apply only what the evidence supports

**What to build:** After ticket 20, finish the relevance work using only the reviewers' advice that
holds up. The owner asked (2026-11-26): "consider the wrong advice from the Sol and Astra, only
consider that are actually correct and fix the problem." The coordinator weighed each
recommendation against its evidence; this ticket records the verdicts and the remaining work.
Rules: [../RULES.md](../RULES.md).

**Blocked by:** [20](20-relevance-demo-and-eval.md) (same files)

**Status:** done

## Verdicts on the reviewers' advice

Adopted (measured, or a plain defect):

| Advice | Why it holds |
| --- | --- |
| The emoji must depict the exact word it sits on (Sol) | Tested: real clips 52% to 69%, written 77% to 81%. |
| Echo the chosen word, integer ids, reject mismatches; a malformed reply is a failed chunk (Sol) | Measured defect: ids like `164:flashlight.`; three runs counted complete and drew nothing. |
| One accepted pick per sentence, enforced in code (Sol) | The prompt already says so; the model broke it on 33 sentences. |
| Never show an emoji before its word is spoken (Sol, Astra) | Measured: 9 of 58 real picks could appear up to 840 ms early. |
| After an edit, an emoji re-attaches only to the same word (Sol) | The 400 ms nearest-time rule can hand an emoji to a neighbour. |
| The hook rule only breaks ties (Sol) | It kept weak picks over strong ones in four cases. |
| Keep the vocabulary glyph-only (Sol) | Names beside glyphs: tokens 4,139 to 7,263, relevance 77% to 74%. |
| Use the model's own strength as a gate (Astra) | Strength 3 only: the wrong 👏 on "satisfying" went, 🧲 on "magnets" stayed, 19 of 23 fit. |
| An emoji should not linger over later, unrelated words (Astra) | Follows from the same link-to-word argument; cheap; judge on renders. |

Rejected or changed:

| Advice | Verdict |
| --- | --- |
| Default density Light (Sol, Astra) | **Rejected.** Sol's own numbers show density barely moves relevance (written 80 / 77 / 75, real 53 / 52 / 46 for Light / Balanced / Expressive), and Astra's support is six showcase excerpts. The owner's Vizard reference shows emojis on adjacent lines. Balanced stays the default; relevance comes from the strength gate below, not from showing fewer. |
| Centre the emoji on its own painted word (Astra) | **Rejected for now.** The evidence is two emojis in one OpusClip excerpt and a reading of test frames. In centred captions the word's x and the block's centre are nearly the same, so it would not settle which word is meant; it needs word boxes in all three caption paths, risks Studio and export parity, tightens slots (more drops), and makes the sticker jump sideways between cues. What links an emoji to its word is the moment it appears and the word being the emphasised one. Revisit only if rendered AI picks still read as unlinked. |
| Natural colours for flame, water, hearts, food (Astra) | **Not adopted.** The owner asked for template colours, the pack has no natural colours, and Astra's own check found the recoloured flame and money bag still read. Owner's call. |
| "A sound made by an object is not a human gesture" in the prompt (Astra) | **Rejected as written.** It is fitted to one clip. The general rule (depict what the word names, not a reaction to it or a thing near it) covers it. |
| Code filter for measurement units after a quantity (Astra) | **Rejected as code.** A per-language unit lexicon to remove two in-sample picks. "Never on a number or a unit of measure" goes into the prompt's never-anchor list instead. |
| Hide professions, Sobbing and others from the AI (Astra) | **Partly rejected.** The coordinator looked at `phone-proof.png`: Sobbing reads as crying, and a profession reads as a person, which is not misleading. Excluded only: money-mouth (reads as tongue-out), ice (reads as a package), fog, nazar-amulet, fire-extinguisher, spaghetti, curry-rice, sun-behind-small-cloud, sun-behind-large-cloud, peeking, face-in-clouds. |
| A model judge in the test loop (Sol) | **Reduced.** Useful as an optional mode of the eval script; never a gate. |

## Deliverables

1. **Reconcile ticket 20 with these verdicts.** Read its Evidence. Where it implemented something
   rejected above (in particular a Light default), change it: `DEFAULT_CAPTION_EMOJI_DENSITY` stays
   `balanced`, the Studio's selected option and the docs agree.
2. **Density is a strength gate plus spacing.** Light keeps strength 3 only; Balanced keeps
   strength 2 and 3; Expressive keeps all. The spacing and repeat rules stay. One place
   (`selectCaptionEmojiPicks`), tested. Report picks per minute and the fit rate at each density on
   the four real clips.
3. **AI vocabulary exclusions**: the eleven designs listed above, as a small id set in
   `packages/caption-emoji` beside the index, applied to `CAPTION_EMOJI_AI_GLYPHS` (so the prompt
   never offers them) and to `emojiRefForGlyph`'s AI path (so a pick of one is dropped). The picker
   still offers them. Test both.
4. **Prompt hygiene.** The prompt states principles, not cases from the evaluation clips. Remove
   any sentence that only exists to fix one transcript; keep one or two short examples of the
   general rule. Add "a number or a unit of measure" to the never-anchor list and a line on
   negation (a thing said to be absent gets no emoji). Re-run the eval after the cleanup to show
   the rates held.
5. **Timing.** If ticket 20 did not already do it: an emoji appears at its word, never earlier,
   and does not sit over later words for long (ticket 20's addendum, items 3 and 4). One rule,
   both renderers, placement tables and the parity check re-run.
6. **Show it.** The four real clips with real AI picks at Balanced on a classic, a Dynamic and a
   Scene preset, one frame per emoji labelled "word → emoji name (strength)", in
   `/private/tmp/claude-501/-Users-murtaza-Documents-dev-narriflow/f7147bb1-206f-4f6e-a8fc-276dea0eb55b/scratchpad/emoji-relevance/final-21/`.
   Read every frame as the owner would: is it obvious why that emoji is there? Report the count
   that pass, and list each one that does not with the reason.

## Acceptance

- [x] Deliverables 1 to 6; rates per density on the real clips, the final prompt text, and the
      sheet paths in Evidence.
- [x] `bun run typecheck`, `bun run test`, `bun run check:web-split`,
      `bun run --cwd apps/api build:worker`, biome on touched files.

## Addendum (coordinator, after ticket 20 landed and the coordinator read its frames)

Ticket 20 reached 97% at Balanced on the real clips (was 60%; Sol measured 52%), kept Balanced as
the default, made the emoji never show before its word, capped the hold at 2 s, stores each
emoji's word, and made the demos truthful. Read its Evidence first; deliverables 1 and 5 above are
therefore done unless you find otherwise. What the frames
(`.../scratchpad/emoji-relevance/final/sheet-*.png`) still show, and what to do:

A. **The emoji's word should be the cue's emphasised word.** On Headline and Reveal the Urdu cue
   "close کرتے ہوئے magnets" draws "کرتے" as the big hero word while the 🧲 belongs to the small
   "magnets" beside it, so the eye connects the emoji to the wrong word. The AI has already judged
   the emoji's word to be the meaningful one. Make a word that carries a drawn emoji count as an
   emphasis word: in `assignCaptionRoles` (`packages/validators/src/caption-emphasis.ts`, called
   from `finalizeCaptionLayers` in the plan) give it the same kind of boost Clip Emphasis Words get
   (the `llm` weight), only when the preset's emojis are on and the entry actually draws, and never
   over a manual `studioEdits.captionEmphasis` override. Studio and export read roles from the same
   plan, so both follow. Check that toggling emojis off returns the cue to its previous roles, that
   plans without emojis are byte-identical, and that the Scene and block build keys change when roles
   change (they include roles already; confirm). Render the same four clips before and after and
   judge: does the highlighted word now match the emoji in every frame that has a hero?
B. **Faces must not be recoloured into another feeling.** On Headline the template palette makes
   faces green: 😍, 😌, 🤔 and 🥳 then read as sick. A face's body colour is part of its meaning
   (green is nauseated, red is angry, blue is cold). In Match template mode, designs that are faces
   keep the stock yellow body (`a`), and take the template only for rim and detail (`b`, `c`, still
   passed through the existing guards against the yellow body); an explicit palette chosen by the
   owner (a named one or Custom) applies to faces fully, as today. "Face" must be a fact carried by
   the art data, not a lookup in the 129 kB index at draw time: add a flag per design in the
   compiled art (decide it in the compiler from the pack's group and design: the Smileys group's
   round faces; say exactly what rule you used and list the borderline designs), so both renderers
   resolve the same palette from the same art. One shared function resolves the palette for a
   design. Render 12 faces on Headline, Lyrics, Tunnel and Horizon before and after.
C. **How many AI picks are lost because their word is last in its cue?** Ticket 20 drops an emoji
   whose word leaves under 250 ms of its cue (on the synthetic fast run that is half of them). On
   the four real clips and the written fixtures, at each words-per-cue value in use (classic 3,
   Dynamic and Scene 3 to 5) and for a classic, a Dynamic and three Scene presets, report the share
   of accepted AI picks that are not drawn for that reason. If it is above 5% on real clips, fix it
   without showing the emoji early: let it keep a minimum readable window (about 400 ms) by holding
   past the cue's end when nothing it would cover is in the way (the collision check already
   exists), otherwise drop it. State the rule and the before and after share.
D. Deliverables 2 (density as a strength gate: Light keeps strength 3 only; the schema now has
   strengths 2 and 3), 3 (the eleven AI vocabulary exclusions), 4 (prompt hygiene: read ticket 20's
   final prompt and remove any sentence that only patches one evaluation clip) and 6 (final
   renders, now with A and B applied) stand as written.
E. Do not start a dev server; the owner runs his own. Compare the two renderers through the shared
   functions and the existing parity tests, as ticket 20 did.

## Evidence

Done 2026-11-26. A previous agent was cut off by a rate limit; this agent took stock of its edits,
finished them and records each part as it is proven. Nothing committed, migrated or deployed. Scratch roots:
`P = /private/tmp/claude-501/-Users-murtaza-Documents-dev-narriflow/5de557b6-eec2-4e0e-9dd9-628da17df857/scratchpad`
(previous agent) and `S2 = /private/tmp/claude-501/-Users-murtaza-Documents-dev-narriflow/c50cc279-eda1-4a3c-94a2-09e85b6b3d95/scratchpad`.

Inherited state: `bun run typecheck` 17/17; tests pass in validators (1,365), composition-plan (200), caption-emoji
(107), caption-scene (3,217), apps/web (1,366); services 1 fail (`clip-detection-persistence.test.ts`, a strength-1
pick that the new Balanced gate drops: the test was not updated for D).

### A. The emoji's word is its cue's hero

- `CaptionEmphasisWord.emoji?` (validators `caption-emphasis.ts`). In `assignCaptionRoles`, when no override sets the
  cue's hero, the best candidate unit (one word or a 2-word unit) holding an emoji word is the hero, ranked by the
  scorer with the repeat penalty, without the confidence gate; otherwise the scorer's gated pick as before. An
  override wins (a manual hero elsewhere; `plain` on the emoji word gives the scorer's pick). A minor word never is a
  candidate, so an emoji on it changes nothing; a style with `emphasis: "never"` (Cutout) is unchanged. The previous
  cue's automatic pick for the repeat penalty ignores emojis, so an emoji changes no other cue.
- Deviation from "the same kind of boost as the `llm` weight": a boost can lose to a long or strong word, which
  leaves the exact mismatch the ticket is about (Urdu "کرتے" at 0.9 s beats "magnets"). The rule is "the emoji's
  word is the hero" instead, so it is always true when an emoji draws.
- "Actually draws" = the plan attaches it to a cue: `attachCaptionEmojis` (composition-plan `caption-emoji-plan.ts`)
  now returns, by layer, the word indexes whose emoji is attached (emojis on, entry resolved to a kept, uncensored
  word, cue with no typed emoji); `finalizeCaptionLayers` marks those words before `assignCaptionRoles`. Dub-cue
  emojis (by time, no word) mark nothing. An emoji the layer later drops for room or time keeps the hero: the plan
  cannot know placement, and the word is still the AI's meaningful word.
- Build keys: `sceneBuildKey` includes every word's `role`, and the block (rows, roles) is plan data, so both rebuild
  when roles change. Consequence: adding an emoji to a word that was not the hero now rebuilds that Scene Style's
  scene (spec section 6 item 1 said an emoji edit never does); an emoji on the existing hero, or on a classic preset,
  still does not.
- **Plan hashes** (`P/a/plan-hash.ts`: 115 presets × 6 sources (English and Urdu synthetic with a cut, and the four
  real clips' documents) × 3 canvases (one plan holds all three), variants off / stored-but-off / on-without-entries /
  on): the 2,070 emoji-free plans hash `35078226…ddd2` before A (`P/a/before.json`, 16:06, before the edit), after A
  (`P/a/after.json`) and on the current tree after B to D (`S2/a/now.json`). The 690 "on" plans change in 540: all 90
  presets that draw a hero, 6 sources each; the 24 classic presets and Cutout are identical.
- Tests: validators `caption-emphasis.test.ts` "emoji words" (5 tests: hero over a stronger word and a Clip Emphasis
  Word; no confidence gate; override and `plain`; 2-word unit; minor word, `never` policy and other cues unchanged).
  composition-plan `caption-emoji-plan.test.ts`: on Headline and Reveal the emoji's word ("decision", a body word) is
  the hero, other cues keep their roles, Headline's block rows change, the switch off with the entry stored gives the
  scorer's roles, a typed-emoji cue keeps its roles, and (added now) a manual hero on another word of the cue wins.
  Each fails without A (the emoji word stays `body`).

### B. Faces keep a yellow body under Match template

- **Fact in the art.** Each shard entry ends with `1` when the design is a face (`encoding.ts`); `CaptionEmojiArt.face`
  (`art.ts`). The compiler decides it (`scripts/face.ts`, `isFaceDesign(group, source)`): a design of the Smileys group
  whose source draws a body-role (`data-role="a"`) circle of radius at least 18 grid units. **107 faces**, every one
  with a body circle of radius 22 or 23. Left out of the Smileys group (68): the ten cats and three monkeys, the clown,
  the alien, the skull and crossbones, pile of poo and the dotted-line face (drawn without that circle), hearts,
  bubbles, marks, buttons and arrows. Borderline: eye-in-speech-bubble has a body circle of r16 and is not a face;
  sun-with-face and full-moon-face are faces in other groups and keep the template (tested), as do people and hands.
- **One resolver.** `resolveCaptionEmojiPalette(preset, colours)` (validators) returns the preset's own palette when
  it has one (a named palette or Custom colours faces in full), else the template palette plus `face` when it differs:
  `captionEmojiFacePalette` = body `#ffe45c` (the pack's yellow), detail the template's primary when it separates
  from the yellow (else white), rim by the same rim rule against the yellow body. `captionEmojiArtPalette(art,
  palette)` (`@narriflow/caption-emoji/draw`) picks the colours for one design. Callers: `captionEmojiLayerStyle`
  (caption-scene `style.ts`, so the worker's ASS writer and the Studio's video layer), `captionEmojiDrawing`
  (`drawing.ts`, shared by both), and the Studio's glyph (`emoji-glyph.tsx`) fed by `use-caption-emojis.ts`. The Match
  swatch in the style controls still shows the template palette (the non-face colours).
- Build deterministic: `bun run --cwd packages/caption-emoji build` on the current tree regenerates `src/generated/`
  with identical `shasum` for every file. Bytes: smileys-0 328,039 → 328,253 (+214, the flags); other shards unchanged.
  `verify -- --pack <S>/emoji-art/pack`: exit 0, 1,408 designs 0 over threshold, 900 tones 0 over, outline faults 0.
- Tests: `art.test.ts` (107 faces, all Smileys; named faces true; cats, monkeys, clown, alien, poo, dotted-line,
  hollow circle, heart, sun and moon faces, rocket false; per-design palette choice); validators "faces keep the stock
  yellow body under every template" (all 115 presets, separation guards); caption-scene `style.test.ts` (Headline:
  heart-eyes body yellow, rocket body the template's; a named palette colours the face); web `emoji-glyph.test.ts`
  (the glyph's SVG uses the face body and rim). Each fails without the flag or the face palette.
- Renders (previous agent, 16:31, after the B code was final): the Urdu clip with 12 face picks and a rocket on
  Headline, Lyrics, Tunnel and Horizon, before and after, export path:
  `P/b/sheet-faces-closeup.png` (close-ups) and `P/b/sheet-faces.png` (whole frames). Looked at: every face is
  yellow after (green, lime or pink before), rims follow the template (orange on Tunnel, cyan on Horizon, dark on
  Headline); the rocket keeps the template colours. 😍, 😌, 🤔, 🥳 on Headline no longer read as sick.

### C. Emojis whose word ends its cue

- **Measured before** (previous agent, `P/c/measure.ts` over `P/c/tagged`: real AI picks at Balanced, 3 runs × 4
  real clips = 37 accepted picks, and 28 written fixtures, 160 picks; export path `planClipComposition` (9:16) →
  `compileCompositionPlanCaptions` at 30 fps; before = 16:34, ticket 20's rule, before `layer.ts` changed):
  share of accepted picks not drawn for `no-time`:

  | Preset, words per cue | real before | real after | written before | written after |
  | --- | --- | --- | --- | --- |
  | Electric (classic) 3 | 10.8% | 0% | 0% | 0% |
  | Headline (Dynamic) 3 / 4 / 5 | 10.8 / 2.7 / 2.7% | 0 / 0 / 0% | 0 / 0 / 0% | 0% |
  | Reveal (Scene) 3 / 4 / 5 | 10.8 / 2.7 / 2.7% | 0 / 0 / 0% | 10.6 / 8.8 / 3.1% | 0% |
  | Tunnel (Scene) 3 / 4 / 5 | 5.4 / 0 / 0% | 0% | 0% | 0% |
  | Horizon (Scene) 3 / 4 / 5 | 5.4 / 0 / 0% | 0% | 0% | 0% |
  | all runs | 4.2% (20 of 481) | 0% | 1.7% (36 of 2,080) | 0% |

  Above 5% at 3 words per cue on all three kinds, so fixed. No pick dropped for room on these clips before or after.
- **Rule** (`packages/caption-scene/src/emoji/layer.ts`, `plan`, one function for both renderers): a word leaving
  250 ms or more of its cue's last paint is unchanged (to the last paint, at most 2 s); one leaving 120 to 250 ms holds
  past the last paint to `CAPTION_EMOJI_LATE_HOLD_MS = 400` ms from its word, with the quick entrance, and the slot is
  checked over that whole window (`slotWindow`: obstacles, other emojis, safe area; it may trim the end within the
  usual limit, else `no-room`); under `CAPTION_EMOJI_LATE_MIN_MS = 120` ms (the quick entrance would not land while
  the word shows) `no-time`. Never before the word.
- **Feeders.** The worker needs nothing new: a held window is a longer ASS event. The Studio mounts one classic or
  Dynamic cue at a time, so `OneCueEmojis` remembers each drawn cue's box (`held-cue-boxes.ts`, a `WeakMap` by plan
  layer) and `HeldCueEmojis` (`held-cue-emojis.tsx`, mounted in `video-preview.tsx` beside the caption overlay) draws
  the same `CueEmojiLayer` from that box from the cue's end for 400 ms. Scene Styles draw all cues as one scene, so
  nothing is held there. Studio limits: a cue never drawn in the session (seeking straight into the held 120 to 280 ms)
  has no box and shows no held emoji; a held emoji does not follow a drag in progress.
- **Limit:** a classic or Dynamic cue is placed alone (ticket 14 item 9), so the held window is checked against its own
  cue's box, not the next cue's text; a Scene Style's check sees every cue's pieces. Measured over the real clips on
  Electric, Headline (3/4/5) and Bold Pop (`S2/c/held-overlap.test.ts`, every cue's box against each held emoji's ink
  on every frame): 14 held of 985 placed, **0 cover the next cue's text**. Not worth a cross-cue feeder.
- Placement tables (84 styles × 3 canvases, `M/tables/table.ts`, [cues, no-room, problems, no-time]): demo fake
  `[1221,4,0,0]`, demo HarfBuzz `[1221,5,0,0]` (unchanged); fast fake `[3024,3,0,1611]` → `[3024,12,0,1346]`, fast
  HarfBuzz `[3024,10,0,1608]` → `[3024,18,0,1346]`: 265 more fast-speech emojis drawn, 9 and 8 of the newly held ones
  find no room, 0 problems. The fast run is 150 ms words back to back, so 44% still leave under 120 ms.
- Tests: caption-scene `layer.test.ts` (windows at 300, 250 and under 250 ms left; held to 400 ms; covered after the
  cue → `no-room`; under 120 ms → `no-time`; never before the word). web `held-cue-boxes.test.ts` (held window, Scene
  and empty cues not held). media `caption-emoji-ass.test.ts` "a late word's emoji holds past its cue, the same on
  both feeders" (new): Electric, Headline and Reveal with the emoji on the cue's last word (150 to 170 ms left): the
  export's events run from the word to 400 ms after it, past the cue's last paint; the Studio's feeder input (the one
  cue, or the scene's cues, with the cue's style and anchor) places identically to the worker's group; and the Studio's
  held mount (`heldEmojiCues`, imported from the web module) is active on exactly the export frames after the cue's
  end, never for the Scene. Fails on ticket 20's rule (`no-time`) and without the held mount.

### D. Density, AI vocabulary, prompt

- **Density = strength gate, then spacing** (`selectCaptionEmojiPicks`, validators `caption-emojis.ts`):
  `CAPTION_EMOJI_DENSITY_MIN_STRENGTH = { light: 3, balanced: 2, expressive: 1 }`, applied before the 5 / 2.5 / 1.5 s
  spacing and the 10 s repeat rule. `DEFAULT_CAPTION_EMOJI_DENSITY` stays `balanced`; the Studio's options say "Only
  the surest matches" / "Clear matches" / "Every match" with the spacing; `caption-styles.mdx` says the same with
  Balanced the default. The model writes strengths 2 and 3 only (schema enum), so Expressive and Balanced differ only
  in spacing for AI picks. Tests: validators "density is a strength gate first" (a lone strength-2 pick is not kept
  at Light); services `clip-detection-persistence.test.ts` updated (it used a strength-1 pick at Balanced) and now
  asserts that Balanced drops strength 1.
- **AI exclusions** (`packages/caption-emoji/src/ai-vocabulary.ts`, `CAPTION_EMOJI_AI_EXCLUDED`): money-mouth, ice,
  fog, nazar-amulet, fire-extinguisher, spaghetti, curry-rice, sun-behind-small-cloud, sun-behind-large-cloud, peeking,
  face-in-clouds. `CAPTION_EMOJI_AI_GLYPHS` leaves them out (997 glyphs, so the prompt never lists them) and
  `emojiRefForAiGlyph` (the tagger's glyph mapping) returns null for them; `emojiRefForGlyph`, the index and the picker
  still have them. Tests: caption-emoji `index.test.ts` (vocabulary less the eleven; each excluded glyph → null on the
  AI path, found by the picker's lookup) and, new, services `clip-emoji-tagging.test.ts` (the system prompt has no 🤑
  or 🧊; a model reply with 🤑 and 🧲 keeps only the magnet).
- **Prompt hygiene.** Against ticket 20's final prompt (`P/d/prompt-before.txt`), removed the cases taken from the
  evaluation clips: the "died laughing / my phone died / 🔋 on battery" example (the en-waveform clip's "The battery
  might be dead"), "skip fire when it only means excellent", and the topic-association examples "a camera on video, a
  trophy on season, a rocket on a title" (en-waveform "episodes", owner-halftone "Star Wars"). In their place, one
  invented example per principle: 😴 on "asleep" but nothing on "sleep" in "let me sleep on it"; "sick" meaning great;
  a ball on "weekend" in a talk about football. Added "a number or a unit of measure" to the never-anchor list and a
  negation line. The feeling rule's "nervous / felt" example was not from an eval clip and stays.
- The previous agent had lengthened the negation line last (16:51, "because the video would show what the speaker says
  is missing ... in any language (no, without, lack of, not)"). Measured both wordings on the 9 fixtures with negated
  nouns, 3 runs each (`S2/d/eval/neg-{1646,current}.json`): picks on a negated noun kept at Balanced, by hand, 8 with
  the short line and 10 with the long one (mostly "lack of profit/money" and "not built for gaming", in Urdu, Hindi
  and Arabic). The longer line does not help, so the short one is final. Negation is obeyed only partly.
- **Did the cleanup cost relevance?** Same grading for all (hand labels from tickets 20 and 21, mine for every pick
  the judge did not rate A, `S2/d/labels-mine*.json`), real clips only, 6 runs each (`S2/d/eval/graded-*.md`):

  | Prompt | Light | Balanced | Expressive | Picks/min L/B/E |
  | --- | --- | --- | --- | --- |
  | ticket 20's final | 100% (29) | 92% (78) | 90% (81) | 1.6 / 4.2 / 4.4 |
  | cleanup, short negation line (final) | 100% (42) | 92% (92) | 91% (94) | 2.3 / 5.0 / 5.1 |
  | cleanup, long negation line | 100% (45) | 93% (107) | 93% (108) | 2.5 / 5.8 / 5.9 |

  Ticket 20's own prompt measures 92% today, so the gap to its recorded 97% (3 runs) is run-to-run spread and grading,
  not the cleanup; no change was undone. The recurring misses under every prompt are ticket 20's known kinds: 🥹/🥺 on
  "feeling" in "I'm feeling emotional", 🧱/✂️/🏗️ on "tear it down", 🎙️/🎬 on "episodes".
- **Final eval** with the final prompt, 3 runs, real clips and the 28 written fixtures, judge on
  (`S2/d/eval/final21-graded.md`):

  | Set | Light | Balanced | Expressive | Picks/min L/B/E |
  | --- | --- | --- | --- | --- |
  | real clips | **100%** (24) | **94%** (47 of 50; 1 B, 2 C, 0 D) | 92% (51) | 2.6 / 5.4 / 5.6 |
  | written en | 99% | 97% | 97% | 3.9 / 6.5 / 6.8 |
  | written ur | 100% | 98% | 99% | 3.9 / 6.1 / 6.6 |
  | written hi | 97% | 96% | 95% | 4.2 / 7.9 / 8.8 |
  | written ar | 99% | 94% | 94% | 4.6 / 8.1 / 9.1 |

  Real-clip misses at Balanced: 🥹 on "feeling" (B), 🧳 on "carry" (C), 🤔 on "weird" (C). Ticket 20: real 100 / 97 /
  97%, 3.6 / 4.0 / 4.1 per minute. Light now keeps fewer (strength 3 only) and stays at 100%. Malformed 8 of 934,
  unknown glyphs 4 (♨️ and similar), failed chunks 0 of 96, serious leaks 0. Cost $0.0045 per 1,000 words; median 4.4 s
  per transcript, max 6.5 s. Judge vs hand: same A-or-not 68%, 4 false A.
- **Final prompt** (`emojiTaggingSystemPrompt`, then the 997 glyphs):

```
You add emojis to the captions of a short video, in any language.
You get the video's title and its transcript as numbered words "id:word", one sentence per line.
First list in "serious" every passage about a serious subject: death, an accident, injury, illness or hospital, grief, violence, abuse, disaster, war, crime and similar, in any language.
A passage runs from the id of its first word ("from") to the id of its last word ("to") and covers every line about that event, including how the speaker felt and wishes or prayers for the people in it.
Serious passages get no emoji at all, not even a sad, sick, caring or praying one.
An emoji illustrates the one word it sits on. Pick only when the picture immediately depicts that word (a thing, an action or a feeling the word names) or the concrete meaning of a short fixed expression containing it. A viewer who hears the word should see at once why this exact word has this emoji.
Use the sentence only to settle the word's sense: 😴 on "asleep" in "the baby is finally asleep", but nothing on "sleep" in "let me sleep on it". Skip a word used only as praise or slang, like "sick" meaning great.
Anchor a thing to its own noun, an action to its own verb and a feeling to the word that names it: 😰 on "nervous" in "I felt so nervous", not on "felt": when a feeling is said with feel, be, get or seem and a describing word, the describing word is the anchor. For a fixed expression, use the word that completes its meaning.
Skip topic associations (a picture of the subject on a word that only belongs to it, like a ball on "weekend" in a talk about football), loose metaphors, generic reaction faces on neutral words, and anything whose tone would distract from the speaker. Never anchor a name or title, a number or a unit of measure, a filler or hesitation sound, or a function word.
A thing said to be absent, missing or not happening gets no emoji: nothing on "coffee" in "there was no coffee left".
At most one emoji per line. Pick every word that passes this test, and skip the rest.
Never mock or judge a person, a group, a religion or a culture.
For each pick write k, the word's id; w, the word exactly as written after that id; e, one emoji copied exactly from the list below, without skin-tone modifiers; s, its strength: 3 = depicts the word immediately, 2 = depicts its sense in this sentence or a fixed expression. Leave out anything weaker.
Returning no picks is normal.
Emojis: ${glyphs.join(" ")}
```

### Renders (deliverable 6) and the A and B pairs

`F = /private/tmp/claude-501/-Users-murtaza-Documents-dev-narriflow/f7147bb1-206f-4f6e-a8fc-276dea0eb55b/scratchpad/emoji-relevance/final-21`

- **Script fix found while reading the frames.** `caption-scene-real-render.ts` planned with no caption language, but the
  render worker and the Studio pass the project's (`frozenState.captionLanguage`, `clipInfo.captionLanguage`). Without
  it the plan used every language's word lists: "لو" (Arabic "if") was a minor word and could never be the hero, and
  the Urdu cues were grouped differently. Now `createRealPlanner` takes `captionLanguage` and the script passes the
  project language from `meta.json` (`caption-scene-real-render.ts`, `caption-scene-real-plan.ts`). The `meta.json`
  copies in `F` set `hi` for hi-matte and `en` for en-waveform (their stored meta had none; a real project always has
  one), which the tagger also reads.
- **Correction to the addendum's premise.** With the Urdu language, "magnets" is already the hero of "کرتے ہوئے
  magnets" before A; the "کرتے" hero in ticket 20's frames came from the script planning without a language. A does
  change real Urdu cues: "gorgeous" (was "display") and "لو" (was "viewfinder"). Both pairs are in `F`:
  `sheet-a-urdu-hero.png` (caption language `ur`, fixed picks; before = the same cues with emojis off, which are the
  pre-A roles by the plan hash) and `sheet-a-urdu-hero-script-without-language.png` (previous agent's pair, pre-A code
  vs A, no language: "کرتے" → "magnets", "comfortable", "swap", "gorgeous" become the hero). Looked at: after A every
  cue with an emoji has the emoji's word as its big word on Headline and Reveal (the "swap" tile catches a gap
  between cues in both).
- **B pair:** `F/sheet-b-faces-closeup.png` and `F/sheet-b-faces.png` (copies of `P/b`, see B).
- **Final renders**: fresh AI picks at Balanced (one tagger run per clip), the production render path, all 22 outputs
  `validateRenderOutput` ok. Electric, Headline and Reveal for each clip, plus Lyrics and Horizon for the Urdu clip.
  Sheets (one frame per emoji, "word → emoji name (strength)"; short windows are sampled 150 ms in, while their own cue
  shows): `F/sheet-urdu-direction.png`, `F/sheet-en-waveform.png`, `F/sheet-hi-matte.png`, `F/sheet-owner-halftone.png`.
  Drawn: 48 of 48 on Electric, Headline, Reveal and Horizon; Lyrics 8 of 10 (screen and selfies `no-room`, the known
  Lyrics limit).
- **Read as the owner** (pass = obvious why it is there, and on Headline and Reveal its word is the big word):

  | Clip | Pass | Fail and why |
  | --- | --- | --- |
  | urdu-direction (10) | 8 | 💡 on "features" in "missing features" (a bulb does not say features, and they are missing); 📷 on "camera" in "no telephoto camera" (the camera is said to be absent: negation) |
  | en-waveform (4) | 4 | none |
  | hi-matte (2) | 2 | none |
  | owner-halftone (4) | 3 | 🥹 on "feeling" in "I'm feeling emotional": the feeling is "emotional"; at caption size 🥹 reads as a smile, and A makes "feeling" the big word |

  17 of 20 pass. Hero match: every emoji word is its cue's hero on Headline, Reveal and Horizon (Electric highlights
  the spoken word, not a hero). Other notes: 📱 four times in the 75 s Urdu clip (iPhone ×2, display, screen), each
  defensible, together repetitive; non-face emojis take the template colour (green phones and sun on Headline), faces
  stay yellow.
- **Held emojis on the next cue (C, seen on hi-matte).** "glare" leaves 220 ms of its Headline/Reveal cue, so ☀️ holds
  to 400 ms after the word: 140 ms into the next cue, whose hero "बहुत" is then the big word under it. A frame sampled
  there reads as ☀️ on "बहुत". On the real clips 14 of 985 placed emojis are held, each 160 to 240 ms into the next cue.
  Ending the hold at the next cue would bring back a sub-250 ms flash, and classic and Dynamic placement does not see
  the next cue, so the rule stays as the coordinator set it; this is the trade-off to know.

### Files (this ticket)

- A: validators `caption-emphasis.ts` (+test); composition-plan `caption-emoji-plan.ts` (+test), `clip-composition-plan.ts`.
- B: caption-emoji `src/{colour,draw,encoding,art}.ts`, `src/art.test.ts`, `scripts/{face,build}.ts`, `src/generated/`;
  validators `caption-emojis.ts` (+test, palette); caption-scene `emoji/{drawing.ts,style.test.ts}`; web emoji
  `emoji-glyph.tsx` (+test), `use-caption-emojis.ts`.
- C: caption-scene `emoji/{layer.ts,layer.test.ts}`; web emoji `held-cue-boxes.ts` (+test), `held-cue-emojis.tsx`,
  `cue-caption-emojis.tsx`, `video-preview.tsx` (mount); media `caption-emoji-ass.test.ts` (feeder test).
- D: caption-emoji `src/{ai-vocabulary,index,index.test}.ts`; validators `caption-emojis.ts` (density, +test),
  `emoji-tagging.ts` (prompt); services `clip-emoji-tagging.ts` (+test), `clip-detection-persistence.test.ts`,
  `scripts/emoji-tagging-eval.ts`; web emoji `emojis-section.tsx`.
- Renders: media `scripts/caption-scene-real-render.ts`, `scripts/caption-scene-real-plan.ts` (caption language).
- Docs: `docs/adr/0022-caption-emojis.md` (scene rebuild sentence), `apps/web/content/docs/caption-styles.mdx` (faces
  keep yellow; the emoji's word is highlighted), spec section 7.

### Verification (final tree)

- `bun run typecheck`: 17/17. `bun run test`: 16/16 tasks; validators 1,365, composition-plan 200, caption-emoji 107,
  caption-scene 3,217, services 1,697 (1,567 PostgreSQL skipped), media 1,205 (1 skip), web 1,366, api 994 (60 skip),
  api-client 234, others pass; 0 fail. Web re-run after the docs edit: 1,366 pass.
- `bun run check:web-split`: passed. `bun run --cwd apps/api build:worker`: audit passed. `test:inventory`: 302 routes,
  0 problems. `openapi:check`: matches all 32 REST operations.
- `bunx biome check` on the 38 touched code files: clean.
