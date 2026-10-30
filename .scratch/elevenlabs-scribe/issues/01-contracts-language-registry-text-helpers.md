# 01 — Freeze contracts: language registry, word spacing, text helpers, ADR 0018

**What to build:** The shared contracts every later ticket builds on, in `packages/validators` (+ ADR).
- `language.ts`: replace the AssemblyAI registry with the Scribe v2 catalog (spec D8): canonical code, label, ISO 639-3 provider code, script, direction; explicit forward/reverse maps (reverse also accepts `cmn`); `SCRIBE_MODEL_ID = "scribe_v2"`; keep exported names `sourceLanguageCodeSchema`, `sourceLanguageInputSchema`, `sourceLanguageCodeFromFormValue`, `getSourceLanguageLabel`; add `normalizeProviderLanguageCode(code)` and `languageDirection/ languageScript`. Delete AssemblyAI constants, U3.5/U2 grouping, accuracy bands. Source the list from https://elevenlabs.io/docs/overview/capabilities/speech-to-text (+ Yoruba, verified accepted).
- `transcript.ts`: optional `spaceBefore?: boolean` on `TranscriptWord` (spec D7).
- New `text-script.ts` (or similar): `joinTranscriptWords(words)`, `isNoSpaceScriptChar`, `textDirection(text)` (first strong char), locale-aware casing helper (`toLocaleUpperCase(lang)`, no-op for caseless scripts, never Georgian Mtavruli), Unicode caption edge-punctuation set.
- `utterance-split.ts`: sentence terminals per spec §7 (`。！？．` `؟` `۔` `।` `॥` `።` `။` `։` U+037E) with closing quotes/brackets in those scripts; ASCII `;` is NOT a terminal; keep abbreviation/decimal handling; `buildSentenceUtterance` uses `joinTranscriptWords`.
- `docs/adr/0018-elevenlabs-scribe-transcription.md` + index entry: provider decision (evidence links to `.scratch/elevenlabs-scribe/`), probe-then-pin policy (D6), durable submission and duplicate-cost acceptance (D1), single finalizer (D2).

**Out of scope:** updating every join call site (ticket 09), web picker (11), worker (05/06).

**Blocked by:** None

**Status:** ready-for-agent

**Acceptance:**
- [ ] Catalog enumerated and tested (count, maps round-trip, `tl`→`fil`, `jw`→`jv`, `en_us`→`en`, `eng`/`urd`/`zho`/`cmn`/`yue` normalize).
- [ ] `joinTranscriptWords` fixtures: English, `今天天气很好。`, `2026年`, `「OpenAI」`, Thai with explicit `spaceBefore` phrase spaces, mixed Urdu+English, Japanese with Latin insertion.
- [ ] Sentence split fixtures for each terminal + abbreviations/decimals unchanged + English `;` not a terminal.
- [ ] `bun run --cwd packages/validators test` and `bun run typecheck` pass (callers of removed AssemblyAI exports may be left failing ONLY if listed in the return for tickets 06/11; prefer temporary minimal call-site updates that keep typecheck green).
