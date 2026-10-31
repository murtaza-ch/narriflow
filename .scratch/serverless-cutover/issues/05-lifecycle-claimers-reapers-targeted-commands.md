# 05 - Lifecycle claimers/reapers → targeted commands

**What to build:** Lifecycle claimers and reapers → targeted commands.

**Blocked by:** 04

**Status:** claimed

**Spec:** [Serverless cutover](../spec.md)

- **Build:** §4.2: exact-id acquire/renew/release/expire for ingest, Workflow Attempts, Render Groups and background jobs. DB time after locks, process-start charging, immutable work sets, short parent settlement, deadline registered before dispatch, epoch invalidation.
- **Files:** `packages/services/src/{ingest-job-lifecycle,workflow-run-lifecycle,render-group-lifecycle,layout-evidence,media-cleanup*}.ts` and their DB tests.
- **Accept:** one active owner. An expired owner can't renew or commit. Pre-start rejection is uncharged. Settlement happens once with no live or retryable groups. Targeted expiry and the hourly backstop share one transition.

## Evidence

Render Group, Ingest and Workflow transaction-aware control plus exact audio-ready generation handoff and unleased render-parent orchestration are implemented; typed provider/stage settlements, hourly integration and other background domains remain in progress. This ticket is not complete.

- Shared `ExecutorDomainControl` ports and wake-result/observed-deadline contracts are available through a narrow services export.
- Render Group exact-id lock/acquire/renew/start/artifact/fail/release/progress methods share the caller transaction. Existing charge, member and variant bodies were lifted rather than duplicated.
- Lock order is epoch in the control owner, then Workspace usage, Project admission, parent, group, members/variants, then the generic Execution Attempt. Clocks are re-read after locks.
- Acquisition is uncharged and commits an absolute watchdog plus an immediate acquisition/lease wake. Renewal creates no timer. Completion/requeue wakes both the sleeping old driver and parent; a retry/release increments subject generation while preserving the Render Work Set UUID.
- A final validated member artifact settles only its group. The parent remains unleased for RenderRun settlement. Unacquired absolute expiry fails unsettled members without inventing an execution or charge.
- Root-owned migration must replace the old Render Group identity trigger to permit bounded generation/epoch changes and initial immutable deadline binding. The replacement was applied only to the isolated gate branch during development; final fresh migration verification remains required.

Verification so far, 2026-10-31:

- Real isolated Postgres plus real Executor Control/Render Group adapter: four cases passed, including owner race/start replay, renewal/no new timer, final artifact/group+wake commit and pre-start release. The fifth case initially rejected an invalid test fixture deadline before its creation timestamp; correcting the fixture then passed the focused unacquired-expiry case. Raw logs: `/tmp/narriflow-serverless-gates/targeted-render-core.log` and `targeted-render-unstarted.log`.
- All five domain cases have passed, with 24 assertions across the main and focused runs. This is domain correctness evidence, not deployed Workers or Linux media evidence.
- Service typecheck and scoped Biome checks pass.

Ingest now exposes the same exact-id lock/acquire/renew/start/artifact/fail/release/progress and targeted-expiry ports. Acquisition reserves ownership without charging; process-start increments once, and progress does not extend the native lease. Retry/release revokes the old generation and appends retry plus parent/finished wakes in the same transaction. Pre-start release cannot decrement below zero.

Whole-source Source Audio is stored with its strict normalized measured-binding hash, distinct from the pre-output artifact binding. It wakes the Import Pipeline while leaving video unready and usage reserved. The role-specific video validator must accept matching whole-source evidence before publication. Either callback order is durable: video-first seals its binding on the immutable committed artifact; the later same-owner audio commit validates that evidence and completes ingest plus video-ready/finished wakes atomically. No object-store reads occur under domain locks.

Additional verification, 2026-10-31:

- Real PostgreSQL plus Executor Control/Ingest: startup rejection, exact process-start replay/progress lease preservation, Source Audio persistence and never-acquired absolute expiry passed in the main gate. Both callback orders reached publication; their final assertion originally used the wrong generic history field. Correcting only that assertion yielded two passing focused cases and 20 assertions. Raw logs: `/tmp/narriflow-serverless-gates/targeted-ingest-complete.log` and `targeted-ingest-either-order.log`.
- Ingest claim lifetime, independent measured hash and real video comparison unit suites: 9 tests, 37 assertions passed. Services typecheck and scoped Biome pass.
- The shared Workflow Run provenance hash helper has an independent Python-calculated literal vector and mutation/property-order checks: 1 test, 8 assertions passed. Handoff/admission wiring follows next.

`handoffGeneration(reference)` now accepts one exact Import Pipeline ledger reference. It validates the full immutable database tuple and current epoch/generation, locks Workspace usage before Project/Ingest, re-reads the latest Content Pack and admits from immutable current Source Audio while native video remains running. Usage settlement, transcript source ID/revision, STT admission and its Operation Driver obligation commit together. Replays return the same dispatch for scheduler-confirmation retry. A draft pack authorizes no work. The old scanner only selects and delegates this single body until its deletion.

