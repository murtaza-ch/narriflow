# 07 — Preserve all core render paths and resume semantics

**What to build:** Move every core encode topology behind the Clip Render Attempt so single-video, shared multi-output, edited per-output, and audiogram work preserve existing outputs while gaining exact variant outcomes and retry behavior.

**Blocked by:** [06 — Own guarded uploads and attempt cleanup](06-own-guarded-uploads-and-attempt-cleanup.md).

**Status:** ready-for-agent

**Specification:** [Deepen the Clip Render Attempt](../spec.md)

## Observable acceptance criteria

- [ ] Single-video, shared multi-output, per-output Studio-edit, and audiogram paths all execute through `ClipRenderAttempt.execute`.
- [ ] Existing selection rules decide which topology applies; command builders, codecs, presets, caption cues, output dimensions, timing, metadata, and fallbacks remain compatible.
- [ ] A shared command failure affects exactly its planned variants, while a per-output failure does not stop unrelated groups.
- [ ] Mixed surviving success and failure returns and persists `partial`; terminal partial does not retry failed variants.
- [ ] Zero success follows causal retryable/permanent classification, and a retry resumes only interrupted or retryable variants while preserving completed and permanent outcomes.
- [ ] Export-bound variants honor persisted clip snapshot, resolution, and watermark; ordinary variants preserve attempt-start resolution and plan entitlement.
- [ ] Aggregate counts come from the Render Work Set rather than current-attempt claims.

## Public-interface and failure-injection tests

- [ ] Table-driven tests call only `execute` for each topology and compare observable output probes, persistence, counts, and command-adapter requests with legacy fixtures.
- [ ] Failure injection covers each command topology, one output of a group, all outputs, upload/persistence on resumed work, retry exhaustion, partial outcome, and all-superseded outcome.
- [ ] Existing pure builder and real-FFmpeg regression tests remain until equivalent output compatibility is proven; shallow orchestration tests are removed only when superseded by interface coverage.

## Migration and mixed-version considerations

- [ ] The old and new orchestrators coexist behind a single disabled cutover control, but never process the same live attempt concurrently.
- [ ] Previously completed and failed child rows with legacy null lineage are left untouched; only newly claimed pending work enters the new path.
- [ ] Export objects produced before attempt-unique keys remain downloadable.

## Rollout and recovery safety

- [ ] Representative fixtures can run legacy and new paths offline and compare media probes and durable outcomes before cutover.
- [ ] Any unexplained byte or probe difference blocks rollout unless recorded as an explicit specification change; the only pre-approved visible change is persisted export watermark enforcement.

## Scope boundaries

- [ ] Do not add render modes, parallel encodes, hardware acceleration, composition-policy unification, or quality changes.
- [ ] Optional assets beyond the minimal existing core inputs, framing analysis migration, lifecycle ownership, Studio, and Ingest Jobs remain outside this ticket.

## Fresh-task handoff

Implement in a fresh task with `/implement`; drive the change with `/tdd`, finish with `/code-review`, and run uncached interface, database, and real-media regression tests, `bun run typecheck`, `bun run lint`, and a production build.
