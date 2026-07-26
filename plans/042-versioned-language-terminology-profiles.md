# Plan 042: Create versioned language and terminology profiles across outputs

> **Product-foundation plan**: Implement before production dubbing and before
> workspace personalization depends on vocabulary/locale choices. This does not
> mean promising all provider languages. Ship a small, measured quality matrix
> and expose provider/model fallbacks truthfully.
>
> **Drift check**:
> `git diff --stat 05d273d..HEAD -- packages/validators/src/language.ts packages/db/prisma/schema.prisma packages/db/prisma/migrations packages/services/src/transcript.service.ts packages/services/src/project.service.ts apps/worker/src/tasks/transcribe.ts apps/worker/src/tasks/detect-clips.ts apps/worker/src/tasks/content-suite.ts apps/worker/src/tasks/dubbing.ts 'apps/web/app/(app)'`

## Status

- **Priority**: P1 product-quality foundation
- **Effort**: M
- **Risk**: MED
- **Confidence**: HIGH
- **Depends on**: plans/024-multilingual-foundation.md,
  plans/041-production-shaped-integration-gates.md
- **Category**: multilingual, feature, data, UX, provider quality
- **Planned at**: commit `05d273d`, 2026-07-10, live working tree

## Why this matters

Narriflow's current AssemblyAI model chain and 102-code submit enum are correct,
but language behavior is fragmented:

- automatic detection is enabled, while `language_confidence` is omitted from
  normalization and persistence (`packages/services/src/transcript.service.ts:25-45,263-273`;
  `packages/db/prisma/schema.prisma:271-290`);
- key terms are one deployment-wide environment string
  (`apps/worker/src/tasks/transcribe.ts:152-166`), not user/project data;
- project source language, target dub language, prompts, brand snapshots,
  captions, and content-suite output have no shared versioned locale contract;
- Plan 026 already requires glossary versions but no creation/governance feature
  currently defines them.

Descript exposes a drive-level do-not-translate glossary, OpusClip has brand
vocabulary, and Submagic sells a custom dictionary. Narriflow can go further by
making the effective terminology/locale profile auditable across every artifact,
not only transcription.

Current primary references:

- <https://www.assemblyai.com/docs/pre-recorded-audio/universal-3-5-pro>
- <https://www.assemblyai.com/docs/api-reference/transcripts/submit>
- <https://help.descript.com/hc/en-us/articles/37973459800589-Manage-your-do-not-translate-list>
- <https://help.opus.pro/docs/article/brand-vocabulary>

## Product outcome

A workspace/show can define names, products, acronyms, pronunciation hints,
translations, protected terms, tone/register, script/caption preferences, and
approved locales once. Every transcript, candidate, content asset, caption,
metadata payload, and dub records the exact profile version it consumed and
surfaces language uncertainty before publication.

Non-goals for V1:

- Do not build a general translation-management system.
- Do not claim equal quality across all 99 provider languages.
- Do not silently rewrite historical artifacts when a profile changes.
- Do not send every sensitive workspace term to every provider by default.

## Phase 0: Approve locale and data policy

Choose an initial quality matrix from actual target customers, for example:

- English global/US/UK plus Spanish;
- one RTL locale (Arabic or Urdu);
- one Indic/code-switching path (Hindi-English);
- one CJK locale (Japanese or Mandarin);
- Turkish for locale-aware casing/segmentation coverage.

For each surface (STT, clip/content generation, captions, metadata, TTS/dub),
record provider/model support, fallback, script/font coverage, QA owner, cost,
latency, data retention/training terms, and current quality threshold. A locale
can be supported for transcription while still being unavailable for dubbing.

Approve whether glossary terms may contain personal/client-sensitive data and
which providers receive which fields. Default to the minimum necessary term
list and require owner visibility.

## Phase 1: Versioned profile schema

Add an ownership model consistent with the approved ICP. Until workspace
ownership is implemented, a user-owned profile can be linked to projects/brand
templates without pretending Team RBAC is complete.

Suggested immutable version contents:

- display name and optional show/brand association;
- source-language mode/code and allowed code-switching language set;
- target locales per output type;
- preferred spellings and case-sensitive display forms;
- pronunciation hints where supported;
- provider-safe key terms/context prompt;
- do-not-translate terms plus locale-specific approved translations;
- tone/register/formality, second-person style, prohibited substitutions;
- caption script rules: casing, punctuation, line-break/reading-speed targets,
  numeral/date/measurement formatting and dual-caption preference;
- owner/reviewer, proofread status, notes, created/activated/retired timestamps.

Edits create a new immutable version. Projects/content packs snapshot the
effective version ID/hash. A retired profile remains readable for provenance.
Do not store the whole profile redundantly on every artifact if one immutable
version reference plus bounded execution snapshot is sufficient.