An early refusal releases unsettled usage and atomically clears the native claim plus revokes matching active generic attempts. An outbox insertion failure rolls back the debit, transcript and run before persisting a durable retry instant.

- Four real PostgreSQL handoff cases passed with 26 assertions: concurrent once-only audio-first admission; changed ledger hash/draft refusal before debit; restricted-workspace refusal/native revocation; injected scheduling failure rollback. Logs: `/tmp/narriflow-serverless-gates/targeted-ingest-handoff.log` and `targeted-ingest-handoff-failures.log`. The first red test failed because the exact command did not yet exist.
- Rendering acquisition additionally requires true video-ready state and a committed source key. A real control/domain gate verifies audio-ready downloading cannot acquire or charge and ready video can: 1 case, 4 assertions (`targeted-render-video-ready.log`).

Render parents now expose `prepareRenderRun(reference, configurations)` and `settleRenderRun(reference)`. Both validate the exact persisted render-run obligation, including child-group wake references resolved server-side. The parent freezes membership and the complete group partition in a short transaction, commits all child Operation Driver obligations, and stays `waiting` with no attempt, lease or new charge. Group identity inherits the current parent epoch, and its semantic input hash binds the parent provenance, stable work-set/group IDs, sorted membership and complete configuration including watermark entitlement.

Settlement reuses one aggregate/lineage body with the interim worker wrapper. Current group leases/retries prevent terminal parent settlement. The stable work-set UUID only correlates/deduplicates events; it grants no ownership. Terminal replay emits no extra notification. Video completion also commits a wake for the exact active Render Run, closing the race where audio-first detection reached a waiting render parent before full video was ready.

- Full real Executor Control/Render Group/Render Run chain passed 1 case with 14 assertions: changed-generation rejection; frozen-watermark mismatch rejection; prepare/replay; pending queued/live child; child acquire/start/verified commit while the parent remains unleased; actual child wake resolution; terminal/replay and one notification. Log: `/tmp/narriflow-serverless-gates/targeted-render-parent-fences.log` (119 seconds across setup and multiple remote transactions; no product lease was lengthened).
- Audio-first callback with an already waiting Render Run passed 1 case/11 assertions, including durable video-ready wake: `targeted-ingest-video-parent-wake.log`.
- Pure hash/fencing, Ingest lifetime and Workflow input suites: 35 tests/84 assertions passed. The new group hash includes an independently calculated Python literal vector. Services typecheck/scoped Biome pass. Project admission locking now precedes run locks in child fencing and queued-generation cancellation.

Non-render-parent Workflow Runs now expose the exact generic control ports. The current frozen transcript source binding is compared with the dispatch input hash under Workspace/Project/run locks. Acquisition is uncharged; durable start increments the domain attempt count once using the generic start ledger. Progress never renews. Release/failure/expiry reuse lifted transaction-aware business bodies; retries revoke the old generation and append the canonical new-generation obligation plus old-driver completion wake. Generic artifact commits are rejected: TS/provider stages require typed settlement methods, while native child artifacts belong to their own subjects.

- Four real Executor Control/Workflow cases passed across a main and focused run: pre-start release/no charge; start receipt replay plus progress/no renewal and retry; expired-owner renewal refusal plus once-only deadline retry; never-acquired operation expiry/no invented attempt. Fifteen assertions total. The initial start test used an invalid phase fixture (`analyzing`); changing it to the existing `preparing` protocol value passed without a product change. Logs: `/tmp/narriflow-serverless-gates/targeted-workflow-commands.log` and `targeted-workflow-start.log`.
- Services typecheck, scoped Biome and the existing 35-test/84-assertion unit set pass. Targeted fixture cleanup now also removes progress obligations for the fixture's Workflow/Workspace Events before cascading those events.
- Provider-wait transition must close/revoke the generic TS execution atomically while preserving only the Workflow Run token as provider lineage. Provider submission/result deadline commands and source-revision/ID-fenced typed callbacks follow in ticket 12; the generic native lease watchdog must not own provider wait lifetime.

Source Audio publication now invokes the same `handoffGenerationWithinTransaction` body immediately when a committed pack exists. Its usage debit, transcript source binding, STT run and scheduling obligation share the audio callback's transaction and receipt wakes. A previously sealed video is validated before admission, so an already-known whole-source mismatch releases the reservation without charging or creating STT. Outer transaction owners flush Workspace Events after the remaining artifact/receipt writes.

- The positive audio-publication test failed first because no STT run existed; after wiring the shared body it passed 1 case/5 assertions (`targeted-ingest-atomic-handoff.log`). Already-sealed mismatch passed 1 case/4 assertions (`targeted-ingest-known-mismatch.log`). Both run through real Executor Control and real Postgres; no pipeline scan or follow-up handoff call appears in the positive test.
