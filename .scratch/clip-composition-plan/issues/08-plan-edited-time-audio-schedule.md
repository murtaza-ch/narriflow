# 08 — Plan the edited-time audio schedule end to end

**What to build:** Give Studio playback and export one edited-time audio schedule for source sound, music, speech ducking, fades, and sound effects while retaining current audio policy and optional-asset behavior.

**Blocked by:** [01 — Establish the Center composition tracer](01-establish-center-composition-tracer.md).

**Status:** ready-for-agent

**Specification:** [Deepen the Clip Composition Plan](../spec.md)

## Observable acceptance criteria

- [ ] The plan declares source audio gain and mute over the complete edited timeline after deleted ranges.
- [ ] Music offset, looping, duration, clamped fade-in, clamped fade-out, and gain use the current shared policy in both adapters.
- [ ] Speech windows and ducking curves use the current shared construction and caps rather than a second browser or worker interpretation.
- [ ] Sound effects start and stop at the same edited-time positions in Studio and export, including boundaries created by deleted ranges.
- [ ] Optional music or sound-effect unavailability omits only that asset, keeps export available, and emits one stable scoped notice.
- [ ] The browser translates the schedule into existing playback controls without becoming a second audio-policy owner.
- [ ] The FFmpeg adapter translates the same schedule into filter and input requests without changing gain, timing, loop, fade, or ducking decisions.
- [ ] Audio schedule size remains capped by existing sound-effect and ducking-window limits.
- [ ] Unrelated visual edits do not change the audio schedule fingerprint or cause optional audio assets to resolve again.
- [ ] Current audible output remains compatible within approved timing and loudness tolerances.

## Public-interface and failure-injection tests

- [ ] Planning-interface tables cover muted and unmuted source audio, gain limits, music offsets, short and looping tracks, clamped fades, overlapping speech, ducking boundaries, sound effects, deleted ranges, and unavailable optional assets.
- [ ] Property tests prove all ranges are finite, ordered, clipped to edited duration, capped, and deterministic.
- [ ] Browser adapter contracts assert scheduled gain, mute, loop, fade, ducking, and sound-effect behavior from shared plan fixtures.
- [ ] FFmpeg adapter contracts consume the same fixtures and assert normalized audio requests without snapshotting raw command strings as composition policy.
- [ ] Real-media tests probe audio duration and compare representative windows for timing, silence, gain, fades, ducking, loops, and sound effects.
- [ ] Failure injection covers optional audio resolution failure, short media, missing audio streams, invalid duration facts, and ownership loss before command execution.

## Plan-only implementation constraints

- [ ] Compose existing shared audio helpers into the plan rather than forking their formulas or constants.
- [ ] Compare planned source gain, placements, fades, ducking windows, optional omissions, and adapter translation through shared fixtures.
- [ ] Remove adapter-owned audio policy as each decision moves into the plan. Keep only browser and FFmpeg translation in the adapters.

## Rollout and recovery safety

- [ ] Deploy the shared schedule only after timing and loudness comparisons pass the approved tolerance corpus.
- [ ] Monitor schedule counts, omitted assets, notice codes, command branch count, planning time, and mismatch class without recording asset URLs.
- [ ] Recovery reverts the offending plan or adapter change without restoring a second audio-policy path or changing editor documents and asset records.

## Scope boundaries

- [ ] Do not change music fade, looping, ducking, source gain, sound-effect timing, or entitlement policy.
- [ ] Do not add audio effects, loudness normalization, new codecs, or new browser mixing technology.
- [ ] Leave audio-only visual topology and fidelity messaging to ticket 09.

## Fresh-task handoff

Implement in a fresh task with `/implement`; use `/tdd` for schedule policy and both adapter contracts; finish with `/code-review`; run uncached focused tests, `bun run typecheck`, `bun run lint`, and `bun run build`; and compare representative audible windows in Studio and real FFmpeg output.
