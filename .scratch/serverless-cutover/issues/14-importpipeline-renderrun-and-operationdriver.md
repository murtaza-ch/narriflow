# 14 - ImportPipeline, RenderRun and OperationDriver

**What to build:** ImportPipeline, RenderRun and OperationDriver.

**Blocked by:** 04–13

**Status:** claimed

**Spec:** [Serverless cutover](../spec.md)

- **Build:** workflows that call domain commands, wait on audio/STT/video/prepare/group outcomes and settle the parent in short transactions. Explicit exports, regeneration, late follow-ups and caption-only imports use the same model. Preparation deduplicated per evidence binding.
- **Files:** `apps/api/src/workflows/{import-pipeline,render-run,operation-driver}.ts`, service adapters, the one-shot `render-group-executor`.
- **Accept:** events before waits, duplicates, cancelled generation, group expiry, mixed outcomes, partial retry and late exports are all handled. No `coordinateRenderWorkSet` loop. Results open only after the frozen batch settles, with a truthful partial outcome. Platform retries never multiply domain retry budgets.

## Evidence

Workflow infrastructure is implemented: explicit four entrypoints, fresh DB/env/ports per command step, metadata-only durable waits, deterministic confirmed registration/wakes, and bounded progress continuation delivery. Unknown business subjects fail explicitly.

[Local workerd/real PostgreSQL infrastructure evidence](../evidence/workflows-workerd-20261031.json) covers8checks. Domain handlers, full import/render acceptance and deployed gates remain required. This ticket remains claimed.

[Independent wake/deadline evidence](../evidence/workflow-wake-delivery-20261031.json) adds a nine-check Workerd gate. The runtime can acknowledge an event after its parent has closed; scheduler delivery therefore also confirms a distinct reference-only Maintenance command. Watchdogs reread current leases, and bounded Project progress drains recover on domain receipt replays. Native validation/thumbnail/RSS and Scribe handlers are wired; ImportPipeline, selection and full RenderRun behavior remain incomplete.

Clip Preparation admission now validates the exact current Render Group dispatch
before reading its source/editor inputs. It requires video-ready, committed
source-video artifact evidence and a complete normalized probe; provisional upload
keys cannot pass. Concurrent groups share one preparation and one adopted immutable
capsule tuple, with an atomic one-way group link and no parent/native ownership.
The capsule freezes the canonical live or export Editor Document, source object,
revision, engine and toolchain. Input writes occur outside locks and fresh provenance
is rechecked before adoption. A composite foreign key prevents cross-Project Clip
provenance.

Every tentative capsule key has a cleanup obligation committed before PUT. Unique
keys prevent reuse of a previously granted deletion target. A losing write stays
known; a referenced input postpones cleanup without forgetting the obligation.
The source-change case leaves no preparation or native attempt. Cleanup scheduling
and native deletion confirmation remain ticket20 work. Three preparation service
cases plus the input-ledger case pass on disposable PostgreSQL; all136 migrations
and the full execution gate pass146 tests/955 assertions. Services typechecking,
focused Biome and28 cleanup tests/80 assertions pass. Exact native control, artifact
publication, stale-export/live-Clip finalization and production composition remain
required. This ticket remains claimed.
