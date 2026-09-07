# 11 — Complete plan coverage and verify plan-only adapters

**What to build:** Finish moving timed visual layers, audio, fidelity, and audio-only behavior into the shared plan, then verify that Studio and FFmpeg remain translation-only adapters. Base-video composition and B-roll are already plan-only.

**Blocked by:** [07 — Move timed visual layers into the shared plan](07-move-timed-visual-layers-into-plan.md); [08 — Plan the edited-time audio schedule end to end](08-plan-edited-time-audio-schedule.md); [09 — Complete composition fidelity UX and audio-only behavior](09-complete-fidelity-ux-and-audio-only.md); [10 — Deduplicate analysis and enforce resource budgets](10-deduplicate-analysis-and-enforce-budgets.md).

**Status:** completed

**Specification:** [Deepen the Clip Composition Plan](../spec.md)

## Observable acceptance criteria

- [x] Worker and web configuration validate plan versions and analysis capabilities once, preserve enabled defaults, and reject invalid values before work begins.
- [x] Center, Fit, Auto, Split, Screen, B-roll, timed visual layers, audio, optional degradation, and audio-only output all use one planning interface.
- [x] Studio's production adapter translates all active plan layers and forwards editor intents without deciding composition precedence, geometry, timing, evidence eligibility, audio policy, or fallback.
- [x] Clip Render Attempt resolves base-video evidence and B-roll assets through internal adapters, then passes one ready or explicitly degraded plan to FFmpeg without surrendering lifecycle ownership.
- [x] The FFmpeg production adapter owns syntax, escaping, input mapping, filter labels, output mapping, and process requests but cannot change any planned scene, layer, crop, audio schedule, or notice.
- [x] Unknown plan and evidence versions fail before browser adoption, durable evidence writes, or command execution.
- [x] Copied web and worker visual-layer ordering, timing, audio policy, and parity fixtures are removed after their replacement plan and adapter tests pass.
- [x] Every target currently uses an independent FFmpeg decode and encode. Any future grouping must pass ticket 10's measured budgets.
- [x] Studio Editing Session and Clip Render Attempt remain the sole owners of their existing state, durability, lifecycle, side effects, cancellation, settlement, delivery, and cleanup responsibilities.
- [x] Operational documentation describes the plan-only path, paired analysis capability switches, direct deployment, diagnostics, and incident response.

## Public-interface and failure-injection tests

- [x] The final behavior suite drives every composition policy only through the Clip Composition Plan interface and does not depend on adapter helper sequencing.
- [x] Shared fixtures cover all base-video modes, supported targets, evidence states, B-roll availability, manual speaker overrides, deleted ranges, and base-layer boundaries.
- [x] Extend shared fixtures to captions, text, logos, transitions, output treatment, audio schedules, optional audio assets, and audio-only input.
- [x] Real-browser verification covers editing, target switching, pending evidence, fallback notices, playback preservation, dual-media scenes, B-roll conflicts, optional degradation, invalid plans, and audiograms.
- [x] Real-FFmpeg verification covers every retained output topology and compares probes, approved keyframes, and audio windows with checked-in fixtures.
- [x] Performance verification records analysis, extraction, decode, command, duration, and peak-RSS measurements for the representative corpus.
- [x] A failure matrix injects analysis, asset, adapter, process, storage, ownership, and cleanup failures and proves one stable recoverable outcome without changing Clip Render Attempt settlement.
- [x] Repository typecheck, lint, production build, full tests, affected database tests, and uncached focused tests all pass.

## Plan-only implementation constraints

- [x] Base-video composition and B-roll use the plan as their only Studio and worker policy path. Removed renderer selectors, compatibility readers, and duplicate geometry must not return.
- [x] Extend the existing plan and adapters directly for tickets 07 through 10. Apply a persistence migration before code reads any new durable evidence shape.
- [x] Remove remaining adapter-owned visual and audio policy only after replacement plan tests, browser checks, real-media checks, and resource measurements pass.
- [x] Completed editor documents, valid current-version analysis records, exports, render variants, and historical workflows remain untouched.

## Rollout and recovery safety

- [x] Deploy each remaining shared plan change with its web and worker adapters after the ticket's browser, FFmpeg, failure, and resource checks pass.
- [x] Final verification monitors plan version and fingerprint, requested and effective mode, evidence version, notice code, scene and layer counts, command grouping, elapsed time, and peak RSS.
- [x] Automatic, Split, and Screen retain narrow analysis kill switches. Disabling one emits a typed plan fallback and never selects another renderer.
- [x] Recovery reverts the offending shared plan or adapter change. It does not restore removed composition selectors or compatibility paths.

## Scope boundaries

