# 01 — Establish the Center composition tracer

**What to build:** Make Center framing the first complete Clip Composition Plan slice. Studio and export must consume the same versioned plan for every supported target while the current implementation remains available for shadow comparison and rollback.

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

**Specification:** [Deepen the Clip Composition Plan](../spec.md)

## Observable acceptance criteria

- [ ] The domain glossary and a new ADR define Clip Composition Plan ownership without changing Studio Editing Session or Clip Render Attempt ownership.
- [ ] One pure, browser-safe planning operation accepts a frozen editor document, source facts, known evidence and availability, capabilities, and up to four output targets.
- [ ] The operation returns an immutable, JSON-safe, versioned plan with a deterministic bounded fingerprint.
- [ ] A Center plan covers the complete edited timeline and declares exact integer canvases, source crops, destination frames, active ranges, stable layer IDs, and ordering for every requested target.
- [ ] Center framing requests no speaker, face, scene, or picture-in-picture analysis.
- [ ] Canonical geometry clamps valid bounds and makes output divisibility explicit, so browser and FFmpeg translation cannot choose different rounding.
- [ ] Studio renders Center framing from the plan, keeps the main media element mounted, and preserves playback state when the matching plan changes.
- [ ] Clip Render Attempt supplies frozen inputs to the planner, and the FFmpeg adapter renders the plan without choosing its own crop or fallback.
- [ ] Current Center output probes and visible Studio behavior remain compatible for every supported aspect ratio and resolution.
- [ ] Shadow diagnostics compare requested and effective mode, target canvas, scene bounds, and crop geometry without recording document contents, URLs, or raw commands.

## Public-interface and failure-injection tests

- [ ] Planning-interface tests cover every supported target, edited and unedited timelines, deleted ranges, exact clip-end lookup, video sources, and mixed target sets.
- [ ] Property tests prove that Center scenes are contiguous and complete, all geometry is finite and bounded, fingerprints are deterministic, and plan size stays capped.
- [ ] Web adapter contract tests assert observable stage geometry and playback preservation from plan fixtures without calling a separate crop helper.
- [ ] FFmpeg adapter contract and real-media tests assert output probes and representative frames from the same plan fixtures.
- [ ] Tests prove that unknown plan versions and deterministic invalid geometry fail before browser adoption or command execution.

## Migration and mixed-version considerations

- [ ] Add the planner and adapters beside current behavior. Do not persist plans or change existing durable editor and analysis records.
- [ ] A validated, mode-specific control enables Center shadowing and cutover independently in Studio and the worker.
- [ ] Rolling versions remain safe because adapters reject unknown plan versions and the current Center implementation remains available.

## Rollout and recovery safety

- [ ] Deploy Center planning dark, compare representative shadow decisions, then enable Studio and worker consumption only after unexplained mismatches reach zero for the approved corpus.
- [ ] Rollback selects the retained Center implementation without changing editor documents, render variants, or durable workflow state.

## Scope boundaries

- [ ] Do not migrate Fit, Auto, Split, Screen, B-roll, timed overlays, or audio policy in this ticket.
- [ ] Do not change codecs, quality, output sizes, render topology, lifecycle protocol, persistence ownership, or editor ownership.
- [ ] Do not add a second composition entry point for either adapter.

## Fresh-task handoff

Implement in a fresh task with `/implement`; drive the planning interface and both adapter contracts with `/tdd`; finish with `/code-review`; run uncached focused tests, `bun run typecheck`, `bun run lint`, and `bun run build`; and inspect representative Center output in a real browser and through real FFmpeg before enabling cutover.
