# 20 - Relevant emojis: honest demos, a relevance evaluation, a better tagger

**What to build:** The owner looked at the prototype page, the placement sheets and a real-clip
render and saw emojis that have nothing to do with the words (a rocket over "MORE MONEY", a flame
over "satisfying clap"). Those images were made with fixed test emojis, not with the AI. Make every
demo show what the product does, prove with real runs that the AI's picks are relevant to the word
they sit on, and improve the tagger where they are not. Rules: [../RULES.md](../RULES.md).

**Blocked by:** [19](19-scene-build-frame-rate.md)

**Status:** done

## Why the images misled

- `apps/media/scripts/caption-scene-real-render.ts --emojis N` anchors N emojis from a fixed list
  (`REAL_RENDER_EMOJIS`) on words spread evenly over the clip.
- The Studio prototype's fixture (`emoji/caption-emoji-fixture.ts`, `EMOJI_FIXTURE_IDS`) cycles ten
  fixed ids over its cues.
- The placement sheets (`.../scratchpad/emoji-layer/tools-v2/sheet.ts`) cycle a list of 20.

None of them called the tagger. The tagger itself was checked once on two short transcripts
(ticket 05), and nobody rendered its picks onto video.

## Deliverables

1. **Demos that tell the truth.**
   - `caption-scene-real-render.ts`: `--emojis ai` runs the real path (the same function the Studio
     route uses, `suggestClipEmojis` with the real tagger and density `balanced`) on the document's
     transcript and renders those picks. Keep `--emojis N` for benchmarks but make its fixed list
     word-relevant is not possible, so name it honestly in the help text ("test emojis, not AI").
   - The Studio fixture and prototype pages: the sample cues carry emojis that fit their words
     ("idea" a bulb, "money" a money bag, "team" people or clapping, "magic" sparkles, and fitting
     ones for the Urdu cues), chosen by hand, anchored on the word they illustrate. A viewer of the
     prototype should never see an emoji that does not fit the word under it.
   - The placement sheet tool: the sample cues get emojis that fit their text too (a small hand map
     per sample sentence), so future sheets do not mislead.
2. **A relevance evaluation that can be re-run.** A script in the repository (for example
   `packages/services/scripts/emoji-tagging-eval.ts`, run with Bun, reading the key the way the
   services do and never printing it) that:
   - takes a set of transcripts: the four real ones under
     `.scratch/motion-captions/out/real/{en-waveform,urdu-direction,hi-matte,owner-halftone}`
     (read their `document.json`) plus written ones you add under the script's fixtures folder to
     cover what creators make: business advice, a comedy story, a tech review, fitness, cooking,
     a motivational talk, a news-style explainer with a tragic passage, and the same range in
     Urdu, Hindi and Arabic (150 to 300 words each, with word times you synthesise);
   - runs the real tagger and the real density rule, and writes a report (Markdown and JSON) to
     the scratchpad: for every pick, the sentence, the word it sits on, the glyph, the design's
     catalog name, the strength; for every glyph the model returned that the catalog does not
     have, the glyph and its count; picks per minute at each density; cost and time;
   - is deterministic in everything except the model's answer, and never runs in the test suite.
3. **Judge the baseline honestly.** Read the report. For each pick decide: fits the word it sits
   on, fits the sentence but sits on the wrong word, or does not fit. Record the three rates per
   language. Then look at the picture, not only the table: render at least the four real clips
   with `--emojis ai` on a classic, a Dynamic and a Scene preset and make a sheet with one frame
   per emoji (the frame where the emoji is at rest and its word is on screen), saved to
   `/private/tmp/claude-501/-Users-murtaza-Documents-dev-narriflow/f7147bb1-206f-4f6e-a8fc-276dea0eb55b/scratchpad/emoji-relevance/`.
   The owner's test is simple: looking at a frame, is it obvious why that emoji is there?
