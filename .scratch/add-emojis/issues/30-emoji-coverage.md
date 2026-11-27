# 30 — Add emojis finds too few emojis

Status: done (2026-11-27; Expressive and Light run a little under their targets overall, see Evidence)
Depends on: 27

## Why

Owner, 2026-11-27, on a 27 s English clip in the deployed Studio: AI tools → Add emojis → Apply answered
"No emojis fit this clip". "Our emojis system is not accurate, accuracy is very bad. It should apply
emojis."

Measured the same day on 34 real clips from four dev projects (20 English, 4 Hindi, 10 Urdu, 2 runs
each, the production prompt and code):

- Balanced keeps 3.1 to 3.4 emojis a minute; the median clip's longest stretch without one is 19 s; 9 to
  12% of runs end with none (30% of Urdu runs). The owner's clip: 0, 0, 1, 2 and 3 raw picks in five runs.
- Cause 1: the prompt asks for almost nothing ("Returning no picks is normal", "Pick only when the
  picture immediately depicts that word", "At most one emoji per line"): 8.5 raw picks a minute.
- Cause 2: `acceptEmojiPicks` keeps one pick per sentence. A spoken sentence here runs up to 49 words
  and 12 s. It drops about 123 of 353 raw picks.
- Cause 3: `p` is answered grammatically, so ❌ on "it doesn't work" and 🤷 on "didn't know" come back
  `p: "no"` and are dropped (21 of 21 times in one reviewer's runs), although they picture exactly what
  is said.

Tickets 20, 21 and 27 tuned only the share of picks that fit (95 to 97%); nobody set a target for how
many emojis a clip gets. Three independent reviews (Sol, Astra, Opus, 2026-11-27) reached the same
diagnosis and the same shape of fix; their measurements are quoted under Decisions.

## Decisions (made by the orchestrator from the reviews; do not re-open)

- **One pass, a better prompt, low reasoning.** A second fill pass, a verification pass, explicit beat
  or span input and medium reasoning were each measured by a reviewer and were worse or only slower
  (medium: 9 to 12 s a clip for the same coverage).
- **No per-sentence cap.** Spacing is the density's job (`selectCaptionEmojiPicks`), which already
  takes the strongest first with a minimum gap.
- **Strength:** 3 = pictures the word itself; 2 = pictures what the phrase says (or the word's sense
  here); 1 = only related, still dropped at acceptance.
- **Negation:** a pick the model marks `p: "no"` is kept when its emoji itself pictures "no"
  (a fixed list of emoji ids, language-independent). Every other `p: "no"` pick is dropped as today.
- **Densities:** gaps stay 5 / 2.5 / 1.5 s. Light keeps strength 3, Balanced and Expressive strength 2
  and 3. Wider gaps only lowered coverage.
- **Targets (ordinary speech, not serious):** Light about 4, Balanced 8 to 11, Expressive 9 to 13
  emojis a minute. No forced minimum: a clip that is serious from start to end still gets none.
- **One retry for an empty chunk:** a chunk of at least 30 words whose report lists no serious passage
  and yields no accepted pick is sent once more (it is the model's variance: 1 in about 200 runs).

## What to build

1. **Prompt** (`emojiTaggingSystemPrompt` in `packages/validators/src/emoji-tagging.ts`): replace the
   rules with the text in
   `/private/tmp/claude-501/-Users-murtaza-Documents-dev-narriflow/f7147bb1-206f-4f6e-a8fc-276dea0eb55b/scratchpad/dbg/mine/v3.txt`
   (everything above the `Emojis:` line; `{{EMOJIS}}` and `{{BADGES}}` are the two vocabulary lists,
   built as today). Copy it exactly; the orchestrator may send you a revised file before you finish, so
   keep the text in that one function. The reply schema does not change.
2. **Acceptance** (`acceptEmojiPicks`, same file):
   - Drop the one-per-sentence rule. Two picks on the same word: keep the stronger, the first on a tie.
     Result sorted by Word Key as today.
   - Keep a `p: "no"` pick when its emoji id is in a new exported constant
     `CAPTION_EMOJI_NEGATION_IDS`: `cross`, `prohibited`, `no-entry`, `person-gesturing-no`,
     `man-gesturing-no`, `woman-gesturing-no`, `person-shrugging`, `thumbs-down`, `cross-mark-button`,
     `zipped-lips`. Check each id against the catalog and leave out any the catalog does not have;
     validators must not import the catalog, so add a test in `packages/caption-emoji` or
     `packages/services` (which may import both) that every listed id is a catalog design the AI can pick.
   - Everything else as today: malformed, number / minor / filler words, strength under 2, serious
     ranges, unknown glyphs, skin tone dropped.
   - Update the function's doc comment and the comment above `EMOJI_TAGGING_SCHEMA` to say what is true now.
3. **Empty-chunk retry** (`tagCaptionEmojis` in `packages/services/src/clip-emoji-tagging.ts`): the
   rule above. It shares the existing single retry: a chunk is never sent more than twice. Count it in
   `retried`. Acceptance needs to tell the caller whether the report listed a serious passage; choose
   the smallest change (for example a second small exported function, or a richer return type used by
   both callers). Keep `acceptEmojiPicks`'s null-means-retry contract.
4. **Density** (`packages/validators/src/caption-emojis.ts`):
   `CAPTION_EMOJI_DENSITY_MIN_STRENGTH` becomes `{ light: 3, balanced: 2, expressive: 2 }`; fix its
   comment and `selectCaptionEmojiPicks`'s. Gaps unchanged.
5. **Token budget:** check `EMOJI_TAGGING_DEFAULTS.maxOutputTokens` (4,000) on the densest fixture
   (500-word chunk): report the largest reply; raise it only if a reply is cut, and say so. Update the
   measured numbers in that file's comments (requests, tokens, cost) from your own runs.
6. **Tests:** update `packages/validators/src/emoji-tagging.test.ts` and any other test that asserts
   one pick per sentence or Expressive strength 1; add cases for: two picks in one sentence both kept;
   same word twice keeps the stronger; `p: "no"` with a negation emoji kept, with any other emoji
   dropped; the empty-chunk retry fires once for a 30-word non-serious chunk and not for a short or a
   serious one.
7. **Eval** (`packages/services/scripts/emoji-tagging-eval.ts` and its fixtures): keep it working with
   several picks per sentence. The baseline is already recorded (ticket 27 Evidence), so run it only
   after your change: 3 runs, with `--judge`, and report relevance and emojis a minute
   at each density on the real clips and the written fixtures, beside ticket 27's numbers.
8. **Coverage measurement on the 34 dev clips:** the clips are in
   `/private/tmp/claude-501/-Users-murtaza-Documents-dev-narriflow/f7147bb1-206f-4f6e-a8fc-276dea0eb55b/scratchpad/dbg/clips`
   (owner content: do not copy them into the repository). `measure.ts` beside that folder shows how to
   read them, but it re-implements acceptance. Write `.scratch/add-emojis/tools/emoji-coverage.ts` that
   runs the **shipped** `tagCaptionEmojis` and `selectCaptionEmojiPicks` over a `--dir` of such clip
   files and prints the same table (emojis a minute at L/B/E, runs with none, longest gap, tokens and
   seconds a clip). Run it 3 runs and report. Expected with the v3 prompt: all about 7.9 a minute at
   Balanced (English 9.5, Hindi 12.2, Urdu 5.1), about 4 s a clip. The owner's clip is
   `en-e1fb-05`: Balanced should show about five emojis on every run (❌ on "work", 😮 on "Wow",
   🤷 on "know", and two or three of ❓ "questions", 📍/🗺️ "geofence", 📱 "screen", 🧭 "navigate",
   🚫 "wheel").
9. **Docs:** `.scratch/add-emojis/spec.md` "As built" (the tagging and density paragraphs),
   `GLOSSARY.md` and `docs/adr/0022-*` only where they state the one-per-sentence rule or the old
   strength meanings. Add the Evidence section to this ticket.

## Rules

- Read `AGENTS.md` and `.scratch/add-emojis/RULES.md` first. Take stock of what is on disk; assume nothing.
- Touch only `packages/validators`, `packages/services`, `packages/caption-emoji` (a test only), the
  docs named above and `.scratch/add-emojis`. Another builder is changing `apps/web` (ticket 31) at the
  same time: do not touch `apps/web`. If a web test or text depends on your change, list it in your
  report instead of editing it.
- Shared checkout: do not commit, stash, reset or restore anything.
- The model key is read from `apps/api/.dev.vars` by the scripts; never print, copy or store it.
- Never start, stop or restart a dev server. No PostgreSQL gates, no `next build`, no heavy suites.
- Verification: `bun run typecheck`, `bun run test` for `packages/validators`, `packages/services`,
  `packages/caption-emoji`, `apps/api` (the suggest route's tests) and `bunx biome check` on the files
  you touched; `bun run --cwd apps/api build:worker` (the Worker must still import only the catalog index).

## Done when

- The owner's clip gets emojis on every one of 5 runs at Balanced, and none of them pictures an absent thing.
- Coverage on the 34 clips is in the target range and reported with the table.
- The eval's relevance on the real clips is reported honestly beside ticket 27's (a drop is expected:
  say how large, and list the ten worst picks).
- Tests, typecheck, lint on touched files and the Worker build pass.

## Evidence

Done 2026-11-27. Nothing committed, migrated or deployed; `apps/web` untouched. Prompt: **v3**
(`.../f7147bb1-.../scratchpad/dbg/mine/v3.txt`, the orchestrator's revision), copied exactly: the built
`EMOJI_TAGGING_SYSTEM_PROMPT` is byte-identical to the file with `{{EMOJIS}}`/`{{BADGES}}` filled (17,916 chars).
Scratch: `S = /private/tmp/claude-501/-Users-murtaza-Documents-dev-narriflow/c891672f-7d2f-4140-8d4e-d9fab6dcca7e/scratchpad`
(`S/cov/v3-3runs.{txt,json}`, `S/cov/owner-final.txt`, `S/eval/t30{,-rescored}.{md,json}`, `S/long/long2.{txt,json}`).

### What changed

- `packages/validators/src/emoji-tagging.ts`: v3 prompt; `acceptEmojiPicks` keeps several picks a sentence (two on
  one word: the stronger, the first on a tie), keeps a `p: "no"` pick whose emoji is in the new
  `CAPTION_EMOJI_NEGATION_IDS` (all 10 listed ids are catalog designs; none left out); new `emojiReportListsSerious`;
  comments (schema, doc comment, chunk size, capsule cap) say what is true now. Null-means-retry unchanged.
- `packages/validators/src/caption-emojis.ts`: `CAPTION_EMOJI_DENSITY_MIN_STRENGTH = { light: 3, balanced: 2, expressive: 2 }`; comments.
- `packages/services/src/clip-emoji-tagging.ts`: the empty-chunk retry (`EMOJI_TAGGING_EMPTY_RETRY_WORDS = 30`), sharing
  the one retry, counted in `retried`; a failed second reply keeps the first, empty answer; measured-number comments.
- `packages/services/scripts/emoji-tagging-eval.ts`: a kept "no" emoji is not counted as an absent drop; the reply read
  for drop reasons is the one the tagger accepted; the negation table says how many kept absent picks are an emoji of "no".
- Tests: `emoji-tagging.test.ts`, `caption-emojis.test.ts` (validators), `clip-emoji-tagging.test.ts` (services; includes
  the catalog check for the negation ids, since validators must not import the catalog).
- `.scratch/add-emojis/tools/emoji-coverage.ts` (new), `.scratch/add-emojis/spec.md` (As built: 20, 21, 27 notes and a new "Coverage (30)" bullet).
- `GLOSSARY.md` and ADR 0022 state neither the one-per-sentence rule nor the strength meanings: unchanged.

```ts
export const CAPTION_EMOJI_NEGATION_IDS: ReadonlySet<string>;              // validators
export function emojiReportListsSerious(report: unknown): boolean;         // validators
export const EMOJI_TAGGING_EMPTY_RETRY_WORDS = 30;                         // services
// acceptEmojiPicks(chunk, report, refForGlyph, languageCode): CaptionEmojiPick[] | null  (signature unchanged)
```

### Coverage on the 34 dev clips (shipped `tagCaptionEmojis` + `selectCaptionEmojiPicks`, 3 runs, 30 s budget)

`bun .scratch/add-emojis/tools/emoji-coverage.ts --dir <dbg>/clips --runs 3 --show en-e1fb-05`

| Set | Runs | Per minute L / B / E | None at B | Longest gap at B: median, worst | Tokens a clip | Seconds a clip | Retried / failed |
| --- | --- | --- | --- | --- | --- | --- | --- |
| all | 102 | 3.3 / **8.0** / 9.3 | 6 (6%) | 10.7 s, 65.4 s | 8,825 | 4.1 (max 7.0) | 0 / 0 of 102 |
| en | 60 | 3.8 / **9.6** / 11.1 | 0 | 9.4 s, 27.3 s | 8,764 | 4.1 (max 7.0) | 0 / 0 |
| hi | 12 | 6.0 / **11.4** / 14.6 | 0 | 8.1 s, 11.9 s | 8,544 | 4.0 (max 5.1) | 0 / 0 |
| ur | 30 | 2.1 / **5.4** / 6.0 | 6 (20%) | 21.4 s, 65.4 s | 9,059 | 4.2 (max 6.2) | 0 / 0 |

Before (ticket text): Balanced 3.1 to 3.4 a minute, median longest gap 19 s, 9 to 12% of runs with none. The orchestrator's
expectation for v3 (all 7.9, en 9.5, hi 12.2, ur 5.1) is met. Against the targets: Balanced 8.0 is in 8 to 11; Light 3.3
is a little under "about 4" (English 3.8); **Expressive 9.3 is under 10 to 13** overall (English 11.1 and Hindi 14.6 are in
range; Urdu 6.0 pulls it down, because Expressive only narrows the gap and Urdu has few candidates). The six runs with none are
all Urdu and all had a serious passage listed (so no empty retry): `ur-7c9d-01` (a climber's death, 3 of 3, correct),
`ur-7c9d-02` (an addicted roommate's breakdown, 2 of 3), `ur-7c9d-08` (ransom/extortion, 1 of 3). The empty retry never fired
in these 102 runs or the 12 long runs.

**Owner's clip `en-e1fb-05`, Balanced, 5 runs with the final code** (`S/cov/owner-final.txt`):

1. ❌ "work." · 📱 "screen" · 😮 "Wow." · 🤷 "know"
2. ❌ "work." · 📱 "screen" · 😮 "Wow." · 🤷 "know"
3. 🗺️ "geofence" · ❌ "steering" · 🧭 "navigate" · 😮 "Wow." · 🤷 "know"
4. ❌ "work." · 📱 "screen" · 😮 "Wow." · 🤷 "know"
5. ❓ "questions." · ❌ "work." · 📱 "screen" · 😮 "Wow." · 🤷 "know"

4 to 5 on every run; none pictures an absent thing (❌ on "steering" in "there's no steering wheel" pictures the absence). In
the 3-run measurement the clip had 4, 5 and 3 (also 🐢 on "miles" in "one to two miles per hour", 👆 "touch", and once 🤔
on "asked").

### Eval (3 runs, `--judge`, ticket 21/23/27 hand labels), beside ticket 27

`bun packages/services/scripts/emoji-tagging-eval.ts --out S/eval --label t30 --runs 3 --judge --labels E/labels-t21.json,E/labels-t23.json,X/labels-t27.json`

| Set | Balanced A, ticket 27 | Balanced A, now | Per min L/B/E, ticket 27 | now |
| --- | --- | --- | --- | --- |
| real clips | 97% (159 of 164, 12 runs) | **73%** (67 of 92) | 1.6-2.3 / 4.1-4.8 / 4.2-5.0 (B 4.47 pooled) | 4.9 / **10.0** / 11.8 |
| written en | 97% | 72% | 4.1 / 6.2 / 6.8 | 4.7 / 11.2 / 13.5 |
| written ur | 96% | 75% | 4.0 / 6.6 / 6.9 | 4.5 / 10.6 / 12.2 |
| written hi | 95% | 75% | 4.4 / 7.6 / 8.4 | 5.2 / 10.5 / 13.2 |
| written ar | 96% | 70% | 4.8 / 7.7 / 8.7 | 5.4 / 12.7 / 15.9 |
| written all | 96% (1,189) | **73%** (993) | 4.0 / 6.6 / 7.2 | 4.9 / **11.1** / 13.4 |
| badge moments | 97% | 93% | 7.1 / 12.3 / 12.8 | 6.3 / 12.7 / 15.8 |

Light stays at 91 to 94% A. **The drop at Balanced is 24 points on the real clips (97% to 73%) and 23 on the written fixtures.**
Most of it is the grading: the judge's A is "depicts that exact word", so a phrase picture (❌ on "optimized" in "not
optimized", ✂️ on "half" in "break them in half", ⭐ on "favorite") is graded B or C. Judge against hand grades: 339 picks,
same A-or-not 75%, 19 false A. Reading the 25 non-A real-clip Balanced picks by hand, 14 are fair phrase pictures and 11 are
wrong, so about 88% (81 of 92) fit. All picks were graded (hand or judge). Not hand-graded beyond the existing label files.

Ten worst real-clip picks at Balanced:

| Line | Pick | Why |
| --- | --- | --- |
| All of them are unplugged. | 🔌 on "are" | function word ("are" is not a minor word in the shared list) |
| All of them are unplugged. | 🔌 on "them" | wrong word (belongs on "unplugged") |
| ... we can break them in half or write on them ... | ✍️ on "them" | wrong word |
| The next tenant will deal with that. | 🤝 on "deal" | idiom pictured word by word |
| ... matte display glare बहुत ही कम ... | ✨ on "display" | loose |
| ... see the new set and the new episodes ... | 🎬 on "episodes," | topic |
| We've shot 384 episodes of this podcast. | 🎙️ on "episodes" (2 runs) | topic (hand C since ticket 20) |
| ... iPhone Duo eSIM only model ... | 📱 on "eSIM" (2 runs) | the SIM, not the phone (hand B) |
| ... our favorite moments in this office ... | 😍 on "favorite" | hand C |
| ... form factor ہر کسی کے لیے نہیں ہے۔ | 🚫 / ❌ on "نہیں" (3 runs) | counted fair (it pictures the phrase), but it sits on the negation word itself, not the word that completes the meaning |

**Negation** (eval's negation table, 3 runs; ticket 27 had 6): picks kept at Balanced on a word the line says is absent: ticket
21's nine 14, of which 5 are an emoji of "no" (❌ on "charger", "تكتب", "perfect"), so 9 show the thing as present (ticket 27:
12 in 6 runs, so 3 a run against 2); the four new negation fixtures 8, of which 6 are 🚫/❌, so 2 (💸 on "expensive" in "do not
need an expensive drone"; ticket 27: 4 in 6 runs); real clips 1, an ❌ on "missing" (0 as present). The residue is the same
pattern as ticket 27: 💰 on "profit" in "not short of customers, short of profit" (ar, hi), 🧾/✍️ on "you don't keep accounts" (ur,
ar), 🔌 on "charger" in "I expected a charger". Advised against ("do not take a fancy office", "end your friendship with sweets")
kept 5 in 3 runs (ticket 27: 3 in 6). Phrase badges at Balanced: real 0 of 92, ordinary written 0 of 993, badge moments 35 of
73 (48%; ticket 27: 41%), 94% A.

### Token budget and cost

- 500-word chunks (the written fixtures joined per language, 733 to 1,317 words, 6 runs, 30 chunks): largest reply **2,823
  tokens** (English), Arabic 2,705, Hindi 2,317, Urdu 1,696; no reply incomplete, no chunk failed or retried. `maxOutputTokens`
  stays 4,000. Per 1,000 words 2.4 requests, 23,700 input and 3,700 output tokens, **$0.0042** at list price before caching
  (ticket 27: $0.0076 on the eval's short transcripts); 9 to 16 s wall per transcript.
- The eval's short transcripts (one request each): **$0.0082 per 1,000 words** (ticket 27: $0.0076), wall median 5.1 s (4.9),
  max 7.7 s (9.4). Real Studio clips: about 8,800 tokens and 4.1 s a clip (max 7.0 s); the owner's clip 4.7 s.
- Prefix: about 7,800 tokens, estimated from short-clip input (ticket 27: 7,015 counted). Cached share of input 97% (936,829 of 968,838).

### Verification

- `bun run --cwd packages/validators test`: 1,395 pass, 0 fail.
- `bun run --cwd packages/services test`: 1,751 pass, 1,567 skip (PostgreSQL), 0 fail.
- `bun run --cwd packages/caption-emoji test`: 114 pass, 0 fail.
- `bun run --cwd apps/api test`: 996 pass, 60 skip, 0 fail (the suggest route's `domains/clips/routes.test.ts` and
  `admission-tables.test.ts`: 83 pass).
- `bunx biome check` on the 8 touched code files: clean.
- `bun run --cwd apps/api build:worker`: import audit passed (no forbidden packages, no art); bundle 12,093,948 bytes.
- `bun run typecheck`: 10 of 11 tasks pass; **`@narriflow/services#typecheck` fails with 11 errors, all in
  `brand-font.service.ts`, `brand-profile.service.ts`, `brand-template.service.ts` and `campaign-operation.service.ts`**
  (they read `BrandTemplate.title`; the Prisma schema names it `name`). Not this ticket's files, clean in git, failing on
  two runs a few minutes apart; nothing in the files this ticket touched.
- Not run: PostgreSQL gates, `next build`, heavy suites.

## Orchestrator review (2026-11-27)

- **How the design was chosen.** Sol, Astra and Opus each reviewed the problem independently with the same 34 clips and
  tool; all three reached the diagnosis above. Their own candidates reached 7.7, 7.1 and 8.5 emojis a minute at Balanced.
  The shipped prompt merges the orchestrator's candidate with Opus's (the negation-emoji rule, the common-meaning rule) and
  adds rules for the faults the reviewers found (worship, a denied thing, the subject for the action, look-alike objects).
  Rejected with measurements: a second fill pass, a verification pass, explicit beats or spans, medium reasoning, wider gaps.
- **Blind grading.** 298 shuffled Balanced picks from three sources, graded by Sol, Astra and Opus without knowing the
  source (F fits / W weak / X wrong; majority of three): current app 94% / 4% / 1.4% (72 picks); Opus's candidate
  85% / 11% / 4.2% (168); the merged v2 prompt 87% / 10% / 2.7% (182). v2's five majority-wrong picks were 🌍 on
  "nationwide" and four look-alike substitutions (slot machine for roulette, flashlight for tube lights, wrench for hinge,
  signal bars for wireless charging); v3 adds the rule against those (12 such emojis in 102 runs became 2, for about 9%
  fewer emojis). v3 itself was not blind-graded.
- **Two changes after the build.** (1) `acceptEmojiPicks` also drops a word the English list calls minor, in every language:
  with no language (or one without a word list) only word length was checked, which is how 🔌 landed on "are" and "them" in
  the eval's real clip (its project has no language code). Tested. (2) The eval's judge prompt now counts a picture of what
  the phrase says as A, as the tagging prompt allows. Re-judged on the build's saved report (no hand labels): real clips
  Light 91%, Balanced 80%, Expressive 73% A; all sets Balanced 77%. The judge is told to withhold A when it hesitates, so
  it reads lower than the three blind graders (87% fit).
- **Typecheck.** The 11 `BrandTemplate.title` errors were a stale generated Prisma client (another session's migration
  `20261127120000_brand_template_title`); after `prisma:generate`, `bun run typecheck` passes 17 of 17 and `bun run test`
  16 of 16.
- **Known and accepted.** Relevance is lower than ticket 27's (about 95% to about 80 to 87%, by grader) for 2.5 times the
  emojis; Light keeps the strict set (91%). Things said to be absent shown as present: about 3 a run on ticket 21's nine
  fixtures (ticket 27: 2). Urdu stays sparsest (5.4 a minute at Balanced on a podcast about faith and loss). A clip the
  model marks serious throughout still gets none, and the Studio says only "No emojis fit this clip".
