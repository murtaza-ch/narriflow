# Deepen the Clip Render Attempt

**Status:** ready-for-agent

## Problem Statement

People waiting for rendered clips depend on Narriflow to turn one frozen request into durable outputs even when assets are unavailable, FFmpeg fails, uploads overlap, a worker loses its lease, or the process crashes during settlement. Today the pure command builders and media helpers are well tested, but the asset resolution → encode → upload → guarded persistence → aggregate settlement sequence lives in one large worker function and is not driven end to end through a domain interface. Correctness is spread across worker branches, storage calls, child-row helpers, Workflow Run settlement, environment reads, cleanup, and post-settlement notifications. This makes retries approximate, permits stale-attempt gaps, and makes behavior changes difficult to verify without asserting helper details or FFmpeg strings.

## Solution

Introduce one deep Clip Render Attempt module for every `clip_rendering` Workflow Attempt. Its single public operation receives the owned Workflow Attempt reference and cancellation signal, then owns a fixed Render Work Set and Frozen Rendering State through asset resolution, command execution, bounded upload, guarded variant persistence, aggregate settlement, durable notification intent, follow-up admission, and cleanup. Deterministic process, storage, media, persistence, temporary-workspace, clock, and diagnostic adapters remain private seams. Existing render modes, FFmpeg builders, media behavior, optional-asset fallbacks, and output characteristics remain unchanged except that export-bound variants must honor their already-persisted watermark value.

## User Stories

1. As a creator, I want every render attempt to use one fixed set of requested variants, so that outputs do not change while work is running.
2. As a creator, I want an active attempt insulated from later project and clip changes, so that its outputs come from coherent rendering state.
3. As a creator exporting a saved revision, I want its persisted clip snapshot, resolution, and watermark honored across retries, so that delivery matches the export I requested.
4. As a creator requesting the latest ordinary render, I want current resolution and plan-entitlement behavior preserved, so that the architecture change does not alter my output unexpectedly.
5. As a creator, I want ranged source access to fall back to a full download, so that a presign or remote-probe problem does not unnecessarily fail rendering.
6. As a creator, I want a missing or unreadable required source reported as a stable failure, so that Narriflow does not pretend an output can be produced.
7. As a creator, I want unavailable optional logos, B-roll, music, sound effects, and backgrounds to keep their current fallbacks, so that optional decoration does not block independent output.
8. As an operator, I want each external operation to have a bounded deadline, so that a hung command, transfer, or probe cannot hold an attempt forever.
9. As an operator, I want ownership loss to cancel active and queued work promptly, so that a stale worker stops consuming resources.
10. As an operator, I want upload concurrency bounded, so that a burst of completed encodes cannot exhaust memory or network connections.
11. As a creator, I want every scheduled upload accounted for before settlement, so that a rejected background promise cannot silently lose an output.
12. As an operator, I want every produced object key unique to its attempt, so that stale workers cannot overwrite newer bytes.
13. As an operator, I want uploaded objects deleted when guarded persistence rejects them, so that stale output does not accumulate indefinitely.
14. As a creator, I want completed variants preserved when a Workflow Run retries, so that successful work is not repeated.
15. As a creator, I want permanently failed variants preserved across retries, so that futile work is not repeated.
16. As a creator, I want interrupted and retryable variants resumed by the next Workflow Attempt, so that transient failures can recover.
17. As a creator, I want one local variant failure to leave unrelated variants running, so that independent outputs can still arrive.
18. As a creator, I want a shared encode failure applied only to the variants that command was meant to produce, so that failure attribution matches actual work.
19. As a creator, I want mixed success and failure reported as a Partial Workflow Outcome, so that successful artifacts remain usable and the run settles honestly.
20. As an operator, I want a zero-success attempt requeued only when a causal failure is retryable, so that retries are useful and bounded.
21. As a creator, I want variants deleted or invalidated during rendering excluded neutrally, so that Studio changes are not reported as render failures.
22. As an operator, I want a work set with no surviving variants to complete without artifacts, so that supersession cannot create a false incident.
23. As a creator, I want variants requested after an attempt begins assigned to an idempotent follow-up Workflow Run, so that late work is neither adopted unpredictably nor stranded.
24. As a creator, I want completion and failure notifications durably recorded with settlement, so that a worker crash cannot lose the notification intent.
25. As an operator, I want variant writes, aggregate outcome, notification intent, and follow-up admission ordered explicitly, so that recovery never has to infer which step committed.
26. As an operator, I want render configuration validated once at worker startup, so that invalid values fail before a project is partially rendered.
27. As an operator, I want structured diagnostics with attempt, variant, phase, disposition, duration, and adapter-operation context, so that failures can be investigated without parsing command text.
28. As a maintainer, I want the Clip Render Attempt interface to be the primary behavior-test seam, so that tests survive internal refactors.
29. As a maintainer, I want deterministic failure injection plus production adapter contract tests, so that ownership, timeout, storage, and media races are reproducible without hiding integration mistakes.
30. As an operator, I want a drain-based rollout, rollback procedure, and safe orphan reconciliation command, so that mixed worker versions and abandoned objects can be recovered deliberately.