4. **Improve the tagger until it passes that test.** Candidates to try, measured against the
   baseline with the eval script (keep what helps, drop what does not, and record the numbers):
   - The prompt (`packages/validators/src/emoji-tagging.ts`) asks for meaning over the literal
     word. The owner's expectation, and his other product Kalakar
     (`~/Documents/dev/kalakar/apps/video-worker/src/processor/transcription.ts`, about line 384:
     one call that returns a word-to-emoji map, and every occurrence of the word shows its emoji
     beside it) is more literal: the emoji illustrates the word it sits on. Find the balance: the
     emoji must be explainable from the word under it (a thing, an action, a feeling the word
     names), while idioms still get the sensible emoji ("this pizza is fire" is not a real fire).
   - The model sees glyphs only. Check whether giving each glyph its catalog name or two keywords
     (a longer cached prefix) improves relevance or reduces picks of designs that look different
     from the common emoji. Measure tokens and cost.
   - Unknown glyphs: measure how many picks are dropped because the catalog lacks the glyph. If it
     is more than a few percent, add a small, explicit fallback table from common emojis the pack
     lacks to the nearest design (🤝 is one), in `packages/caption-emoji` beside
     `emojiRefForGlyph`, with a test, and list for the owner which designs are missing.
   - Anchoring: when the model picks the right emoji but puts it on a neighbouring word, tighten
     the instruction or move the pick in code only if a rule is provably safe.
   - Density `balanced` on real speech: report picks per minute; say whether it feels right on the
     rendered clips.
   Two independent reviewers (Astra and Sol) are reading the prompt and the pipeline at the same
   time; their suggestions arrive after you start. Record your results so they can be compared.
5. **Tests.** Whatever rule changes in code (fallback table, anchoring) gets unit tests. The
   prompt's structure (the cached prefix stays a constant, the schema stays strict) keeps its tests.

## Acceptance

- [x] Deliverables 1 to 5. The report, the per-language rates before and after, the cost per
      1,000 words before and after, and the sheet paths are in Evidence.
- [x] `bun run typecheck`; tests of `packages/validators`, `packages/services`,
      `packages/caption-emoji`, `apps/media`, `apps/web`; `bun run --cwd apps/api build:worker`
      (the Worker still imports only the index); biome on touched files.

## Addendum (coordinator, 2026-11-26 15:05): the first run was interrupted, and Sol's review is in

A previous agent worked on this ticket for about 15 minutes and was stopped. It left, uncommitted:
`packages/services/scripts/emoji-tagging-eval.ts` and `emoji-tagging-eval/fixtures*.ts`, edits to
the Studio fixture (`emoji/caption-emoji-fixture.ts`), the prototype (`controls.tsx`) and
`emoji/caption-emoji-lines.test.ts`, and in the scratchpad
`.../scratchpad/emoji-relevance/{baseline.md,baseline.json,judgements.json,labels-baseline.json,label.ts,debug/}`.
Its last note: "Baseline: 82% fit the word, 15% right sentence/wrong word, 4% miss; 0.4% unknown
glyphs. Checking the two empty transcripts." Treat nothing as finished: read what is there, run
it, and continue.

Sol's independent review measured the same tagger more harshly (three runs each on 12 written
transcripts and the four real clips, scored before density): at Balanced density 77% of picks on
written transcripts and **52% on real clips** fit the exact word and the tone. Its data:
`.../scratchpad/relevance-sol/results.jsonl` and `real-results.jsonl`. The owner's verdict on what
he has seen so far is "very bad experience", and he said: choose the best approach, it does not
have to match Kalakar. The bar: looking at any frame, it is obvious why that emoji is there.
Judge on the real clips first; they are where the tagger is weakest.

Required changes (Sol's findings, accepted by the coordinator; test each against the baseline with
the eval script and keep what helps):

