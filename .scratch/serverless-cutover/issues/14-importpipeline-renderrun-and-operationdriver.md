# 14 - ImportPipeline, RenderRun and OperationDriver

**What to build:** ImportPipeline, RenderRun and OperationDriver.

**Blocked by:** 04–13

**Status:** ready-for-agent

**Spec:** [Serverless cutover](../spec.md)

- **Build:** workflows that call domain commands, wait on audio/STT/video/prepare/group outcomes and settle the parent in short transactions. Explicit exports, regeneration, late follow-ups and caption-only imports use the same model. Preparation deduplicated per evidence binding.
- **Files:** `apps/api/src/workflows/{import-pipeline,render-run,operation-driver}.ts`, service adapters, the one-shot `render-group-executor`.
- **Accept:** events before waits, duplicates, cancelled generation, group expiry, mixed outcomes, partial retry and late exports are all handled. No `coordinateRenderWorkSet` loop. Results open only after the frozen batch settles, with a truthful partial outcome. Platform retries never multiply domain retry budgets.

## Evidence

Pending implementation and verification.
