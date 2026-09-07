# 07 — Preserve all core render paths and resume semantics

**What to build:** Move every core encode topology behind the Clip Render Attempt so single-video, shared multi-output, edited per-output, and audiogram work preserve existing outputs while gaining exact variant outcomes and retry behavior.

**Blocked by:** [06 — Own guarded uploads and attempt cleanup](06-own-guarded-uploads-and-attempt-cleanup.md).

**Status:** completed

**Specification:** [Deepen the Clip Render Attempt](../spec.md)

## Observable acceptance criteria

- [x] Single-video, shared multi-output, per-output Studio-edit, and audiogram paths all execute through `ClipRenderAttempt.execute`.
- [x] Existing selection rules decide which topology applies; command builders, codecs, presets, caption cues, output dimensions, timing, metadata, and fallbacks remain compatible.
- [x] A shared command failure affects exactly its planned variants, while a per-output failure does not stop unrelated groups.
- [x] Mixed surviving success and failure returns and persists `partial`; terminal partial does not retry failed variants.
- [x] Zero success follows causal retryable/permanent classification, and a retry resumes only interrupted or retryable variants while preserving completed and permanent outcomes.
- [x] Export-bound variants honor persisted clip snapshot, resolution, and watermark; ordinary variants preserve attempt-start resolution and plan entitlement.
- [x] Aggregate counts come from the Render Work Set rather than current-attempt claims.

## Public-interface and failure-injection tests

- [x] Table-driven tests call only `execute` for each topology and compare observable output probes, persistence, counts, and command-adapter requests with legacy fixtures.
- [x] Failure injection covers each command topology, one output of a group, all outputs, upload/persistence on resumed work, retry exhaustion, partial outcome, and all-superseded outcome.
- [x] Existing pure builder and real-FFmpeg regression tests remain until equivalent output compatibility is proven; shallow orchestration tests are removed only when superseded by interface coverage.

## Migration and mixed-version considerations

- [x] This historical coexistence criterion is superseded in the current baseline by the already-present later ticket-11 cutover (`0409301`/`b003c05`). Ticket 07 does not restore the retired live orchestrator; the disabled control pauses claims and the enabled control selects only `ClipRenderAttempt`, so concurrent processing remains impossible.
- [x] Previously completed and failed child rows with legacy null lineage are left untouched; only newly claimed pending work enters the new path.
- [x] Export objects produced before attempt-unique keys remain downloadable.

## Rollout and recovery safety

- [x] Representative fixtures can run legacy and new paths offline and compare media probes and durable outcomes before cutover.
- [x] Any unexplained byte or probe difference blocks rollout unless recorded as an explicit specification change; the only pre-approved visible change is persisted export watermark enforcement.

## Scope boundaries

- [x] Do not add render modes, parallel encodes, hardware acceleration, composition-policy unification, or quality changes.
- [x] Optional assets beyond the minimal existing core inputs, framing analysis migration, lifecycle ownership, Studio, and Ingest Jobs remain outside this ticket.

## Completion evidence

- The new `ClipRenderAttempt.execute` interface matrix passes 20 tests with 126 assertions. It covers every core command topology, shared and per-output failure attribution (including audiograms), upload partials, one terminal partial settlement, zero-success requeue and exhaustion, resumed work, all-superseded settlement, and frozen export state.
- Offline real-FFmpeg fixtures render non-empty caption cues through all four topologies using both the retained legacy builders and `ClipRenderAttempt.execute`; normalized command-adapter requests, FFprobe results, and complete output SHA-256 hashes match. A separate media test proves persisted export timing, 720p resolution, and no-watermark state override a changed live clip and free-plan entitlement.
- The combined attempt, legacy builder, and real-media regression set passes 269 tests with 977 assertions. The complete worker suite passes 585 tests with 1,940 assertions.
- The isolated PostgreSQL lifecycle suite passes 54 tests with 182 assertions, including full-work-set aggregates, completed and permanent outcome preservation, retryable-only requeue, legacy null disposition, terminal partial, retry exhaustion, and all-superseded completion.
- Uncached repository verification passes all 11 typecheck, lint, test, and production-build tasks. The Next.js build generates 52 routes.
- Real Chrome verification loads authenticated `/home`, opens a ready 10-clip project, observes the completed Render activity sequence, plays an attempt-unique rendered MP4 to `readyState` 4 without a media error, and records no failed network requests. The only console warning is Clerk's development-key notice.

## Fresh-task handoff

Implement in a fresh task with `/implement`; drive the change with `/tdd`, finish with `/code-review`, and run uncached interface, database, and real-media regression tests, `bun run typecheck`, `bun run lint`, and a production build.