1. **The exact word is the unit of relevance.** The emoji must depict the word it sits on (a thing,
   an action, a feeling that word names); the sentence only settles the word's sense. A topic
   association alone earns no pick. Sol's tested wording (real clips 52% to 69%, written 77% to 81%;
   improve on it):
   > Pick only when the picture immediately depicts the highlighted word or the concrete meaning of
   > a short expression containing that word. The viewer should understand why this exact word gets
   > the emoji when they hear it.
   > Use the sentence to disambiguate the anchor. Put 😂 on "laughing" in "I almost died laughing";
   > skip "died" in "my phone died" unless the line explicitly says the battery ran out, then put 🔋
   > on "battery". Put 😋 on "delicious" or 🍕 on "pizza"; skip "fire" when it only means excellent.
   > Anchor a concrete object to its own noun, an action to its own verb, and a reaction to the word
   > that expresses it. For a fixed multiword phrase, use the word that completes its recognizable
   > meaning. Skip loose metaphors, topic associations, generic reaction faces and anything whose
   > tone would distract from the speaker. Never anchor a name, number, filler, hesitation sound or
   > function word.
   > Strength s: 3 = depicts the anchor immediately; 2 = depicts its contextually clear sense or
   > fixed expression; 1 = weak. Omit weak picks.
2. **Validate the anchor in code before ranking.** The model echoes the word it chose (add a field
   for the word's text; make the id an integer). Reject a pick whose echoed word does not match the
   keyed token after normalisation (`captionWordComparable`), and picks on numbers and known
   fillers. Enforce one accepted pick per source sentence in code (the baseline accepted several on
   33 sentence instances). A report whose ids are malformed (Sol saw `164:flashlight.`; three whole
   runs of one transcript counted as complete and showed nothing) is a failed chunk, so the retry
   applies; "complete" must never be true for a chunk whose picks were all rejected as malformed.
3. **Never show an emoji before its word is spoken.** `packages/caption-scene/src/emoji/layer.ts`
   and `timing.ts`: with under 200 ms left in the cue the emoji falls back to the cue's start (an
   anchor at 2.85 s showing at 1 s). Remove that fallback: show it at the word with the short
   entrance when at least a readable minimum remains (state the minimum, about 250 ms), otherwise
   let it hold briefly past the word within the cue's own tail if the cue's pieces are still
   painting, otherwise drop it. Update tests and re-run the placement tables.
4. **Bring the emoji closer to its word in time.** Today it holds until the cue's pieces stop
   painting (up to 6 s). An emoji that sits over later, unrelated words reads as random. Try: hold
   while its word and the rest of its own cue are on screen, but for cues that keep painting long
   after the word (stacks, long lines) end it about 1.5 s after the word ends. Judge on rendered
   clips which reads better, and keep the simpler rule that passes.
5. **Tie the emoji to the cue's emphasised word where there is one.** Caption styles already
   highlight a keyword per cue (`packages/validators/src/caption-emphasis.ts`, roles hero/body).
   When the model's anchor is the highlighted word, or the highlighted word is the natural anchor,
   the viewer sees the match at a glance. Test giving the model the candidate keywords (the words
   the emphasis scorer ranks highest per sentence) as preferred anchors, and report whether relevance
   on real clips improves.
6. **Re-anchoring after edits requires the same word.** `resolveCaptionEmojiAnchors`
   (`packages/validators/src/caption-emojis.ts`, about line 336) can move an emoji to a neighbour
   within 400 ms. An emoji re-attaches only to a word with the same normalised text; store the
   word's text with the entry if that is the cleanest way to know (schema change in
   `captionEmojiRefSchema`: an optional `word` used only for this check), or resolve it from the
   transcript; say which you chose. Dub captions: attach by time only when the plan cannot check a
   word (state the behaviour; do not invent translation matching).
7. **Density and the hook.** Default density becomes `light` unless your rendered clips show
   Balanced reads better (Sol: Light 80% / Balanced 77% / Expressive 75% on written, 53 / 52 / 46 on
   real). The hook rule only breaks ties between equally strong validated picks; it never keeps a
   weaker pick over a stronger one.
