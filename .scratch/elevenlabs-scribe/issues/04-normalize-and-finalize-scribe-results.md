# 04 — Scribe normalizer + shared finalizer service

**What to build:** In `packages/services`: `normalizeElevenLabsTranscript(payload, {allowEmpty, providerJobId, durationSeconds})` replacing `normalizeAssemblyAiTranscript` (delete it), and `finalizeScribeTranscript(...)` (spec D2) that stores raw JSON under `projects/<p>/transcripts/<run>-<attempt>-elevenlabs-scribe_v2.json` and completes via ticket 02's entry.
Normalizer: keep `type:"word"`; set `spaceBefore` from spacing tokens; seconds as-is, finite checks; dense speaker mapping in first-seen order with one stable unknown bucket; confidence null (`logprob` is not 0–1); group consecutive same-speaker words into turns; existing sentence splitter; language via `normalizeProviderLanguageCode`; duration from the probed source duration, not last word; normalization errors are permanent (`retryable:false`).

**Blocked by:** 01, 02

**Status:** ready-for-agent

**Acceptance:**
- [ ] Fixtures from real payloads in `/tmp/stt-bench/out/*.el_pinned.json` (trim to small slices): English diarized, zh per-character, ja, Urdu RTL + English, audio_event + spacing, missing speaker_id, empty transcript allowed/not allowed.
- [ ] `bun run --cwd packages/services test` green.
