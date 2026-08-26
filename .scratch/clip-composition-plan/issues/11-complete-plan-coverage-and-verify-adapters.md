# 11 — Complete plan coverage and verify plan-only adapters

**What to build:** Finish moving timed visual layers, audio, fidelity, and audio-only behavior into the shared plan, then verify that Studio and FFmpeg remain translation-only adapters. Base-video composition and B-roll are already plan-only.

**Blocked by:** [07 — Move timed visual layers into the shared plan](07-move-timed-visual-layers-into-plan.md); [08 — Plan the edited-time audio schedule end to end](08-plan-edited-time-audio-schedule.md); [09 — Complete composition fidelity UX and audio-only behavior](09-complete-fidelity-ux-and-audio-only.md); [10 — Deduplicate analysis and enforce resource budgets](10-deduplicate-analysis-and-enforce-budgets.md).

**Status:** ready-for-agent

**Specification:** [Deepen the Clip Composition Plan](../spec.md)

## Observable acceptance criteria

- [x] Worker and web configuration validate plan versions and analysis capabilities once, preserve enabled defaults, and reject invalid values before work begins.
- [ ] Center, Fit, Auto, Split, Screen, B-roll, timed visual layers, audio, optional degradation, and audio-only output all use one planning interface.
- [ ] Studio's production adapter translates all active plan layers and forwards editor intents without deciding composition precedence, geometry, timing, evidence eligibility, audio policy, or fallback.
- [x] Clip Render Attempt resolves base-video evidence and B-roll assets through internal adapters, then passes one ready or explicitly degraded plan to FFmpeg without surrendering lifecycle ownership.
- [ ] The FFmpeg production adapter owns syntax, escaping, input mapping, filter labels, output mapping, and process requests but cannot change any planned scene, layer, crop, audio schedule, or notice.
- [x] Unknown plan and evidence versions fail before browser adoption, durable evidence writes, or command execution.
- [ ] Copied web and worker visual-layer ordering, timing, audio policy, and parity fixtures are removed after their replacement plan and adapter tests pass.
- [x] Every target currently uses an independent FFmpeg decode and encode. Any future grouping must pass ticket 10's measured budgets.
- [x] Studio Editing Session and Clip Render Attempt remain the sole owners of their existing state, durability, lifecycle, side effects, cancellation, settlement, delivery, and cleanup responsibilities.
- [x] Operational documentation describes the plan-only path, paired analysis capability switches, direct deployment, diagnostics, and incident response.

## Public-interface and failure-injection tests

- [ ] The final behavior suite drives every composition policy only through the Clip Composition Plan interface and does not depend on adapter helper sequencing.
- [x] Shared fixtures cover all base-video modes, supported targets, evidence states, B-roll availability, manual speaker overrides, deleted ranges, and base-layer boundaries.
- [ ] Extend shared fixtures to captions, text, logos, transitions, output treatment, audio schedules, optional audio assets, and audio-only input.
- [ ] Real-browser verification covers editing, target switching, pending evidence, fallback notices, playback preservation, dual-media scenes, B-roll conflicts, optional degradation, invalid plans, and audiograms.
- [ ] Real-FFmpeg verification covers every retained output topology and compares probes, approved keyframes, and audio windows with checked-in fixtures.
- [ ] Performance verification records analysis, extraction, decode, command, duration, and peak-RSS measurements for the representative corpus.
- [ ] A failure matrix injects analysis, asset, adapter, process, storage, ownership, and cleanup failures and proves one stable recoverable outcome without changing Clip Render Attempt settlement.
- [ ] Repository typecheck, lint, production build, full tests, affected database tests, and uncached focused tests all pass.

## Plan-only implementation constraints

- [x] Base-video composition and B-roll use the plan as their only Studio and worker policy path. Removed renderer selectors, compatibility readers, and duplicate geometry must not return.
- [ ] Extend the existing plan and adapters directly for tickets 07 through 10. Apply a persistence migration before code reads any new durable evidence shape.
- [ ] Remove remaining adapter-owned visual and audio policy only after replacement plan tests, browser checks, real-media checks, and resource measurements pass.
- [x] Completed editor documents, valid current-version analysis records, exports, render variants, and historical workflows remain untouched.

## Rollout and recovery safety

- [ ] Deploy each remaining shared plan change with its web and worker adapters after the ticket's browser, FFmpeg, failure, and resource checks pass.
- [ ] Final verification monitors plan version and fingerprint, requested and effective mode, evidence version, notice code, scene and layer counts, command grouping, elapsed time, and peak RSS.
- [x] Automatic, Split, and Screen retain narrow analysis kill switches. Disabling one emits a typed plan fallback and never selects another renderer.
- [ ] Recovery reverts the offending shared plan or adapter change. It does not restore removed composition selectors or compatibility paths.

## Scope boundaries

- [ ] Do not add new layouts, detectors, output resolutions, codecs, quality policy, hardware acceleration, editor collaboration, or workflow lifecycle changes.
- [ ] Do not change current B-roll conflict, audio-only design, caption cue, manual override, optional-asset, entitlement, or retry policy.
- [ ] Do not persist full Clip Composition Plans or create a second editor or render owner.

## Fresh-task handoff

Implement after tickets 07 through 10 with `/implement`; drive final contract and failure coverage with `/tdd`; finish with `/code-review`; run the full uncached verification matrix, `bun run typecheck`, `bun run lint`, and `bun run build`; and keep the adapters policy-free while closing the remaining visual, audio, and audio-only gaps.