## Implementation Decisions

- A Clip Render Attempt is exactly one execution of a `clip_rendering` Workflow Attempt. It reuses the attempt ID, lease, heartbeat, retry budget, and `WorkflowAttemptLost` control signal from the Workflow Run lifecycle; it introduces no independent claim or retry counter.
- The module has one public method, `execute`. It accepts one input object containing a `WorkflowAttemptRef` restricted to stage `clip_rendering` and an `AbortSignal`. Its result contains `status` (`completed`, `partial`, `failed`, or `requeued`), `requested`, `succeeded`, `failed`, and `superseded` counts across the frozen work set, plus a nullable `followUpWorkflowRunId`.
- Callers do not plan variants, resolve assets, invoke commands, upload objects, persist child outcomes, settle the run, send notifications, or clean temporary files. Those obligations remain behind the module interface.
- `WorkflowAttemptLost` escapes as control flow and never becomes a Workflow Failure, Clip Render Variant failure, terminal notification, or returned `failed` result. An unexpected settlement-infrastructure error may escape only when neither a success nor failure outcome could be persisted; the lifecycle reaper then owns recovery.
- The persistence implementation atomically freezes a Render Work Set. Clip Render rows gain nullable durable Workflow Run lineage and nullable `retryable`/`permanent` failure disposition, while the Workflow Run gains a durable work-set-frozen marker so an initially empty set cannot expand on retry. These fields describe work membership and recovery only; they do not create ownership.
- On the first begin for a Workflow Run, all eligible unassigned pending variants are bound to that run in the same transaction that records the frozen marker. Later attempts select only that lineage. Variants created after the marker remain unassigned until terminal settlement admits a follow-up run.
- Frozen Rendering State is loaded as one attempt-start snapshot containing durable source and optional-asset keys, ordinary clip state, export snapshots, per-row resolution, entitlement-derived treatment, and all variant groupings needed by existing render modes. It is not persisted as a duplicate full manifest.
- Expiring presigned URLs and local temporary paths are access locations, not rendering state, and may be refreshed inside an attempt. Export-bound variants always use persisted clip revision, resolution, and watermark. Ordinary latest variants freeze their row resolution and the owner's current plan-derived watermark at attempt start.
- Persisted Clip Render Variant statuses remain `pending`, `rendering`, `completed`, and `failed`. Resolution, download, probing, encoding, uploading, persistence, cleanup, superseded, and cancellation are typed internal phases, not new durable statuses.
- Existing FFmpeg argument builders, caption cue model, codecs, presets, render modes, layout selection, frame analysis, output naming visible to consumers, metadata, and resolution checks remain implementation details with regression coverage. This work does not centralize composition geometry or preview parity.
- Required source resolution first preserves the current ranged presign/probe path and then falls back to a full object download. If neither path produces a probeable required source, the attempt records a typed failure.
- Optional logo, B-roll, music, sound-effect, and background failures preserve current degradation, omission, or solid-color fallback behavior. Every fallback emits a typed structured diagnostic without leaking URLs, credentials, or raw command lines.
- Process execution accepts the attempt signal and an operation deadline. Ownership loss or caller cancellation terminates the process tree, waits for termination, rejects queued dependent work, and prevents later persistence. A missing executable is permanent; timeout and nonzero exit are retryable unless a more specific classifier marks the input permanently invalid.
- Media probing, remote asset access, object storage, process execution, persistence, temporary workspace, clock, and diagnostics are deterministic internal ports with production and test adapters. Internal ports are dependency-injected when constructing the module but are not exposed through its public interface.
- Uploads use a bounded queue with a default concurrency of two and a hard maximum of four. Queue settlement observes every task result. Ownership loss stops admission, aborts active transfers where supported, rejects queued transfers, and waits for all cleanup paths before removing local files.
- Every ordinary and export-bound output object key contains attempt-unique identity. An object is tracked as provisional until the fenced persistence transaction references it. A stale or superseded completion deletes its provisional object; cleanup failures are diagnosed and delegated to reconciliation rather than reversing a valid persisted outcome.
- Variant mutation distinguishes an owned missing/deleted row (`superseded`) from loss of Workflow Attempt fencing (`WorkflowAttemptLost`). Every claim, transition, completion, and failure write checks the current attempt and its Workflow Run lineage. Persistence adapters never swallow ownership loss.
- Local variant failure does not stop unrelated groups. A command shared by several outputs assigns its failure to exactly those outputs. Once any surviving variant succeeds, remaining failures settle with the run as `partial`; terminal partial runs do not automatically retry failed variants.
- When zero surviving variants succeed, any causal retryable failure requeues the Workflow Run while retry budget remains; an all-permanent causal set fails immediately. Retry exhaustion uses the lifecycle's terminal retry-exhausted outcome while retaining specific per-variant diagnostics. If all variants were superseded, the run completes with zero artifacts.
- Requeue preserves completed and permanently failed variants. Only rendering/interrupted variants and failures marked retryable return to pending, retaining Workflow Run lineage and clearing the attempt claim. Aggregate counts are calculated across the full Render Work Set, not only rows carrying the current attempt ID.
- Terminal settlement is one fenced transaction that writes the aggregate outcome and counts, appends the Workflow Event carrying notification intent, settles child dispositions, and idempotently admits a follow-up `clip_rendering` Workflow Run when unassigned pending variants exist. The follow-up key is derived from the completed run and is safe to replay.
- Workflow Event remains the transactional outbox. Additive notification-required and notification-delivered fields make pending work queryable, while a typed terminal payload declares the render-completed, render-partial, or render-failed intent; the dispatcher uses existing notification delivery/idempotency machinery. Provider delivery occurs after commit and may retry independently without changing domain state.
- Temporary workspaces are removed only after commands and uploads have stopped and provisional-object cleanup has been attempted. Cleanup errors are non-fatal after durable settlement and include stable operation and object identifiers in diagnostics.
- A project-scoped maintenance command lists only attempt-unique render prefixes, compares candidates with durable Clip Render and export references, ignores objects newer than a conservative 24-hour safety age, and defaults to dry-run. Destructive deletion requires an explicit flag and reports examined, referenced, protected, deleted, and failed counts.
- Render environment values are parsed once at worker startup into immutable `RenderConfig`. Missing values use current defaults; invalid numbers and enums fail startup; literal `0` retains existing feature kill-switch semantics; accepted nonstandard values warn. Upload concurrency defaults to two and is capped at four. Timeouts are positive, finite, per-operation deadlines rather than one whole-attempt deadline.
- Structured diagnostics use the repository JSON logging convention and stable fields for Workflow Run, Workflow Attempt, project, clip, variant, export, phase, operation, failure code, disposition, elapsed time, retry state, object key class, and cleanup result. They do not log secrets, signed URLs, document snapshots, or full command lines.
- Migration uses additive nullable columns and indexes first. New code may read legacy null lineage during dark deployment but must not claim through the new module until all render workers are drained. Enabling the new path backfills or assigns only eligible pending work; no completed historical output is rewritten.
- There is no lifecycle protocol version 3. Rolling execution by old and new render workers is unsafe because both would claim protocol-version-2 Workflow Runs with different child semantics. Rollout is: migrate, dark-deploy readers/adapters, drain render workers, enable the new module, then restart. Rollback drains render workers before disabling the new path; the additive schema remains compatible.

