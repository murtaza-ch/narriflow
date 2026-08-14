# 11 — Cut over, contract, and verify recovery

**What to build:** Validate render configuration once, wire all production adapters, drain workers into the Clip Render Attempt path, retire legacy orchestration, and prove rollout and rollback recovery end to end.

**Blocked by:** [03 — Deliver render notifications through Workflow Events](03-deliver-render-notifications-through-workflow-events.md); [07 — Preserve all core render paths and resume semantics](07-preserve-core-render-paths-and-resume-semantics.md); [08 — Preserve optional-asset fallbacks inside the Clip Render Attempt](08-preserve-optional-asset-fallbacks.md); [09 — Preserve framing and media-analysis paths](09-preserve-framing-and-media-analysis-paths.md); [10 — Add safe orphaned-render-object reconciliation](10-add-safe-orphaned-render-object-reconciliation.md).

**Status:** ready-for-agent

**Specification:** [Deepen the Clip Render Attempt](../spec.md)

## Observable acceptance criteria

- [ ] Worker startup parses all render environment inputs once into immutable validated configuration with current defaults.
- [ ] Invalid numeric or enum values fail startup; literal `0` preserves every current kill switch; accepted nonstandard values warn; upload concurrency defaults to two and caps at four; every deadline is finite and positive.
- [ ] The worker caller invokes only `ClipRenderAttempt.execute` for protocol-version-2 clip-rendering work and treats `WorkflowAttemptLost` only as control flow.
- [ ] Legacy asset, command, upload, persistence, settlement, notification, and cleanup sequencing is removed after equivalent interface coverage exists.
- [ ] Production process, storage, media, persistence, workspace, clock, diagnostic, and notification adapters pass contract tests.
- [ ] Structured success, partial, terminal failure, requeue, ownership loss, stale completion, follow-up, notification retry, cleanup failure, and orphan-recovery diagnostics contain stable fields and no secrets.
- [ ] The full render behavior matrix preserves existing output probes and fallbacks; export-bound watermark uses its persisted value.
- [ ] Operational documentation gives exact migrate, dark-deploy, drain, enable, observe, rollback-drain, disable, and reconcile steps.

## Public-interface and failure-injection tests

- [ ] The final behavior suite drives all orchestration through `ClipRenderAttempt.execute`; no test depends on the removed main function's internal sequencing.
- [ ] A failure matrix injects ownership loss and process/storage/persistence failure before and after every durable phase and proves exactly one recoverable outcome.
- [ ] Uncached database and adapter contracts cover old-schema data, null lineage, retry after legacy work, event replay, notification handoff, follow-up replay, worker crash, lease reaping, and orphan reconciliation.
- [ ] Real-media compatibility fixtures cover every core topology, optional-asset fallback, analysis mode, resolution, watermark, and source-access mode.

## Migration and mixed-version considerations

- [ ] Database migrations are applied before code enablement, and all readers tolerate additive fields throughout deployment.
- [ ] Old and new render workers are never allowed to claim live protocol-version-2 render runs simultaneously; no lifecycle protocol version 3 is added.
- [ ] Completed historical rows and objects remain untouched, and rollback retains additive schema and new events for forward recovery.

## Rollout and recovery safety

- [ ] Rollout sequence is enforced and rehearsed: migrate, deploy dark, verify adapters, drain render workers, enable the new path, restart workers, and observe representative outcomes.
- [ ] Rollback sequence drains render workers before disabling the path and restarting legacy-compatible code.
- [ ] Recovery drills prove the lifecycle reaper resumes an abandoned attempt, notification dispatch resumes after failure, follow-up admission is idempotent, and dry-run orphan reconciliation identifies only safe candidates.

## Scope boundaries

- [ ] Do not change Workflow Run ownership, retry budget, lifecycle protocol version, Studio Editing Session, Ingest Jobs, or Clip Composition Plan.
- [ ] Do not introduce output-quality changes, new codecs, hardware acceleration, parallel encode policy, optional-asset UX, or unrelated refactors.

## Fresh-task handoff

Implement in a fresh task with `/implement`; drive the change with `/tdd`, finish with `/code-review`, and run uncached focused and full tests, database tests, `bun run typecheck`, `bun run lint`, and the production build. Cutover is not complete until the code review has no unresolved findings and the recovery drill evidence is recorded.
