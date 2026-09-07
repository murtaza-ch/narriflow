# 08 — Plan the edited-time audio schedule end to end

**What to build:** Give Studio playback and export one edited-time audio schedule for source sound, music, speech ducking, fades, and sound effects while retaining current audio policy and optional-asset behavior.

**Blocked by:** [01 — Establish the Center composition tracer](01-establish-center-composition-tracer.md).

**Status:** completed

**Specification:** [Deepen the Clip Composition Plan](../spec.md)

## Observable acceptance criteria

- [x] The plan declares source audio gain and mute over the complete edited timeline after deleted ranges.
- [x] Music offset, looping, duration, clamped fade-in, clamped fade-out, and gain use the current shared policy in both adapters.
- [x] Speech windows and ducking curves use the current shared construction and caps rather than a second browser or worker interpretation.
- [x] Sound effects start and stop at the same edited-time positions in Studio and export, including boundaries created by deleted ranges.
- [x] Optional music or sound-effect unavailability omits only that asset, keeps export available, and emits one stable scoped notice.
- [x] The browser translates the schedule into existing playback controls without becoming a second audio-policy owner.
- [x] The FFmpeg adapter translates the same schedule into filter and input requests without changing gain, timing, loop, fade, or ducking decisions.
- [x] Audio schedule size remains capped by existing sound-effect and ducking-window limits.
- [x] Unrelated visual edits do not change the audio schedule fingerprint or cause optional audio assets to resolve again.
- [x] Current audible output remains compatible within approved timing and loudness tolerances.

## Public-interface and failure-injection tests

- [x] Planning-interface tables cover muted and unmuted source audio, gain limits, music offsets, short and looping tracks, clamped fades, overlapping speech, ducking boundaries, sound effects, deleted ranges, and unavailable optional assets.
- [x] Property tests prove all ranges are finite, ordered, clipped to edited duration, capped, and deterministic.
- [x] Browser adapter contracts assert scheduled gain, mute, loop, fade, ducking, and sound-effect behavior from shared plan fixtures.
- [x] FFmpeg adapter contracts consume the same fixtures and assert normalized audio requests without snapshotting raw command strings as composition policy.
- [x] Real-media tests probe audio duration and compare representative windows for timing, silence, gain, fades, ducking, loops, and sound effects.
- [x] Failure injection covers optional audio resolution failure, short media, missing audio streams, invalid duration facts, and ownership loss before command execution.

## Plan-only implementation constraints

- [x] Compose existing shared audio helpers into the plan rather than forking their formulas or constants.
- [x] Compare planned source gain, placements, fades, ducking windows, optional omissions, and adapter translation through shared fixtures.
- [x] Remove adapter-owned audio policy as each decision moves into the plan. Keep only browser and FFmpeg translation in the adapters.

## Rollout and recovery safety

- [x] Deploy the shared schedule only after timing and loudness comparisons pass the approved tolerance corpus.
- [x] Monitor schedule counts, omitted assets, notice codes, command branch count, planning time, and mismatch class without recording asset URLs.
- [x] Recovery reverts the offending plan or adapter change without restoring a second audio-policy path or changing editor documents and asset records.

## Scope boundaries

- [x] Do not change music fade, looping, ducking, source gain, sound-effect timing, or entitlement policy.
- [x] Do not add audio effects, loudness normalization, new codecs, or new browser mixing technology.
- [x] Leave audio-only visual topology and fidelity messaging to ticket 09.

## Completion evidence

- Planner tests cover edited-time source gain, music looping and fades, capped ducking windows, sound-effect stop times, deleted ranges, deterministic fingerprints, optional failures, and sub-160ms output fades.
- Studio translates the plan through the typed Studio Editing Session playback intent. Deferred music and sound-effect lookups have explicit pending, available, and failed states, including retained and removed asset races.
- FFmpeg adapter tests consume the planned schedule as resolved input bindings. A real Clip Render Attempt fixture verifies music looping, fades, ducking, sound-effect timing, and final output duration.
- Authenticated Chrome verification exercised synchronized Studio playback with ready media and a clean application console.
- `bun run typecheck`, `bun run test`, `bun run lint`, and `bun run build` pass repository-wide.

## Fresh-task handoff

Implement in a fresh task with `/implement`; use `/tdd` for schedule policy and both adapter contracts; finish with `/code-review`; run uncached focused tests, `bun run typecheck`, `bun run lint`, and `bun run build`; and compare representative audible windows in Studio and real FFmpeg output.