8. **Vocabulary stays glyph-only** (Sol tested names beside glyphs: input 4,139 to 7,263 tokens,
   relevance 77% to 74%). Fallback table only for true equivalents. List art the owner should add:
   bird, rickshaw, handshake came up; add what your runs show.
9. **A regression check the team can re-run.** Add a judge mode to the eval script: a second model
   pass that labels each pick A (depicts the word, right tone), B (right picture, wrong word), C
   (does not fit), D (fits, wrong tone), given the sentence, its neighbours, the anchor, the glyph
   and the design's name; validate the judge against the hand labels you and the earlier agent
   made (`labels-baseline.json`), report its agreement, and report picks per minute, malformed
   ids, serious-passage leaks and unknown glyphs beside the rates so an empty answer cannot score
   well. Not part of the test suite.

Target before you stop: on the four real clips, at the default density, at least 85% of rendered
emojis rated A by your own strict reading of the frames, with no C on any clip; and say plainly if
you could not reach it and why. A second reviewer (Astra) is running the tagger independently at
the same time; its findings so far: all three baseline runs put 👏 on "satisfying" in the phone
review, and a late anchor can show the sticker at the beginning of the cue.

## Evidence

Done 2026-11-26 by a second agent (the first was interrupted; its eval script, fixtures and Studio edits were
finished or repaired here). Nothing committed, migrated or deployed. Scratch roots below:
`S = /private/tmp/claude-501/-Users-murtaza-Documents-dev-narriflow/f7147bb1-206f-4f6e-a8fc-276dea0eb55b/scratchpad`
and `M = /private/tmp/claude-501/-Users-murtaza-Documents-dev-narriflow/1dca7421-53b1-49c5-945a-6be7a182d11a/scratchpad`.

### A. What the first agent left

- The eval script and four-language fixtures ran but graded word/sentence/miss by hand only; rewritten (below).
- The Studio fixture already had hand-chosen emojis; `controls.tsx` failed typecheck (`findLast`, lib es2023): fixed.
  "team" now gets 👥 busts-in-silhouette (it had 👏, which does not depict a team). The fixture stores each emoji's word.
- Its 82% baseline was lenient labels on mostly written transcripts; on the real clips its own labels gave 68%.

### B. Baseline (old prompt, reasoning none), three runs on the four real clips, graded by me

