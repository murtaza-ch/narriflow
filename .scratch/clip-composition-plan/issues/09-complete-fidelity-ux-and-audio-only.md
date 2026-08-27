# 09 — Complete composition fidelity UX and audio-only behavior

**What to build:** Give creators one honest fidelity model for every composition. Studio and export must distinguish exact, pending, degraded, and invalid plans, name the effective fallback, and represent audio-only output without pretending unsupported visual choices will render.

**Blocked by:** [07 — Move timed visual layers into the shared plan](07-move-timed-visual-layers-into-plan.md); [08 — Plan the edited-time audio schedule end to end](08-plan-edited-time-audio-schedule.md).

**Status:** completed

**Specification:** [Deepen the Clip Composition Plan](../spec.md)

## Observable acceptance criteria

- [x] Exact plans show no warning and remain visually quiet in Studio.
- [x] Missing evidence shows a neutral analyzing state that does not imply export will use the temporary approximation.
- [x] Approximate and degraded plans show concise accessible text that names the requested mode, effective composition, affected target or scene, and any available user action.
- [x] One problem in a target or scene does not mark unaffected targets or scenes as degraded.
- [x] Optional image, B-roll, logo, music, and sound-effect degradation remains exportable and does not become a failed render variant.
- [x] A deterministic invalid plan blocks export before command execution and maps to one stable creator-facing error plus safe structured diagnostics.
- [x] Evidence or asset arrival replaces pending or degraded fidelity only when the plan fingerprint still matches the open editing session.
- [x] Fidelity changes preserve playhead, play state, playback rate, selected target, and the main media element.
- [x] Audio-only input uses the existing audiogram composition in Studio and export.
- [x] Unsupported audio-only background choices produce an explicit notice and never appear in Studio as if export will include them.
- [x] Composition notices use stable codes and contain no provider messages, raw exceptions, signed URLs, document contents, or raw commands.

## Public-interface and failure-injection tests

- [x] Planning-interface tables cover every requested and effective mode with exact, pending, degraded, and invalid fidelity; target- and scene-scoped notices; optional failures; and audio-only sources.
- [x] Accessibility tests cover live analysis updates, keyboard and screen-reader access to fallback details, color-independent state communication, and non-blocking optional degradation.
- [x] Studio Editing Session tests prove stale plans are ignored, matching plans arrive without reload, playback authority remains unchanged, and planning never becomes a second editor owner.
- [x] Clip Render Attempt tests prove invalid plans fail before encoding, optional notices do not fail variants, and terminal failure classification remains stable.
- [x] Browser tests inspect exact, pending, fallback, optional degradation, invalid export, and audiogram states at every supported target.
- [x] Real-media tests compare audio-only probes and representative audiogram frames with current output and prove unsupported backgrounds are omitted consistently.
- [x] Failure injection covers delayed evidence, stale evidence completion, failed optional assets, invalid geometry, missing required source, and ownership loss during evidence resolution.

## Plan-only implementation constraints

- [x] Extend the existing plan notice model until every composition mode has verified copy for its real fallbacks.
- [x] Keep render failure and optional degradation behavior stable while moving the remaining visual and audio decisions into the plan.
- [x] Do not persist plans or composition notices as a new source of truth.

## Rollout and recovery safety

- [x] Verify that every shown fallback matches the shared plan and rendered result before deploying its fidelity UI.
- [x] Monitor notice code, requested and effective mode, target scope, plan version, invalid-plan count, and optional degradation count.
- [x] Recovery reverts the offending presentation or plan change without restoring a second composition path or discarding evidence and editor changes.

## Scope boundaries

- [x] Do not redesign the audio-only audiogram, add new framing modes, or change optional-asset entitlement and fallback policy.
- [x] Do not block export for an optional degradation.
- [x] Do not change Studio Editing Session durability, cloud convergence, write ownership, or playback ownership.

## Completion evidence

- Planner and adapter tables cover exact, pending, degraded, and invalid fidelity with stable target, scene, and asset-scoped notices.
- Studio exposes every active notice as accessible status text, preserves stable keys for duplicate copy, and replans only from matching evidence and explicit asset-resolution facts.
- Audio-only Studio and export use the existing audiogram topology. Unsupported backgrounds emit a truthful notice and stay out of the rendered visual stack.
- A real Clip Render Attempt audiogram fixture verifies waveform, captions, text, logo, transition, watermark, optional-logo fallback, and H.264/AAC output.
- Authenticated Chrome verification exercised video playback and the audio-source Studio fixture with ready media, waveform canvases, no alerts, and no application errors.
- Final independent Standards and Spec reviews reported no actionable findings. Repository typecheck, tests, lint, and production build pass.

## Fresh-task handoff

Implement in a fresh task with `/implement`; use `/tdd` for fidelity states, accessibility, session adoption, render failure mapping, and audio-only parity; finish with `/code-review`; run uncached focused tests, `bun run typecheck`, `bun run lint`, and `bun run build`; and verify every state in a real browser plus representative real-media output.
