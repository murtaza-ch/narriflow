# 03 — Plan automatic speaker composition end to end

**What to build:** Make Auto framing use one eligible speaker-scene plan in Studio and export. Pending evidence, target-specific no-split behavior, and manual speaker changes must have the same meaning in both adapters.

**Blocked by:** [01 — Establish the Center composition tracer](01-establish-center-composition-tracer.md).

**Status:** ready-for-agent

**Specification:** [Deepen the Clip Composition Plan](../spec.md)

## Observable acceptance criteria

- [ ] The planner accepts validated automatic layout evidence only when its source identity, clip bounds, deleted ranges, engine version, and relevant document fingerprint match.
- [ ] Missing eligible evidence produces a provisional Auto plan with one stable keyed request, a neutral analyzing notice, and a deterministic temporary fallback.
- [ ] A valid result produces contiguous edited-time speaker scenes for every target in one planning call.
- [ ] Targets that cannot use two simultaneous crops receive the existing no-split scene sequence without degrading eligible targets.
- [ ] Manual speaker move, resize, crop, rotation, and reset changes apply after automatic scene selection to the same scene and target in both adapters.
- [ ] Existing manual-override matching tolerance remains unchanged, and unrelated caption or audio edits retain valid layout evidence.
- [ ] Source-window, deleted-range, or relevant layout changes invalidate stale evidence immediately.
- [ ] Studio adopts newly eligible evidence without reload only when its input fingerprint still matches the working and cloud documents. Adoption preserves playback state and the main media element.
- [ ] Clip Render Attempt resolves a generic evidence request through its existing analysis capability, replans, and passes only a ready or explicitly degraded plan to FFmpeg.
- [ ] One valid durable analysis serves all compatible targets, and Center or Fit plans never trigger it.

## Public-interface and failure-injection tests

- [ ] Planning-interface tables cover valid, missing, stale, disabled, failed, and version-mismatched evidence; one- and two-speaker scenes; no-split targets; manual overrides; deleted ranges; and the exact final frame.
- [ ] Evidence-request tests use recording fakes to prove one key per source window and engine version, reuse across targets, and no duplicate request for unrelated edits.
- [ ] Web adapter contracts assert active-scene geometry, target switching, synchronized secondary-media mounting only when required, and evidence adoption without playback reset.
- [ ] FFmpeg adapter and real-media tests use the same scene fixtures and compare approved frames and probes with current Auto output.
- [ ] Failure injection covers analysis timeout, detector failure, stale completion, ownership loss, and a document change while evidence is in flight.
- [ ] Property tests prove scene order, complete coverage, bounded crops, stable IDs, deterministic fingerprints, and capped scene counts.

## Migration and mixed-version considerations

- [ ] Keep the current durable automatic layout envelope and Studio polling flow. Extend or version evidence only when the planner needs a deterministic new fact.
- [ ] Shadow comparison covers scene boundaries, full and no-split selection, target geometry, manual overrides, and fallback reasons before cutover.
- [ ] Auto cutover remains independent of explicit Split and Screen, and the current path remains available for rollback.

## Rollout and recovery safety

- [ ] Enable Auto for a representative corpus only after shadow mismatches are explained and approved.
- [ ] Diagnostics record evidence source and version, scene count, requested and effective mode, target, notice code, and planning duration without source URLs or document contents.
- [ ] Rollback returns both adapters to current Auto behavior without deleting durable evidence.

## Scope boundaries

- [ ] Do not train or replace speaker, face, or scene models.
- [ ] Do not change scene caps, detector thresholds, manual-override matching policy, or Studio Editing Session ownership.
- [ ] Do not migrate explicit Split, Screen, B-roll conflicts, visual overlays, or audio scheduling.

## Fresh-task handoff

Implement in a fresh task with `/implement`; drive evidence eligibility, planning, and both adapters with `/tdd`; finish with `/code-review`; run uncached focused and affected database tests, `bun run typecheck`, `bun run lint`, and `bun run build`; and verify pending-to-exact adoption in a real browser plus representative Auto renders through real FFmpeg.
