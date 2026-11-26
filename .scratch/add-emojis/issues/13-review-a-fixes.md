# 13 - Fixes from review A (data, AI, pipeline)

**What to build:** The defects and quality findings an independent Opus High review found in the
data model, plan, AI and pipeline. Rules: [../RULES.md](../RULES.md).

**Blocked by:** [05](05-ai-tagging.md), [11](11-apply-to-all.md), [12](12-parity-and-fixes.md)

**Status:** done

## Areas

`packages/validators` (`caption-emojis.ts`, `emoji-tagging.ts`, `filler-tagging.ts`,
`clip-selection.ts`), `packages/composition-plan`, `packages/services` (emoji tagging, suggestion,
detection persistence, clip service), `apps/api/src/domains/clips`. Each fix needs a test that
fails before it.

## Defects

1. **Apply to all has no rate limit but now spends model calls.**
   `apps/api/src/domains/clips/admission.ts` (the `apply-caption-preset` entry). With
   `captionPreset.emojis: true` every call tags every clip that has no emojis, including clips
   where the model found nothing, so a loop of calls is unbounded spend. Add an actor rate limit
   in the style of the suggest route (prefix `clip-caption-preset-apply`, limit 30). Read
   `apps/api/src/http/request-policy.ts` to see what a refused request returns and whether
   `deferRateRefusal` (or the existing equivalent) fits; the preset apply without emojis is cheap
   and should not become harder to use. `bun run --cwd apps/api test:inventory` must pass.
2. **Capsules prepared before this change do not decode.**
   `packages/validators/src/clip-selection.ts`: `editor.emojiPicks` is nullable but has no default,
   so a stored capsule without the key throws, finalization fails as `selection_result_invalid`
   and paid window results are discarded. Make it `.nullable().default(null)`. This is schema
   design, not a compatibility branch. Restore of an old capsule still refuses (it re-encodes with
   defaults filled in and the hash differs); do not work around that, record it as a deploy note:
   no selection may be in flight when this is deployed. Correct the wrong sentence in ticket 03's
   Evidence ("nothing re-encodes a decoded capsule").
3. **A zero-length caption layer rejects the whole export** (older than the emoji work; the owner
   allowed fixing existing code where it makes the product better, and this blocks real Urdu
   clips). `packages/composition-plan/src/clip-composition-plan.ts`, `finalizeCaptionLayers`
   (about lines 2893-2899): each cue's end is clamped to the next cue's start, so a zero-length
   word followed by a word at the same start, or two utterances that start together, gives
   `[t, t]`, and `composition-ffmpeg-adapter.ts` (about 682) throws
   `invalid_clip_composition_visual_layers`. Fix: after roles, blocks and emojis are attached,
   drop caption layers whose `activeRange.endSec <= activeRange.startSec`, at both return points.
   An emoji on a dropped cue is dropped with it. Keep `cueIndex` values as they are. Then run the
   caption-scene, composition-plan, media and web suites to confirm Scene Styles, the Studio and
   subtitle files accept a gap in cue indices; if subtitle files should still contain the word,
   say what they do now and leave that behaviour unchanged. Tests: the three probe cases from the
   review (words a(1,1), b(1,1), c(1.5,2) at one word per cue; two utterances both starting at
   1.0; a normal clip unchanged).
4. **Overlapping speakers lose a re-timed emoji.**
   `packages/validators/src/caption-emojis.ts`, `resolveCaptionEmojiAnchors` (about line 293):
   `words.find(...)` takes the first utterance whose span holds the key and searches only its
   words. Collect every utterance whose span holds the key and search their words together.
   Test: utterance 0 spans 1.0-3.0 s, utterance 1 has a word at 2.05 s, stored key `2100`.
5. **Text symbols block the added emoji.**
   `packages/composition-plan/src/caption-emoji-plan.ts` (about line 80): the typed-emoji check
   counts `™ © ‼ ♥` because `\p{Extended_Pictographic}` includes text-presentation symbols.
   Require emoji presentation (U+FE0F after the base, or `\p{Emoji_Presentation}`). Check whether
   `isCaptionEmojiCluster` in `packages/caption-fonts` is the right place to change or whether
   other callers depend on its current meaning; if they do, add the narrower check beside it.
   Tests: "Brand™", "©2024", "love ♥" take an emoji; "fire 🔥", "ok ❤️" do not.
6. **The first word of a clip loses its pick at import.** `clip-timing.ts` (about line 552) clamps
   the start of a word that straddles the clip start, which changes its Word Key, and the import
   matches pick keys exactly. Verify by test, then fix so the pick is matched to the word (match
   before the clamp, or resolve with the same nearest-time rule the plan uses).
7. **Create-from-range ignores the import's emoji choice.** `packages/services/src/clip.service.ts`
   (about line 1738) uses `runDefaultCaptionPreset` without the `addEmojis` override, so a brand
   preset with `emojis: true` gives clips from library search an Emojis switch that is on with
   nothing drawn. Apply the same rule as detected clips when the project's Content Pack is at hand
   (`captionPreset.emojis = pack.addEmojis`); if it is not available there without a new query,
   set `emojis: false` and say so.
