# 32 — Emojis on most captions

Status: done (2026-11-27; one Done-when miss: 1 of 102 runs marked `ur-7c9d-02` silent from start to end, see Evidence)
Depends on: 30

## Why

Owner, 2026-11-27, after ticket 30 was deployed: "The algorithm needs to be better, I just want emojis to
be shown frequently." A 42 s clip got 3 emojis: "if the user only sees 2 or 3 emojis then what is the
purpose of emojis features?" "Also loosen the serious passages." He asked whether the AI model's own
decision-making is the problem and how his other product Kalakar shows so many.

**The priority is now frequency first.** An emoji on most captions, as Submagic, Vizard and Kalakar do.
Fit still matters (nothing that contradicts what is said, nothing on a real death), but a loosely
related emoji is now welcome where tickets 20 to 30 dropped it. This overrides the earlier "relevance
matters more than matching Kalakar".

## What was found (measured 2026-11-27 on 34 real clips: 20 English, 4 Hindi, 10 Urdu)

- Ticket 30's shipped code on the owner's clip (`en-e1fb-02`, 142 words), 4 runs: the model proposed 7, 8,
  12 and 15 picks (asked for about 18); Balanced kept 3 to 7. Code lost more to the 20 s same-emoji rule.
- **The request shape is the limit, not the model's judgement.** A free list of picks lets gpt-6-luna stop
  early (0.33 picks per caption line). When code splits the transcript into caption lines and the reply
  must hold one answer per line, the same model at the same reasoning gives 0.92 to 0.96. gpt-6.1-terra,
  gpt-6-sol and gpt-6-astra follow "every line" even in a free list, but cost 10 to 100 times more and make
  the same kinds of mistakes; none is needed.
- Kalakar (`~/Documents/dev/kalakar/apps/video-worker/src/processor/transcription.ts`, about lines 380 to
  520) asks for a word → emoji map and puts the emoji on every occurrence, with no spacing and no
  negation or serious check. Tested here: most emojis, but a car on "no steering wheel". Not copied.
- Three independent reviews (Sol, Astra, Opus) reached the same design. Astra's is the base (it
  never returned unusable anchors; Sol's word-id format once did); its harness is the reference
  implementation.

Measured with the reference harness and the final prompt (34 clips, 2 runs, gpt-6-luna low):

| Set | Light / Balanced / Expressive per minute | Lowest clip at Balanced | Lines with a candidate | s per clip |
| --- | --- | --- | --- | --- |
| ordinary (33 clips) | 12.4 / 19.4 / 27.0 | 12.6 | 95% | 4.7 (max 9.6) |
| en / hi / ur at Balanced | 19.8 / 21.1 / 18.6 | | | |

