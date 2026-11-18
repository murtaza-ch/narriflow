# 01 - Emphasis scorer and g1

**What to build:** Every cue's hero word is chosen deterministically by `assignCaptionRoles` (spec 5.3), with a blind pick-sheet review (gate G1).

**Blocked by:** None

**Status:** claimed

Spec: [../spec.md](../spec.md). Follow the spec; where a ticket and the spec disagree, the spec wins.

## Acceptance

- [x] `packages/validators/src/caption-emphasis.ts` and the word lists (English, Urdu, Hindi, Roman Urdu/Hindi; 20 KB cap) implement spec 5.3 exactly, including units, the confidence gate and overrides.
- [x] Unit tests cover each signal, the never-minor rules, units, the gate, every override value, the repeat penalty against automatic picks only, masked words and untimed utterances.
- [x] `packages/validators/scripts/emphasis-sheet.ts` exports blind sheets from a JSON transcript export and scores labels against the scorer and the baseline.
- [x] Real transcripts are exported read-only from the dev database (`PGOPTIONS='-c default_transaction_read_only=on'`, `packages/db/.env`) into the session scratchpad, never into git.
- [ ] G1 result recorded under `## Comments` (the orchestrator runs the Sol labelling).
- [ ] `bun run lint`, `bun run typecheck`, `bun run test` pass (Bun 1.4.4). No PostgreSQL or heavy suites.

## Comments

### 2026-11-19, scorer and sheets (G1 labelling still open)

Built `caption-emphasis.ts` (`assignCaptionRoles`, `baselineCaptionHero`, `CAPTION_EMPHASIS_WEIGHTS`,
`captionWordKey`, `captionEmphasisOverrideSchema`, `CAPTION_EMPHASIS_OVERRIDE_LIMIT`), four
hand-written word-list modules (11 KB together), 41 unit tests, and `scripts/emphasis-sheet.ts`.

Commands and results:

- `bun test packages/validators/src/caption-emphasis.test.ts`: 41 pass.
- `bun run --cwd packages/validators test`: 833 pass.
- `bun run typecheck`: 15/15 tasks pass.
- `bun run lint`: the new files are clean. The run fails on one error in another ticket's
  file, `.scratch/dynamic-captions/references/proof/layout.js:172` (unused parameter).
- Full `bun run test` not run (this ticket ran the validators suite only).

Export: `emphasis-sheet.ts export` read the dev database through psql with
`default_transaction_read_only=on` (verified `on`). Clips that repeat speech (re-runs, or the
same video in two projects, found by 5-word shingles) were dropped. Exported 40 English clips
(22 projects, round-robin), 22 Urdu clips and 19 Hindi clips (6 projects in all). The data held
no more Urdu or Hindi.

Sheets (`sheet`, 4 words per cue, split by clip and alternating, a middle window of 6 cues per
English clip and 4 per Urdu or Hindi clip):

| Sheet | English | Urdu native | Hindi native | Roman (ur + hi) |
| --- | --- | --- | --- | --- |
| tuning | 120 | 39 | 33 | 12 (5 + 7) |
| held-out | 120 | 42 | 31 | 7 (2 + 5) |

Both sheets meet the 100 English and 60 Urdu or Hindi minimum. The Roman group is small
because these transcripts write Urdu in Arabic script and Hindi in Devanagari. Their Latin
tokens are English words inside the sentence, so a cue is Roman only when the English words
outweigh the native ones. G1 has no real Roman Urdu or Roman Hindi text to measure.

With the starting weights the gate gives a hero to 41 to 45% of English cues and 20 to 28% of
native-script cues.

Files are in the session scratchpad, not in git:
`/private/tmp/claude-501/-Users-murtaza-Documents-dev-narriflow/49bb75c5-29c7-4a2e-aa64-a5b996ebf64f/scratchpad/g1/`
(`export.json`, `tuning.md`, `tuning.json`, `heldout.md`, `heldout.json`).

Scoring: `bun packages/validators/scripts/emphasis-sheet.ts score <export.json> <labels.json>
<tuning.json> [<heldout.json>] [--weights <partial.json>] [--details]`. Labels are
`{ "<cue id>": { "acceptable": ["word", ...] | "none" } }`. A list may also contain "none".
A pick agrees when any of its words is acceptable. No pick agrees only where "none" is
acceptable.

Judgement calls (where the spec was unclear):

- Seconds per letter for the stretch median is `duration / clamp(letters, 3, 12)`, the same
  clamp as the ratio, so an utterance's typical word scores a ratio of 1.
- Untimed utterance: a cue with one word whose `raw` contains whitespace. It gets role
  `body`, no hero, and stays out of the statistics. It also resets the repeat chain.
- Latin tokens in `ur`/`hi` use the Roman lists together with the English lists, because the
  data is code-switched English.
- `two`-like words that double as verbs or articles (دو/दो/do, ایک/एक/ek, Roman saath) are
  not number words. ایک/एक/ek are minor (article). Urdu نا is a filler; Hindi ना and Roman na
  are negations, as the spec says.
- "Capitalised" means the first letter is upper case, so an ALL CAPS word earns both signals.
- `policy: "never"` drops override heroes too, because tile styles have no hero.
- Masked words cannot be the hero even through an override. A `hero` or `pair` override on a
  minor or filler word is honoured. A `pair` on a cue's last word, or before a masked word,
  becomes a single hero.
- `plain` takes a word, and any unit that contains it, out of the automatic pick. The
  remaining candidates must still pass the gate.
- Unit words are one list across all languages. A capitalised pair needs both words to be
  eligible.
- `assignCaptionRoles` takes an optional `weights`, for tuning only.