8. **Abort on client disconnect may be a no-op.** Both emoji routes pass `c.req.raw.signal`.
   Check whether the Worker's compatibility flags (`apps/api/wrangler*`) include
   `enable_request_signal`. Do not change the Worker's flags in this ticket (that is a deploy
   decision); report what you found and make sure nothing depends on the abort for correctness
   (the deadline must bound the work on its own).

## Quality

9. One function for "kept words with edited start" instead of `captionEmojiPickWords`
   (`clip-detection-persistence.ts`) and `clipEmojiTaggingWords` (`clip-emoji-suggestion.ts`),
   with masking optional.
10. One small factory for "read key, check admission, closure over `tagCaptionEmojis`" used by
    `suggestEmojis` and the apply service's `prepareSuggester`.
11. Neutral names where emoji tagging reuses filler-tagging pieces
    (`fillerTaggingUtterances`, `FillerTaggingChunk`, `chunkTranscriptForFillerTagging`,
    `FILLER_TAGGING_DEFAULTS` used by both): rename the shared pieces so both taggers read
    correctly, and move them to a neutral module if that is cleaner. Filler tagging's behaviour and
    request bytes must not change (its tests prove it).
12. The suggest route returns an empty map when the transcript is missing. Return the typed error
    the clips domain already uses for a transcript that is not ready (find it; do not invent a
    code unless none exists), and make sure the Studio shows it (the Studio's section already
    handles typed errors; check the code is mapped to a message in
    `packages/validators/src/error-messages.ts`).

## Acceptance

- [x] Items 1 to 12, each with its test or its recorded finding.
- [x] `bun run typecheck`, `bun run test`, `bun run --cwd apps/api test:inventory`,
      `bun run --cwd apps/api openapi:check`, `bun run --cwd apps/api build:worker`,
      `bun run check:web-split`, biome on touched files.

## Evidence

Finished 2026-11-26 by a second agent: the first stopped mid-ticket with no Evidence. Each item
was re-read against the code and its test run; "proven" means the test fails with the fix removed.
Nothing committed, migrated or deployed.

1. **Rate limit on Apply to all.** Done by the first agent, proven here. `clips/admission.ts`:
   `rate: { scope: "actor", prefix: "clip-caption-preset-apply", limit: 30 }, deferRateRefusal: true`;
   `routes.ts` enforces the recorded limit (`enforceRecordedRateLimit`) only when
   `captionPreset.emojis` is on, so a plain preset apply is never refused. An apply without emojis
   still counts toward the window. Test `routes.test.ts` "an exhausted or unavailable limiter refuses
   only an apply that tags emojis" (429 `rate_limited` / 503 `mutations_unavailable` with emojis,
   200 without); it fails with the enforce line removed. `admission-tables.test.ts` pins the entry.
2. **Old capsules decode.** `clip-selection.ts`: `emojiPicks: captionEmojiPicksSchema.nullable().default(null)`.
   New test `clip-selection-input.test.ts` "a capsule frozen before emoji picks existed decodes with
   no picks": hand-written bytes without the key decode to `emojiPicks: null`; fails without
   `.default(null)`. Ticket 03's Evidence already carries the corrected sentence (restore
   re-encodes, so an old capsule's restore refuses). **Deploy note: no selection may be in flight.**
