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

The preparation service now implements exact Generic Executor Control ports and
its typed transfer composition. It confirms an absolute watchdog and stable native
attempt before returning, records an immediate lease-observation wake on acquire,
and spends one charge at process start. Current linked group/source/editor proof
is recompiled under the owning locks before granting fresh work. A manifest can
arrive before preview/peaks: its bounded typed evidence stays pending until all
required same-owner artifacts are committed. Preview publication, preparation
completion and bounded group wakes then commit together. A frozen export can
finish after an edit without replacing the live Clip. Terminal evidence and charge
history are protected by database constraints.

Thirteen preparation service/model cases pass107 assertions, covering owner races,
replay, manifest order, source revocation, bounded lease retry, changed evidence,
and SQL-injected projection rollback. The full136-migration execution gate now
passes167 tests/1114 assertions across23 suites; services typechecking and focused
Biome checks pass. The private JSON writer, production factories, native render
handoff and deployed integration acceptance remain required. This ticket remains
claimed.

The shared private JSON adapter and preparation runtime factory are now committed.
`getPrivateJsonStorage` supplies bounded conditional input reads and immutable
nonce-key writes for preparation and Render Group capsules. An uncertain PUT is
accepted only after HEAD plus an If-Match read verifies the actual byte digest.
Two storage cases pass21 assertions, including lost acknowledgement, conflicting
bytes and oversized-stream cancellation. `getClipPreparationService` derives the
shared engine hash from the required render toolchain fingerprint in a fresh
database/environment scope. Additional PostgreSQL cases reject mismatched frozen
export revisions and elapsed group deadlines before input PUT. Media owns the
Render Group factory's durable deadline before input I/O, failure gate and final
native handoff; full ticket14 integration acceptance remains open.

The Render Group factory now commits its absolute watchdog before preparation or
input storage I/O. An unstarted deadline can settle without a Generic Attempt,
lease or charged media history. Completed preparation and one adopted private
capsule are required before native dispatch and checked again on acquire. Ready
command races admit one native generation. Source revision and frozen member
configuration are rechecked before publication. Capsule cleanup retains the exact
adopted key; losing writes remain planned for cleanup.

One typed capsule supplies the existing native renderer with source observations,
export configuration, owner-scoped asset tuples and the existing stock search plan.
The actual downloaded stock IDs are validated against that plan; attribution is
now persisted in `ClipRender.brollCredits` with successful publication. Per-member
failure publishes a bounded `render_outcome` object. The final API acknowledgement
carries authoritative whole-group counts across retries. A retry wake and its later
terminal wake have distinct immutable delivery identities. The parent stays unleased.

Disposable PostgreSQL passes31 cases/256 assertions across preparation and targeted
execution, including the real signer/transfer factory boundary, failed input PUT,
concurrent admission, current-source refusal, permanent/retryable mixtures, frozen
watermark after a plan change, and current/curated audio ownership. The earlier
Render Group invariants also pass18 cases/181 assertions. Media/services typechecks
pass. Preparation uses the renderer's sole timing helper, with explicit policy
version2, so a600-second caption-only source is preserved rather than truncated.

[Native Render Group evidence](../evidence/modal-render-group-native-20261031.json)
records successful actual x86 Modal default-Sandbox child execution, typed permanent
failure and lost-acknowledgement retention through controlled scoped ports. All
three cases enforce the pinned profile and reuse completed preparation with zero
detector work. This gate found Bun's numeric `statfs` overflow on Modal's large
virtual filesystem; bigint reads fix resource admission while retaining the same
scratch cap. Actual Function, live HTTP/domain integration, long-source transfer
and full-batch throughput acceptance remain required. Ticket14 stays claimed.

Render work packages now sign only the server-selected original source initially.
All frozen asset descriptors remain in the verified private capsule, and exact
source IDs obtain fresh scoped grants on demand. A PostgreSQL transfer case with
200 assets and maximum-length grant URLs stays within the64KiB envelope and
refuses a foreign source ID. An actual Bun/FFmpeg render loads the object-backed
capsule and reads the selected200th library track with zero other asset downloads.
That test caught and fixed public URL validation rejecting the renderer's own
scoped audio URL. Only exact frozen owned URLs pass that native port; pasted media
retains the public URL policy.

Unfinished preparation returns an explicit dependency wait with its already
registered absolute watchdog ID, without a Generic Attempt or native token.
The two affected PostgreSQL suites pass25 cases/217 assertions; five actual
native operation cases,43 layout cases/281 assertions and media/services
typechecks pass. Parent Workflow integration remains in progress.
