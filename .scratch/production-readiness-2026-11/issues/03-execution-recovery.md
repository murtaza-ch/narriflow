# 03 Execution recovery

**What to build:** No project, render or reservation can stay stuck, and one bad row cannot stop the safety sweep.

**Blocked by:** None

**Status:** done

Owns: `packages/services/src/{executor-control,execution-dispatch,execution-dispatch-runtime,execution-maintenance,execution-safety-pages,workflow-run-lifecycle,render-group-lifecycle,render-group-contract,modal-dispatch,progress-outbox}.ts`, `apps/api/src/workflows/**`. `ingest-job-lifecycle.ts` is shared with tickets 02 and 04; keep edits small.

## Must fix
1. **Permanent source failure after audio-first handoff leaves admitted runs open forever (high).** `ingest-job-lifecycle.ts:472-475,503-507,603-664`, guards at `workflow-run-lifecycle.ts:448,2122`. Only mismatch failures call `cancelSourceExecutionsWithinTransaction`. Route every terminal source failure with an admitted generation through that path and record refund need when usage is settled. Add a DB test: audio admitted, then video terminal.
2. **Restricting a Workspace strands in-flight work (high).** `ingest-job-lifecycle.ts:309-310`, `workflow-run-lifecycle.ts:446-447`, `render-group-lifecycle.ts:529,547`, `executor-control.ts:338-344`. The `workspace.status=active` check returns terminal without changing the domain row, the watchdog closes the attempt, and after reactivation nothing can settle the row. Do not close attempts on a restriction-only lock, or perform an explicit domain cancel there. Add a DB test.
3. **Hourly sweep aborts whenever a render run waits for video (medium).** `execution-safety-pages.ts:26` throws `maintenance_domain_registration_missing` for groups committed by `workflow-run-lifecycle.ts:2430-2448` before `waiting_for_video`. Every later phase is skipped that hour. Skip unregistered rows and log them. One row must never fail a page.
4. **Workflow command retry budget is about 7 seconds (medium).** `apps/api/src/workflows/scoped-workflow.ts:34`. `errored` counts as `confirmed_existing` (`scheduler.ts:15`). Raise to minutes, for example 8-10 retries capped near 60s. Commands are idempotent; confirm it.
5. **One undeliverable dispatch stalls the sweep chain (medium).** `execution-dispatch-runtime.ts:134-143`, `execution-maintenance.ts:98,105`. Register the next-phase dispatch first and treat recovered wakes as best effort.
6. **Spawned Modal call that never acquires is undetected for the full deadline (medium).** `modal-dispatch.ts:21`, `render-group-lifecycle.ts:838-840,786-801`, `ingest-job-lifecycle.ts:499-505`. Add a short acquisition deadline; on expiry use bridge `status` and respawn the same attempt under a new delivery id when `failed` or `unknown`. If this needs a schema change, record it in Comments and implement the part that does not.
7. **Ledger rows never purged, abandoned drafts add a row and a Workflow every hour (medium).** `execution-safety-pages.ts:39`, `ingest-job-lifecycle.ts:878`, `execution-maintenance.ts:8`. Exclude `waiting_for_pack` and inaccessible Projects from the page. Add daily retention with explicit windows and FK order (artifact, attempt, dispatch) for `ExecutionDispatch`, `ExecutionAttempt`, `ExecutionArtifact`, `OutboundDelivery`, `ZoomWebhookJob`, `OperationReceipt`, `CompletionCallback`, `ProgramAnalyticsEvent`, completed `MediaCleanupObligation`, terminal `UploadSession`, expired `SocialOAuthState`. Never purge a row something still needs for fencing or dedupe; state the window in a comment.
8. **Every wake repeats admission under the exclusive Workspace lock (medium).** `render-run-driver.ts:272-277`, `workflow-run-lifecycle.ts:2397,2449-2466`, `render-group-lifecycle.ts:610-617`, `scheduler.ts:92-102`. Return early from prepare once frozen and dispatched, one parent wake per outcome.
9. **Pre-start render failures retry with zero delay (medium).** `render-group-contract.ts:197`. Add a separate uncharged attempt cap with backoff.
10. **Cancellation leaves export variants non-terminal (low).** `workflow-run-lifecycle.ts:1164`, `render-group-lifecycle.ts:360-395`. Fail those variants and call `syncClipExportAggregates` in the same transaction.
11. **Progress publishing out of order causes socket resets (low).** `progress-outbox.ts:121-122`, `durable-objects/project-progress.ts:147`. Publish a page sequentially.
12. **Local fetch dispatches can never be acknowledged (low, dev).** `workflows/scheduler.ts:29`, `execution-dispatch.ts:371-372`, `ingest-source-execution.ts:74`. Return `confirmed_created` for this registration.
13. **No acknowledged wake retry after an executor commit (low).** `executor-control.ts:108-114`, `execution-dispatch.ts:344`. Retry through a Worker continuation so a transient failure does not pause a project for an hour.

## Reuse
- Result-to-directive helper in `apps/api/src/workflows/domain-runtime.ts:187-244`.
- Stable dispatch append: `workflow-dispatch.ts:21-25`, `workflow-run-lifecycle.ts:1180-1183,2454-2460`, `render-group-lifecycle.ts:710-712`, `clip-selection-window.ts:109-112`.
- `retryableTransactionFailure` and `retryableGroupTransaction` are the same logic.
- Delete `invalidateRenderGroupMembersWithinTransaction` (no production callers).

