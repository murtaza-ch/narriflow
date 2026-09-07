# Plan 024: Establish a provider-accurate multilingual generation foundation

> **Executor instructions**: Follow every step and gate. Touch only scoped
> files. Stop on any STOP condition. The reviewer maintains the plan index.
>
> **Working-tree override**: the uncommitted tree is the current product. Work
> directly in it. Do not branch, stage, commit, push, or revert user work.
>
> **Drift check**:
> `git diff --stat 05d273d..HEAD -- packages/validators/src apps/web/app/'(app)'/_shared/languages.ts apps/worker/src/tasks/transcribe.ts apps/worker/src/tasks/detect-clips.ts packages/services/src/transcript.service.ts packages/services/src/project.service.ts packages/services/src/content-suite.service.ts apps/worker/Dockerfile README.md ROADMAP.md`
> Inspect live excerpts because these paths intentionally differ from HEAD.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: plan 021
- **Category**: correctness, ux, accessibility, tests
- **Planned at**: commit `05d273d`, 2026-07-09, live working tree
- **Result**: REOPENED — the provider chain, 102-code registry, normal clip/
  content prompts, fonts and exact content-output validation are implemented.
  Fresh review found four integration/Unicode gaps below; complete them before
  restoring DONE.

## Why this matters

Narriflow advertises multilingual output but requests the superseded
`universal-3-pro`, exposes only 15 manually selected source languages, injects
unrelated demo names/brands into every eligible transcript, and does not tell
clip/content generation which language to preserve. Non-Latin worker images
also lack deliberate CJK/Arabic/Indic font coverage. The result can be wrong
language, biased names, missing glyphs, or a content-suite response that is
partial but reported as success.

## Authoritative current documentation

Use the official AssemblyAI pages fetched on 2026-07-09:

- `https://www.assemblyai.com/docs/pre-recorded-audio/select-the-speech-model`
  — default/recommended chain is `universal-3-5-pro`, then `universal-2`.
- `https://www.assemblyai.com/docs/pre-recorded-audio/universal-3-5-pro`
  — U3.5 Pro provides native code switching, contextual prompting, 18 core
  languages, and automatic U2 fallback for 99-language coverage.
- `https://www.assemblyai.com/docs/pre-recorded-audio/supported-languages`
  — exact current supported languages and quality bands.
- `https://www.assemblyai.com/docs/api-reference/transcripts/submit`
  — use the current `TranscriptLanguageCode` enum for exact provider codes;
  do not infer codes from English labels.

The configured legacy AssemblyAI MCP warns it will shut down on 2026-07-16;
this is an environment maintenance note, not application code.

## Current state

- `apps/worker/src/tasks/transcribe.ts:45` hardcodes
  `['universal-3-pro','universal-2']`.
- `packages/services/src/project.service.ts:132-134` and
  `packages/services/src/transcript.service.ts:93-99` repeat/fabricate the same
  legacy chain.
- `transcribe.ts:46-53` globally biases every transcript toward `MrBeast`,
  `Xavien`, `Juan`, `Fort Freezy`, `Square`, and `Coca-Cola`.
- `apps/web/app/(app)/_shared/languages.ts` contains Auto plus 15 languages,
  while official fallback coverage is 99.
- Project/upload validators accept arbitrary short strings, so unsupported
  codes reach the provider.
- `detect-clips.ts` loads `transcriptRow.languageCode` but does not add it to
  the prompt. `content-suite.service.ts` does not even select it.
- Content-suite schema accepts empty, duplicate, and incomplete asset arrays;
  the service upserts whatever arrived and returns historical rows, allowing
  stale types to masquerade as a complete generation.
- `apps/worker/Dockerfile` includes Latin display fonts and emoji but no
  deliberate Noto core/CJK/extra families.

## Scope

Only modify/create:

- `packages/validators/src/language.ts` (create)
- `packages/validators/src/language.test.ts` (create)
- `packages/validators/src/index.ts`
- `packages/validators/src/project.ts`
- `packages/validators/src/upload.ts`
- `packages/validators/src/content-asset.ts`
- `packages/validators/src/content-asset.test.ts`
- `apps/web/app/(app)/_shared/languages.ts`
- `apps/web/app/(app)/upload/_lib/content-pack-form.ts`
- `apps/web/app/(app)/upload/_lib/content-pack-form.test.ts`
- `apps/worker/src/tasks/transcribe.ts`
- `apps/worker/src/tasks/detect-clips.ts`
- `packages/services/src/transcript.service.ts`
- `packages/services/src/transcript.service.test.ts`
- `packages/services/src/project.service.ts`
- `packages/services/src/content-suite.service.ts`
- `packages/services/src/content-suite.service.test.ts` (create if useful)
- `apps/worker/Dockerfile`
- `README.md`
- `ROADMAP.md`