## Testing Decisions

- The one-method Clip Render Attempt interface is the highest and primary behavior-test seam. Tests provide a Workflow Attempt and signal, drive deterministic adapters, and assert returned outcome plus observable persisted rows, events, object references, cleanup, and diagnostics.
- Interface tests cover empty work sets, canonical freezing, ordinary and export-bound state, every existing render mode, ranged-source fallback, required-source failure, every optional-asset fallback, shared and independent commands, timeouts, nonzero exits, missing executables, cancellation, ownership loss at every phase, upload backpressure, stale completion, partial outcome, zero-success classification, retry/resume, supersession, late variants, notification intent, follow-up admission, cleanup, and settlement-infrastructure failure.
- Failure injection is available at every internal adapter operation and before/after every durable transition. Tests use a manual clock, controllable process adapter, in-memory object storage, deterministic media adapter, tracked temporary workspace, recording diagnostics adapter, and a database-backed persistence adapter or transactional stand-in.
- Public-interface tests assert behavior and ordering, not private helper calls, FFmpeg string fragments, queue internals, or implementation phases. Existing pure command-builder and media-math regression tests remain where they independently define output compatibility.
- Database contract tests prove atomic work-set freezing, attempt fencing, stale-attempt rejection, disposition-aware requeue, cross-attempt aggregates, partial settlement, terminal notification event creation, and idempotent follow-up admission.
- Production adapter contract tests cover process termination and timeout classification, R2 upload/download/delete/list behavior, presigned ranged access and full-download fallback, media-probe normalization, temporary-workspace cleanup, and configuration parsing.
- Existing R2 tests are expanded from pure metadata helpers to observable adapter contracts. Tests use isolated prefixes and never depend on production credentials unless an explicitly opt-in integration environment is configured.
- Migration tests cover pre-migration null lineage, mixed schema with the feature disabled, first new-path claim, retry after a legacy attempt, drain/restart cutover, rollback with additive columns retained, and recovery by the existing reaper.
- Final verification for every implementation ticket uses uncached relevant tests, database tests where applicable, repository typecheck, lint, and a production build. The final cutover ticket runs the complete repository suite and inspects structured diagnostics from representative success, partial, retry, ownership-loss, and cleanup scenarios.