3. **Zero-length caption layers.** `finalizeCaptionLayers` drops a layer whose
   `activeRange.endSec <= startSec` at both return points, after emojis, roles and blocks are
   attached (an emoji on it goes with it). Deviation, agreed for ticket 15: the cues after it are
   renumbered (`numberCaptionCues`), not left with a gap, because ticket 15 needs `cueIndex` unique
   and ordered and one rule (`cueIndex` = the cue's place in the target) serves both. Tests
   `clip-composition-plan.test.ts` "a caption cue that can never show is not planned": a(1,1)
   b(1,1) c(1.5,2) gives cues `b`, `c` numbered 0, 1; two utterances at 1.0 keep only `yo`; a
   normal clip keeps every cue and its emojis. Normal plans are byte-identical: a hash over 230 plans
   (115 presets × English two-speaker and Urdu, 9:16 + 1:1 + 16:9, a cut, three emojis) was
   `e4e2633d…` before and after both this item and ticket 15 item 1. Subtitle files: the dropped
   cue's word is not in them (it had no time on screen); `deriveCaptionCues` gives `["b", "c"]`.
4. **Overlapping speakers.** `resolveCaptionEmojiAnchors` collects every utterance whose span holds
   the key. Test `caption-emojis.test.ts` "overlapping speakers": key 2100 resolves to the word at
   2.05 s of utterance 1 inside utterance 0's 1.0-3.0 s span; the first-utterance-only search finds
   nothing within 400 ms.
5. **Text symbols.** New `isCaptionEmojiPresentation` beside `isCaptionEmojiCluster` in
   `caption-fonts/src/graphemes.ts` (`\p{Emoji_Presentation}`, U+FE0F or a keycap, never U+FE0E);
   `isCaptionEmojiCluster` keeps its meaning for its other callers. `caption-emoji-plan.ts` uses the
   new check. Test `caption-emoji-plan.test.ts`: `Brand™`, `©2024`, `♥`, `‼` take an emoji; `🔥`,
   `❤️`, `✌🏽`, `🇵🇰`, `#️⃣` do not.
6. **First word at import.** `clip-detection-persistence.ts` `clipEmojiPicks`: a pick on a source
   word that straddles the clip start moves to the clamped key (`captionWordKey(clipStartSec)`).
   `buildDetectedClipRows` takes the capsule's `utterances` for this. Test "a pick on the word that
   straddles the clip start is kept": `So` (9.8-11) clamped to 10.0 keeps its pick as `10000`.
7. **Create from range.** `runDefaultCaptionPreset(brandSnapshot, contentPack)` sets
   `emojis = contentPack.addEmojis ?? false`; `createClipFromRange` passes the run's Content Pack
   (`select: { captionPreset, addEmojis }`, no extra query). This item had left typecheck red
   (`captionPreset` from Prisma is a string); the parameter is now
   `{ captionPreset?: string | null; addEmojis?: boolean }`. Test "a clip added later to the run
   follows the run's Add emojis, not the brand style".
8. **Abort on disconnect.** `apps/api/wrangler.jsonc` flags: `nodejs_compat`,
   `disallow_importable_env`; no `enable_request_signal`, so `c.req.raw.signal` never aborts on the
   Worker today. Flags unchanged (deploy decision). Nothing depends on the abort: the suggest route has
   a 30 s deadline (`EMOJI_SUGGESTION_BUDGET_MS`), Apply to all 20 s, every request is capped at
   `min(30 s, time left)` and none starts with under 5 s left (`clip-emoji-tagging.test.ts` "no key,
   a past deadline or an aborted signal sends nothing"; apply test "the time budget stops further calls").
9. **One kept-words function.** `clipEmojiWords(clip)` in `clip-emoji-suggestion.ts` (censor
   masking applies when `censorSegments` is given) serves the Studio route, Apply to all and
   import row building. Tests in `clip-emoji-suggestion.test.ts`.
10. **One tagger factory.** `openClipEmojiTagger(prisma)` in `clip.service.ts` (key, execution
    admission, closure over `tagCaptionEmojis`) is used by `suggestEmojis` and `prepareSuggester`.
11. **Neutral names.** Not started by the first agent. The chunker moved to
    `validators/src/transcript-tagging.ts` (`chunkTranscriptForTagging(utterances, languageCode, maxWords)`,
    `TranscriptTaggingChunk`, `TranscriptTaggingToken`); filler keeps
    `chunkTranscriptForFillerTagging(utterances, languageCode)` at 250 words, emoji
    `chunkTranscriptForEmojiTagging` at 500. The streamed request moved to
    `services/src/transcript-tagging-request.ts` (`requestTaggingReport`, `TAGGING_REQUEST_DEFAULTS`
    with the request limits, `TaggingModel`, `TaggingFetch`, `TaggingRequestConfig`);
    `FILLER_TAGGING_DEFAULTS` keeps only `budgetMs`, `concurrency`, `maxOutputTokens`.
    `fillerTaggingUtterances` is `selectionTaggingUtterances`. Behaviour unchanged: the 8 request
    bodies of a filler run plus an emoji run over the same 700-word German transcript hash to
    `83ac9dd0…` before and after; filler and emoji suites 39 + 38 tests pass before and after.
12. **Transcript not ready.** `suggestEmojis` throws `transcript_not_ready` (the clips domain's
    existing code) unless the project's transcript is `completed` (`clipEmojiTranscriptFailure`);
    `error-messages.ts` maps it ("The transcript isn't ready yet. Try again when transcription
    finishes."). Test `clip-emoji-suggestion.test.ts` "a missing or unfinished transcript is not ready".

### Verification (shared with ticket 15, run after both)

- `bun run typecheck`: 17/17 tasks successful.
- `bun run test --continue`: 15/16. Every suite passed (validators 1348, composition-plan 198,
  services 1694, api 994, api-client 234, caption-scene 3118, web 1343, media 1180, ...) except
  `@narriflow/caption-emoji` (1 failure, "a shard that fails to load drops only its own ids", ticket
  14's package). Re-run `bun test` in `packages/caption-emoji`: 104 pass, 0 fail.
- `test:inventory`: 302 routes, 0 problems. `openapi:check`: matches all 32 REST operations.
  `build:worker`: audit passed. `check:web-split`: passed.
- `bunx biome check` on the 42 files touched: no diagnostics.