`ur-7c9d-01` (a climber's death) got none on both runs. `en-e1fb-02` got 13 and 15 at Balanced (was 3).
A 30,000-word import replay took 49 s with 16 requests in flight, about $0.0022 per 1,000 words.

## Decisions (made by the orchestrator from the reviews; do not re-open)

1. **Model:** gpt-6-luna, low reasoning (`none` gave failed or unparseable replies in two reviews).
2. **Caption lines.** Code splits each utterance's kept words into lines of at most 4 words, ending a
   line early at a word that ends with `, . ? ! ; :` (and `، ؟ ۔ ।`) once it has 2 words; a lone last
   word joins the line before it. These lines are only the tagging unit; they are not the on-screen cues.
3. **Eligible anchors.** In each line, every word that may carry an emoji gets a letter (`a` to `e`, by
   its position in the line): not a minor word (in the transcript's language or in English), not a number,
   not a filler. A line with no eligible word is not requested. The model answers with the letter, so it
   cannot anchor a function word or a word that is not there.
4. **One required answer per line.** The reply's JSON schema is built per request:
   `{ silent: [{from,to}], lines: { L0: string, …, Ln: string } }`, strict, every `L` key required. Each
   value is `"<letter> <emoji> <strength>"` with an optional ` no`, or `"X"` for a silent line.
5. **Request size.** At most 96 requested lines per request; a Studio clip is normally one request. Each
   request also shows up to 8 lines before and after its block as `context:` lines (not requested).
6. **Strength:** 3 = pictures the anchor word; 2 = pictures what the phrase says; 1 = its mood or point.
   All three are kept at acceptance now.
7. **Negation:** a value marked ` no` is dropped unless its emoji is in `CAPTION_EMOJI_NEGATION_IDS`.
8. **Serious, loosened.** Only an account of a real person's death, grave injury, life-threatening
   illness, suicide, abuse, or the victims of a disaster or war is silent (the whole account, from its
   lead-in to its aftermath). Addiction, a breakdown, a scam, ransom, failure, religion and unhappiness
   get understated emojis. Silent lines come back as ranges of `L` numbers and as `"X"`; code also keeps
   the 6 caption lines after a silent line silent, across request boundaries.
9. **Densities** (`packages/validators/src/caption-emojis.ts`): minimum gap 3.5 / 2.0 / 1.2 s for Light /
   Balanced / Expressive; minimum strength 2 / 1 / 1; the same emoji again after 6 s
   (`CAPTION_EMOJI_REPEAT_GAP_SEC`, was 20). Strongest first, earliest on a tie, as today.
10. **Retry.** A request whose reply is not the schema's shape, or in which fewer than half of the
    requested lines hold a usable value or an `X`, is sent once more (the existing single retry; it
    replaces ticket 30's empty-chunk rule). No second model, no fill request.

## What to build

Reference implementation (read it first; it is a measuring script, so rebuild it cleanly, do not paste
it): `D/astra2/bench-ranges.ts` and `D/astra2/import-ranges.ts`, where
`D = /private/tmp/claude-501/-Users-murtaza-Documents-dev-narriflow/f7147bb1-206f-4f6e-a8fc-276dea0eb55b/scratchpad/dbg`.
Prompt: `D/freq/final.txt` (everything above `Emojis:`; `{{EMOJIS}}` and `{{BADGES}}` are the vocabulary
lists as today). Copy the prompt exactly; the orchestrator may send a revised file, so keep it in one
function. Statistics script used for the numbers above: `D/freq/stats.py`.

1. **`packages/validators/src/emoji-tagging.ts`** (pure, no network, no catalog import): the caption
   lines with their eligible anchors; the request blocks with their user message and their schema; the
   system prompt; acceptance of one block's report into picks (`{ key, ref, strength }`, by Word Key, as
   today) plus the lines it marks silent; and the step that applies silence (with the 6-line carry)
   across all blocks and collects the picks. Keep what still applies: `refForGlyph` passed in, skin tone
   dropped, the Word Key ambiguity rule and the cap in `collectEmojiPicks`, the title folded to one
   bounded line, and the rule that a chunk whose text could forge prompt structure is never sent (the
   new message has `L<n>:` and `context:` line prefixes and letter-marked words `a=word`: make sure
   transcript text cannot forge those; reuse the shared rule in `transcript-tagging.ts` where it fits).
   Delete what no longer applies (the old picks schema, `p`, `k`, `w`, `emojiReportListsSerious`,
   `EMOJI_TAGGING_CHUNK_WORDS` if unused). No compatibility layer.
2. **`packages/services/src/clip-emoji-tagging.ts`**: one request per block with its own schema, the
   existing concurrency, deadline, abort, 429 handling and single retry; the outcome's shape and
   meaning stay (`chunks` now counts blocks). Check prompt caching still applies with a per-request
   schema and report the cached share; if the schema position breaks caching, say so with numbers.
   Update the measured-number comments from your own runs.
3. **Densities**: decision 9. Fix the comments and tests.
4. **Storage cap.** A 3-hour source now yields about 6,000 to 7,000 picks, above `EMOJI_TAG_MAX_PICKS`
   (5,000). Raise it to hold a 3-hour source with room (12,000 unless the selection capsule's size limit
   says otherwise): measure the encoded capsule with that many picks (`fitSelectionTags` drops emoji
   picks when the input is too large) and report the bytes and the limit. Update every schema that
   bounds it.
5. **Import budget.** Replay a 30,000-word source built from the 34 clips through the shipped
   `tagCaptionEmojis` with a 60 s deadline: report wall time, blocks, retried, failed, skipped, picks,
   tokens and cost. If blocks are skipped at the deadline, raise the emoji tagging concurrency (not the
   budget) until none are, and report what you chose and whether any 429 appeared.
6. **What is drawn.** More emojis means more of them meet the Emoji Layer's rules (the late-word rule,
   room drops, the held emoji yielding to the next). For three clips (`en-e1fb-02`, `hi-59c6-01`,
   `ur-7c9d-06`) at each density, report how many placed emojis the layer actually draws (use the
   existing scene/layer functions or tests, no rendering needed). Do not change the layer; if it drops
   more than one in ten, say so with the reasons.
7. **Tools.** Update `.scratch/add-emojis/tools/emoji-coverage.ts` to the shipped functions and add:
   lines with a candidate, the lowest clip at Balanced, runs under 10 a minute at Balanced. Run it on
   the 34 clips (`D/clips`, owner content: never copy into the repository), 3 runs. Expected: the table
   above. Print the Balanced emojis of `en-e1fb-02` and `en-e1fb-05` on every run.
8. **Eval** (`packages/services/scripts/emoji-tagging-eval.ts`): keep it working with the new reply
   (its "raw / dropped" accounting changes: explain what it now counts). Run 3 runs with `--judge` and
   report relevance and emojis a minute per density beside ticket 30's numbers, the negation table, and
   the serious leaks. A lower relevance is expected and accepted; report it exactly.
9. **Tests**: lines and anchors (4-word split, punctuation, lone last word, RTL and Devanagari, minor /
   number / filler words get no letter, a line with no eligible word is not requested); block building
   (96 lines, context lines, schema keys); acceptance (valid value, unknown letter, unknown glyph, ` no`
   with and without a negation emoji, `X`, silent ranges, malformed values, under half usable → null);
   silence carry of 6 lines across two blocks; forged-structure text; the service's retry; densities.
   Update `apps/api` tests that stub the tagger's report. Do not edit `apps/web` except a test or text
   that this change breaks; list any such edit.
10. **Docs**: `.scratch/add-emojis/spec.md` "As built", `docs/adr/0022-*` (its reply shape is now this
    one), `GLOSSARY.md` if a term changes, and the Evidence section of this ticket.

## Rules

- Read `AGENTS.md` and `.scratch/add-emojis/RULES.md` first. Take stock of what is on disk; assume nothing.
- Touch only `packages/validators`, `packages/services`, `packages/caption-emoji` (tests only),
  `apps/api` (tests only), the docs named above and `.scratch/add-emojis`.
- Shared checkout: do not commit, stash, reset or restore anything.
- The model key is read from `apps/api/.dev.vars` by the scripts; never print, copy or store it.
- Never start, stop or restart a dev server. No PostgreSQL gates, no `next build`, no heavy suites.
- Verification: `bun run typecheck` (run `bun run --cwd packages/db prisma:generate` first if
  `BrandTemplate` type errors appear: that is a stale generated client), `bun run test`,
  `bunx biome check` on the files you touched, `bun run --cwd apps/api build:worker`,
  `bun run --cwd apps/api test:inventory`, `bun run --cwd apps/api openapi:check`.

## Done when

- On the 34 clips, 3 runs: no ordinary clip under 10 emojis a minute at Balanced on any run; averages
  near 12 / 19 / 27; `ur-7c9d-01` gets none or one; `ur-7c9d-02` and `ur-7c9d-08` get emojis.
- `en-e1fb-02` shows at least 10 emojis at Balanced on every run.
- The import replay finishes inside 60 s with no skipped block.
- Tests, typecheck, lint on touched files, the Worker build and the two API checks pass.
- The Evidence section reports every number asked for above, the ten worst Balanced picks you saw, and
  anything left undone.

## Evidence

Done 2026-11-27. Nothing committed, migrated or deployed. Prompt: `D/freq/final.txt` copied exactly (the text above
`Emojis:`), in `emojiTaggingSystemPrompt`; system prompt 15,137 characters. Scratch output:
`S = /private/tmp/claude-501/-Users-murtaza-Documents-dev-narriflow/71cb23df-2c97-4327-be67-6fcabdbf4c33/scratchpad`
(`S/cov/run3.{txt,json}`, `S/cov/run3b.{txt,json}`, `S/cov/ur02.json`, `S/import/c16{,b}.json`, `S/drawn/drawn.json`,
`S/eval/t32.{md,json}`).

### What changed

- `packages/validators/src/emoji-tagging.ts`: rebuilt. Caption lines and anchors (`emojiTaggingLines`), request blocks
  with their message and schema (`emojiTaggingBlocks`, `emojiTaggingSchema`), the prompt, one line's value
  (`readEmojiLineValue`), one block's acceptance (`acceptEmojiBlockReport`), silent ranges (`emojiSilentRangeLines`), and
  `collectEmojiPicks` (6-line silence carry across blocks, the Word Key ambiguity rule, the cap). Deleted: the picks
  schema, `p`/`k`/`w`, `chunkTranscriptForEmojiTagging`, `acceptEmojiPicks`, `emojiReportListsSerious`,
  `EMOJI_TAGGING_CHUNK_WORDS`. `EMOJI_TAG_MAX_PICKS` 5,000 → 12,000.
- `packages/validators/src/transcript-tagging.ts`: the forged-structure rule and the colon display exported
  (`forgesTaggingStructure`, `shownTaggingToken`) and shared; filler tagging's prompt is byte-identical.
- `packages/validators/src/caption-emojis.ts`: densities 3.5 / 2 / 1.2 s, least strength 2 / 1 / 1, repeat gap 6 s; comments.
- `packages/services/src/clip-emoji-tagging.ts`: one request per block with its own schema; the single retry now fires on
  a failed reply, a reply not of the schema's shape, or one answering under half its lines (the empty-chunk rule and
  `EMOJI_TAGGING_EMPTY_RETRY_WORDS` are gone); `chunks` counts blocks; measured-number comments.
