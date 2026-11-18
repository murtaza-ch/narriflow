# Sentence-timed dubbing

**Status:** implemented, uncommitted (2026-11-19). Sol design + code reviews addressed. Not yet migrated, deployed or live-tested.

## Problem

A voiceover dub today translates the clip transcript as one string, voices it with one
TTS call, and swaps the audio track of an existing render (`apps/media/src/tasks/dub-mix.ts`,
`-c:v copy -shortest`). Measured on a real Urdu dub of a 52.7 s clip:

- The narration drifts behind the picture: ~0 s at the start, 7.3 s at 26 s, 16.8 s at 51 s.
- The narration is cut off at the end (`-shortest`).
- The burned-in captions are the source-language captions with source word timings.
- The script includes words the clip no longer contains: `buildDubTranscriptText`
  (`packages/services/src/dubbing-policy.ts:16`) joins the whole `transcriptSlice`, ignoring
  `deletedRanges`. Silence and filler-word removal chosen at import seed `deletedRanges`
  (`packages/validators/src/clip-cleanup.ts`), and so do manual Studio cuts.
- A completed dub is reused for the same clip/language/voice/aspect even after the clip was
  edited (`dubbing.service.ts:185`, partial unique index in
  `migrations/20261031140000_execution_dubbing`).

## Outcome

A dub is a video of the clip's normal composition (layout, B-roll, text layers, logo, music,
scene blocks, caption style) where:

1. Speech is target-language TTS placed sentence by sentence at the time each source sentence
   is heard in the edited clip. Lateness is bounded; drift cannot accumulate.
2. Exactly the words the clip's captions would show are dubbed (same cut rule as captions).
3. Captions are in the target language, timed to the dub audio, rendered by the clip's caption
   preset through the shared cue model. RTL/Nastaliq handling in `caption-ass.ts` is keyed by
   cue language.
4. Narration never runs past the clip end and is never truncated or faded away. A dub whose
   narration cannot fit within the bounds fails with `dub_narration_unfit` and its monthly
   count is released.
5. A dub belongs to one editor revision of the clip.

Running cost stays the same order: one translation call, N TTS calls billed by text,
one normal render.

## Time domain

Everything the dub produces is on the **edited timeline**: source time after
`buildClipCutPlan(document.deletedRanges, window).map`, before inserted scene blocks. Caption
layers are built in that domain (`captionLayersForTarget`) before
`retimeVisualLayersForInsertedScenes`, and the render wraps edited-timeline dialogue with
`compileCompositionPlanSceneAudio`. The dub audio file is exactly `editedDurationSec` long.

## Design

### 1. Segment plan (pure, `packages/validators/src/dub-plan.ts`)

`planDubSegments(document)` returns `{ editedDurationSec, segments }` or a typed refusal.

- Cut plan: `buildClipCutPlan(document.deletedRanges, { startSec: clipStartSec, endSec: clipEndSec })`.
- Sentences: `splitUtterancesIntoSentences(document.transcriptSlice)`.
- Timed sentence: keep a word iff `sourceWordToEdited(map, word)` is non-null (the caption
  rule; a partially cut word that captions show is kept). Drop words whose text has no letter
  or digit only when they would start a segment (punctuation stays attached to text).
  Segment = `{ startSec, endSec, text }`: first kept word's edited start, last kept word's
  edited end, `joinTranscriptWords` of kept words.
- Untimed utterance (no words): fully kept (`isSourceTimeDeleted` false over its whole range,
  i.e. `sourceRangeToEdited` length equals the source length within epsilon) → one segment;
  fully cut → skipped; partially cut → refusal `dub_transcript_untimed_cut`.
- Sort segments by `startSec`, then index. Overlapping segments (overlapping speakers) merge:
  text joined in order, range = union.
- Merge pass, left to right, deterministic: a segment shorter than 1.0 s merges into the next
  when the gap is under 0.35 s; otherwise into the previous when that gap is under 0.35 s.
