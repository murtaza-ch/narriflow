# 01 — Freeze contracts: language registry, word spacing, text helpers, ADR 0018

**What to build:** The shared contracts every later ticket builds on, in `packages/validators` (+ ADR).
- `language.ts`: replace the AssemblyAI registry with the Scribe v2 catalog (spec D8): canonical code, label, ISO 639-3 provider code, script, direction; explicit forward/reverse maps (reverse also accepts `cmn`); `SCRIBE_MODEL_ID = "scribe_v2"`; keep exported names `sourceLanguageCodeSchema`, `sourceLanguageInputSchema`, `sourceLanguageCodeFromFormValue`, `getSourceLanguageLabel`; add `normalizeProviderLanguageCode(code)` and `languageDirection/ languageScript`. Delete AssemblyAI constants, U3.5/U2 grouping, accuracy bands. Source the list from https://elevenlabs.io/docs/overview/capabilities/speech-to-text (+ Yoruba, verified accepted).
- `transcript.ts`: optional `spaceBefore?: boolean` on `TranscriptWord` (spec D7).
- New `text-script.ts` (or similar): `joinTranscriptWords(words)`, `isNoSpaceScriptChar`, `textDirection(text)` (first strong char), locale-aware casing helper (`toLocaleUpperCase(lang)`, no-op for caseless scripts, never Georgian Mtavruli), Unicode caption edge-punctuation set.
- `utterance-split.ts`: sentence terminals per spec §7 (`。！？．` `؟` `۔` `।` `॥` `።` `။` `։` U+037E) with closing quotes/brackets in those scripts; ASCII `;` is NOT a terminal; keep abbreviation/decimal handling; `buildSentenceUtterance` uses `joinTranscriptWords`.
- `docs/adr/0018-elevenlabs-scribe-transcription.md` + index entry: provider decision (evidence links to `.scratch/elevenlabs-scribe/`), probe-then-pin policy (D6), durable submission and duplicate-cost acceptance (D1), single finalizer (D2).

**Out of scope:** updating every join call site (ticket 09), web picker (11), worker (05/06).

**Blocked by:** None

**Status:** done

**Acceptance:**
- [x] Catalog enumerated and tested (count, maps round-trip, `tl`→`fil`, `jw`→`jv`, `en_us`→`en`, `eng`/`urd`/`zho`/`cmn`/`yue` normalize).
- [x] `joinTranscriptWords` fixtures: English, `今天天气很好。`, `2026年`, `「OpenAI」`, Thai with explicit `spaceBefore` phrase spaces, mixed Urdu+English, Japanese with Latin insertion.
- [x] Sentence split fixtures for each terminal + abbreviations/decimals unchanged + English `;` not a terminal.
- [x] `bun run --cwd packages/validators test` and `bun run typecheck` pass (callers of removed AssemblyAI exports may be left failing ONLY if listed in the return for tickets 06/11; prefer temporary minimal call-site updates that keep typecheck green).

## Comments

Verification (2026-10-30, branch feat/elevenlabs-scribe):
- `bun run --cwd packages/validators test`: 645 pass, 0 fail (new/rewritten: language, text-script, utterance-split suites).
- `bun run typecheck`: 15/15 tasks. `bun run test`: 12/12 tasks. `bun run lint`: exit 0 (only pre-existing warnings). `openapi:check`: 31 operations match. `test:inventory`: 0 problems.
- Catalog fetched from the ElevenLabs page: 100 listed languages + Yoruba = 101; the page's `zho`/`cmn` inconsistency matches the brief (reverse map accepts both).
- Judgement calls: Kurdish (`ku`) is registered as Latin/ltr (Kurmanji; Sorani would be Arabic) and Serbian as Cyrillic; both are only registry defaults, cue direction follows the text. Han/kana abut a digit (`2026年`) in the script fallback beyond D7's "both no-space" rule; Latin next to Han/kana still gets a space unless `spaceBefore` says otherwise.
- Call sites touched to stay green: web `_shared/languages.ts` (flat list), web `language-select.tsx` (no accuracy band, plain code tile), services `project.service.ts` (`storedLanguageCode` maps retired codes via `normalizeProviderLanguageCode`; STT model placeholder), services `ingest-job-lifecycle.ts` (placeholder model), worker `transcribe.ts` (local placeholder model chain, ticket 06 replaces), tests `project-language.test.ts` and api `ingest/routes.test.ts`, regenerated `public-v1.json` and the REST snapshot (the language enum changed).
