# 27 — Negated and loosely matched emoji picks

**Status:** done (coordinator accepted 2026-11-26: negated picks fell by two thirds, not to the target of at most 1 in 3 runs; the residue is one sentence pattern, see Evidence; a second pass was measured and rejected)
**Area:** `packages/validators/src/emoji-tagging.ts`, `packages/services/src/clip-emoji-tagging.ts` (and the shared tagging request if needed), `packages/services/scripts/emoji-tagging-eval.ts`, their tests.

## Why

The owner asked for the fixable known limits to be fixed. Real-clip relevance at Balanced is 92 to
94% (ticket 21 and 23 Evidence). The misses that remain are two kinds:

- **Negation.** A thing said to be absent or denied still gets its emoji: 📷 on "camera" in "no
  telephoto camera", money on "lack of profit". Ticket 21 tried two wordings of a prompt line
  (`S2/d/eval/neg-{1646,current}.json`, 9 fixtures with negated nouns, 3 runs each); neither
  helped. A third wording is not the fix.
- **Loose matches.** 💡 on "features" in "missing features": the emoji does not picture the word.

## What to try, in this order, measuring each

1. **Make the model say it instead of asking it to stay silent.** Add a field to each pick in the
   reply schema that the model must fill, for example whether the speaker says the thing is
   present / absent or denied / hypothetical, and drop non-present picks in code. Models label
   better than they abstain. Consider the same for looseness: a field for what the emoji
   literally pictures, or a "pictures the word itself" yes/no, dropped in code when no. Keep the
   reply small: field names short, values enumerated.
2. **Only if 1 is not enough:** a second short pass that sees only the kept picks with their
   sentences and answers keep or drop for each. Measure its cost and latency; it must stay a
   small fraction of the tagging call. The eval's judge prompt is a starting point but it is
   stricter than a careful reader on objects (84% agreement), so do not reuse it blindly.

Do not add language-specific word lists. It has to work in any language (the fixtures include
Urdu and Arabic).

## Acceptance