- `packages/services/scripts/emoji-tagging-eval.ts`: reads the new reply. `raw` is now **caption lines requested** in
  the reply the tagger used (not model picks), and `dropped` says what became of them: `serious` lines the reply marked
  silent ("X" or a range), `malformed` values (not the form, or a letter the line lacks), `unknownGlyph`, `absent`
  (" no" on an emoji that does not picture "no"), `rule` (kept by the block, dropped by the run: the 6-line carry or a
  shared Word Key). "Marked loose" is gone (strength 1 is kept). Sentences for the judge are still whole sentences.
- `packages/services/src/clip-selection-preparation.ts`: the spend comment ($0.05 → $0.12 for a 3-hour source).
- Tests: `emoji-tagging.test.ts`, `caption-emojis.test.ts` (validators); `clip-emoji-tagging.test.ts`,
  `clip-detection-persistence.test.ts` (services: Balanced now keeps a strength-1 pick). No `apps/api` test stubs the
  tagger's report (the suggest route's tests stub `suggestEmojis`), so none changed.
- Docs: ADR 0022 (the reply shape), spec "As built" (new "Frequency first (32)" bullet), `GLOSSARY.md` unchanged (no
  term changed; a caption line is a tagging unit, not a new domain term).
- **Outside the named areas, one edit:** `apps/web/content/docs/caption-styles.mdx`, two sentences the change made false
  (the densities and repeat gap; what goes silent).