- [x] Do not add new layouts, detectors, output resolutions, codecs, quality policy, hardware acceleration, editor collaboration, or workflow lifecycle changes.
- [x] Do not change current B-roll conflict, audio-only design, caption cue, manual override, optional-asset, entitlement, or retry policy.
- [x] Do not persist full Clip Composition Plans or create a second editor or render owner.

## Completion evidence

- The Clip Composition Plan remains the sole policy interface for video and audio-only input, every base mode, B-roll, timed visual layers, captions, text, logos, transitions, output treatment, source/music/SFX schedules, and optional degradation. Studio and FFmpeg adapter contract suites consume ready plans and reject unknown versions without re-deciding policy.
- The final changed-path matrix passed 162 Clip Render Attempt, process-adapter, and validator tests (897 assertions) plus 111 explicit Studio Editing Session, preview-adapter, capability, and FFmpeg-adapter tests (367 assertions). Real-media fixtures probe every retained topology, including audiogram, edited audio, optional degradation, Automatic, Split, Screen, ranged/download sources, and four-target output.
- Declared unknown Automatic, Split, and Screen evidence versions or engine discriminators now throw a stable permanent `unsupported_clip_composition_evidence_version` before analysis persistence or command construction. Validator tests cover the exact fail-closed boundary, and the public Clip Render Attempt test proves no evidence write, command, upload, or successful variant can occur.
- Authenticated Chrome verification exercised the supplied YouTube import end to end, visible preview playback, target switching without playback loss, accessible Split and Screen pending/fallback notices, restoration to Auto, and fresh four-target 1080p delivery. A separate Screen-requested clip displayed the exact B-roll conflict notice, exposed the active VIDEO and B-ROLL tracks, and delivered a fresh 720p export whose plan contained a source-plus-B-roll scene and one optional degradation. An existing audio-only project played its preview and delivered a fresh 720p audiogram. A persisted clip declaring unknown Screen evidence failed closed in Chrome at the editor boundary (`We couldn’t load the editor`, digest `662039297`) instead of adopting or replacing that evidence. The development-only `qaCompositionPlan=invalid` browser fixture then exercised literal invalid-plan handling: Studio displayed the invalid-plan notice, changed the trigger to `Export blocked`, and disabled the final export action. Production ignores this fixture. The generated local audio upload attempt also exposed an environment-specific `invalid resume metadata` failure before project creation; the existing durable audio project was used to verify the plan and render path independently of that uploader failure.
- Production-path diagnostics reported exact plan fidelity, plan/evidence versions, four target scenes, 92 timed visual layers, independent command grouping, four completed commands/decodes, no duplicate analysis, and 742,850,560 bytes peak worker-plus-FFmpeg RSS. The audiogram recorded one scene, 39 visual layers, one completed command/decode, and 467,648,512 bytes peak RSS. Fresh one-target Center, Screen, Split, edited Split, 61.02-second/24-scene Auto/two-up, 61.02-second/14-scene 1080p explicit Split, and B-roll exports also completed in Chrome: Center recorded 9,738 ms encode time and 424,984,576 bytes peak RSS; Screen recorded 5,637 ms and 1,153,449,984 bytes while exercising keyed analysis, shared extraction, and typed optional degradation; Split recorded 5,087 ms and 550,223,872 bytes; the 2.66-second deleted-range Split edit recorded 4,582 ms and 576,258,048 bytes while exercising a new keyed analysis and shared extraction, then the cut was reverted and the saved editor document returned to no deleted ranges; the 24-scene Auto/two-up run recorded 13,665 ms, 630,980,608 bytes production-scope RSS, and 206,553,088 bytes worker-only RSS; the 1080p explicit-Split companion recorded 13,112 ms, 1,155,072,000 bytes production-scope RSS, and 330,235,904 bytes worker-only RSS before the layout was restored to Auto; B-roll recorded 4,984 ms and 705,134,592 bytes with an active dual-media scene. Production peak measurements used the `worker_and_command_processes` scope unless explicitly labeled worker-only. The rollout runbook documents the paired kill switches, command budget, resource fields and scope, direct deployment, and recovery path.
- Repository typecheck, lint, full tests, production build, focused web/worker contract suites, real FFmpeg fixtures, Biome, and diff validation pass. No database schema or persistence shape changed, so no migration or composition-specific database integration test was applicable.

## Fresh-task handoff

Implement after tickets 07 through 10 with `/implement`; drive final contract and failure coverage with `/tdd`; finish with `/code-review`; run the full uncached verification matrix, `bun run typecheck`, `bun run lint`, and `bun run build`; and keep the adapters policy-free while closing the remaining visual, audio, and audio-only gaps.
