# Plan 026: Rebuild dubbing as a timed, caption-correct multilingual studio

> **Decision-gated direction plan**: Do not advertise current dubbing as
> publication-grade until Phase 1–3 pass media-quality gates. This is a staged
> redesign, not a patch to the existing `-shortest` mux.
>
> **Drift check**:
> `git diff --stat 05d273d..HEAD -- apps/worker/src/tasks/dubbing.ts apps/worker/src/tasks/render-clips.ts packages/services/src/dubbing.service.ts packages/db/prisma/schema.prisma 'apps/web/app/(app)/projects/[projectId]/dubbing-panel.tsx'`

## Status

- **Priority**: P1 correctness / P2 differentiator
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: plans/024-multilingual-foundation.md,
  plans/042-versioned-language-terminology-profiles.md, and
  plans/027-leased-idempotent-workflows.md for production retries/finalization
- **Category**: bug, feature, migration, tests
- **Planned at**: commit `05d273d`, 2026-07-09, live working tree

## Why this matters

Competitors already market subtitle translation across 50–130 languages, and
Captions/Descript offer AI dubbing and lip-sync workflows. Narriflow's current
dub flattens every timed utterance into one text blob, sends one TTS request,
replaces all audio, copies a video that already has source-language captions
burned in, and muxes with `-shortest`. Translation expansion/contraction can
cut off speech or end the video early; long scripts can exceed TTS input limits;
the final video speaks one language while permanently displaying another.

## Current state

- `dubbing.ts:114-137` discards utterance timestamps, pauses, and speakers.
- `dubbing.ts:182-230` translates and synthesizes one unstructured script.
- `dubbing.ts:330-355` uses `-shortest` and never enforces source duration.
- Dubbing starts from an already caption-burned completed render and copies its
  video stream unchanged.
- One generic voice represents all speakers; source ambience/music is lost with
  the replaced audio.
- The configured `gpt-4o-mini-tts` alias remains current in OpenAI's model
  documentation; an older dated snapshot is deprecated. Pin or replace the
  alias only after checking the implementation-date model/API docs and running
  a voice, locale, timing, and cost evaluation.

Until Phase 1–3 pass, pricing and in-product entitlement copy must call this an
`AI voiceover draft (beta)` or omit it from sellable benefits. A technically
completed row is not evidence of publication-grade duration, captions, or
language fidelity.

## Phase 0: Choose the launch matrix and consume language-profile truth

- Approve a deliberately small launch matrix of source/target locale pairs,
  voices, scripts, provider/model versions, quality thresholds, latency and unit
  economics. Transcription support does not imply dubbing support.
- Require a pinned Plan 042 profile version for protected names/numbers,
  preferred translations, do-not-translate terms, register/formality,
  pronunciation and caption/script rules.
- Evaluate candidate TTS providers/models with consent/data-use terms, native
  locale quality, word/phoneme timing availability, voice consistency, input
  limits, retry/idempotency, cost and regional availability. Keep an adapter
  boundary; do not bake product guarantees into one mutable alias.
- Define acceptance and human-review policy per locale. Unsupported or
  unevaluated pairs are unavailable, not silently best-effort.

## Phase 1: Preserve a clean render and timed translation units

- Produce/reuse a clean crop/B-roll/layout intermediate before caption burn-in.
- Translate structured utterances with immutable segment IDs, source start/end,
  speaker, source text, target text, and target locale.
- Preserve names, numbers, quotations, register, glossary terms, and deliberate
  code switching; validate exact segment coverage before writing.
- Persist translation model/prompt, language-profile version/execution snapshot,
  provider/model/voice version, and source transcript revision. A transcript or
  applicable profile edit invalidates the affected dub version explicitly.

## Phase 2: Synthesize and fit each segment

- Chunk by timed utterance and provider input limit; never split inside a name
  or number when avoidable.
- Synthesize per speaker/segment, measure actual audio duration, and fit to the
  segment budget using bounded voice speed/time-stretch plus silence padding.
- Reject or flag segments whose required stretch exceeds a calibrated quality
  range; never silently clip them.
- Rebuild the complete timeline with original pauses. Compare target and source
  duration before mux; the final video duration must equal the clean source
  duration within a small measured tolerance.
- Stage background preservation separately: use a source-separation pipeline or
  an explicitly licensed provider, then mix ambience/music under the dub. Do
  not simply lower the original speech track and call it preserved.

## Phase 3: Render target-language captions and a QA pass

- Generate ASS/SRT/VTT from translated timed segments.
- Let users choose target-only, source-only, or dual captions; render from the
  clean intermediate, never on top of source captions.
- Resolve fonts and cue layout by script/locale; cover RTL/CJK/Indic golden
  frames and locale-aware casing.
- Add deterministic QA: missing/duplicate segments, untranslated spans,
  name/number mismatch, invalid glyphs, caption overflow, duration drift, and
  clipped audio. Compare protected terms and approved translations against the
  pinned profile. Block publish on high-severity failures with an explicit
  override and audit trail.

## Phase 4: Speaker voices, consent, and optional lip sync

- Add per-speaker voice selection only after segment timing is stable.
- Custom/clone voices require recorded consent, owner authorization, deletion,
  abuse controls, and visible provenance.
- Treat lip sync as a beta provider adapter with quality and cost gates, not a
  prerequisite for reliable dubbing.

## Required tests and media gates

- Synthetic FFmpeg fixtures for shorter, equal, and longer translations; no
  final duration truncation.
- Scripts over provider character limits chunk without text loss.
- Two-speaker fixture preserves order/pauses/voice mapping.
- Arabic/Urdu RTL, Hindi-English, Spanish, Japanese, and Mandarin fixtures have
  target captions, glyph coverage, and bounded drift.
- Every locale/provider combination in the launch matrix has an eval-backed
  minimum quality result and an explicit unsupported/fallback state.
- Names and all numeric values survive translation validation.
- Failed segment/provider retries are idempotent and do not duplicate costs.
- `ffprobe` asserts final duration and streams; golden frames assert captions.

## Done criteria

- No `-shortest` correctness dependency.
- No one-blob translation/TTS request.
- No source-captioned video is reused for a target-language final.
- Segment timing/provenance/QA is persisted and visible.
- The exact language-profile and provider/model versions are persisted and
  every sellable locale pair passes the approved launch matrix.
- Users can preview/retry one segment instead of regenerating an entire dub.
- The selected TTS model is current, supported, and eval-backed at execution.

## STOP conditions

- The product owner has not chosen target markets/locales and acceptable cost.
- Plan 042's immutable profile and language-confidence review are unavailable.
- A TTS/voice provider's consent or data-use terms are not acceptable.
- Duration, translated-caption, or name/number gates cannot be measured.
- The implementation tries to ship voice cloning/lip sync before timed basic
  dubbing is reliable.
