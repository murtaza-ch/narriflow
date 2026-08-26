# 01 — Establish the Center composition tracer

**What to build:** Make Center framing the first complete Clip Composition Plan slice. Studio and export must consume the same versioned plan for every supported target.

**Blocked by:** None — can start immediately.

**Status:** completed

**Specification:** [Deepen the Clip Composition Plan](../spec.md)

## Observable acceptance criteria

- [x] The domain glossary and a new ADR define Clip Composition Plan ownership without changing Studio Editing Session or Clip Render Attempt ownership.
- [x] One pure, browser-safe planning operation accepts a frozen editor document, source facts, known evidence and availability, capabilities, and up to four output targets.
- [x] The operation returns an immutable, JSON-safe, versioned plan with a deterministic bounded fingerprint.
- [x] A Center plan covers the complete edited timeline and declares exact integer canvases, source crops, destination frames, active ranges, stable layer IDs, and ordering for every requested target.
- [x] Center framing requests no speaker, face, scene, or picture-in-picture analysis.
- [x] Canonical geometry clamps valid bounds and makes output divisibility explicit, so browser and FFmpeg translation cannot choose different rounding.
- [x] Studio renders Center framing from the plan, keeps the main media element mounted, and preserves playback state when the matching plan changes.
- [x] Clip Render Attempt supplies frozen inputs to the planner, and the FFmpeg adapter renders the plan without choosing its own crop or fallback.
- [x] Current Center output probes and visible Studio behavior remain compatible for every supported aspect ratio and resolution.
- [x] Structured diagnostics record requested and effective mode, target canvas, scene bounds, and crop geometry without recording document contents, URLs, or raw commands.

## Public-interface and failure-injection tests

- [x] Planning-interface tests cover every supported target, edited and unedited timelines, deleted ranges, exact clip-end lookup, video sources, and mixed target sets.
- [x] Property tests prove that Center scenes are contiguous and complete, all geometry is finite and bounded, fingerprints are deterministic, and plan size stays capped.
- [x] Web adapter contract tests assert observable stage geometry and playback preservation from plan fixtures without calling a separate crop helper.
- [x] FFmpeg adapter contract and real-media tests assert output probes and representative frames from the same plan fixtures.
- [x] Tests prove that unknown plan versions and deterministic invalid geometry fail before browser adoption or command execution.

## Plan-only state

- [x] Keep plans derived and ephemeral. Do not persist them or change existing durable editor records.
- [x] Center has no renderer selector or analysis capability switch. Both adapters always consume the plan.
- [x] Rolling versions remain safe because adapters reject unknown plan versions and the current Center implementation remains available.

## Rollout and recovery safety

- [x] Verify representative Center decisions in Studio and FFmpeg before changing the shared planner.
- [x] Recovery keeps the plan-only Center path and reverts the offending code change without rewriting editor documents, render variants, or workflow state.

## Scope boundaries

- [x] Do not migrate Fit, Auto, Split, Screen, B-roll, timed overlays, or audio policy in this ticket.
- [x] Do not change codecs, quality, output sizes, render topology, lifecycle protocol, persistence ownership, or editor ownership.
- [x] Do not add a second composition entry point for either adapter.

## Completion evidence

- `@narriflow/composition-plan` owns the deterministic versioned plan, bounded fingerprints, canonical geometry, and stable logical identifiers. Studio and the worker translate that plan through separate web and FFmpeg adapters.
- The plan-only path was exercised in authenticated Chrome and the worker. Vertical, landscape, and square outputs were probeable, and playback survived plan adoption.
- The full test, typecheck, lint, and production-build gates passed. Independent specification and standards reviews reported no remaining findings.

## Fresh-task handoff

For future Center changes, use `/implement` and `/tdd`, finish with `/code-review`, run uncached focused tests plus repository verification, and inspect representative output in a real browser and through real FFmpeg.
