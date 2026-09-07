# 10 — Deduplicate analysis and enforce resource budgets

**What to build:** Remove repeated composition analysis and extraction work without trading it for unsafe filter graphs or higher worker memory. Compatible targets and modes should reuse evidence, while complex encoding remains bounded by measured budgets.

**Blocked by:** [07 — Move timed visual layers into the shared plan](07-move-timed-visual-layers-into-plan.md); [08 — Plan the edited-time audio schedule end to end](08-plan-edited-time-audio-schedule.md).

**Status:** completed

**Specification:** [Deepen the Clip Composition Plan](../spec.md)

## Observable acceptance criteria

- [x] Every analysis request has a stable key derived only from source identity, relevant source window, deleted ranges, evidence kind, and engine version.
- [x] Compatible targets and layout modes issue at most one request for the same evidence key during a render attempt.
- [x] Detectors over the same source window share one extracted analysis segment and one cleanup lifecycle.
- [x] Valid durable automatic and screen evidence is preferred over new analysis when its versioned fingerprint matches.
- [x] Evidence kinds remain isolated unless a new version explicitly records every fact required by both policies and shared fixtures prove equivalent behavior.
- [x] Screen face confirmation is skipped only when versioned evidence contains the complete deterministic confirmation facts.
- [x] Center, Fit, audio-only, disabled, and B-roll-short-circuited paths perform no unnecessary face or scene analysis.
- [x] The current independent per-target topology remains the safe baseline until measured grouping proves lower cost within the worker memory budget.
- [x] Structurally equivalent complex targets may share work only when pixel, branch, scene, command-size, and memory budgets all permit it.
- [x] Segment-heavy Split, Screen, B-roll, and edited plans keep the safer per-output topology by default.
- [x] Any newly enabled grouping must reduce a measured decode, extraction, analysis, or command cost and stay within the current peak-RSS envelope for the same representative fixture and measurement tolerance.
- [x] Plans remain capped at four targets and existing scene, text, sound-effect, and ducking-window limits.

## Public-interface and failure-injection tests

- [x] Recording-fake tests assert analysis request count, extraction count, evidence reuse, source decode count, command count, and cleanup count for every composition mode and mixed target set.
- [x] Performance fixtures cover plain, edited, Auto, Split, Screen, B-roll, audio, and four-target compositions and record planning time, encode time, command count, source decodes, and peak RSS.
- [x] The existing 60-second, 24-scene Split fixture remains the before-and-after grouping guardrail; this change leaves its command graph and topology unchanged so a broader graph cannot hide a large memory regression.
- [x] Budget-boundary tests cover exact acceptance, one-unit rejection, and command-size rejection. Group-memory rejection and fallback are not applicable because no grouped topology is enabled; deterministic per-output encoding remains the only path.
- [x] Failure injection covers detector/extraction degradation, ownership loss, cleanup failure, and stale durable evidence. Consumer cancellation and grouped-command failure are not applicable because analysis consumers and output commands are not grouped.
- [x] Diagnostics tests prove stable fields and reject signed URLs, raw commands, document contents, and provider errors.
- [x] Full real-media comparisons prove unchanged topology output remains byte-identical where intended and visually or audibly equivalent within approved tolerances elsewhere.

## Plan-only implementation constraints

- [x] Land keyed request and measurement support before enabling any analysis reuse or broader output grouping.
- [x] Preserve exact `explicit-split-v1` and `screen-layout-v2` reuse. Do not add compatibility reads for older or unrelated evidence.
- [x] Preserve independent per-target encoding as the recovery path for any grouped topology.

## Rollout and recovery safety

- [x] Enable new evidence reuse by kind only after call-count, shared-fixture, and real-media tests pass.
- [x] Enable any new complex grouping behind a separate validated budget control and start with the safest measured class.
- [x] Monitor analysis executions, extracted segments, source decodes, command grouping, encode time, and peak RSS by plan version and topology.
- [x] Recovery disables new reuse or grouping without changing editor documents, durable evidence, workflow ownership, or render variants.

## Scope boundaries

- [x] Do not raise worker concurrency, scene caps, output-target caps, retry budgets, or memory limits.
- [x] Do not introduce new detector models, distributed analysis coordination, hardware acceleration, codecs, or quality changes.
- [x] Do not group a complex topology merely to reduce command count. It must satisfy the resource budget and demonstrate saved work.

## Completion evidence

