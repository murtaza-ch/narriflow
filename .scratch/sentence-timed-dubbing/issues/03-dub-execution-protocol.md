# 03 - Dub execution protocol (translation JSON, per-segment speech, timing, recovery)

**What to build:** Spec §2 frozen-request shape and §3 stages end to end: validators (`dubbing-execution.ts`), `dubbing-policy.ts` bodies and stage table, `dubbing-provider.ts` JSON translation parse, `dubbing-native.ts` rewrite using ticket 02 helpers, `dubbing-cli.ts` and `apps/media/python/narriflow_media/dubbing_runtime.py` stage/source lists, and server-side checkpoint validation, recovery and `unfit` settlement in `packages/services/src/dubbing-execution.ts` (+ `dubbing-recovery.ts`, test support). Completion here only completes the dub with audio + timing; export creation is ticket 04.

**Blocked by:** 01, 02

**Status:** done

## Acceptance
- [x] Frozen request carries `segments` + `editedDurationSec`; no `baseRender`/`script`. Execution input has no `baseVideo`.
- [x] Stages and sources exactly as spec §3; `video`/`base_video`/`dub_video` removed everywhere (TS + Python).
- [x] Speech intent hash covers all segment bodies; fresh `authority` before each POST; strictly sequential control RPCs; first-failure settlement rules.
- [x] `timing` committed before `audio`; server refuses `audio` without `timing`; recovery downloads `dub_timing` + `dub_audio` and never POSTs.
- [x] `final_result` gains `outcome: "unfit"` → dub `failed`, `dub_narration_unfit`, usage released.
- [x] Unit tests updated/added (`dubbing-native.test.ts`, Python dubbing runtime tests). DB-gated tests may be edited for shape but are not run.
- [x] `bun run lint`, `bun run typecheck`, `bun run test`, Python dubbing runtime tests pass.

## Comments

- 2026-11-19: Done. Frozen request now carries `segments` + `editedDurationSec` (no `baseRender`/`script`); execution input has no `baseVideo`. Stages `translation_intent, translation_result, speech_intent, timing, audio, final_result`; sources `translation_result, dub_timing, dub_audio`; `video`/`base_video`/`dub_video` and `muxDubbedVideo` removed (TS policy, native, cli, Python). `translation_result` checkpoint carries `segments: string[]`; `final_result` gained `outcome: "unfit"` (+ `segmentIndex`) which sets the dub `failed` / `dub_narration_unfit` and fails the run non-retryable through the lifecycle, which releases the count like other known failures. `ClipDub.timingArtifactId` added in `20261119120000_sentence_timed_dubbing` (plus a small immutability trigger); ticket 04 extends that file.
- Server verification of the speech intent: the checkpoint only carries `bodySha256`, so `createDubbingExecution().prepare` reads the sealed `translation_result` artifact when a `speech_intent` is committed and the commit recomputes `dubSpeechIntentHash(request, segments)` (and `segments.join(" ") === translatedText`). Timing is validated by `dubTimingMatchesRequest` (count, ordered, inside `[0, editedDurationSec]`, words inside segment).
- Left for ticket 04: identity/editorRevision, censor refusal, export preflight and dub export creation at completion, dropping `renderStorageKey`/`renderSizeBytes`/`videoArtifactId` columns (completion no longer writes them), the `dub_mix` role MIME allowlist still listing `video/mp4` in `execution-transfer.ts`/`transfer.py`, snapshot `hasVideoAsset`.
- Verification: `bun run lint` 0 errors (20 existing warnings), `bun run typecheck` 15/15, `bun run test` 14/14 (media 892 pass, 1 skip; `dubbing-native.test.ts` 8 pass), `bun run --cwd apps/api build:worker` passes with the import audit, Python `test_dubbing_runtime.py` 5 tests OK. DB-gated `*.db.test.ts` edited for shape only and not run (excluded from typecheck).
