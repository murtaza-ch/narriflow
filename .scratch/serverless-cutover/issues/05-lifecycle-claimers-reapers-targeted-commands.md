# 05 - Lifecycle claimers/reapers → targeted commands

**What to build:** Lifecycle claimers and reapers → targeted commands.

**Blocked by:** 04

**Status:** ready-for-agent

**Spec:** [Serverless cutover](../spec.md)

- **Build:** §4.2: exact-id acquire/renew/release/expire for ingest, Workflow Attempts, Render Groups and background jobs. DB time after locks, process-start charging, immutable work sets, short parent settlement, deadline registered before dispatch, epoch invalidation.
- **Files:** `packages/services/src/{ingest-job-lifecycle,workflow-run-lifecycle,render-group-lifecycle,layout-evidence,media-cleanup*}.ts` and their DB tests.
- **Accept:** one active owner. An expired owner can't renew or commit. Pre-start rejection is uncharged. Settlement happens once with no live or retryable groups. Targeted expiry and the hourly backstop share one transition.

## Evidence

Pending implementation and verification.
