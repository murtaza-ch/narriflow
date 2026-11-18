# 05 - Render the dub export with dub audio and target captions

**What to build:** Spec §4 render input and §5: `renderExecutionInputSchema.dub`, `createRenderInputSnapshot`, transfer sources in `render-group-execution.ts`, Python `render_runtime.py` scoped sources, Bun source map in `render-group.ts`, `clip-render-attempt.ts` passing `captionOverride` and the dub file, ffmpeg builders in `composition-ffmpeg-adapter.ts`, and `render-output-validation.ts`.

**Blocked by:** 01, 04

**Status:** done

## Acceptance
- [x] A render group whose export has a dub renders with the dub as dialogue (all three builders), scene wrapping intact, no original-audio processing, captions from the override in the dub language.
- [x] Unit tests for the ffmpeg arg builders with a dub input (single, B-roll, audiogram, with and without scenes/music) and for output validation expectations.
- [x] `bun run lint`, `bun run typecheck`, `bun run test` pass; do not run the slow Python render runtime suite.

## Comments

- 2026-11-19: Done (uncommitted). Flow: dub export -> `createRenderInputSnapshot` (joins `ClipExport.dubId`, verifies the completed dub of this revision and its sealed `audio`/`timing` artifacts, HEADs the audio for key/etag/size/sha256, reads the `timing` JSON through `readArtifactJson`) -> `renderExecutionInputSchema.dub` (+ `captionLanguage` = dub language) -> `dub_audio` source in the API transfer sources, Python scoped sources and the Bun source map -> `clip-render-attempt` downloads and probes it (a bad file fails the render, it never degrades), plans with `captionOverride` and `source.hasAudio = true`, binds `dub: { path }` into the audio request -> the three builders add it as the last `-i`.
- Builders: the dub is `aresample=48000,aformat=stereo,apad,atrim=duration=<pre-scene edited length>` into `[composition_dub_audio]`, which replaces the source dialogue (no `alignSourceAudioClock`, no cut-concat audio, no `[0:a]` reference). Scene wrapping takes a new `unityGain` option so the source gain/mute never reaches it; the mix and dialogue filters receive a unity-gain copy of the audio request; censors with a dub throw `dub_censor_unsupported`. The audiogram splits the dub label because a filter output cannot have two readers.
- Deviation 1: output validation expects the delivery format the dub filter produces (48 kHz, 2 channels; presence only when music/scenes mix) instead of the dub file's own rate/channels, because the filter normalizes the dub so music is not narrowed to 24 kHz mono. The dub file is probed only for decodability.
- Deviation 2: the earlier layout-evidence `planClipComposition` call is untouched (captions do not change its evidence requests).
- No-dub evidence: `__fixtures__/composition-no-dub-args.json` holds 27 argument lists recorded from the builders before any adapter edit (single, B-roll, audiogram x plain/cut/music/scenes/scenes+music+cut/source gain/muted, plus silent-source variants); `composition-dub-audio.test.ts` asserts `toEqual` against each.
- Tests: `composition-dub-audio.test.ts` (71: golden no-dub args, dub args per builder/scenario incl. unused-label check, expectation unit tests, 5 real ffmpeg renders with MP3 dub through `validateRenderOutput`), `render-dub.test.ts` (14), `render-input-snapshot.test.ts` (5, fake transaction), extended `render-execution-input.test.ts`, Python `test_a_dub_narration_is_a_scoped_source_beside_the_original_and_the_frozen_assets` (single test only, 0.2 s; the slow suite was not run).
- Out-of-scope fix, needs your eye: `dubbing-native.test.ts` "real translated speech..." failed in 3 of 3 `bun run test` runs once the new media tests existed. Root cause is a ticket 02 bug, reproducible with plain ffmpeg: `amix,apad=whole_dur,atrim` ends the output at the last narration in ~15% of runs (9/60), so the dub MP3 comes out shorter than the edited duration (4.27 s instead of 6.05 s). `buildMixDubAudioArgs` now mixes an `anullsrc` bed of the edited duration (0/60 short) and `dub-mix.test.ts` strings were updated. Revert `dub-mix.ts`/`dub-mix.test.ts` if you would rather handle it in a separate ticket.
- Verification: `bun run lint` 0 errors (20 existing warnings), `bun run typecheck` 15/15, `bun run test` 14/14 (media 963 pass 1 skip, services 1621 pass 1567 DB skips, validators 792, composition-plan 99, api 984), `bun run --cwd apps/api build:worker` passes with import audit. No DB gate, Docker or full Python suite run.
