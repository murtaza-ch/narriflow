# 10 — Deduplicate analysis and enforce resource budgets

**What to build:** Remove repeated composition analysis and extraction work without trading it for unsafe filter graphs or higher worker memory. Compatible targets and modes should reuse evidence, while complex encoding remains bounded by measured budgets.

**Blocked by:** [07 — Move timed visual layers into the shared plan](07-move-timed-visual-layers-into-plan.md); [08 — Plan the edited-time audio schedule end to end](08-plan-edited-time-audio-schedule.md).

**Status:** ready-for-agent

**Specification:** [Deepen the Clip Composition Plan](../spec.md)

## Observable acceptance criteria

- [ ] Every analysis request has a stable key derived only from source identity, relevant source window, deleted ranges, evidence kind, and engine version.
- [ ] Compatible targets and layout modes issue at most one request for the same evidence key during a render attempt.
- [ ] Detectors over the same source window share one extracted analysis segment and one cleanup lifecycle.
- [ ] Valid durable automatic and screen evidence is preferred over new analysis when its versioned fingerprint matches.
- [ ] Evidence kinds remain isolated unless a new version explicitly records every fact required by both policies and shared fixtures prove equivalent behavior.
- [ ] Screen face confirmation is skipped only when versioned evidence contains the complete deterministic confirmation facts.
- [ ] Center, Fit, audio-only, disabled, and B-roll-short-circuited paths perform no unnecessary face or scene analysis.
- [ ] The current independent per-target topology remains the safe baseline until measured grouping proves lower cost within the worker memory budget.
- [ ] Structurally equivalent complex targets may share work only when pixel, branch, scene, command-size, and memory budgets all permit it.
- [ ] Segment-heavy Split, Screen, B-roll, and edited plans keep the safer per-output topology by default.
- [ ] Any newly enabled grouping must reduce a measured decode, extraction, analysis, or command cost and stay within the current peak-RSS envelope for the same representative fixture and measurement tolerance.
- [ ] Plans remain capped at four targets and existing scene, text, sound-effect, and ducking-window limits.

## Public-interface and failure-injection tests

- [ ] Recording-fake tests assert analysis request count, extraction count, evidence reuse, source decode count, command count, and cleanup count for every composition mode and mixed target set.
- [ ] Performance fixtures cover plain, edited, Auto, Split, Screen, B-roll, audio, and four-target compositions and record planning time, encode time, command count, source decodes, and peak RSS.
- [ ] The existing 60-second, 24-scene Split fixture records a before-and-after baseline so a broader graph cannot hide a large memory regression.
- [ ] Budget-boundary tests cover exact acceptance, one-unit rejection, command-size rejection, memory rejection, and deterministic fallback to per-output encoding.
- [ ] Failure injection covers detector failure, extraction failure, one consumer cancellation, ownership loss, cleanup failure, stale durable evidence, and a grouped command failure.
- [ ] Diagnostics tests prove stable fields and reject signed URLs, raw commands, document contents, and provider errors.
- [ ] Full real-media comparisons prove unchanged topology output remains byte-identical where intended and visually or audibly equivalent within approved tolerances elsewhere.

## Plan-only implementation constraints

- [ ] Land keyed request and measurement support before enabling any analysis reuse or broader output grouping.
- [ ] Preserve exact `explicit-split-v1` and `screen-layout-v2` reuse. Do not add compatibility reads for older or unrelated evidence.
- [ ] Preserve independent per-target encoding as the recovery path for any grouped topology.

## Rollout and recovery safety

- [ ] Enable new evidence reuse by kind only after call-count, shared-fixture, and real-media tests pass.
- [ ] Enable any new complex grouping behind a separate validated budget control and start with the safest measured class.
- [ ] Monitor analysis executions, extracted segments, source decodes, command grouping, encode time, and peak RSS by plan version and topology.
- [ ] Recovery disables new reuse or grouping without changing editor documents, durable evidence, workflow ownership, or render variants.

## Scope boundaries

- [ ] Do not raise worker concurrency, scene caps, output-target caps, retry budgets, or memory limits.
- [ ] Do not introduce new detector models, distributed analysis coordination, hardware acceleration, codecs, or quality changes.
- [ ] Do not group a complex topology merely to reduce command count. It must satisfy the resource budget and demonstrate saved work.

## Fresh-task handoff

Implement in a fresh task with `/implement`; use `/tdd` for request keys, reuse, cancellation, grouping budgets, and resource accounting; finish with `/code-review`; run uncached focused, performance, and real-media tests plus `bun run typecheck`, `bun run lint`, and `bun run build`; and record reproducible before-and-after cost and peak-RSS evidence.
