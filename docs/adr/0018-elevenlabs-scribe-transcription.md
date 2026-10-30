# ElevenLabs Scribe v2 transcribes every Project; the language is pinned from the user's choice or a probe

Narriflow transcribes with ElevenLabs Scribe v2 (`scribe_v2`). AssemblyAI is removed in the same change (pre-production policy: no dual provider, no fallback to the old path). Stored transcripts stay readable because the normalized transcript model is provider-neutral; historical `provider="assemblyai"` rows and raw JSON are left as they are.

## Why

Measured 2026-10-29/30 (evidence: [spec](../../.scratch/elevenlabs-scribe/spec.md), [FLEURS benchmark](../../.scratch/elevenlabs-scribe/benchmark-fleurs.md), [vendor matrix](../../.scratch/elevenlabs-scribe/sol-scribe-vs-assemblyai.md), [spec review](../../.scratch/elevenlabs-scribe/sol-spec-review.md)):

- AssemblyAI auto-detect labelled an Urdu video Hindi and routed it to a model that mixed scripts and dropped 226 s of speech.
- On FLEURS (16 languages, language set) Scribe v2 had the lower error in 13 of 16, ties in two. Price is equal (about $0.22/h with diarization).
- Scribe's own auto mode on full files can also mix scripts or drop speech; pinned to the right language it was clean in every case.

## Decisions

- **One model, one language registry.** `packages/validators/src/language.ts` holds Scribe's published catalog plus Yoruba (101 languages). The stored code is ISO 639-1 where one exists, else ISO 639-3. Explicit forward (canonical to the 639-3 code Scribe takes) and reverse maps exist; the reverse map also accepts `cmn`. `normalizeProviderLanguageCode` maps provider results, `tl` to `fil`, `jw` to `jv`, and regional tags (`en_us` to `en`); a language outside the registry is null.
- **Probe, then pin.** A chosen language is sent as-is. On Auto the worker probes only when the source is at least 60 s: three non-overlapping 20 s windows centred at 20/50/80 %, read by FFmpeg range requests from the presigned URL, one synchronous Scribe call without diarization. It pins only when `language_probability >= 0.80`, the probe returned at least 15 words, and the code maps into the registry; otherwise the full run is unpinned. These thresholds are heuristics chosen from the benchmark, recorded in code with this rationale. A probe failure never fails the run, and usage is unchanged (ADR 0012). Script variants (Hindi/Urdu, Serbian Cyrillic/Latin) cannot be decided from audio; users who need one pick it in the picker.
- **Durable submission, accepted duplicate cost.** Before the full POST the worker records provider-wait intent on the current attempt through the lifecycle (run `waiting`, no provider id, a submission deadline). On 202 it records `request_id` and `transcription_id`; `providerJobId` is the `transcription_id`. A waiting run with no accepted id past its deadline fails the attempt as retryable, and the next attempt resubmits. A POST that timed out may already be billed, so a crash that loses both the 202 and the callback can cost one duplicate transcription. We accept that rather than build an idempotency lookup the vendor does not offer.
- **One finalizer, two triggers.** A service-owned `finalizeScribeTranscript` normalizes the result, stores the raw JSON under an attempt-and-provider-specific key, and completes the transcript fenced by run and attempt (and provider id when known). The signed webhook calls it with the callback payload; the worker's GET recovery calls the same function. Duplicate, stale, cancelled or terminal deliveries are acknowledged no-ops. `ownedAttemptWhere` is not loosened.
- **Text is script-aware.** `TranscriptWord.spaceBefore` records the provider's spacing (zh/ja arrive per character, Thai spaces phrases). `joinTranscriptWords` in `packages/validators/src/text-script.ts` is the only word joiner: explicit `spaceBefore` wins, else a script rule. Cue direction comes from the first strong character; casing is locale-aware and never produces Georgian Mtavruli.
- **Requested versus detected language.** `Project.languageCode` (requested, nullable) stays separate from `Transcript.languageCode` (detected). Captions, fonts, casing and direction use the effective language, transcript first.

## Consequences

Every later piece (worker adapter, webhook route, migration of stored codes, fonts, RTL rendering, picker) builds on these contracts. Thresholds in the probe may need tuning once real traffic exists. Free-form Roman-script captions and a re-transcribe action are out of scope.
