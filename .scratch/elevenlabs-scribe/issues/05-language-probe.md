# 05 — Bounded language probe (worker module only)

**What to build:** `apps/worker/src/language-probe.ts` implementing spec D6 with a frozen interface, e.g. `probeSourceLanguage({sourceUrl, durationSeconds, signal, workerProcess}): Promise<{pinned: CanonicalLanguageCode | null; detected: string|null; probability: number|null; wordCount: number; reason: string}>`. FFmpeg reads the three windows from the presigned URL with input seeking (no full download), concatenates to mono 16 kHz, synchronous Scribe POST (multipart, `scribe_v2`, no diarize, `tag_audio_events=false`), scratch cleanup, Worker Process Module cancellation rules. Never throws for probe failures (returns `pinned:null` + reason). Do not touch `tasks/transcribe.ts` (ticket 06).

**Blocked by:** 01

**Status:** done

**Acceptance:**
- [x] Unit tests for window selection (60 s, 10 min, 3 h), threshold predicate, provider-code mapping, failure → unpinned.
- [x] One live smoke run against the Urdu source (presign via existing R2 helper) recorded in the ticket: detected code, probability, words, elapsed, bytes read.

## Comments

**Implemented 2026-10-30** — `apps/worker/src/language-probe.ts` (+ `language-probe.test.ts`, 15 tests). Interface:

```ts
probeSourceLanguage({ sourceUrl, durationSeconds, signal, workerProcess, apiKey?, fetch? }):
  Promise<{ pinned: SourceLanguageCodeValue | null; detected: string | null; probability: number | null; wordCount: number; reason: string }>
```

One ffmpeg process with three `-rw_timeout … -ss S -t 20 -i <presigned url>` inputs, `concat` + `aresample=16000`, mono PCM WAV in a `withScratchDirectory`; one multipart POST (`scribe_v2`, `tag_audio_events=false`, `timestamps_granularity=word`, no diarize). Failures return `pinned:null` with a reason; an aborted signal rethrows (cancellation is not a probe failure).

**Live smoke (shared R2, real Scribe, ≈ $0.01 total):**

| source | duration | detected | probability | words | elapsed | bytes read (3 inputs) | result |
|---|---|---|---|---|---|---|---|
| Urdu podcast | 973 s | `hin` | 0.970 | 196 | 9.9 s | 16.5 MB (6.0+4.7+5.7) | pinned `hi` — **wrong** |
| English podcast | 4101 s | `eng` | 0.989 | 183 | 11.2 s | 19.6 MB (6.1+6.8+6.7) | pinned `en` |

**Finding:** Scribe hears the Urdu source as Hindi at 0.97 and returns a Devanagari transcript (625 Devanagari / 0 Arabic chars). Pinning that would force the wrong script — the failure the probe exists to prevent. Hindi/Urdu are one spoken language, so the probe now never pins `hi`/`ur` (`reason: "hindi_urdu_ambiguous"`) and the run falls back to Auto. Consequence: an Urdu source still goes through Auto (which per the benchmark can mix scripts) until the owner picks Urdu explicitly. Possible follow-up for the owner: a script-aware rule (dominant script of the probe text) — not done, since Auto's own Urdu behaviour is the open question.