At Balanced: **36 of 60 rendered picks A (60%)** (runs: 55%, 65%, 60%). Sol measured 52%: same failure kinds, my grading
is slightly kinder on two items (🖥️ on "display", 🥂 on "pour one out"), so the numbers agree within grading noise.
Failure kinds: wrong word (😢 on "feeling" in "I'm feeling emotional", 🔔 on "get" in "get subscribed", 😮 on "kind" in
"kind of crazy"); topic links (🎬 on "moments", "set", "episodes"; 🚀 on "Star" of Star Wars; 🧱/🔨/✂️ on "tear it
down"; 💥 on "break them in half"; ✨/😎 on "glare"); function word (❓ on "Is"); 👏 on "satisfying". Data:
`S/emoji-relevance/b0/real-{1,2,3}.{json,md}`.

### C. The changes, each measured on the real clips (3 runs, my hand grades, `M/exp/results-*.jsonl`)

| Variant | Light A | Balanced A | Picks/min (B) |
| --- | --- | --- | --- |
| baseline prompt, none | n/a | 60% | ~6 |
| 1+2: word-unit prompt, echo, code checks (none) | 78% | 74% | 5.8 |
| + reasoning low | 92% | 92% | 2.6 |
| + "pick every word that passes", not "most lines get none" | 94% | 92% | 3.9 |
| + feeling rule (the describing word, not "feel"/"be") | 94% | 94% | 3.7 |
| + emphasis keywords as preferred anchors (item 5) | 84% | 82% | dropped |
| same as row 5 but reasoning none | 72% | 69% | dropped |

1. **Prompt** (`packages/validators/src/emoji-tagging.ts`, still one constant prefix + glyph list, 5,690 chars): Sol's
   word-unit wording, with my own examples (none taken from the eval clips): an emoji illustrates the one word it sits on;
   the sentence only settles the sense; 😰 on "nervous", not "felt" (the describing word is the anchor); skip topic
   links ("a camera on video, a trophy on season, a rocket on a title"), metaphors, generic faces; never a name, title,
   number, filler or function word; "Pick every word that passes this test, and skip the rest"; strength 3/2 only.
2. **Schema and validation.** Picks are `{ k: integer, w: string, e, s: 2|3 }` (word echoed before the emoji);
   `serious` ranges are integers. `acceptEmojiPicks(chunk, report, refForGlyph, languageCode)` drops a pick whose `w`
   is not the token's text (`captionWordComparable`), whose id is not a token, whose word is a number, a filler or a
   minor word (`captionWordIsNumber`, new beside `captionWordIsMinor`; `isFillerWord`), inside a serious range, or with
   an unknown glyph; keeps one pick per source sentence (strongest, first on a tie; tokens carry `line`). A report with
   picks none of which names a word of the chunk is invalid (null): the chunk fails and gets its retry, so `complete`
   is never true for it (Sol's `164:flashlight.` case is a test).
   Tagger reasoning: **low** (`EMOJI_TAGGING_MODEL`); it was the largest single gain.
3. **Never before the word** (`caption-scene/src/emoji/layer.ts`): the fallback to the cue's start is gone. An anchor
   leaving less than `CAPTION_EMOJI_MIN_HOLD_MS = 250` ms before its cue's last paint draws nothing (`no-time`); 250 to
   450 ms keeps the quick entrance. Test: no piece of any emoji ever starts before its word.
4. **Hold**: `CAPTION_EMOJI_MAX_HOLD_MS` 6,000 → **2,000 ms from the word's start** (about 1.5 s after a typical word
   ends), still ending earlier at the cue's last paint or the next emoji of the cue. Chosen over storing word ends in the
   plan: no new data, both renderers through the one function. On the rendered clips every window was 0.37 to 1.45 s
   (the cues end first), so the cap only binds on stacks and long lines.
5. **Emphasis keywords**: tried (each line's hero from `assignCaptionRoles` listed as preferred anchors): 82 to 84%,
   worse (it pulled picks onto "pain points", "carry", "لو"). Not kept.
6. **Re-anchoring needs the same word.** Chosen: store it. `captionEmojiRefSchema` gains optional `word` (1 to 200
   chars) and `captionEmojiRefOnWord(ref, text)` is the one way writers set it: the tagger (so import, the suggest
   route and Apply to all), the Studio's place and move. `resolveCaptionEmojiAnchors(entries, words)` now takes the
   entries; anchor words carry `text`; an entry with `word` takes only a word with that comparable text, its exact
   key's word included (a rewrite in place no longer draws the old emoji on the new word). Entries without `word`
   attach by time, by design. Dub captions: the check runs on the source words, then the emoji joins the dub cue live at
   that time (no translation matching). Readers updated: plan, Studio words/runs, selection carry-over, `studioEdits`
   equality. Tests in validators, composition-plan and web.
7. **Density and hook.** Default stays **Balanced** (coordinator, 2026-11-26). The hook rule is gone as a special case:
   strongest first, earliest on a tie, so an opening pick wins only a tie (`CAPTION_EMOJI_HOOK_SEC` deleted; test).
8. **Vocabulary glyph-only; fallback table not added**: unknown glyphs were 0 of 717 raw picks in the final run (1 of
   242 in the baseline: ⬛ on "black bars"). Art the owner could add, from all runs: auto-rickshaw 🛺 (got 🚕/🚗), handshake
   🤝, bird 🐦, electric/ceiling fan (got 🌀), a squat or leg-day figure (got 💪/🏋️). 🫓 flatbread exists; the model chose
   🥖 for naan once.
9. **Judge mode** (`--judge`, `--rejudge`, `--rescore`): gpt-6-luna reasoning medium grades A/B/C/D with the sentence and
   its neighbours, and flags serious sentences. Agreement with hand grades: on my 76 unique real-clip picks, **84% same
   A-or-not, 76% same grade, 2 false A**; on the first agent's 241 lenient labels 73% A-or-not, 1 false A. It is stricter
   than a careful reader on objects (📷 on "photos", ✈️ on "airport", 👔 on "suit"), so its A-rate is a lower bound;
   the written rates below trust its A's and use my grade for every pick it did not rate A.

### Final rates (`S/emoji-relevance/final/final-graded.md`, 3 runs × 32 transcripts)

| Set | Light | Balanced | Expressive | Picks/min L/B/E |
| --- | --- | --- | --- | --- |
| real clips (hand) | **100%** A | **97%** A, 1 D, 0 C | 97% A | 3.6 / 4.0 / 4.1 |
| written en | 99% | 99% | 98% | 3.9 / 5.1 / 5.4 |
| written ur | 98% | 97% | 97% | 4.4 / 5.3 / 5.6 |
| written hi | 94% | 89% (10% C) | 89% | 4.7 / 5.8 / 6.5 |
| written ar | 93% | 94% | 93% | 5.2 / 6.1 / 7.3 |

Same judge before and after, Balanced, judge grades only: real 62% → 92%, en 62% → 96%, ur 60% → 89%, hi 51% → 76%,
ar 54% → 89%. Malformed picks 7 of 717; unknown glyphs 0; failed chunks 0 of 96; serious leaks 0 (the tagger marked the
news passages; no kept pick sits in them). Hindi's remaining C's: fitness moves (🏃 on "jumping jacks", 🏋️ on "squats"),
💸 on "sheet", 🤩 on "talented", the idiom "ground split open" (💥/🕳️).

**Cost**: baseline $0.0034 per 1,000 words at list price before cache discounts (first agent's run), final **$0.0042**
(40,189 output tokens of which 25,024 reasoning over 14,559 words; 99.9% of input cached). Time: median 3.9 s per
clip transcript (one chunk), max 5.7 s; a 1,317-word transcript (3 chunks, the largest 500 words) 7.2 to 8.9 s wall,
no truncation at the 2,000 output-token cap.

### D. Truthful demos and real renders

- `apps/media/scripts/caption-scene-real-render.ts --emojis ai`: `withAiEmojis` runs `suggestClipEmojis` with the real
  tagger at `DEFAULT_CAPTION_EMOJI_DENSITY`, title and language from `meta.json`, key from env or `apps/api/.dev.vars`
  (never printed), writes `<out>/emojis.json`. `--emojis N` is documented as "test emojis, not AI". Two narrow services
  exports added (`./clip-emoji-suggestion`, `./clip-emoji-tagging`).
- Placement sheet tool (`S/emoji-layer/tools-v2/sheet.ts`, old copy `sheet.before-ticket20.ts`): a hand map from
  sample words to designs; a cue takes an emoji only on a mapped word, otherwise none (`placementRun` gained an optional
  `emojiFor`). Sheet: `S/emoji-relevance/final/placement-sheet-ltr-9x16.png` (looked at: 💰 on "savings", 🤖 on "AI",
  📈 on "revenue", 😋 on "taste", 💥 on "SMASHED").
- Real clips, one fresh AI run each, Electric (classic), Headline (Dynamic), Reveal (Scene): `urdu-direction` and
  `hi-matte` on their own source (`hi-matte` is a Hindi transcript of the same 76 s upload); `en-waveform` (5,211 s
  YouTube source) and `owner-halftone` have no local video, so their transcripts were re-timed to 0 onto that source
  (other footage, their own words and timing). 12 renders, all `validateRenderOutput` ok, **11 of 11 AI emojis placed on
  every preset, 0 dropped, 0 not drawn**. Sheets (one frame per emoji at rest, caption visible, label
  "word → emoji name (strength)", read by me): `S/emoji-relevance/final/sheet-{urdu-direction,en-waveform,owner-halftone,hi-matte}.png`.
  By the tagger: 11 of 11 A (📸 on "لو" in "selfie لو", take a selfie, is the borderline one). **Target met**: ≥85% A,
  no C. By the picture: on Headline the template turns face emojis green and 🤔 on "confusing", 🥳 on "jolly" and 😌 on
  "comfortable" read as sick faces (30 of 33 tiles clearly A). On Electric/Reveal the magnet in yellow and blue reads
  close to a letter U. Both are the palette (D6), not relevance: the owner may want faces to keep a skin-yellow body.
- Density on these clips: Light and Balanced give almost the same picks (the tagger is sparse now: 1 to 5 per clip).
  Windows on Electric are short (0.37 to 0.9 s) because its cues are short.

### Timing changes: placement and parity

- Placement suite and tables (84 styles × 3 canvases, `M/tables/table.ts`, [cues, no-room, problems, no-time]):
  demo fake `[1221,4,0,0]`, demo HarfBuzz `[1221,5,0,0]` (unchanged); fast fake `[3024,3,0,1611]`, fast HarfBuzz
  `[3024,10,0,1608]` (before: 64 and 64 no-room, and the late ones were shown from the cue's start). The fast run is
  150 ms words back to back, so about half its anchors leave under 250 ms. The suite now counts `no-time` apart from
  `no-room`; problems 0.
- Parity: the browser check was **not re-run** (coordinator: no dev server). Both renderers call the same
  `placeCaptionEmojis`/`buildCaptionEmojiPieces` with inputs from the shared feeders; `caption-studio-parity`,
  `caption-emoji-ass`, `caption-inserted-scene` and `caption-scene-frame-rate` (Studio builder vs export ASS at 24 to 60
  fps) pass. The frame-rate test's flame moved to the cue's first word ("believe" at 120 ms a word now draws nothing on
  either side; a new test asserts both sides draw nothing).

### Files

- validators: `emoji-tagging.ts` (+test), `caption-emojis.ts` (+test: `word`, `captionEmojiRefOnWord`, resolver, hook),
  `caption-emphasis.ts` (`captionWordIsNumber`), `transcript-tagging.ts` (token `line`), `studio-edits.ts` (equality).
- services: `clip-emoji-tagging.ts` (+test), `clip.service.ts` (resolver call), `package.json` (2 exports),
  `scripts/emoji-tagging-eval.ts`, `scripts/emoji-tagging-eval/fixtures*.ts`.
- composition-plan: `caption-emoji-plan.ts` (+test). caption-scene: `emoji/layer.ts`, `layer.test.ts`,
  `placement.test.ts`, `placement-support.ts`. media: `scripts/caption-scene-real-render.ts`,
  `src/caption-scene-frame-rate.test.ts`. web: emoji `caption-emoji-fixture.ts`, `caption-emoji-runs.ts`,
  `caption-emoji-words.ts`, `use-caption-emojis.ts`, tests `use-caption-emojis.test.tsx`, `emoji-chips.test.tsx`;
  `app/prototype/caption-emoji-controls/controls.tsx`. Docs: `caption-styles.mdx` unchanged in the end (default stays
  Balanced).

### Verification

- `bun run typecheck`: 17/17. `bunx biome check` on the 32 touched files: clean.
- Tests: validators 1,357 pass; services 1,696 pass (PostgreSQL skipped); composition-plan 199; caption-scene 3,216;
  caption-emoji 104; api-client 234; apps/web 1,363; apps/media full run 1,200 pass, 1 skip, 1 fail (the frame-rate
  test above), then fixed: that file 10 pass (full suite not re-run); apps/api 1,013 pass, 1 fail in `scripts/gates/deployed-http-acceptance.test.ts` (untouched by
  this effort, fails twice the same way; not mine).
- `bun run --cwd apps/api build:worker`: audit passed (only `caption-emoji` index modules).