## Out of Scope

- Changing Workflow Run claiming, lease ownership, heartbeat, retry budget, reaper ownership, or lifecycle protocol version.
- Studio Editing Session behavior or ownership.
- Ingest Job lifecycle or upload intake.
- The separate Clip Composition Plan recommendation, including preview/render geometry unification.
- New codecs, hardware acceleration, parallel encode policy, output-quality changes, or performance-driven clip-group claiming.
- New optional-asset UX, stricter optional-asset requirements, new B-roll providers, or attribution schema redesign.
- Changing caption cue semantics, editor persistence, export creation contracts, social publishing, dubbing, or billing entitlements.
- Retrofitting historical completed objects or changing existing downloadable URLs.
- Production implementation in this design task; each ticket is implemented separately.

## Further Notes

- The only approved visible rendering change is honoring the watermark already frozen on an export-bound variant. All other output bytes and fallback behavior are compatibility constraints.
- ADR 0001 remains authoritative for lifecycle ownership. ADR 0003 adds clip-rendering work-set and child-settlement semantics without establishing a competing lifecycle.
- Work proceeds only through the dependency-ordered local tickets. Each ticket must be implemented in a fresh task using `/implement`, which drives `/tdd` and finishes with `/code-review`, uncached tests, typecheck, lint, and a production build.
- Traceability groups: canonical inputs and ownership are delivered by tickets 01 and 04; settlement, retry, idempotency, late work, and notifications by 02 and 03; source, commands, and timeouts by 05; bounded upload and cleanup by 06 and 10; render modes and media behavior by 07–09; validated configuration, adapter contracts, rollout, and recovery by 11.