- Canonical evidence keys include the evidence kind plus a fingerprint of source identity, source window, normalized deleted ranges, and engine version. Recording fakes prove one request and one extraction lifecycle across mixed targets for Automatic, Split, and Screen, and zero analysis for Center, Fit, audio-only, disabled, and B-roll-short-circuited plans.
- Matching durable Automatic, `explicit-split-v1`, and exact `screen-layout-v2` evidence executes no detector or extraction work. Evidence kinds remain isolated; the incomplete Screen v1 discriminator is rejected rather than read compatibly.
- Independent per-target encoding remains the only topology. The historical 60-second/24-scene 1080p explicit-Split guardrail was about 683 MB versus about 267 MB under its original worker-only measurement method. A fresh amended-path 720p export of the local 61.02-second/24-scene Auto/two-up fixture (`Blue gets eliminated`, nine two-up scenes) recorded a 206,553,088-byte worker-only peak with a 100 ms process sampler and a 630,980,608-byte peak with the production `worker_and_command_processes` sampler. A second export of that clip at 1080p with current `explicit-split-v1` evidence produced 14 scenes and recorded 330,235,904 bytes worker-only plus 1,155,072,000 bytes in the production scope. Both worker-only results remain below the historical complex-layout peak, while the production scope now records the FFmpeg child that the old measurement omitted. Because the current explicit Split planner produced 14 rather than 24 scenes for this source, these runs bound the amended path but are not claimed as a pixel-for-pixel reproduction of the historical graph. No broader graph or grouped failure surface was enabled, so grouping-only memory rejection, consumer cancellation, and fallback cases remain deliberately inapplicable.
- Commands are measured before process execution and bounded by `WORKER_COMPOSITION_MAX_COMMAND_BYTES` (default 524288). The exact byte boundary passes and one byte less rejects permanently before FFmpeg. Stable resource diagnostics omit commands, URLs, documents, and provider errors.
- Resource telemetry is an injected `{ rssBytes, scope }` seam. Probe and recorder failures are isolated as degraded diagnostics and cannot change render or settlement state; failure-injection tests prove a successful variant still completes. Shared segment extraction likewise catches adapter failure once, records zero completed extractions, selects typed plan fallbacks, cleans the workspace once, and preserves settlement.
- Authenticated Chrome verification delivered a fresh four-target 1080p Auto export on the amended production path. It recorded 4 completed commands/decodes, 0 analysis executions/extractions, 31,264 ms aggregate encode time, and 742,850,560 bytes peak worker-plus-FFmpeg process RSS. A separate 43.9-second audiogram export recorded 1 completed command/decode, 4,904 ms encode time, and 467,648,512 bytes with the same scope.
- Additional 720p production exports broadened that measurement corpus. Center recorded 1 scene, 91 visual layers, 1 command/decode, a 1,447-byte command, 9,738 ms encode time, and 424,984,576 bytes peak RSS. Screen recorded 64 scenes, 62 visual layers, 1 keyed request, 1 analysis execution, 2 detector executions over 1 completed shared extraction, 1 command/decode, a 42,415-byte command, 5,637 ms encode time, and 1,153,449,984 bytes peak RSS; its no-candidate result selected the typed speaker-band fallback. Split recorded 7 scenes, 28 visual layers, 1 command/decode, a 3,796-byte command, 5,087 ms encode time, and 550,223,872 bytes peak RSS. A reversible 2.66-second deleted-range edit on that Split clip recorded 7 edited scenes, 26 visual layers, 1 keyed request/analysis/detector/shared extraction, 1 command/decode, a 4,105-byte command, 7 ms planning time, 4,582 ms encode time, and 576,258,048 bytes peak RSS; Chrome confirmed export `58d15f52-f1b1-4e11-b837-900e7be2cd7e` Ready before the editor cut was reverted and durable `deletedRanges` returned to `[]`. The 61.02-second/24-scene Auto/two-up guardrail recorded 65 visual layers, 1 keyed request/analysis, 2 detector executions over 1 completed shared extraction, 1 command/decode, a 10,328-byte command, 3 ms planning time, 13,665 ms encode time, and 630,980,608 bytes production-scope peak RSS; Chrome confirmed export `aab3a739-1216-4c66-b1fb-8ff6a387b417` Ready. Its 1080p explicit-Split companion recorded 14 scenes, 65 visual layers, 1 keyed request/analysis/detector/shared extraction, 1 command/decode, a 5,489-byte command, 8 ms planning time, 13,112 ms encode time, and 1,155,072,000 bytes production-scope peak RSS; Chrome confirmed export `e6396e23-cbd4-4bd8-b463-ac8aa08f55a4` Ready before restoring Auto. The active B-roll case recorded 3 scenes (including one source-plus-B-roll scene), 52 visual layers, 1 command/decode, a 1,801-byte command, 4,984 ms encode time, and 705,134,592 bytes peak RSS. Every production diagnostic value used the `worker_and_command_processes` scope and every export settled successfully.

## Fresh-task handoff

Implement in a fresh task with `/implement`; use `/tdd` for request keys, reuse, cancellation, grouping budgets, and resource accounting; finish with `/code-review`; run uncached focused, performance, and real-media tests plus `bun run typecheck`, `bun run lint`, and `bun run build`; and record reproducible before-and-after cost and peak-RSS evidence.