- Segments with no letter or digit are dropped. Empty → refusal `dub_transcript_empty`.
  More than 160 segments → refusal `dub_transcript_too_long`.

### 2. Admission (`dubbing.service.ts`)

- Identity: clip, language, voice, aspect **and editorRevision**. Reuse, live-run and
  conflict lookups use the revision; the partial unique index gains `editorRevision`.
- Refuse when the document has enabled censor segments: `dubbing_censor_unsupported`
  (the translated words have no source word ids to mask or beep).
- Preflight the dub's export before paid work: `assertClipExportDocumentAllowed(pricingTier,
  document)` and the export output resolution (`resolveClipExportOutput`).
- No completed render is required. The plan-limit check uses edited duration plus scene
  block durations.
- Frozen request: drop `baseRender` and `script`; add `segments` and `editedDurationSec`.
  `transcriptText` stored on the row is the segment texts joined.

### 3. Execution (`dub_mix`)

Stages, in order: `translation_intent`, `translation_result`, `speech_intent`, `timing`,
`audio`, `final_result`. Sources for recovery: `translation_result`, `dub_timing`,
`dub_audio`. No `base_video`, `video` or `dub_video`.

- **Translation:** one Responses call with a strict JSON schema. Input
  `[{ id, text, seconds }]`; output `{ segments: [{ id, text }] }` with the same ids in the
  same order, each text non-empty, else outcome `unknown`. The prompt asks each line to be
  speakable within its seconds at a natural pace. Same-language dubs skip the call.
  The `translation_result` checkpoint carries `segments: string[]`.
- **Speech:** sequential `/audio/speech` calls, one per segment, MP3. One `speech_intent`
  checkpoint whose `bodySha256` hashes the JSON array of all bodies, then before **each** POST
  a fresh `authority` RPC. Control RPCs are strictly sequential. On the first failure stop:
  a refused call (4xx in the refusal set) settles the batch `rejected` with its status, any
  other failure `unknown`. Calls that already succeeded do not change settlement.
- **Trim:** each clip's leading and trailing silence is removed
  (`silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.05`, then the same on
  `areverse`), keeping 50 ms at each edge; interior pauses stay. A clip that trims to nothing
  is outcome `unknown`. The natural duration is measured on the decoded, trimmed audio.
- **Placement** (pure, `apps/media/src/tasks/dub-placement.ts`). Constants: `GAP = 0.08`,
  `LATE_MAX = 0.6`, `TEMPO_MAX = 1.3`. For segment i with source start `s_i`:
  - `start_i = max(s_i, end_{i-1} + GAP)` (first: `s_0`).
  - `deadline_i = s_{i+1} + LATE_MAX - GAP` for all but the last; the last is
    `editedDurationSec`. Also `deadline_i <= editedDurationSec`.
  - `tempo_i = max(1, natural_i / (deadline_i - start_i))`; if `deadline_i <= start_i` or
    `tempo_i > TEMPO_MAX` the dub is unfit.
  - `end_i = start_i + natural_i / tempo_i`.
  - This bounds every start to `s_i + LATE_MAX`; no lateness carries further.
  - Unfit: `final_result` with `outcome: "rejected"`-like settlement `unfit`
    (`dub_narration_unfit`), dub status `failed`, generation usage released.
- **Audio:** decode each trimmed clip through `atempo=tempo_i` to mono 24 kHz float, mix into a
  buffer of `editedDurationSec` at `start_i`, encode once to MP3. Measure the result.
- **Caption words:** tokens from `Intl.Segmenter(target, { granularity: "word" })` keeping
  punctuation attached to the preceding word-like token and recording `spaceBefore` from the
  original whitespace. Each segment's `[start_i, end_i]` is spread over its tokens in
  proportion to grapheme count. Approximate highlighting is an accepted tradeoff; forced
  alignment is out of scope.
- **Durability:** `timing` (probe JSON:
  `{ segments: [{ startSec, endSec, tempo, words: [{ text, spaceBefore, startSec, endSec }] }] }`)
  is committed before `audio`; the server refuses `audio` without `timing`. A recovered attempt
  downloads `dub_timing` and `dub_audio` and does no paid work. `speech_intent` is outstanding
  until `audio` is committed.
- **Completion** (`final_result: completed`): in the same transaction, re-run
  `assertClipExportDocumentAllowed` against the frozen document. When it passes, create the
  dub export (section 4) and hand it to a `clip_rendering` run. When it fails, the dub still
  completes with its audio; its video state is `failed` with the admission error code.

### 4. The dub video: a dub-bound export

- `ClipExport.dubId` nullable unique FK to `ClipDub` (cascade delete). Fingerprint includes
  the dub id. One variant: the dub's aspect ratio; resolution and watermark from
  `resolveClipExportOutput` for the workspace plan.
- Isolation: `findCoveringInFlightExport`, current-export listings, library, share links,
  render-state reads, export routes and `syncClipExportAggregate` consumers filter
  `dubId: null` for ordinary exports. Dub exports are reachable only through the dub.
- Retry: "Render again" calls the existing `retryFailed` lifecycle for the dub's export
  (after `assertClipExportDocumentAllowed`), or creates the export when none exists.
- Render input: `renderExecutionInputSchema.dub` nullable
  `{ audio: source object (immutable identity: key, etag, byteLength, sha256), language,
  segments: words[][] }`, filled by `createRenderInputSnapshot` from the dub's committed
  `audio` and `timing` artifacts. The dub audio is carried through the API transfer sources
  (`render-group-execution.ts`), Python scoped sources (`render_runtime.py`) and the Bun source
  map (`render-group.ts`). Preparation, proxies and layout evidence stay source-bound.

### 5. Render integration

- `planClipComposition` input gains optional
  `captionOverride: { language, segments: CaptionWord[][] }` (edited time). When present,
  `captionLayersForTarget` groups each segment's words with
  `groupCaptionTokens(preset.wordsPerCue)` (cues never straddle segments) and applies the same
  preset, text transform (override language), emoji, anchor and scene retiming. It is part of
  the plan fingerprint. `deriveCaptionCues` takes the same override so cue derivation stays one
  model.
- `buildAudioSchedule` takes ducking windows from the override words when present.
- ffmpeg builders (`buildSingleVideoArgs`, `buildBrollVideoArgs`, `buildAudiogramArgs`): the
  dub file is an extra `-i`; its label replaces the source dialogue (no
  `alignSourceAudioClock`, no cut-concat audio, no unused original-audio outputs), is wrapped
  by scene audio, then music/SFX/dialogue filters as today. Original-audio gain and mute do not
  apply to it. The audiogram waveform reads the dub.
- Output validation uses the dub file's probed audio facts (sample rate, channels) as the
  expected dialogue source.

### 6. Dub surfaces

- Snapshot gains `video: { status: "none" | "rendering" | "ready" | "failed", errorCode }`
  from the dub export; `hasVideoAsset`/`renderSizeBytes` come from the export variant.
  Video download presigns the export variant's file with the dub filename.
- Remove `ClipDub.renderStorageKey`, `renderSizeBytes`, `videoArtifactId` and update cleanup
  and retention references (`project-retention-execution.ts`, media cleanup holds).
- Dubbing panel: every clip is selectable (no render prerequisite); a dub row shows audio as
  soon as the dub completes and the video once rendered, with "Render again" on failure.
- Pre-production policy: old dub rows are reset; no dual paths.

## Out of scope

Voice cloning, per-speaker voices, lip sync, re-translating overlong lines, forced alignment,
subtitle-file downloads for dubs, dubbing clips with enabled censor edits.

## Verification

`bun run lint`, `bun run typecheck`, `bun run test`, `bun run --cwd apps/api test:inventory`,
`bun run --cwd apps/api openapi:check`, `bun run check:web-split`,
`bun run --cwd apps/api build:worker`. Python unit tests for the touched runtimes (not the
slow render runtime suite). Postgres behaviour (migration, index, export isolation) has no
automated gate and is reviewed closely.
