# 04 — Scribe normalizer + shared finalizer service

**What to build:** In `packages/services`: `normalizeElevenLabsTranscript(payload, {allowEmpty, providerJobId, durationSeconds})` replacing `normalizeAssemblyAiTranscript` (delete it), and `finalizeScribeTranscript(...)` (spec D2) that stores raw JSON under `projects/<p>/transcripts/<run>-<attempt>-elevenlabs-scribe_v2.json` and completes via ticket 02's entry.
Normalizer: keep `type:"word"`; set `spaceBefore` from spacing tokens; seconds as-is, finite checks; dense speaker mapping in first-seen order with one stable unknown bucket; confidence null (`logprob` is not 0–1); group consecutive same-speaker words into turns; existing sentence splitter; language via `normalizeProviderLanguageCode`; duration from the probed source duration, not last word; normalization errors are permanent (`retryable:false`).

**Blocked by:** 01, 02

**Status:** done

**Acceptance:**
- [x] Fixtures from real payloads in `/tmp/stt-bench/out/*.el_pinned.json` (trim to small slices): English diarized, zh per-character, ja, Urdu RTL + English, audio_event + spacing, missing speaker_id, empty transcript allowed/not allowed.
- [x] `bun run --cwd packages/services test` green.

## Comments

- 2026-10-30 (Sonnet): done. `normalizeElevenLabsTranscript` replaces the AssemblyAI normalizer (deleted with its tests); `TranscriptNormalizationError` now carries `retryable:false` and code `elevenlabs_result_invalid`. `finalizeScribeTranscript` = `scribe-transcript.ts` (injected `createScribeFinalizer`) + `scribe-transcript-runtime.ts` (production binding: lifecycle, `projectService.runAllowsEmptyTranscript`, `getSourceProbeDurationForWorker`, R2 `putJson`). Raw JSON is stored even when normalization fails (evidence), then the attempt fails permanently. The API already has R2 env (env-check requires `R2_*` in api).
- Fixtures: trimmed real slices in `packages/services/src/test-fixtures/scribe/` (en diarized, zh, ja, ur, hi mixed English, podcast ~143 words). Real payloads contain no `audio_event` tokens and the Urdu slice has no Latin words, so those two cases splice synthetic tokens in the test.
- Evidence: `bun run --cwd packages/services test` 1474 pass / 0 fail; `bun run typecheck` 15/15; lint: only existing warnings. `apps/worker` tests: 3 failures in `ingest.test.ts` (media-duration probing, unrelated).
