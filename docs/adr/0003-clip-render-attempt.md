# Clip Render Attempts execute leased Render Groups

A Clip Render Attempt executes one Render Group under an immutable group token and renewable DB-time lease. One parent `clip_rendering` Workflow Run owns the fixed Render Work Set; each group contains one clip and one frozen export configuration, including aspect variants. This settled exception to ADR 0001 replaces the original parent-only render ownership, which prevented single-project scaling and isolated crash accounting poorly.

One deep attempt module still owns Frozen Rendering State, asset resolution, command execution, bounded delivery, guarded variant persistence and cleanup behind one execution interface. Process, object-storage, media-analysis, temporary-workspace, clock, persistence and diagnostic adapters remain deterministic internal seams. There are no per-clip Workflow Runs and no second full render manifest. Existing export-bound snapshots remain authoritative; expiring access locations are refreshed without changing frozen inputs.

Groups and historical members bind to the parent's stable work-set generation. Every variant mutation checks the open parent and valid membership as well as the current unexpired group token and owner. ADR 0001 defines the exact lock and fencing predicate. A replacement coordinator cannot invalidate healthy groups. Explicit cancellation and supersession can invalidate affected membership. Uploaded object keys are unique to the group execution token; a stale worker cannot overwrite a newer output or remove bytes after an ambiguous commit. Losing ownership aborts the attempt without recording a new failure or sending a notification.

Variant failures are classified as retryable or permanent. Unrelated variants continue after a local failure, a shared encode failure affects every variant produced by that command, retryable or interrupted members requeue with the existing 30s then 60s backoff through the three-charged-attempt limit for that group even when siblings succeeded. Parent settlement stays nonterminal and emits no terminal notification while a retry remains. Once no retry remains, mixed surviving success and failure settles the Workflow Run as a Partial Workflow Outcome; zero successful surviving variants fails, and an entirely superseded work set completes without a notification. Completed and permanently failed variants remain settled across retries; only interrupted or retryable variants return to pending. Workflow Event remains the transactional outbox: terminal outcome, notification intent, and follow-up admission are committed with fenced settlement before cleanup is considered complete.

## Considered options

We rejected uncoordinated Render Attempt leases with a separate parent retry authority; separate public plan, execute, and settle methods because callers and tests would have to reproduce sequencing; a persisted full render manifest because most inputs are already durable and expiring access locations must be refreshed; shared export object keys because stale attempts could overwrite or delete newer bytes; dynamic adoption of variants created mid-attempt because it makes settlement non-deterministic; fail-fast aggregate rendering because one bad variant should not discard independent outputs; and absorbing Clip Composition Plan policy because preview/render geometry parity is a separate architecture recommendation.

## Consequences

ADR 0001 owns the coordinator lifecycle and final parent settlement. The Render Group lifecycle is the sole authority for child claiming, heartbeats, charged starts, retries and reaping. One poison group exhausts its own budget while healthy siblings keep running. Tickets 18-20 must integrate before runtime deployment, removing parent-token-only child writers and the sequential parent encode path. Drain old render workers before enabling the integrated runtime. Render configuration is parsed once into an immutable validated value, operation deadlines and upload concurrency are bounded, structured diagnostics use stable phase and failure fields, and a project-scoped dry-run reconciliation command recovers attempt-unique orphaned objects.

## Implementation ownership

The injected attempt implementation lives in `clip-render-attempt.ts`; `clip-render-attempt-runtime.ts` supplies production adapters. The attempt still exposes only `execute()`. Scene visual assets and fonts are loaded through an injected persistence reader scoped to the frozen Workspace. The attempt validates their fingerprints, kinds, media and font facts before planning. Optional media retains the current typed degradation policy.

The FFmpeg adapter compiles a Clip Composition Plan and resolved input facts into one encoding command. Cut and audio filters, caption serialization, and video, B-roll and audiogram argument builders stay private to that adapter. Rendering has no legacy subtitle path: caption visibility and cues come from the plan. Attempt tests verify encoded media and fenced settlement through `execute()`; pure compiler tests exercise the adapter interface.

## Retry policy amendment, 2026-10-29

