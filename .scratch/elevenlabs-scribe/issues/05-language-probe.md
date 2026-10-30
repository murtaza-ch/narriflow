# 05 — Bounded language probe (worker module only)

**What to build:** `apps/worker/src/language-probe.ts` implementing spec D6 with a frozen interface, e.g. `probeSourceLanguage({sourceUrl, durationSeconds, signal, workerProcess}): Promise<{pinned: CanonicalLanguageCode | null; detected: string|null; probability: number|null; wordCount: number; reason: string}>`. FFmpeg reads the three windows from the presigned URL with input seeking (no full download), concatenates to mono 16 kHz, synchronous Scribe POST (multipart, `scribe_v2`, no diarize, `tag_audio_events=false`), scratch cleanup, Worker Process Module cancellation rules. Never throws for probe failures (returns `pinned:null` + reason). Do not touch `tasks/transcribe.ts` (ticket 06).

**Blocked by:** 01

**Status:** ready-for-agent

**Acceptance:**
- [ ] Unit tests for window selection (60 s, 10 min, 3 h), threshold predicate, provider-code mapping, failure → unpinned.
- [ ] One live smoke run against the Urdu source (presign via existing R2 helper) recorded in the ticket: detected code, probability, words, elapsed, bytes read.
