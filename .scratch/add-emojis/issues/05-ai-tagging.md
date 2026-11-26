# 05 - AI tagging: import hook and the Studio suggest route

**What to build:** The tagger, its use at import, and the route the Studio calls. Rules:
[../RULES.md](../RULES.md). Spec D8.

**Blocked by:** [02](02-contracts-and-plan.md), [03](03-import-option.md),
[01b](01b-art-outline-and-contract.md) (for `emojiRefForGlyph` and `CAPTION_EMOJI_AI_GLYPHS`)

**Status:** done

## Areas

`packages/services` (new `clip-emoji-tagging.ts`, its prompt and schema in
`packages/validators/src/emoji-tagging.ts`, the preparation and persistence hooks),
`apps/api/src/domains/clips/{routes,admission}.ts`, `packages/api-client/src/clips`.
These are critical paths (selection preparation, clip creation): read before you write, and keep
the change small.

## Deliverables

1. **Tagger** `tagCaptionEmojis({ words, language, title?, signal, deadline })` in
   `packages/services/src/clip-emoji-tagging.ts`, modelled on `clip-filler-tagging.ts` and
   `packages/validators/src/filler-tagging.ts`: chunked keyed words (reuse the filler chunker and
   its key-ambiguity rule), bounded concurrency, a time budget, streamed or not as the filler
   tagger does, never throws (a failed chunk yields no picks). Model `OPENAI_TEXT_MODEL` with
   reasoning none, through `requestOpenAiText` / the same client the filler tagger uses.
   - System prompt: a constant prefix that lists `CAPTION_EMOJI_AI_GLYPHS` so provider prompt
     caching applies; the keyed words go last. Rules from spec D8. Strict JSON schema
     `{ picks: [{ k: string, e: string, s: 1 | 2 | 3 }] }`.
   - Server mapping: `emojiRefForGlyph(e)`; unknown glyph or unknown key dropped. Output
     `{ key, ref, strength }[]`.
   - The Worker bundle may import `@narriflow/caption-emoji/index` only, never the art. Verify with
     `bun run --cwd apps/api build:worker` and record the bundle size change.
   - Larger chunks than filler tagging are fine if quality holds (emoji output is sparse); state
     the chunk size you chose and why. Log cost the way the other text jobs do.
