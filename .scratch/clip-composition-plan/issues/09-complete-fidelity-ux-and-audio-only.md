# 09 — Complete composition fidelity UX and audio-only behavior

**What to build:** Give creators one honest fidelity model for every composition. Studio and export must distinguish exact, pending, degraded, and invalid plans, name the effective fallback, and represent audio-only output without pretending unsupported visual choices will render.

**Blocked by:** [07 — Move timed visual layers into the shared plan](07-move-timed-visual-layers-into-plan.md); [08 — Plan the edited-time audio schedule end to end](08-plan-edited-time-audio-schedule.md).

**Status:** ready-for-agent

**Specification:** [Deepen the Clip Composition Plan](../spec.md)

## Observable acceptance criteria

- [ ] Exact plans show no warning and remain visually quiet in Studio.
- [ ] Missing evidence shows a neutral analyzing state that does not imply export will use the temporary approximation.
- [ ] Approximate and degraded plans show concise accessible text that names the requested mode, effective composition, affected target or scene, and any available user action.
- [ ] One problem in a target or scene does not mark unaffected targets or scenes as degraded.
- [ ] Optional image, B-roll, logo, music, and sound-effect degradation remains exportable and does not become a failed render variant.
- [ ] A deterministic invalid plan blocks export before command execution and maps to one stable creator-facing error plus safe structured diagnostics.
- [ ] Evidence or asset arrival replaces pending or degraded fidelity only when the plan fingerprint still matches the open editing session.
- [ ] Fidelity changes preserve playhead, play state, playback rate, selected target, and the main media element.
- [ ] Audio-only input uses the existing audiogram composition in Studio and export.
- [ ] Unsupported audio-only background choices produce an explicit notice and never appear in Studio as if export will include them.
- [ ] Composition notices use stable codes and contain no provider messages, raw exceptions, signed URLs, document contents, or raw commands.

## Public-interface and failure-injection tests

- [ ] Planning-interface tables cover every requested and effective mode with exact, pending, degraded, and invalid fidelity; target- and scene-scoped notices; optional failures; and audio-only sources.
- [ ] Accessibility tests cover live analysis updates, keyboard and screen-reader access to fallback details, color-independent state communication, and non-blocking optional degradation.
- [ ] Studio Editing Session tests prove stale plans are ignored, matching plans arrive without reload, playback authority remains unchanged, and planning never becomes a second editor owner.
- [ ] Clip Render Attempt tests prove invalid plans fail before encoding, optional notices do not fail variants, and terminal failure classification remains stable.
- [ ] Browser tests inspect exact, pending, fallback, optional degradation, invalid export, and audiogram states at every supported target.
- [ ] Real-media tests compare audio-only probes and representative audiogram frames with current output and prove unsupported backgrounds are omitted consistently.
- [ ] Failure injection covers delayed evidence, stale evidence completion, failed optional assets, invalid geometry, missing required source, and ownership loss during evidence resolution.

## Migration and mixed-version considerations

- [ ] Add fidelity messages beside current UI until all plan modes emit stable notices and the copy is verified against real fallbacks.
- [ ] Keep render failure and optional degradation compatibility while old and new adapters coexist.
- [ ] Do not persist plans or composition notices as a new source of truth.

## Rollout and recovery safety

- [ ] Enable fidelity UI per composition mode and verify that the shown fallback matches shadow and rendered results before broad rollout.
- [ ] Monitor notice code, requested and effective mode, target scope, plan version, invalid-plan count, and optional degradation count.
- [ ] Rollback hides the new presentation and selects retained composition paths without discarding evidence or editor changes.

## Scope boundaries

- [ ] Do not redesign the audio-only audiogram, add new framing modes, or change optional-asset entitlement and fallback policy.
- [ ] Do not block export for an optional degradation.
- [ ] Do not change Studio Editing Session durability, cloud convergence, write ownership, or playback ownership.

## Fresh-task handoff

Implement in a fresh task with `/implement`; use `/tdd` for fidelity states, accessibility, session adoption, render failure mapping, and audio-only parity; finish with `/code-review`; run uncached focused tests, `bun run typecheck`, `bun run lint`, and `bun run build`; and verify every state in a real browser plus representative real-media output.