The owner replaced the original early partial-settlement rule after transient executor and storage failures stranded recoverable siblings. Successful outputs and permanent failures stay settled; only unsettled members consume the remaining attempts. Manual retries of settled exports use the same project admission lock, detach failed children from their old run, attempt and failure disposition, preserve frozen documents and output entitlements, and recompute progress from all variants. Concurrent retry requests admit work once and cannot reset active children. A heartbeat racing the handler's own settlement waits for its commit result; only committed settlement suppresses ownership loss.

## Durable group protocol, 2026-10-29

`render-group-contract.ts` supplies the pure identity, fencing, charge and settlement contracts for the service protocol and worker adapter. `RenderGroup` is uniquely keyed by parent, stable generation, clip and canonical export identity. The identity encodes export ID or automatic output, editor revision, resolution and watermark; aspect ratio is membership, not another group. Admission validates each existing variant against those frozen inputs under the admission lock. Unique membership prevents one variant joining two groups in the same work set. Historical variant IDs intentionally have no mutable ClipRender foreign key: editor deletion or manual reassignment must not erase membership or execution denominators. Missing current rows become explicitly superseded members, never silently disappear from requested counts.

A claim atomically inserts a `RenderGroupExecution` ledger row with a new token and immutable owner, then sets that group's current token and DB-time lease. Claiming alone does not charge an attempt. The worker records execution start once after successful process startup, before accepting artifact completion; the group counter and ledger charge commit together under the token fence. It cannot continue rendering if recording start fails. A crash after this durable start retains exactly one charge; pre-start spawn rejection or lease expiry consumes none. Graceful shutdown records `released`, refunds any charge once and defers retry until the shutdown drain completes. Finished ledger rows and per-token/per-variant outcomes are immutable, so retries and acknowledgement loss cannot rewrite history. Duplicate writes use token/member uniqueness and compare the committed result rather than overwriting it.

All success and permanent-failure members stay settled. Retryable, pending or interrupted members alone requeue. Three charged starts exhaust the group; the first and second charges schedule 30s and 60s backoff using DB time. Pre-start release uses no exponential delay, but may have a drain deadline. Final group outcomes distinguish completed, partial, failed and entirely superseded membership. Reaping records interruption once and applies this same policy, with no parent retry counter charging child work. Ledger records retain identifiers, causal error code/disposition and source, analysis and toolchain fingerprints, never signed URLs, commands or a duplicate render manifest.

Every ClipExportVariant change still calls `syncClipExportAggregates` inside its transaction. Child completion and its ledger outcome commit together and remain queryable by token after acknowledgement loss. Neither rejection of a DB call nor an analytics read failure proves an object is unreferenced. Parent settlement aggregates all groups only after every retry and live lease has ended; it alone commits the terminal outbox and notification intent. Execution settlement markers suppress late heartbeat-loss reports only after commit, preserving genuine loss before settlement.

## Group-only persistence and attempt telemetry, 2026-10-30

The parent lifecycle has no render-variant or render-analysis writers and no
parent-only render retry, child reset or render-completion path. Generic parent
completion rejects clip rendering. Coordinator failure returns coordination to
the queue without rewriting live groups. Only group settlement makes media
retry decisions; the coordinator waits for that settlement before closing the
Render Work Set. Test fixtures use a test-only helper built on the same group
admission, start, variant outcome and finish operations.

A group's execution ledger records claims, charged starts, releases, crashes
and terminal outcomes. Each variant start also has an idempotent Workflow Event
keyed by group token and variant ID. Completion and permanent failure publish
child results transactionally, so Task history survives a later Studio reset
while other groups still run. Retryable failure never publishes terminal child
failure. Per-token variant outcomes remain the completion acknowledgement
source, including after a lost response. Mutable ClipRender counts are not an
attempt failure-rate denominator.

Structured logs carry operation durations and one summary per execution.
Phase durations include retries and may overlap. Resource measurements separate
worker RSS, cgroup current/peak/page-cache bytes and CPU quota. Log-derived
counts omit processes that crash before flushing; use the durable ledger when
reporting attempt rates. No external telemetry service is required. The
[render runbook](../runbooks/render-hardening.md) defines the read-only checks.
