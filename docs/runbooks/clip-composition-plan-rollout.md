# Clip Composition Plan operations

Clip Composition Plan is the only video composition path for Studio preview and worker export. There are no renderer-selection, shadow, or compatibility modes.

The remaining environment values are analysis capability kill switches:

| Evidence | Studio (`apps/web/.env.local`) | Worker (`apps/worker/.env`) |
| --- | --- | --- |
| Automatic speakers | `NEXT_PUBLIC_AUTOMATIC_SPEAKER_LAYOUT` | `WORKER_LAYOUT_ENGINE` |
| Explicit Split | `NEXT_PUBLIC_SPLIT_LAYOUT` | `WORKER_SPLIT` |
| Screen/PiP | `NEXT_PUBLIC_SCREEN_LAYOUT` | `WORKER_SCREEN_LAYOUT` |

Keep each public value aligned with its worker value. Disabling a capability does not select another renderer: the shared planner emits a typed notice and an explicit Center fallback plan.

## Resource budgets and diagnostics

Each target is encoded by an independent FFmpeg command. This is the recovery-safe production topology for plain, edited, Automatic, Split, Screen, B-roll, and audio-only plans. Do not group targets merely to reduce command count. A grouped topology requires representative pixel, branch, scene, command-size, encode-time, and peak-RSS evidence that it is cheaper without exceeding the current memory envelope.

`WORKER_COMPOSITION_MAX_COMMAND_BYTES` defaults to 524288 bytes. Clip Render Attempt measures the encoded command argv before starting FFmpeg. An oversized command fails permanently as `composition_command_budget_exceeded` and logs `clip_composition_budget_rejected` with the stable `composition_command` phase, failure code, disposition, and byte counts only; the log never includes arguments, URLs, editor documents, or provider errors.

Every completed clip group emits `clip_composition_resources`. Use its stable fields to compare like-for-like work: `planVersion`, `planFingerprint`, `requestedMode`, `effectiveModes`, `sceneCount`, `visualLayerCount`, `analysisRequestCount`, `analysisRequestKeys`, `analysisExecutionCount`, `detectorExecutionCount`, `extractedSegmentCount`, `targetCount`, `commandGrouping`, `commandCount`, `sourceDecodeCount`, `commandBytes`, `planningDurationMs`, `encodeDurationMs`, `peakRssBytes`, and `peakRssScope`. A completed decode is counted only after FFmpeg succeeds, and an extracted segment only when analysis produced a distinct segment file. Linux cgroup workers measure the worker and FFmpeg together; macOS and non-cgroup Unix hosts sample the worker plus the active command process. Windows reports the explicit `worker_only` scope.

The historical 60-second, 24-scene 1080p Split comparison remains the grouping guardrail: about 683 MB for the mixed Split graph versus about 267 MB for its non-Split baseline under its original measurement method. Do not compare those worker-only numbers directly with the newer worker-plus-command scope. On 2026-08-27, the amended macOS production path measured 742,850,560 bytes for a 20.2-second, four-target 1080p Auto export and 467,648,512 bytes for a 43.9-second, single-target 720p audiogram. Ticket 10 does not broaden the graph, target cap, scene cap, worker concurrency, codec, or quality policy. New evidence reuse saves detector and extraction work only; independent encoding remains unchanged.

## Deployment

1. Apply pending database migrations before deploying code that reads composition evidence.
2. Deploy the shared planner, Studio adapter, and worker adapter together.
3. Verify Center and Fit across all supported aspect ratios.
4. Verify Automatic with fresh, durable, unavailable, disabled, and target-ineligible evidence.
5. Verify Split with two speakers, insufficient faces, disabled analysis, and targets whose tiles cannot be distinct.
6. Verify Screen with confirmed PiP, face-band fallback, unavailable analysis, and disabled analysis.
7. Watch `clip_composition_plan` logs for plan version, fingerprint, effective modes, evidence source/version, evidence request count, and typed notice codes.
8. Compare `clip_composition_resources` against the representative baseline for analysis executions, extracted segments, source decodes, command grouping, command bytes, encode time, and peak RSS.

## Incident response

Use the narrow analysis kill switch for a failing detector and keep Studio's public mirror aligned. Center, Fit, plan validation, and FFmpeg composition remain active. Unknown plan versions fail before FFmpeg starts and must not be bypassed.

Exact `explicit-split-v1` and `screen-layout-v2` records are reused only when their source identity and versioned fingerprint match. There are no compatibility reads. To recover from a detector incident, disable only its paired Studio and worker capability. To recover from a command-budget incident, inspect the safe byte-count diagnostic before changing the limit; do not restore a renderer selector or combine targets as a workaround.