## Verification
`test:execution:db`, `test:workflow:db`, `test:processing-usage:db`.

## Comments

All 13 findings were confirmed in the code, and none was rejected. Tests for items 1, 2, 3 and 10 failed first (red run: 9 of the 12 failures were these).

1. A terminal source failure (`fail`, operation deadline, exhausted retries, MCP cancel of a queued job) goes through `closeAdmittedGeneration` in `ingest-job-lifecycle.ts`: active runs are cancelled in the same commit, and settled usage leaves a `SourceRefundNeed`. Mismatch uses the same path. With no active run, the transcript is not touched.
2. Chose "do not close attempts". `ExecutorDomainLock` gained `restricted`: the executor is told to stop, the attempt stays open, and its deadline runs the normal domain expiry, so the row requeues or fails. Reactivation re-enters through the hourly wake, so recovery can take up to an hour. A project that is inaccessible rather than restricted behaves as before.
3. `recovery()` skips and logs a row with no registration. `processed` still counts it, so the page continues.
4. `WORKFLOW_COMMAND_STEP`: 10 linear retries at 6..60 s, about 5.5 minutes. Cloudflare has no delay cap, so linear gives the bound. Commands are idempotent: each re-reads the ledger and mutates behind its receipt or fence. The `errored` as `confirmed_existing` mapping is unchanged; continuations and hourly wakes re-enter.
5. `ExecutionMaintenanceService` confirms the next page first and alone. Recovered wakes follow in chunks of 4; a failed chunk is logged and stays due in the outbox.
6. No schema change. A `ma1.<modal dispatch>` Maintenance instance checks 3 minutes after spawn, then polls bridge `status`. Any state except `pending` respawns the same attempt under a new delivery id, which is a `respawn_n` ledger row, at most 3 times. This goes beyond the ticket's `failed`/`unknown`, because a finished call with no owner can never acquire. The watch ends once the attempt acquires or closes. No Python change: the bridge already keys on delivery.
7. New `execution-ledger-retention.ts` with 11 daily phases; the windows and reasons are in its header. An artifact leaves only after its object's deletion was acknowledged, because media cleanup refuses an assigned object with no artifact. Domain registrations stay while the subject row exists. Dead-lettered and unacknowledged dispatches are never purged. The hourly ingest page excludes drafts, missing packs, and inaccessible or restricted Projects; the other domain pages exclude inaccessible or restricted Projects.
8. `prepareRenderRun` returns `dispatched` from a lock-free read once frozen with every driver and watchdog acknowledged. The group-subject `render_run` wake is gone, along with its branch in `lockRenderRun`: one parent wake per outcome. Not changed: a wake still runs twice, as `sendEvent` plus the independent continuation (`scheduler.ts`), because only the continuation guarantees the re-read. So `settleRenderRun` still takes the exclusive lock on both.
9. Uncharged failures back off 5/10/20/40 s and stop at 5 attempts, counted from `RenderGroupExecution`. On exhaustion the members become permanent, so later parent reads agree with the settlement. Ingest `startup_rejected` still retries at 0 s, bounded by the operation deadline; it is not in this ticket.
10. `failUnfinishedRendersWithinTransaction` fails renders, variants and aggregates in one commit, including retryable-failed renders and renders never placed in a group.
11. A page publishes sequentially and stops at the first unconfirmed event.
12. `deliverLocalFetchReference` returns `confirmed_created`.
13. `createExecutorWakeDelivery`: on delivery failure, each unacknowledged wake continues in a `nf_retry_<id>` Maintenance instance that only delivers. If that cannot register, the executor gets the failure and replays. `DEV_CLOUD` keeps the old behaviour.

Reuse: `directive()` in `domain-runtime.ts`, `appendStableExecutionDispatch`, one `retryableTransactionFailure`, `invalidateRenderGroupMembersWithinTransaction` deleted.

Files edited outside the Owns list: `executor-domain-control.ts`, `execution-maintenance-runtime.ts`, `workflow-dispatch.ts`, `clip-selection-window.ts`, `index.ts`, `apps/api/src/domains/execution/runtime.ts`, `run-execution-db-tests.ts`, `media-cleanup-recovery.db.test.ts` (order of delivery). `render-execution-test-fixture.ts` now has a valid upload payload: ticket 04's cleanup admission made 83 render tests fail with `worker_invalid_payload`.

Known limit: `syncClipExportAggregates` can add publication wakes to a source cancellation, outside its 123-wake budget. Past 128 wakes the executor command fails. It needs a Project with about 100 exports waiting on publications.

Schema request for ticket 02 (retention works without these, but scans): indexes on `OperationReceipt(createdAt, id)`, `ProgramAnalyticsEvent(createdAt, id)`, `OutboundDelivery(status, expiresAt)`, `MediaCleanupObligation(objectKey)`.

Verification, local test database, final run: `test:execution:db` 635 pass, 0 fail. `test:workflow:db` 168 pass, 0 fail. `test:processing-usage:db` 35 pass, 0 fail. `bun run typecheck` passes, route inventory has 0 problems, workflow unit tests 60 pass. One earlier execution run also failed `media-cleanup-control` ("assigned output grants drain") on `ExecutionAttempt_authority_check`; it passed in the next run and I did not find the cause. `biome check` on `packages/services/src` reports `workflow-event-append.ts:42`, which is not this ticket's file. Not run: the full `bun run test`, and anything on deployed Workers or Modal.