2. **Import hook** (insertion points from the design review; verify them):
   - `clip-selection-preparation.ts`: when `pack.addEmojis`, run the tagger beside
     `tagSelectionFillers` in the same `Promise.all` and under the same deadline (about lines
     96-124); carry the result in the frozen capsule as `editor.emojiPicks` (keyed by Word Key);
     drop it first in the size-fit fallback; pass it through `capsule()` so the final hash recheck
     matches. The capsule's schema is in `packages/validators/src/clip-selection.ts`
     (`editor` is a strict object).
   - `clip-detection-persistence.ts` (`prepareDetectedClipSeed`, `buildDetectedClipRows`, about
     lines 102-151): for each clip, keep the picks whose word is kept in the clip, run
     `selectCaptionEmojiPicks` on edited time (the clip's `deletedRanges` are computed there) with
     density `balanced`, and write `studioEdits.captionEmojis` into the clip's initial editor
     document. Set `captionPreset.emojis = pack.addEmojis` on the clip's resolved preset, whatever
     the brand preset says.
   - A tag failure or a dropped capsule field means clips without picks; the import never fails
     for it. Check the replay path (`execution-selection-restore.ts`) still validates.
3. **Studio route** `POST /projects/:projectId/clips/:clipId/emojis/suggest` with body
   `{ density }`, modelled on title suggestions (`clips/routes.ts` about 79-92, `admission.ts`
   line 7: `kind: "project"`, `capability: "processing.consume"`, actor rate 30, prefix
   `clip-emoji-suggest`). The service loads the clip's current editor document, tags its kept
   caption words, applies `selectCaptionEmojiPicks`, and returns `{ emojis: Record<WordKey, ref> }`.
   It does not write the document: the Studio applies the result as an edit. Typed errors like the
   title route (`openai_not_configured`, `openai_rate_limited`, a failure code). A clip with no
   words returns an empty map without calling the model.
   Export a service function `suggestClipEmojis` that ticket 11 can reuse for other clips.
4. **api-client**: `clips` mutation for the route, typed.
5. Tests: tagger mapping and failure behaviour with a stubbed model client; preparation with the
   flag on and off (capsule carries or omits picks; hash consistent); row building (picks filtered
   to kept words, density applied, preset switch set); the route's admission entry
   (`bun run --cwd apps/api test:inventory`) and handler.
6. If an OpenAI key is available in `apps/api/.dev.vars`, run the tagger once against a real
   transcript from the repo's fixtures in English and once in Urdu or Arabic through a small script
   in the scratchpad, and paste the picks into Evidence (do not print the key). If no key or the
   call fails, say so.

## Acceptance

- [x] Deliverables 1 to 5; 6 attempted and reported.
- [x] `bun run lint`, `bun run typecheck`, `bun run test`, `test:inventory`, `build:worker` (lint fails only in files outside this ticket; see Evidence).
- [x] Bundle size change and chunk timing recorded.

## Evidence

Implemented 2026-11-26. Nothing committed, migrated or deployed.

### Files

- `packages/validators/src/emoji-tagging.ts` (new): system prompt builder, strict schema, chunker
  (the filler chunker at 500 words plus a one-line title), `acceptEmojiPicks`, `collectEmojiPicks`
  (filler key-ambiguity rule on Word Keys), capsule schema `captionEmojiPicksSchema`, route body
  `suggestClipEmojisSchema`. Exported from the index and `api/clips`.
- `packages/validators/src/filler-tagging.ts`: `chunkTranscriptForFillerTagging` takes an optional
  `maxWords` (default 250, unchanged output).
- `packages/validators/src/clip-selection.ts`: `editor.emojiPicks: captionEmojiPicksSchema.nullable()`.
- `packages/validators/src/error-messages.ts`: `clip_emoji_suggestion_failed` copy.
- `packages/services/src/clip-filler-tagging.ts`: the streamed request is now the exported
  `requestTaggingReport(config, model, { system, user, schemaName, schema })`, with an optional
  caller `signal` and `rateLimited` on a final 429. Filler requests are byte-identical.
- `packages/services/src/clip-emoji-tagging.ts` (new): `tagCaptionEmojis`.
- `packages/services/src/clip-emoji-suggestion.ts` (new): `suggestClipEmojis` (one clip's document,
  for the Studio route and ticket 11), `clipEmojiTaggingWords`, `clipEmojiSuggestionFailure`.
- `packages/services/src/clip-selection-preparation.ts`: `tagSelectionEmojis` beside
  `tagSelectionFillers` in the same `Promise.all` and deadline; `fitSelectionTags` (drop emoji
  picks first, then filler tags); `capsule()` takes the picks so the final hash recheck matches.
- `packages/services/src/clip-selection-runtime.ts`: wires `emojiTagger`.
- `packages/services/src/clip-detection-persistence.ts`: seed carries `emojiPicks`;
  `captionPreset.emojis = pack.addEmojis`; rows get `studioEdits.captionEmojis` from picks on the
  clip's kept words at Balanced.
- `packages/services/src/clip.service.ts`: `clipService.suggestEmojis`; new failure code
  `clip_emoji_suggestion_failed`; the shared `openai_not_configured` / `openai_rate_limited` safe
  messages now say "AI suggestions" (they said "Title suggestions").
- `packages/services/package.json` + `bun.lock` (one line): depends on `@narriflow/caption-emoji`.
- `apps/api/src/domains/clips/{routes,admission}.ts`: `POST /projects/:id/clips/:clipId/emojis/suggest`.
- `packages/api-client/src/clips/mutations.ts`: `clipCommands.suggestEmojis`.
- Tests: `emoji-tagging.test.ts` (validators), `clip-emoji-tagging.test.ts`,
  `clip-emoji-suggestion.test.ts`, `clip-selection-emoji-tagging.test.ts`, additions to
  `clip-detection-persistence.test.ts`, `routes.test.ts`, `admission-tables.test.ts`,
  `clips.test.ts`; `emojiPicks: null` added to three existing capsule fixtures.

### Decisions inside the ticket

- `k` is the chunk-local word id ("17"), as in filler tagging, not the millisecond Word Key: fewer
  tokens, no copying errors. The server maps it to the Word Key.
- The schema has `serious: [{ from, to }]` before `picks`. With the rule in the prompt only
  (three drafts, six runs per language), the Urdu illness passage got 😢/😷/🤒/🙏 in 3 of 6 runs
  and the English accident passage 😢 in 1 of 6 (plus a ⚠️ on its lead-in line once). With the
  ranges, 0 of 6 runs tagged a serious passage, and the server drops any pick inside a listed range.
- Skin tone from the model is dropped (the AI never chooses one); `emojiRefForGlyph` still maps
  gendered sequences. Phrase badges are not in the vocabulary.
- Cut and caption-masked words are not offered to the model on the Studio route. At import the
  whole processing range is tagged (cuts are per clip and not known yet); row building keeps only
  picks on each clip's kept words.

### Final prompt rules (system prompt before the vocabulary)

```
You add emojis to the captions of a short video, in any language.
You get the video's title and its transcript as numbered words "id:word", one sentence per line.
First list in "serious" every passage about a serious subject: death, an accident, injury, illness or hospital, grief, violence, abuse, disaster, war, crime and similar, in any language.
A passage runs from the id of its first word ("from") to the id of its last word ("to") and covers every line about that event, including how the speaker felt and wishes or prayers for the people in it.
Serious passages get no emoji at all, not even a sad, sick, caring or praying one.
Pick a word only when an emoji adds something a viewer gets at a glance: a feeling, a reaction, a thing, an action or a place the sentence is about.
Choose by what the sentence means, not by the literal word: "this pizza is fire" is 😋 or 🤤, not 🔥 for a real fire; "I almost died laughing" is 😂, not 💀 for death.
At most one emoji per line, never two. Most lines get none: skip neutral, connecting or abstract lines, and keep only the moments where an emoji clearly helps.
Put the emoji on the word that carries the meaning. Never on a name, a number, a filler or hesitation sound, or a short function word.
Never mock or judge a person, a group, a religion or a culture.
Strength s: 3 = the emoji says exactly what the moment means; 2 = clearly fitting; 1 = fitting but optional.
k is the word's id as written. e is one emoji copied exactly from the list below, without skin-tone modifiers.
Returning no picks is normal.
Emojis: <the 1,008 single-design glyphs>
```

User message: `Title: <one line, max 200 chars>\nLanguage: <code>\nTokens:\nS0: 0:word 1:word ...`.

### Live check (deliverable 6)

Script: `/private/tmp/claude-501/-Users-murtaza-Documents-dev-narriflow/f7147bb1-206f-4f6e-a8fc-276dea0eb55b/scratchpad/emoji-ai/run.ts`
(and `bench.ts`), key read from `apps/api/.dev.vars`, never printed; model API only. No usable
transcript fixture exists in the repo, so I wrote two: English (266 words, a Lisbon trip vlog with
a car-accident passage) and Urdu (187 words, a village wedding with a grandmother in hospital).

Final prompt, three runs each, `balanced` result (all picks survive density on these fake timings):

- English: `🤯@blew 🥧@pastel 😵@lost 😂@laughed 🌅@sunset ✈️@flights 🔋@died 💃@danced 😩@exhausted ✈️@Tokyo 🍜@ramen`;
  `🤯@blew 😋@eat 🧭@lost 😂@laughed 🌅@sunset ✈️@flights 🔋@died 💃@danced 😩@exhausted 🍜@ramen`.
  "My phone died twice" got 🔋, not 💀. The accident, injury and ambulance lines got nothing in
  all runs.
- Urdu: `🎉@شادی 😋@مزیدار 😂@ہنس 🎆@آتش 🥁@ڈھول 🌧️@بارش 😊@مزہ 🌼@خوبصورت 👍@لائک 🍔@فوڈ`;
  `😋@مزیدار 💃@ناچنے 🎆@آتش 🥁@ڈھول 🌧️@بارش 🌼@خوبصورت 👍@لائک 🍔@فوڈ`.
  The illness, hospital and prayer lines got nothing in all runs.

Judgement: relevant and sensible in tone; meaning over the literal word works in both languages.
Weak spots: 🍔 for Lahore street food (a burger, not desi food); ✈️ twice in English (the 10 s
repeat rule thins it on real timing). Not as sparse as "most lines get none": about one pick per
17-25 words, 40-60% of lines. Balanced (2.5 s) and Light (5 s) do the thinning; Expressive can
only show what the model offered.

### Cost and time (500-word chunks, concurrency 16, gpt-6-luna, reasoning none)

| | 500-word chunks | 250-word chunks |
| --- | --- | --- |
| 2,128 words: chunks | 5 | 9 |
| Wall time | 3.1 s and 3.8 s (two runs) | 2.7 s |
| Per-chunk p50 | 3.0-3.3 s | 2.0 s |
| Input tokens / 1,000 words | 12,140 (about 7,800 the cacheable prefix) | 18,370 |
| Output tokens / 1,000 words | 870 | 890 |
| Picks | 126-127 | 122 |

- Chosen: 500 words. Same picks at a third fewer input tokens; latency stays far inside the 45 s
  preparation budget. The first uncached request took up to 6.8 s; later ones hit the cache
  (4,470 of 4,473 input tokens cached).
- Vocabulary prefix: about 3,300 tokens (4,929 characters of prompt).
- Price at list rates ($0.10 / $0.50 per 1M): about $0.0017 per 1,000 words before cache
  discounts, about $0.05 for a 3-hour source (about 27,000 words, 54 chunks, estimated 13-15 s
  wall in 4 rounds of 16). A 60 s Studio clip (about 160 words) is one request, about 2 s.
- Logged as `clip_emoji_tagging` (preparation) and `clip_emoji_suggestion` (route) with chunks,
  tagged, failed, skipped, tokensUsed, pick counts and elapsed ms, like `clip_filler_tagging`.

### Worker bundle

`bun run --cwd apps/api build:worker`: audit passed. Compared with the build just before this
ticket (bundle metafile, bytes in output): +137,098 bytes from this ticket's inputs, of which
117,738 is `caption-emoji/src/generated/index-data.ts`, 1,835 `caption-emoji/src/index.ts`, 88
`geometry.ts`, and about 17.4 kB the new and changed service, validator and route modules. The
only `caption-emoji` modules in the bundle are `index`, `geometry` and `index-data`; no art shard.
`index.js` 11,894,073 to 12,035,719 bytes (+141,646, which includes other tickets' concurrent edits).

### Replay

`execution-selection-restore.ts` decodes the capsule and re-encodes it with only `contentPack`
and `parent` replaced, so `editor.emojiPicks` round-trips unchanged; the restore hash check holds.
The selection capsule test round-trips picks byte-identically, and a capsule missing the field
fails the strict editor schema (pre-production policy: no fallback).

### Verification

- `bun run typecheck`: 17 of 17 tasks successful.
- `bun run lint`: 170 errors, 274 warnings, none in this ticket's files (the listed diagnostics
  are in untracked `.scratch/caption-templates-v2/**`, the set earlier tickets recorded at 168).
  `bunx biome check` on all 28 files this ticket touched: no diagnostics.
- `bun run test --continue`: 15 of 16 tasks pass (validators 1343, services 1668, api 991,
  api-client 234, media 1170, web 1257, ...). `@narriflow/caption-scene` failed 2 tests named
  `dbg` in `src/zz-dbg.test.ts`, another agent's temporary file, since removed. Re-run
  `bun run --cwd packages/caption-scene test`: 3103 pass, 0 fail.
- New and changed suites: validators `emoji-tagging.test.ts` + `filler-tagging.test.ts` 39 pass;
  services `clip-emoji-tagging` 6, `clip-emoji-suggestion` 4, `clip-selection-emoji-tagging` 5,
  `clip-detection-persistence` 14, selection/filler/restore suites 51, all pass; api
  `admission-tables` + `domains/clips` 78 pass; api-client `clips` 5 pass.
- `bun run --cwd apps/api test:inventory`: 302 routes, 0 problems.
- `bun run --cwd apps/api openapi:check`: matches all 32 REST operations (the route is first-party).
- `bun run --cwd apps/api build:worker`: audit passed (numbers above).
- `bun run check:web-split`: passed.
