# 09 — Preserve text through clip slicing, composition and exports

**What to build:** Use `joinTranscriptWords` at every join site from the recon list (clip-timing `rebuildText`, composition-plan `captionCueText` + no-timing fallback, transcript.service TXT/SRT/VTT, editor-document word edit, subtitles, clip.service titles, auto-censor display, use-current-caption fallback, supplied-captions/subtitle-lines splitting). Clip slice keeps zero-duration interior words; only clamped edge slivers dropped; half-open rule `start <= t < end`. Cue grouping for no-space-script runs by character budget (D7) in composition-plan, deterministic. Effective caption language (D10) carried on the composition caption layer contract.

**Blocked by:** 01

**Status:** done

**Acceptance:**
- [x] Fixtures: zh/ja/th/mixed cues identical across Studio-facing and export-facing derivations; SRT/VTT/TXT have no spurious spaces; zero-duration words survive slicing.
- [x] `bun run --cwd packages/composition-plan test`, validators, services tests; `bun run test:clip-editor-persistence:db` green.

## Comments

- Join sites now use `joinTranscriptWords`: clip-timing `rebuildText`, composition-plan `captionCueText`, editor-document `updateWordText`, supplied-captions (cue lines, merged cues, fit), auto-censor `matchedText`/context, `transcript.service` TXT/SRT/VTT (rebuilt from words), clip.service titles/excerpt/prompt text, Studio transcript panel (rendered spacing, copy, paragraph text), selection math (`wordCharRanges` uses `hasSpaceBefore`), subtitle-lines.
- Not touched: `coerceUtteranceText` (~85) lives inside `normalizeAssemblyAiTranscript`, which ticket 04 replaces.
- Slice rule: half-open `[start, end)`; zero/short interior words survive; only clamp-created slivers (<10 ms) drop. Utterances with words are judged by their words.
- Cue grouping: `groupCaptionTokens` (validators/caption-cues.ts), budget `wordsPerCue × 2` characters; spaced words cost 2, no-space-script tokens cost their base characters (combining marks free), CJK punctuation costs 0. Used by the composition plan and the Studio resolver (`use-current-caption.ts`); no `Intl.Segmenter`.
- Language: `CaptionCue.language`, `CompositionCaptionVisualLayer.language`, `ClipCompositionPlanInput.captionLanguage`, `deriveCaptionCues(..., { language })`. Populated from transcript language ?? project language in the worker render (via `getFrozenRenderingStateForWorkSet.captionLanguage`), subtitle exports and timeline export. `applyCaptionTextTransform(text, transform, language)` uses `toCaptionUpperCase`. The Studio web preview does not populate it yet (no language on the clip payload); fonts/direction tickets read it.
- auto-censor `normalizeToken` keeps combining marks at word edges.
- Verified: validators 665, composition-plan 89, services 1443 (+900 DB skipped), web 989, `test:clip-editor-persistence:db` green on local Postgres 17 (port 55434), `bun run typecheck` green, lint has only pre-existing warnings. `apps/worker` tests: 3 failures in `tasks/ingest.test.ts` ("upload source pinning"), identical on the baseline commit.
