# Clip Composition Plan operations

Clip Composition Plan is the only video composition path for Studio preview and worker export. There are no renderer-selection, shadow, or compatibility modes.

Automatic speaker, Split, and Screen/PiP analysis are enabled in Studio and the worker. Unavailable or failed evidence produces a typed notice and an explicit Center fallback plan.

## Resource budgets and diagnostics

Each target is encoded by an independent FFmpeg command. This is the recovery-safe production topology for plain, edited, Automatic, Split, Screen, B-roll, and audio-only plans. Do not group targets merely to reduce command count. A grouped topology requires representative pixel, branch, scene, command-size, encode-time, and peak-RSS evidence that it is cheaper without exceeding the current memory envelope.

`WORKER_COMPOSITION_MAX_COMMAND_BYTES` defaults to 524288 bytes. Clip Render Attempt measures the encoded command argv before starting FFmpeg. An oversized command fails permanently as `composition_command_budget_exceeded` and logs `clip_composition_budget_rejected` with the stable `composition_command` phase, failure code, disposition, and byte counts only; the log never includes arguments, URLs, editor documents, or provider errors.

Every completed clip group emits `clip_composition_resources`. Use its stable fields to compare like-for-like work: `planVersion`, `planFingerprint`, `requestedMode`, `effectiveModes`, `sceneCount`, `visualLayerCount`, `analysisRequestCount`, `analysisRequestKeys`, `analysisExecutionCount`, `detectorExecutionCount`, `extractedSegmentCount`, `targetCount`, `commandGrouping`, `commandCount`, `sourceDecodeCount`, `commandBytes`, `planningDurationMs`, `encodeDurationMs`, `peakRssBytes`, and `peakRssScope`. A completed decode is counted only after FFmpeg succeeds, and an extracted segment only when analysis produced a distinct segment file. Linux cgroup workers measure the worker and FFmpeg together; macOS and non-cgroup Unix hosts sample the worker plus the active command process. Windows reports the explicit `worker_only` scope.

The historical 60-second, 24-scene 1080p Split comparison remains the grouping guardrail: about 683 MB for the mixed Split graph versus about 267 MB for its non-Split baseline under its original measurement method. Do not compare those worker-only numbers directly with the newer worker-plus-command scope. On 2026-08-27, the amended macOS production path measured 742,850,560 bytes for a 20.2-second, four-target 1080p Auto export and 467,648,512 bytes for a 43.9-second, single-target 720p audiogram. Ticket 10 does not broaden the graph, target cap, scene cap, worker concurrency, codec, or quality policy. New evidence reuse saves detector and extraction work only; independent encoding remains unchanged.

## Deployment

1. Apply pending database migrations before deploying code that reads composition evidence.
2. Deploy the shared planner, Studio adapter, and worker adapter together.
3. Verify Center and Fit across all supported aspect ratios.
4. Verify Automatic with fresh, durable, unavailable, failed, and target-ineligible evidence.
5. Verify Split with two speakers, insufficient faces, unavailable analysis, and targets whose tiles cannot be distinct.
6. Verify Screen with confirmed PiP, face-band fallback, unavailable analysis, and failed analysis.
7. Watch `clip_composition_plan` logs for plan version, fingerprint, effective modes, evidence source/version, evidence request count, and typed notice codes.
8. Compare `clip_composition_resources` against the representative baseline for analysis executions, extracted segments, source decodes, command grouping, command bytes, encode time, and peak RSS.

## Invalid-plan browser check

In a development or test environment, append `?qaCompositionPlan=invalid` to a Studio clip URL. Studio must show the invalid composition notice, label the export trigger `Export blocked`, and keep the final export action disabled. Remove the query parameter to confirm the same clip returns to its normal export state. The fixture is ignored in production and never changes the editor document or durable composition evidence.

## Incident response

Investigate detector failures through typed analysis diagnostics. Center, Fit, plan validation, and FFmpeg composition remain active when analysis is unavailable. Unknown plan versions fail before FFmpeg starts and must not be bypassed.

Exact `explicit-split-v1` and `screen-layout-v1` records are reused only when their source identity and versioned fingerprint match. There are no compatibility reads. To recover from a detector incident, fix the detector and retry failed evidence. To recover from a command-budget incident, inspect the safe byte-count diagnostic before changing the limit; do not restore a renderer selector or combine targets as a workaround.

## Regression checks

Keep these tests passing when changing retained time, inserted Scenes, text rendering, or B-roll resolution:

- Retained slivers under `MIN_KEPT_SEGMENT_SEC` share one clock for render duration, captions, subtitles, censors, and ducking: `dropped edit slivers share the render duration and caption clock` in `packages/composition-plan`, and `apps/worker/src/tasks/cut-plan.test.ts`.
- Music ducking follows speech after inserted Scenes: `music ducking follows speech after an inserted scene`, `music ducking follows speech across an inserted scene`, and the real-FFmpeg `encoded music ducks at the speech's final time after a Scene Block`.
- Text-layer weight matches Studio's 800/500 request: `text layer bold control changes the rendered font weight` in `apps/worker/src/composition-text-weight.test.ts`.
- Automatic stock cutaways render only inside their planned window: `renders automatic stock cutaway pixels only inside the planned window` in `apps/worker/src/tasks/clip-render-attempt-core-paths.test.ts`.