## Phase 2: Language-confidence and source review

- Capture AssemblyAI `language_confidence` and detection mode/threshold in the
  transcript/provider provenance.
- Set an eval-backed confidence policy. Below it, transcription may complete but
  downstream auto-render/publish is blocked pending a user confirmation or
  retranscription with explicit language. Do not invent one global threshold
  without multilingual fixtures.
- Show detected language, confidence band, actual provider model/fallback, and
  a clear “confirm or retranscribe” action. Never allow changing the label alone
  while keeping a transcript produced under another language.
- Preserve segment-level code switching/provenance when the provider returns it;
  otherwise label mixed-language behavior as inferred/unsupported rather than
  fabricating precise segments.

## Phase 3: Provider adapters consume one effective contract

Create a pure resolver that produces the minimal effective profile for each
operation and records a redacted execution snapshot/hash.

- **Transcription**: source code/detection, allowed code-switching set,
  contextual prompt and bounded key terms based on actual model limits.
- **Clip/content generation**: source/target locale, protected names/numbers,
  tone/register, editorial brief, locale-specific output rules.
- **Captions**: script-aware font fallback, punctuation/casing, line breaks,
  reading speed, directionality, numeral handling.
- **Social metadata**: platform locale, protected terms, hashtags/casing without
  translating brand names accidentally.
- **Dubbing**: structured segment IDs, source/target locale, approved
  translations, pronunciation/voice rules and Plan 026's timing/caption QA.

Validate that each provider supports the requested option. Unsupported fields
must be omitted with a visible capability result; do not rely on providers
silently ignoring options.

## Phase 4: Correction-to-profile UX

- Add one lightweight profile manager under brand/show settings.
- During transcript/caption/content review, allow “correct this occurrence” and
  an explicit “save for future projects” action. Never silently promote a one-
  off edit into workspace truth.
- Show conflicts/duplicates, exact-match behavior, term limits, provider scope,
  and which future artifacts will change.
- Add import/export as a small reviewed CSV/JSON contract only after the core UI
  works; validate every row and provide partial error reporting.
- Profile edits affect future/re-generated artifacts only. Offer explicit
  selective regeneration with cost/invalidations; do not mutate published or
  approved content.

## Phase 5: Quality evaluation and observability

Create consented, privacy-safe golden fixtures per launch locale covering:

- names, brands, acronyms, numbers, currency, dates and measurements;
- code switching, RTL, CJK/Indic segmentation and locale-aware casing;
- ambiguous language detection and low-quality/noisy audio;
- captions at narrow/wide formats and font fallback;
- translated protected terms and do-not-translate behavior.

Measure word/name/number accuracy, terminology adherence, untranslated spans,
caption overflow/reading speed, user correction rate, language-confirmation
rate, and publish-block incidents by locale/model/profile version. Do not reduce
everything to one global “accuracy” score.

## Test plan

- Unit: profile/version schemas, conflict resolution, exact/case behavior,
  provider-specific limits, redacted snapshot/hash, locale formatting.
- Integration: create/edit/activate/retire, project snapshot, old artifact
  provenance, concurrent edit winner, tenant boundaries, deletion/retention.
- Provider contracts: U3.5 direct/U2 fallback, explicit/auto detection,
  low-confidence response, unsupported option warning, key-term limit.
- Golden output: English, Spanish, Hindi-English, Arabic/Urdu, Japanese/Mandarin,
  Turkish; names/numbers and caption frames.
- E2E: set profile → transcribe → confirm low confidence → correct/save term →
  regenerate candidate/content/caption → verify future-only effect.

## Done criteria

- [ ] One immutable profile version governs terminology/locale behavior across
  transcript, generation, captions, metadata, and dubbing.
- [ ] Every generated artifact records effective profile provenance.
- [ ] Low-confidence automatic detection is visible and blocks unsafe
  downstream automation according to an eval-backed policy.
- [ ] Users can correct once or explicitly save a future rule without silent
  global changes.
- [ ] Provider option/fallback support is truthful per surface and locale.
- [ ] Launch-locale golden gates pass; unsupported locales are labelled instead
  of overpromised.
- [ ] Historical approved/published artifacts never change on profile edit.

## STOP conditions

- Initial customer locales and measurable acceptance thresholds are undecided.
- Profile ownership is implemented as Team/workspace data before the ownership
  model/RBAC decision is approved.
- Sensitive glossary terms would be sent to providers without data-policy
  approval and user visibility.
- A correction silently alters old/published artifacts or every workspace.
- The implementation claims precise code-switching provenance the provider did
  not return.
- Plan 026 begins production dubbing without consuming a pinned profile version.