- Tools: `.scratch/add-emojis/tools/emoji-coverage.ts` (shipped functions; lowest clip, runs under 10, lines with a
  candidate, cached share, silent lines per run), new `emoji-import-replay.ts`, `emoji-capsule-size.ts`, `emoji-drawn.ts`.

```ts
export const EMOJI_TAGGING_LINE_WORDS = 4, EMOJI_TAGGING_BLOCK_LINES = 96, EMOJI_TAGGING_CONTEXT_LINES = 8, EMOJI_TAGGING_SILENT_CARRY_LINES = 6;
export const EMOJI_TAG_MAX_PICKS = 12_000;
export interface EmojiTaggingWord { readonly word: TranscriptWord; readonly anchor: string | null }
export interface EmojiTaggingLine { readonly index: number; readonly words: readonly EmojiTaggingWord[] }
export interface EmojiTaggingBlock { readonly lines: readonly EmojiTaggingLine[]; readonly prompt: string | null; readonly schema: Record<string, unknown> }
export interface EmojiBlockAnswer { readonly picks: readonly { line: number; pick: CaptionEmojiPick }[]; readonly silent: readonly number[] }
export type EmojiLineValue = { kind: "silent" } | { kind: "malformed" } | { kind: "unknown-glyph"; glyph; word } | { kind: "pick"; word; ref; strength; no };
export function emojiTaggingLines(utterances, languageCode): EmojiTaggingLine[];
export function emojiTaggingBlocks(utterances, languageCode, title): { lines: EmojiTaggingLine[]; blocks: EmojiTaggingBlock[] };
export function emojiTaggingSchema(count: number): Record<string, unknown>;
export function readEmojiLineValue(line, value: string, refForGlyph): EmojiLineValue;
export function emojiSilentRangeLines(ranges, count: number): Set<number>;
export function acceptEmojiBlockReport(block, report: unknown, refForGlyph): EmojiBlockAnswer | null;
export function collectEmojiPicks(lines, answers: readonly (EmojiBlockAnswer | null)[]): CaptionEmojiPick[];
export const forgesTaggingStructure: (text: string) => boolean; export const shownTaggingToken: (text: string) => string;
// tagCaptionEmojis(input, config): CaptionEmojiTaggingOutcome  (signature and outcome shape unchanged)
```

Forged structure: a word with whitespace, a line or paragraph separator or a control character keeps its whole block
unsent (`unsafe`); `:` and `=` inside a word are shown fullwidth, so `L3:`, `context:` and `a=car` in a transcript read
as words. The model answers by letter and code maps it to its own word, so shown text is never compared.

### Coverage on the 34 dev clips (shipped `tagCaptionEmojis` + `selectCaptionEmojiPicks`, 30 s budget)

`bun .scratch/add-emojis/tools/emoji-coverage.ts --dir <dbg>/clips --runs 3 --show en-e1fb-02,en-e1fb-05,...`, run twice
(sample A is the measurement; sample B a second one, run after it to see the miss below again or not).