Out of scope:

- Database schema/migrations for language confidence, generation provenance,
  locale variants, or glossaries.
- Dubbing target-language list, TTS model migration, segment timing, translated
  captions, lip sync, or voice cloning.
- Caption token segmentation/bidi renderer redesign; this pass supplies glyph
  coverage, while script-aware cue layout remains a follow-up.
- Guessing unsupported provider codes or changing billing.

## Commands

| Purpose | Command | Expected |
|---|---|---|
| Language tests | `bun test packages/validators/src/language.test.ts` | all pass |
| Content tests | `bun test packages/validators/src/content-asset.test.ts` | all pass |
| Transcript tests | `bun test packages/services/src/transcript.service.test.ts` | all pass |
| Full lint | `bun run lint:biome` | exit 0 |
| Full typecheck | `bun run typecheck` | exit 0 |
| Full tests | `bun run test` | exit 0 |
| Build | `bun run build` | exit 0 |

## Steps

### Step 1: Create one provider-accurate source-language registry

Add a validator-owned registry derived from the current official API enum.
Each entry must have an exact AssemblyAI code, human label, whether U3.5 Pro
handles it directly or U2 is the fallback, and the official U2 accuracy band
when documented. Include Auto as a UI mode, not as a provider language code.

Export:

- immutable `ASSEMBLYAI_SPEECH_MODELS = ['universal-3-5-pro','universal-2']`;
- the exact U3.5 language-code set;
- all documented source-language entries without duplicate codes;
- a Zod schema for nullable/manual source codes;
- helpers to normalize form `auto` to null and return a display label.

Use the API's exact codes (including any regional/underscore code it defines),
not invented BCP-47 conversions. Preserve existing persisted codes that are in
the official enum. Make project and upload validators use this shared schema.
Derive web `LANGUAGE_OPTIONS` from the registry and visually distinguish
high-accuracy U3.5 choices from extended U2 fallback choices in labels without
claiming equal quality.

Tests must assert: all codes unique; all 18 documented U3.5 languages are
represented; representative U2-only codes (Urdu, Korean, Russian) validate;
invalid code rejects; Auto maps to null; existing codes en/es/pt/fr/de/it/nl/
ru/tr/id/hi/ar/zh/ja/ko remain accepted.

**Verify**: language tests pass and UI has no independently maintained list.

### Step 2: Upgrade transcription and remove global vocabulary bias

Use the shared model chain everywhere instead of repeated strings. Update the
worker request, project metadata, transcript normalization fallback/tests, and
docs to U3.5 Pro → U2.

Delete all demo/default keyterms. Only explicitly configured, trimmed,
deduplicated environment vocabulary may be sent. Since the fallback chain can
route to U2, cap provider keyterms at U2's documented safe limit (200) and keep
the six-words-per-phrase constraint. Do not silently inject project examples.
Use keyterms for official supported languages only; Auto is allowed with the
documented fallback chain.

Preserve the provider's actual `speech_model_used` when present. When absent,
store an honest unknown/null-compatible value if the current type permits; if
the DB shape requires a string, store the requested chain clearly labeled as
requested/fallback rather than claiming which model ran. Do not add a schema
migration.

**Verify**:

- `rg -n 'universal-3-pro|MrBeast|Xavien|Juan|Fort Freezy|Coca-Cola' apps packages README.md ROADMAP.md`
  returns no matches (ordinary unrelated `Square` text need not be banned).
- Transcript normalization tests cover actual model and missing-model behavior.

### Step 3: Preserve source language in clip and written-content generation

Pass the detected/manual transcript language into clip detection and content
suite prompts. The contract must say:

- write user-facing title/hook/payoff/reasoning/assets in the source language
  unless a future explicit target locale is supplied;
- preserve script, proper names, product names, numbers, quotations, and
  intentional code switching;
- do not translate the transcript merely because system instructions are
  English;
- if language is unknown, infer it from the transcript and stay consistent.

For content suite, select transcript `languageCode`, include it in the prompt,
and improve transcript truncation so later sections are not always discarded
(for example, deterministic head/middle/tail excerpts within the existing
48k-char bound). Keep the structured response API and model choice.

Add pure prompt/selection tests when feasible; never call OpenAI in tests.

**Verify**: both generation paths consume language code and tests demonstrate
non-English language instructions plus preservation of names/numbers.

