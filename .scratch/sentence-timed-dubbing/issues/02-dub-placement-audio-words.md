# 02 - Dub trim, placement, mix and caption words (media, pure + ffmpeg)

**What to build:** In `apps/media/src/tasks/`: `dub-placement.ts` (spec §3 Placement, pure), caption-word tokenisation and proportional timing (spec §3 Caption words, pure), and ffmpeg helpers in `dub-mix.ts` that trim one TTS clip (spec §3 Trim) and build the final MP3 from placed clips (spec §3 Audio). Remove `muxDubbedVideo`.

**Blocked by:** None

**Status:** done

## Acceptance
- [x] `placeDubSegments({ editedDurationSec, segments: { startSec, naturalSec }[] })` returns `{ kind: "placed", segments: { startSec, endSec, tempo }[] } | { kind: "unfit", segmentIndex }` with the exact constants and formulas in the spec.
- [x] `dubCaptionWords(text, language, startSec, endSec)` uses `Intl.Segmenter`, attaches punctuation to the preceding token, records `spaceBefore`, spreads time by grapheme count, works for ur, ar, hi, zh, ja, es.
- [x] Trim and mix helpers run through `WorkerProcessModule` like the existing dub-mix code; mixing places each clip at `startSec` with `atempo`, output length exactly `editedDurationSec`, MP3.
- [x] Unit tests: placement fit, tempo > 1, lateness bound never exceeded, unfit cases (deadline <= start, tempo over cap), last segment bounded by clip end; word timing monotonic and inside the segment; ffmpeg arg builders.
- [x] `bun run lint`, `bun run typecheck`, `bun run test` pass.

## Comments

- 2026-11-19: Added `apps/media/src/tasks/dub-placement.ts` (`placeDubSegments`, `dubCaptionWords`, `GAP`/`LATE_MAX`/`TEMPO_MAX`) and, in `dub-mix.ts`, `trimDubClip`/`mixDubAudio` with pure builders `buildTrimDubClipArgs`/`buildMixDubAudioArgs`. 30 unit tests in `dub-placement.test.ts` and `dub-mix.test.ts` (2000 random plans hold start_i <= s_i + LATE_MAX). Smoke-ran both builders against real ffmpeg: trim gave 24 kHz mono pcm_s16le; an 8 s mix gave 24 kHz mono MP3 reporting 8.064 s (MP3 frame/encoder padding; sample-exact length is not possible in MP3).
- `muxDubbedVideo` is deliberately still in `dub-mix.ts`: `dubbing-native.ts` still imports it. The ticket that rewrites `dubbing-native.ts` (03) must delete it.
- `bun run lint` (0 errors, 20 pre-existing warnings), `bun run typecheck` (15/15) and `bun run test` (14/14) pass.