| Set | Runs | L / B / E per minute | Lowest clip at B | Under 10 at B | Lines with a candidate | Longest gap at B (median, worst) | s a clip | Tokens a clip |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| ordinary (A) | 99 | 12.4 / **19.1** / 26.8 | 0.0 (`ur-7c9d-02` run 1) | 1 | 94% | 4.8 s, 65.4 s | 4.1 (max 10.6) | 8,120 |
| ordinary (B) | 99 | 12.5 / **19.4** / 27.2 | 10.8 (`en-0b07-06`) | 0 | 95% | 4.9 s, 8.3 s | 4.0 (max 11.4) | 8,111 |
| en (A / B) | 60 | 12.8 / 19.8 / 28.1 · 12.7 / 19.6 / 28.1 | 13.5 · 10.8 | 0 · 0 | 96% · 97% | | 3.9 | 7,950 |
| hi (A / B) | 12 | 13.0 / 20.8 / 26.5 · 13.0 / 20.3 / 26.5 | 18.2 · 14.9 | 0 · 0 | 91% · 90% | | 3.4 | 7,650 |
| ur (A / B) | 27 | 11.6 / 17.9 / 25.0 · 12.1 / 18.9 / 26.0 | 0.0 · 15.3 | 1 · 0 | 92% · 95% | | 4.7 | 8,706 |
| all (A) | 102 | 12.0 / 18.6 / 26.0 | | 4 | 92% | | 4.0 | 8,107 |

Expected (reference harness): ordinary 12.4 / 19.4 / 27.0, lowest 12.6, 95% of lines, 4.7 s (max 9.6). Met, except one
run. Per sample: 1 retried request, 0 failed of 99; largest reply 1,298 tokens; no reply incomplete.

