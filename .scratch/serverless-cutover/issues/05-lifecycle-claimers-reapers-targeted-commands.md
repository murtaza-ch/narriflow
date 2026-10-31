# 05 - Lifecycle claimers/reapers → targeted commands

**What to build:** Lifecycle claimers and reapers → targeted commands.

**Blocked by:** 04

**Status:** claimed

**Spec:** [Serverless cutover](../spec.md)

- **Build:** §4.2: exact-id acquire/renew/release/expire for ingest, Workflow Attempts, Render Groups and background jobs. DB time after locks, process-start charging, immutable work sets, short parent settlement, deadline registered before dispatch, epoch invalidation.
- **Files:** `packages/services/src/{ingest-job-lifecycle,workflow-run-lifecycle,render-group-lifecycle,layout-evidence,media-cleanup*}.ts` and their DB tests.
- **Accept:** one active owner. An expired owner can't renew or commit. Pre-start rejection is uncharged. Settlement happens once with no live or retryable groups. Targeted expiry and the hourly backstop share one transition.

## Evidence

Render Group transaction-aware control is implemented; Ingest, Workflow and other background domains remain in progress. This ticket is not complete.

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

Source Audio measured-binding hash helper is also prepared: strict schema normalization, full measured evidence hash distinct from assigned pre-output artifact binding, and a frozen independent SHA-256 vector. Ingest persistence and video-equivalence wiring follow next.
