# 09 — Preserve text through clip slicing, composition and exports

**What to build:** Use `joinTranscriptWords` at every join site from the recon list (clip-timing `rebuildText`, composition-plan `captionCueText` + no-timing fallback, transcript.service TXT/SRT/VTT, editor-document word edit, subtitles, clip.service titles, auto-censor display, use-current-caption fallback, supplied-captions/subtitle-lines splitting). Clip slice keeps zero-duration interior words; only clamped edge slivers dropped; half-open rule `start <= t < end`. Cue grouping for no-space-script runs by character budget (D7) in composition-plan, deterministic. Effective caption language (D10) carried on the composition caption layer contract.

**Blocked by:** 01

**Status:** ready-for-agent

**Acceptance:**
- [ ] Fixtures: zh/ja/th/mixed cues identical across Studio-facing and export-facing derivations; SRT/VTT/TXT have no spurious spaces; zero-duration words survive slicing.
- [ ] `bun run --cwd packages/composition-plan test`, validators, services tests; `bun run test:clip-editor-persistence:db` green.