- **The miss:** in sample A run 1, `ur-7c9d-02` (an addicted roommate's breakdown) came back with every line silent, so it
  had no emoji. The rule now says such a story gets understated emojis, and the model followed it on every other run of
  the clip: 2 more in sample A (18, 20 at Balanced), 8 re-runs (`S/cov/ur02.json`: 17 to 19, 0 silent lines each), 3 in
  sample B (20, 22, 18). So 1 of 14 runs. I did not add a rule against it (decisions 8 and 10 are closed); a second
  model or a fill request would be the fix, and both are ruled out.
- `ur-7c9d-01` (a climber's death): none, one, none (A); 0 or 1 in 8 re-runs (19 to 23 of 27 lines silent); none ×3 (B). Met.
- `ur-7c9d-08` (ransom): 13, 13, 13 (A); 13, 10, 14 (B). Met.
- Cached share: 100% in both samples, because these requests are byte-identical to the reference harness's (system,
  user message and schema), which shows the whole prompt, schema included, is cached. See the caching note below.

**Balanced emojis, sample A** (B in `S/cov/run3b.txt`: `en-e1fb-02` 12, 14, 15; `en-e1fb-05` 9, 8, 8):

- `en-e1fb-02` run 1 (14): 👥 multi-user · ❓ question · 😓 hard · 🔄 context · ⚙️ logic · 🔒 privacy · 🎬 commercial · 💬 texts ·
  ⏱️ seconds · 🙂 Yeah. · 📊 reviews · ⏱️ seconds · 🔄 switching · 🚶 walk
- `en-e1fb-02` run 2 (13): 👥 multi-user · ❓ question · 😣 hard · 🔄 context · 🧠 logic · 🔒 privacy · 📱 reading · ⏱️ seconds ·
  🙂 Yeah. · 📊 lot · ⏱️ seconds · 📱 screen- · 🚶 walk
- `en-e1fb-02` run 3 (14): 👥 multi-user · ❓ question · 😓 hard · 🔄 context · 🧠 logic · 🔒 privacy · 🎬 commercial · 💬 texts ·
  ⏱️ seconds · ❌ doesn't · ⏱️ seconds · 📱 screen- · 🚶 walk · ⏳ seconds.
- `en-e1fb-05` run 1 (8): ❓ questions. · 📍 geofence · ❌ work. · ⚙️ operating, · 🛞 pedals, · 📏 miles · 😮 Wow. · 📃 previous
- `en-e1fb-05` run 2 (9): ❓ asked · 📍 outside · ❌ doesn't · ⚙️ operating, · 🚗 wheel · 📱 touch · 🛣️ miles · 😮 Wow. · 📖 previous
- `en-e1fb-05` run 3 (9): ❓ questions. · 🗺️ outside · ❌ doesn't · ⚙️ operating, · 🚲 no · 👆 move · 🛣️ miles · 😮 Wow. · ⏮️ previous

`en-e1fb-02` has at least 10 at Balanced on every run (13 to 15; it had 3). On `en-e1fb-05`, "there's no steering wheel
and no pedals" got 🚗 on "wheel" (A2), 🚲 on "no" (A3), 🛞 / 🚗 on "pedals" (A1, B1): the negation rule is not held there.

### Prompt caching with a schema per request

The provider caches the reply schema ahead of the system prompt. A probe of fresh requests (a random title, so no
request repeats; `S/cache-probe.ts`) on one clip cut to 19, 16, 9 and 7 lines: cached 7,019, 6,995, **0, 0**; the same
sizes again: 7,019, 6,995, 6,939, 6,923; another clip at 47, 40, 39, 33 lines: 7,243, 7,187, 7,179, **0**. The cached
amount grows with the line count, so the schema is inside the cached prefix, and a line count the cache has not seen
lately misses once: about 7,000 uncached input tokens, $0.0007 at list price, and no measurable latency in these runs.
Import blocks are almost all 96 lines (one schema), so the first replay cached 73% of its input and a repeat 100%. I
left the schema as decided; making it constant would mean padding lines the model must answer.

### Import replay (30,000 words built from the 34 clips, shipped `tagCaptionEmojis`, 60 s deadline)

`bun .scratch/add-emojis/tools/emoji-import-replay.ts --dir <dbg>/clips` (no language: the clips are en, hi and ur).

| Run | Wall | Blocks | Retried | Failed | Skipped | 429 | Picks | Input (cached) | Output | Largest reply | Cost, list price before caching |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 (fresh) | **44.1 s** | 81 | 0 | 0 | 0 | 0 | 7,047 | 730,490 (73.2%) | 94,547 | 1,937 | $0.120, $0.0040 / 1,000 words |
| 2 (repeat) | 45.2 s | 81 | 1 | 0 | 0 | 0 | 7,055 | 739,378 (100%) | 97,567 | 1,894 | $0.123 |

8,256 caption lines, 7,733 requested. Concurrency stays 16 (no block skipped). The reference's $0.0022 per 1,000 words
is the cache-discounted figure; mine is before discounts (the eval's convention). If cached input bills at a tenth, run 1
is about $0.072, $0.0024 per 1,000 words (an assumption about the price, not measured).

### Storage cap

`bun .scratch/add-emojis/tools/emoji-capsule-size.ts --dir <dbg>/clips` (the shipped `encodeClipSelectionInput`): a capsule
for 27,000 words (these clips' speech is fast, 2.3 hours) is 2,950,751 bytes without picks and **3,826,207 with 12,000**
(875,456 bytes, 73 a pick), 22.8% of the 16,777,216-byte limit. 30,000 words with the replay's 7,047 picks: 3,802,874.
So **12,000** as the ticket proposed; `captionEmojiPicksSchema` (`.max(EMOJI_TAG_MAX_PICKS)`) is the only schema that bounds it.

### What is drawn (`emoji-drawn.ts`: tagger once per clip, density, Studio storage, `planClipComposition` 9:16, `compileCompositionPlanCaptions` with art)

| Clip | Light placed → drawn | Balanced | Expressive | Left out (reason) |
| --- | --- | --- | --- | --- |
| `en-e1fb-02` | 8 → 8 / 8 / 8 | 15 → 15 / 14 / 14 | 20 → 20 / 20 / 20 | 1 no-room (Headline), 1 no-time (Lyrics) |
| `hi-59c6-01` | 6 → 6 / 6 / 6 | 8 → 8 / 8 / 8 | 14 → 14 / 14 / 13 | 1 no-time (Lyrics) |
| `ur-7c9d-06` | 12 → 11 / 11 / 12 | 16 → 15 / 15 / 16 | 24 → 23 / 23 / 21 | 9 no-time |

(drawn per preset: default / Headline / Lyrics.) In all: Light 76 of 78 (97.4%), Balanced 113 of 117 (96.6%), Expressive
168 of 174 (96.6%); no emoji fails to resolve to a word. Only one case drops more than one in ten: `ur-7c9d-06` at
Expressive with Lyrics, 3 of 24 (12.5%), all `no-time`, the late-word rule (an anchor too close to its cue's end). The
layer was not changed.

### Eval (3 runs, `--judge`, hand labels t21, t23, t27), beside ticket 30

`bun packages/services/scripts/emoji-tagging-eval.ts --out S/eval --label t32 --runs 3 --judge --labels E/labels-t21.json,E/labels-t23.json,X/labels-t27.json`

| Set | Balanced A, ticket 30 | Balanced A, now | Light A, now | Per min L / B / E, ticket 30 | now |
| --- | --- | --- | --- | --- | --- |
| real clips | 73% (67 of 92) | **50%** (99 of 197) | 54% | 4.9 / 10.0 / 11.8 | 13.6 / **21.5** / 28.5 |
| written en | 72% | 62% | 62% | 4.7 / 11.2 / 13.5 | 11.8 / 17.9 / 25.7 |
| written ur | 75% | 59% | 66% | 4.5 / 10.6 / 12.2 | 11.5 / 18.4 / 25.3 |
| written hi | 75% | 60% | 66% | 5.2 / 10.5 / 13.2 | 11.4 / 18.0 / 27.3 |
| written ar | 70% | 65% | 72% | 5.4 / 12.7 / 15.9 | 11.8 / 17.7 / 25.2 |
| written all | 73% (993) | **60%** (1,650) | 65% | 4.9 / 11.1 / 13.4 | 11.8 / **18.4** / 26.1 |
| badge moments | 93% | 57% | 54% | 6.3 / 12.7 / 15.8 | 12.0 / 20.0 / 28.1 |

Every pick graded (hand, else judge). The judge now counts a phrase picture as A (ticket 30 review); ticket 30's real-clip
figure re-judged that way was 80%, so the honest drop on real clips is 80% → 50% A (73% → 50% as reported). Light fell from
91-94% to 54%: Light now keeps strength 2. B (right picture, wrong word) is 12% on real clips, C 37%. Judge against hand:
344 picks, same A-or-not 68% (ticket 30: 75%), 30 false A (19). Malformed values: 30 of 3,804 lines; unknown glyph 61
(2%); failed requests 0 of 96. Phrase badges at Balanced fell to 2 of 115 on the badge-moment fixtures (ticket 30: 35 of 73)
and 0 elsewhere: the new prompt allows a badge only when both parts fit, and the model rarely chooses one.
Cost $0.0073 per 1,000 words (ticket 30: $0.0082), wall median 4.0 s, max 9.8 s.

**Negation** (picks kept at Balanced on a word the line says is absent; 3 runs):

| Set | Ticket 30 (3 runs) | Now | Of those, an emoji of "no" | Shown as present |
| --- | --- | --- | --- | --- |
| ticket 21's nine | 14 | 27 (8, 10, 9 a run) | 2 | **25** (ticket 30: 9) |
| negation fixtures | 8 | 22 (5, 8, 9) | 0 | **22** (ticket 30: 2) |
| real clips | 1 | 4 | 2 | 2 (ticket 30: 0) |

Advised against, kept at Balanced: 6 (ticket 30: 5). Present targets kept: 17 of 36. 34 values were marked " no" and
dropped. Typical: 🔌 on "charger" and 📦 on "box" in "no charger in the box", 🏋️ on "gym" in "I've never seen a gym door",
💰 on "profit" in "short of profit, not customers" (ar, ur, hi), 📒 on "you don't keep accounts", 🎮 on "this laptop isn't
made for gaming". The model marks " no" far less often than it set `p: "no"`.

**Serious leaks at Expressive (judge):** 8, none a real death or illness: 7 on "I dropped my phone and the screen cracked"
(badge-moment fixtures, en and ur: 📱 💥; the judge counts an accident, the new rule does not), 1 🧩 on "project" in "The
project also had a dark chapter" (en-news, s1). No death, illness or disaster passage got an emoji.

**Ten worst Balanced picks seen** (coverage and eval):

| Line | Pick | Why |
| --- | --- | --- |
| there's no steering wheel and no pedals | 🚗 on "wheel", 🚲 on "no", 🛞/🚗 on "pedals" (4 runs) | pictures the absent thing |
| there is no charger in the box | 🔌 "charger", 📦 "box" | absent thing shown |
| Does the remote even still work? | 🔧 on "work?" | a tool for "work" |
| ... first win ہے اس کی hinge. | 🔩 / 🔧 on "hinge." (3 runs) | look-alike object, which the prompt forbids |
| ... eSIM only model ... اپنی SIM | 💳 on "SIM" | look-alike |
| Wouldn't have done it any other way. | 🛣️ on "way." (3 runs) | idiom pictured word by word |
| we will catch you guys on the other side | 👋 on "catch" (3 runs) | idiom |
| ... form factor ہر کسی کے لیے نہیں ہے | 👥 on "ہر", 👥 on "نہیں" | Urdu function words with no minor-list entry get a letter |
| ... اتنا smartly ... | 🙈 on "smartly" | loose |
| Yeah. / a lot of reviews | 🙂 on "Yeah.", 📊 on "lot" (s1) | mood picks on empty words |

### Verification

- `bun run typecheck`: 17 of 17 tasks pass (no stale Prisma client this time).
- `bun run test`: 16 of 16 tasks pass. validators 1,395 pass; services 1,750 pass, 1,567 skip (PostgreSQL), 0 fail;
  caption-emoji 114 pass; api 996 pass, 60 skip; api-client 243 pass; web 1,536 pass.
- `bunx biome check` on the 14 touched code and tool files: clean.
- `bun run --cwd apps/api build:worker`: import audit passed (no forbidden packages, native or obsolete modules).
- `bun run --cwd apps/api test:inventory`: 302 routes, 45 protocol routes, 0 problems.
- `bun run --cwd apps/api openapi:check`: matches all 32 REST operations.
- The eval script is outside the services tsconfig; checked with tsc on its own: no new errors (only the existing
  `import.meta.dir` and `findLast` lib-target errors of the setup).
- Not run: PostgreSQL gates, `next build`, heavy suites.

### Left undone or uncertain

- One run in 102 (and 1 in 14 of that clip) silenced the addiction-breakdown clip entirely; the Done-when bullet "no
  ordinary clip under 10 a minute on any run" failed on that run and held on the second sample.
- Things said to be absent are shown as present about 3 times as often as after ticket 30 (25 against 9 on ticket 21's
  nine fixtures in 3 runs), including the owner's "no steering wheel" clip.
- Phrase badges almost never appear now (2 of 115 on lines written to say a badge's moment).
- Relevance by the judge: real clips 50% A at Balanced (expected to fall; it fell from 80% re-judged / 73% reported).
- The schema-ahead-of-prompt caching miss costs about $0.0007 per cold line count; not changed.


## Orchestrator review (2026-11-27)

The build met the frequency target but its own Evidence showed three weaknesses. Fixed in review, each tested:

1. **Absent things shown as present** had tripled (a car, a bicycle and a tyre on "there's no steering wheel and no
   pedals"). The model rarely wrote the optional " no". Every value now ends `yes` or `no` (asked for on every line, like
   ticket 27's required `p`; a missing marker reads as yes), and the prompt tells it to prefer ❌ / 🚫 / 🤷 in such a
   caption. An emoji on a negation word itself ("no", "not", "نہیں", by the language's list and the English one) is kept
   only when it pictures "no" (`captionWordIsNegation`).
2. **An ordinary sad clip went fully silent once in 14 runs.** A reply that silences more than half of its block is asked
   once more and the reply with fewer silent lines stands (`emojiAnswerMostlySilent`, inside the one retry). The
   climber's death is silenced both times, so it stays silent.
3. **Phrase badges had nearly vanished** (2 of 115 on the badge fixtures). The prompt's badge rule is restored in full.

Prompt as shipped: `D/freq/final2.txt`. Measured after these changes with the shipped code:

- **34 clips, 3 runs** (`emoji-coverage.ts`): ordinary clips 12.2 / 19.1 / 26.9 a minute at Light / Balanced /
  Expressive (en 19.3, hi 20.5, ur 18.5 at Balanced); lowest ordinary clip at Balanced 11.0; no ordinary run under 10
  and none empty; 94% of lines get a candidate; 4.5 s a clip (max 8.9). `ur-7c9d-01` got none on 3 of 3 runs (asked
  twice each time); `ur-7c9d-02` 17, 18, 12; `ur-7c9d-08` 10, 13, 10.
- **Owner's clips at Balanced:** `en-e1fb-02` 14, 13, 12 (ticket 30: 3). `en-e1fb-05` 8, 8, 8, with 🚫 on "no" or
  "steering" on every run and no picture of the missing wheel.
- **Eval, 2 runs, judged, no hand labels:** Balanced graded A 48% on real clips and 60% on all sets, B (right picture,
  neighbouring word) 15 to 19%, C 25 to 33%; 17.9 to 19.6 a minute. Absent things kept at Balanced: 6.5 a run on ticket
  21's nine fixtures (build: 8.3; ticket 30: 3) and 3 a run on the negation fixtures, 2 of them an emoji of "no"
  (build: 7.3). Badges kept on the badge fixtures: 16 of 73 (build: 2 of 115; ticket 30: 35 of 73). Serious leaks: 3.
- **Checks:** `bun run typecheck` 17 of 17; `bun run test` 15 of 16 on the first run (one media test that samples
  process memory failed while the eval ran beside it; `apps/media` alone: 1,271 pass, 0 fail); Biome on the touched
  files clean; the Worker build's import audit passed.

Accepted, as the owner asked for frequency first: the strict judge's A rate is far below ticket 30's (80% → 48% on real
clips), because mood picks and pictures on a neighbouring word are now kept; the reviewers' own reads of Balanced picks
put plainly wrong ones at 3 to 8%, none of them strength 1.