- [ ] On the 9 negation fixtures (add more real ones if you find them, and at least three where
      the negation is far from the noun or the sentence only sounds negative: "no doubt the
      camera is great" must keep its camera), 3 runs: negated picks kept at Balanced go from 8 to
      at most 1, and correct picks in those fixtures are not lost.
- [x] Real clips and written fixtures under the same grading as ticket 23 (`E/eval/after23-graded.md`),
      6 runs before and 6 after: relevance does not drop and emojis per minute stay within 10%.
      Grade by hand where the judge says not-A. Report the numbers honestly, including if the
      change does nothing.
- [x] Cost per 1,000 words and latency before and after. The constant prompt prefix stays
      constant (cached).
- [x] The malformed-reply retry, the echoed-word check and the strength gate keep working; tests
      for the new fields (a pick marked absent is dropped; a reply without the field is treated as
      malformed, not kept).
- [x] Phrase badges: no change wanted. Report the badge pick rate after your change so it is known.
- [x] `bun run --cwd packages/validators test`, `bun run --cwd packages/services test`, typecheck,
      biome on touched paths.

The model key in `apps/api/.dev.vars` may be read by the eval script; never print or store it.
Eval output goes in
`/private/tmp/claude-501/-Users-murtaza-Documents-dev-narriflow/f7147bb1-206f-4f6e-a8fc-276dea0eb55b/scratchpad/emoji-fix-ai/`.

## Evidence

Done 2026-11-26. Nothing committed, migrated or deployed. Scratch: `X = /private/tmp/claude-501/-Users-murtaza-Documents-dev-narriflow/f7147bb1-206f-4f6e-a8fc-276dea0eb55b/scratchpad/emoji-fix-ai`
(reports `X/{before,v1,v2,v3,v3-real}-graded.{md,json}`, prompt texts `X/prompt-{before,v1,v3}.txt`, source copies
`X/emoji-tagging.{before,v1,v2,v3}.ts`, probes `X/check/`).

### What changed

- **Reply schema** (`packages/validators/src/emoji-tagging.ts`). Before: `{ serious: { from, to }[]; picks: { k: number; w: string; e: string; s: 2 | 3 }[] }`.
  After: `{ serious: { from, to }[]; picks: { k: number; w: string; p: "yes" | "no" | "if"; e: string; s: 1 | 2 | 3 }[] }`.
  `p` comes before the emoji. `acceptEmojiPicks` drops a pick whose `p` is not `"yes"` or `"if"` and, as before, any
  strength under 2. A reply whose picks lack `p` fails the schema parse (null), so the chunk is retried, never kept.
  An absent pick still names its word, so a reply of only absent picks is an answer, not a failure.
- **Prompt.** The line "A thing said to be absent ... gets no emoji" is removed. The "For each pick write" sentence
  defines `p` ("yes": it is there, happens or is felt, also in a question, a plan or advice to do it, and when only
  the wording is negative; "no": the line says it is absent, missing, lacking, not had, not needed, not happening or to
  be avoided, wherever the negation sits; "if": only wished, expected, imagined or conditional) and `s` 1 ("only related
  to the word (its topic, a thing near it, a metaphor or another word of the line), not a picture of it"). No word lists.
- **Output cap** (`packages/services/src/clip-emoji-tagging.ts`): `maxOutputTokens` 2,000 → 4,000 (below).
- **Eval** (`packages/services/scripts/emoji-tagging-eval.ts`, `emoji-tagging-eval/fixtures-negation.ts`, `fixtures.ts`):
  four new negation transcripts (en, ur, ar, hi: 25 lines; far negations such as "there was, after all that, no bread
  left", "not a single taxi, not one, stopped", and lines that only sound negative: "No doubt the camera ...", "Without a
  doubt, this is the best coffee", "Nothing beats a cold shower", "I can't stop eating these custard tarts", and the same
  in Urdu, Arabic and Hindi), reported apart like the badge moments. `NEGATION_TARGETS` marks the words each line
  says are `absent` (ticket 21's nine, the new four, and the real clips' "no telephoto camera" and "missing features"),
  `advised` against ("fancy office मत लीजिए", "quit sweets", reported apart) and `present`. The report gains a Negation
  section (absent and advised picks kept per density and per run, present targets kept, A rate of the other picks)
  and lists every pick the model marked absent or only related, so each drop can be read.

### Grading

As ticket 23: hand labels `E/labels-t21.json` and `E/labels-t23.json`, then mine for every kept pick the judge did not
rate A (`X/labels-t27.json`, 177 labels). Every report in the tables below has every kept pick graded (by hand or by
a judge A), except v2 (39 picks ungraded; v2 is used only for its negation counts). Negated picks are graded on
relevance the way tickets 20 to 23 graded them ("📷 on camera" is A), so relevance and negation are separate counts.
Judge against hand grades: 413 picks, same A-or-not 62%, 10 false A.

### Variants (each 6 runs of all 4 real clips, 28 written fixtures, 2 badge-moment and 4 negation transcripts, judge on)

| Variant | Absent kept at B: nine (runs 1-3) | new four | real | Written all: A at B, per min B |
| --- | --- | --- | --- | --- |
| before (ticket 23's prompt) | 28 (14) | 13 | 4 | 93%, 7.2 |
| v1: `p` field, abstain line removed | 7 (2) | 2 | 0 | 94%, 6.7 |
| v2: v1 + a sharper `p` with two invented examples | 10 (4) | 4 | 0 | (not fully graded), 6.7 |
| **v3: v1 + `s: 1` "only related", final** | **12 (8)** | **4** | **0** | **96%, 6.6** |

v2 was reverted (no better than v1). v1 and v3 have the same `p` text, so 7 versus 12 is run-to-run spread: pooled,
1.6 absent picks per run on the nine against 4.7 before, a 66% cut. **The target (at most 1 in 3 runs) is not met.**
Of v3's 12, nine are one sentence pattern in three languages: "most founders are not short of customers, they are
short of profit" (منافع / पैसे / الربح get 💰, in about half the runs); the rest are 🔌 on "charger" in "I expected ... a
charger in the box" (labelled `if`), 🚪 on "دروازہ" in "never even saw the gym's door", and ✍️ on "تكتب" in "you do
not write your accounts". On the new four: 🚁 on "drone" in "you do not need an expensive drone", 🚕 on "taxi", 🍕 on
"بيتزا" in "we found no pizza open". Advised picks kept: 11 → 3. Present targets kept at Balanced: 47 → 49 of 72.
Correct picks on the nine's other words: 328 A → 310 A over 6 runs (-5%, the s1 drops).

### Step 2 (a second keep/drop pass): measured, not adopted

Prototype (`X/check/`): every Balanced pick of the before run on 21 transcripts (297 picks), 25 per request,
gpt-6-luna. With `p` plus a "does the picture show what the word names" field: absent kept 2 to 3 of 17, but the
picture field dropped 66 to 74 A picks per run (as strict as the judge). `p` alone: absent kept 0 to 3 of 17 over
two wordings and 3 runs each, the same residuals ("lack of profit/money", "expected a charger"), plus false drops
("unplugged", "fun", "jolly"); at reasoning medium, still 0 to 2. Cost about 19,000 to 24,000 tokens per 297 picks
and 5 to 8 s per 25-pick request, after the tagging call. It does not fix what the tagger's own `p` misses, and it
would add about 50% to the latency. Not built.

### Final numbers (v3 against before, same grading, 6 runs each)

| Set | Balanced A before | after | Per min L/B/E before | after |
| --- | --- | --- | --- | --- |
| real clips | 95% (80 of 84) | 96% (73 of 76); 6 more runs 98% (86 of 88); pooled 97% (159 of 164) | 2.2 / 4.6 / 4.6 | 1.6 / 4.1 / 4.2; 6 more 2.3 / 4.8 / 5.0; pooled B 4.47 (-3%) |
| written en | 93% | 97% | 4.3 / 6.9 / 7.1 | 4.1 / 6.2 / 6.8 |
| written ur | 93% | 96% | 3.9 / 7.0 / 7.4 | 4.0 / 6.6 / 6.9 |
| written hi | 91% | 95% | 4.6 / 8.4 / 9.4 | 4.4 / 7.6 / 8.4 |
| written ar | 94% | 96% | 4.5 / 8.0 / 8.9 | 4.8 / 7.7 / 8.7 |
| written all | 93% (1,287) | 96% (1,189) | 4.1 / 7.2 / 7.7 | 4.0 / 6.6 / 7.2 (B -8%) |
| badge moments | 98% | 97% | 4.9 / 12.6 / 13.1 | 7.1 / 12.3 / 12.8 |

The first 6 real-clip runs were at 4.1 per minute (-11%); six more runs gave 4.8, so I report the pooled 12 runs.
Malformed picks 14 of 2,000 → 22 of 2,296 raw; failed chunks 0 of 192 in both.

- **The s1 drops** (119 in v3): of the 35 that had a hand grade, 12 A, 8 B, 14 C, 1 D; reading the other 84, about
  a quarter were good picks. Right: 🎙️ on "episodes", 🥹/😢 on "feeling" in "I'm feeling emotional" (ticket 20's two
  standing real-clip misses), 👏 on "satisfying", ⬆️ on "up", ✅ on "do", ⏰ on "five", 🚗 on "ride" (fear in the back
  seat), 😖 on "be" in "you will be sore", 🔁 on "consistent". Wrong: 💍 on "married", 💰 on "price" (four times),
  🍳 on "pan", 🍲 on "pot", 🥩 on "protein".
- **Cost and latency** (gpt-6-luna list price before cache discounts, as tickets 20 to 23): **$0.0070 → $0.0076 per
  1,000 words** on the eval's transcripts (output 107,035 → 138,289 tokens over 32,646 words, +29%; reasoning 59,152 →
  71,912). Wall per transcript: median 4.1 → 4.9 s, max 11.9 → 9.4 s. On 500-word chunks (21 per tagger, four
  languages, cap 4,000): output median 1,078 → 1,704 tokens, max 2,024 → 2,404 in that sample; wall median 8.5 → 10.1 s,
  max 15.0 → 14.3 s.
- **Output cap.** At the old 2,000 cap the new tagger failed chunks on long transcripts (the written fixtures of one
  language joined, 6 runs each: a chunk failed after its retry in 3 of 6 English runs (1,317 words), 1 of 6 Hindi
  (997), 4 of 6 Arabic (733), 0 of 6 Urdu (1,125); 11 of 38 captured requests ended `incomplete`). Before this ticket it already happened: 2 of 42 full chunks over 2,000 tokens. Short-sentence Arabic
  (61 lines in 497 words) draws 55 to 129 picks a reply, up to 3,943 tokens. Now 4,000: at about 185 tokens a second,
  that is about 22 s, inside the request's 30 s timeout; 6,000 would not be. After the change: 12 long-transcript runs,
  0 failed and 0 retried. A denser chunk could still reach the cap (then it gets its one retry); if that shows up,
  smaller chunks are the fix, not a larger cap.
- **Prefix**: one constant string, built once (`EMOJI_TAGGING_SYSTEM_PROMPT`); 6,902 → 7,015 tokens (o200k_base), rules
  685 → 788, and ticket 26's four new designs (🛺 🤝 🐦 🔪, in the vocabulary from my v3 run on; before and v1 had the
  same 1,008). Cached share of input 97.1% before, 97.0% after.
- **Phrase badges** at Balanced: real clips 0 of 84 → 0 of 76 (and 0 of 88); ordinary written 3 of 1,287 → 3 of 1,189;
  badge moments 69 of 145 (48%) → 58 of 142 (41%), A 97% in both. Part of the drop is a wrong `p`: ☕⏰ on "کافی" in
  "صبح کی کافی کے بغیر میرا دن شروع ہی نہیں ہوتا" (my day doesn't start without my morning coffee) is marked absent (3 runs).

### Ten picks the change now drops, and whether the drop is right

| Line | Pick | Dropped as | Right? |
| --- | --- | --- | --- |
| تو no telephoto camera, no face ID ... (real, urdu-direction) | camera → 📷 | `p: no` (11 of 12 runs) | yes |
| ... but there is no charger in the box. | charger → 🔌 | `p: no` (6 of 6) | yes |
| Gaming के लिए ये laptop नहीं बना है। (not built for gaming) | Gaming → 🎮 | `p: no` (5 of 6) | yes |
| سارا دن بازار میں گھومے، ہر دکان دیکھی، لیکن آم کہیں بھی نہیں ملے۔ (no mangoes anywhere) | آم → 🥭 | `p: no` (6 of 6) | yes |
| Nobody read it, nobody clapped. | clapped → 👏 | `p: no` | yes |
| We've shot 384 episodes of this podcast. (real) | episodes → 🎙️ | `s: 1` | yes |
| I'm feeling emotional. (real) | feeling → 🥹 | `s: 1` | yes |
| چائے کے بغیر میری صبح شروع ہی نہیں ہوتی۔ (my morning doesn't start without tea) | چائے → ☕ | `p: no` (4 of 6) | **no**: a double negative; the old prompt also skipped it (0 of 6) |
| Gaming के लिए ये laptop नहीं बना है। | laptop → 💻 | `p: no` (1 run) | **no**: the laptop is there |
| We have been married for six years now. | married → 💍 | `s: 1` (1 run) | **no** |

### Tests

- validators `emoji-tagging.test.ts`: schema order `k, w, p, e, s`, `p` enum, `s` enum `[1, 2, 3]`; a pick marked
  absent is dropped and `"if"` kept; a stronger absent pick does not take the sentence from a present one; a reply of
  only absent picks is an answer (`[]`), an unknown `p` drops the pick; a reply whose pick lacks `p` is null;
  strength 1 dropped (existing test, renamed); every existing pick fixture carries `p`.
- services `clip-emoji-tagging.test.ts`: a pick marked absent is dropped end to end and the run counts as tagged; a reply
  without `p` is a failed chunk, sent once more (in the failed-reply list beside the cut-off, non-JSON, wrong-shape
  and no-word cases); the echo, unknown-glyph, badge, retry, 429, deadline and partial-run tests pass unchanged apart
  from `p` in their fixtures.

### Verification

- `bun run --cwd packages/validators test`: 1,367 pass, 0 fail.
- `bun run --cwd packages/services test`: 1,698 pass, 1,567 skip (PostgreSQL), 0 fail.
- `bun run typecheck`: 17 of 17 tasks.
- `bunx biome check` on the 7 touched files: clean.
- The eval script is outside the services tsconfig; `tsc` with it included reports only three existing errors
  (`import.meta.dir`, `findLast`), none in lines this ticket added.
- Commands: `bun packages/services/scripts/emoji-tagging-eval.ts --out X --label <v> --runs 6 --judge`, then
  `--rescore X/<v>.json --labels E/labels-t21.json,E/labels-t23.json,X/labels-t27.json`.