### Step 4: Reject incomplete/stale content-suite success

Before any database write, require exact set equality between requested output
types and returned assets: same count, every requested type once, no duplicates,
no missing/extras. Reflect exact min/max item count in the JSON schema. If this
fails, return `openai_bad_output` and write nothing.

After a valid transaction, return only the newly generated requested rows, not
unrelated historical assets. Keep upsert behavior for those requested types.

Tests must reject empty, duplicate, missing, and extra asset sets and accept an
exact complete set in any order.

**Verify**: content validator/service tests pass.

### Step 5: Bundle broad script font coverage

In the Debian worker image install supported Noto families for core scripts,
CJK, and extra scripts alongside the existing emoji and Latin fonts. Keep apt
cache cleanup and existing downloaded brand fonts. Do not allow a required
system font package install to fail silently.

Add an image-build maintenance comment naming representative coverage (Arabic/
Hebrew, Devanagari/Indic, CJK). Do not claim preview/export typography parity
until script-aware cue segmentation is implemented.

**Verify**: Dockerfile syntax is valid and `fc-list`/image build instructions in
maintenance notes make representative font verification straightforward.

### Step 6: Update truthful docs and run release gates

Update README/ROADMAP legacy model references and language claims. State 18
U3.5 core languages + U2 fallback to 99, and clearly list remaining limitations:
no persisted language-confidence UI, no glossary/profile, dubbing remains
segment/timing work, and script-aware caption layout evaluation remains open.

Run all gates and inspect the full diff.

### Step 7: Close multilingual integration gaps (reopened follow-up)

1. **Autopilot validation**: replace the arbitrary 2–16-character language
   validator at `packages/validators/src/autopilot.ts:11-17` with the shared
   nullable `sourceLanguageCodeSchema`. Reject unsupported codes at create/update
   instead of letting `project.service.ts:2477-2489` silently convert them to
   Auto. Audit/backfill existing invalid rows and test create, update and import.
2. **Caption-only metadata**: `detect-clips.ts:889-917` hardcodes English
   reasoning and `clip-card.tsx:865-875` displays it as generated “Why this
   clip.” For caption-only provenance, suppress creative analysis/score copy or
   derive neutral source-language metadata without adding an LLM call. Add a
   non-Latin fixture and ensure no English generated metadata leaks into the
   output/review contract.
3. **Unicode-safe excerpts**: `content-suite.service.ts:37-51` slices arbitrary
   UTF-16 offsets. Align head/middle/tail cuts to grapheme and preferably word
   boundaries with a deterministic code-point-safe fallback while preserving
   the prompt cap. Test surrogate-pair emoji/supplementary CJK and combining
   sequences at all three boundaries.
4. **Direct orchestration contracts**: extract injectable request/prompt helpers
   and test manual versus Auto AssemblyAI request branches, U3.5→U2 chain,
   provider model persistence, non-Latin/entity/number prompt preservation,
   caption-only behavior and content-suite source-language input. No live model
   call in unit tests.

## Done criteria

- [x] One tested registry owns every manual source language and provider model.
- [x] U3.5 Pro → U2 is used everywhere; global demo keyterms are gone.
- [x] Invalid source codes fail before provider calls.
- [x] Clip/content outputs explicitly preserve source language/script/entities.
- [x] Content generation cannot report partial/stale results as success.
- [x] Worker image has deliberate Noto core/CJK/extra coverage.
- [x] Docs are current and limitations remain honest.
- [x] Targeted and full lint/typecheck/tests/build pass.
- [x] No out-of-scope file changed.
- [ ] Autopilot accepts only the shared provider source-language enum and never
  silently falls back from invalid manual input.
- [ ] Caption-only projects expose no hardcoded English generated analysis for a
  non-English source.
- [ ] Long transcript excerpts cannot split Unicode grapheme/code-point
  boundaries.
- [ ] Manual/Auto provider routing and non-Latin prompt contracts have direct
  request-level tests.

## STOP conditions

Stop and report if:

- The exact provider code list cannot be verified from official current docs.
- Strict validation would reject an existing official code with no compatible
  normalization path.
- A requested improvement requires a DB migration or dubbing redesign.
- Font packages are unavailable in the worker's Debian base repository.
- Any implementation uses guessed model/language claims.
- A gate fails twice after one reasonable correction.

## Maintenance notes

- Persisted language confidence/detection results and a human QA queue should
  be the next multilingual data plan.
- A project terminology/glossary profile should replace env-only keyterms.
- Timed per-utterance dubbing and translated/dual caption renders are necessary
  before calling dubbing publication-grade.
