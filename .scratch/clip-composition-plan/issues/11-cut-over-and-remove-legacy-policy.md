# 11 — Cut over adapters and remove legacy composition policy

**What to build:** Move every supported composition through the shared plan, prove production compatibility, and delete the duplicated Studio and worker policy only after rollout and rollback have been rehearsed.

**Blocked by:** [09 — Complete composition fidelity UX and audio-only behavior](09-complete-fidelity-ux-and-audio-only.md); [10 — Deduplicate analysis and enforce resource budgets](10-deduplicate-analysis-and-enforce-budgets.md).

**Status:** ready-for-agent

**Specification:** [Deepen the Clip Composition Plan](../spec.md)

## Observable acceptance criteria

- [ ] Worker and web configuration validate plan-version and mode controls once, preserve current defaults, and reject invalid values before work begins.
- [ ] Center, Fit, Auto, Split, Screen, B-roll, timed visual layers, audio, optional degradation, and audio-only output all use one planning interface.
- [ ] Studio's production adapter translates active plan scenes and forwards existing editor intents without deciding composition precedence, geometry, timing, evidence eligibility, or fallback.
- [ ] Clip Render Attempt resolves plan evidence and assets through internal adapters, then passes one ready or explicitly degraded plan to FFmpeg without surrendering lifecycle ownership.
- [ ] The FFmpeg production adapter owns syntax, escaping, input mapping, filter labels, output mapping, and process requests but cannot change the plan's scenes, layers, crops, audio schedule, or notices.
- [ ] Unknown plan and evidence versions fail before browser adoption, analysis side effects, storage writes, or command execution.
- [ ] Copied web and worker geometry constants, layout precedence, fallback branches, scene timing, audio timing, and parity fixtures are removed after their replacement interface and adapter tests pass.
- [ ] The current plain shared multi-output path and budgeted complex topologies remain intact.
- [ ] Studio Editing Session and Clip Render Attempt remain the sole owners of their existing state, durability, lifecycle, side effects, cancellation, settlement, delivery, and cleanup responsibilities.
- [ ] Operational documentation gives exact dark-deploy, shadow, per-mode enablement, observation, rollback, and final contraction steps.

## Public-interface and failure-injection tests

- [ ] The final behavior suite drives composition policy only through the Clip Composition Plan interface and does not depend on removed helper sequencing.
- [ ] Shared fixtures cover all modes, supported targets and resolutions, evidence states, optional assets, manual overrides, deleted ranges, layer boundaries, audio schedules, output treatments, and audio-only input.
- [ ] Real-browser verification covers editing, target switching, pending evidence, fallback notices, playback preservation, dual-media scenes, B-roll conflicts, optional degradation, invalid plans, and audiograms.
- [ ] Real-FFmpeg verification covers every retained output topology and compares probes, approved keyframes, and audio windows with the legacy path.
- [ ] Performance verification records analysis, extraction, decode, command, duration, and peak-RSS measurements for the representative corpus.
- [ ] A failure matrix injects analysis, asset, adapter, process, storage, ownership, and cleanup failures and proves one stable recoverable outcome without changing Clip Render Attempt settlement.
- [ ] Repository typecheck, lint, production build, full tests, affected database tests, and uncached focused tests all pass.

## Migration and mixed-version considerations

- [ ] Deploy additive plan modules, evidence versions, and adapters before enabling consumption. Apply any evidence persistence migration before code reads it.
- [ ] Cut over one mode at a time and retain its legacy path until shadow, adapter, browser, real-media, and resource checks pass.
- [ ] Contract duplicated policy only after all consuming modes are enabled and rollback has been rehearsed.
- [ ] Completed editor documents, analysis records, exports, render variants, and historical workflows remain untouched.

## Rollout and recovery safety

- [ ] Rehearse deploy dark, collect shadow decisions, enable one mode, observe, disable, and restore current behavior before broad rollout.
- [ ] Final rollout monitors plan version and fingerprint, requested and effective mode, evidence version, notice code, adapter mismatch, scene and layer counts, command grouping, elapsed time, and peak RSS.
- [ ] Rollback controls remain mode-specific until final contraction and require no data rewrite.
- [ ] Final contraction occurs only after the approved observation window has no unexplained parity, failure, or resource regressions.

## Scope boundaries

- [ ] Do not add new layouts, detectors, output resolutions, codecs, quality policy, hardware acceleration, editor collaboration, or workflow lifecycle changes.
- [ ] Do not change current B-roll conflict, audio-only design, caption cue, manual override, optional-asset, entitlement, or retry policy.
- [ ] Do not persist full Clip Composition Plans or create a second editor or render owner.

## Fresh-task handoff

Implement in a fresh task with `/implement`; drive final compatibility and failure coverage with `/tdd`; finish with `/code-review`; run the full uncached verification matrix, `bun run typecheck`, `bun run lint`, and `bun run build`; and do not contract the legacy policy until browser, real-media, performance, rollout, and recovery evidence is recorded with no unresolved review findings.
