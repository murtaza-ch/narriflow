# Project-retention restore runbook

Use this after restoring the application Postgres database to an earlier point in time. The general restore order (fence, attest, begin, redispatch, resume) is [the execution restore procedure](execution-restore.md); this page covers only what project retention adds. Do not reopen intake until the redispatch receipts and platform checks in that procedure pass.

## What survives a restore

- Project purge is a durable, Workflow-driven page chain (`packages/services/src/project-retention-execution.ts`). A restored Project whose `expiresAt` has passed is purged again by the `redispatch_retention` restore phase and the daily retention schedule.
- When a Project is purged, a content-free deletion receipt is written to R2 at `retention-receipts/v1/<sha256(projectId)>.json` and recorded in `ProjectDeletionReceipt`. These tombstones are the only record of a deletion that happened after the restored snapshot.

## Known gap

The earlier `retention:replay-tombstones` command belonged to the retired worker and has no replacement in this repository. Nothing reads the R2 tombstones back into a restored database. A Project deleted after the snapshot reappears until a person deletes it again. Until a replay exists, treat this as a manual check before reopening intake:

1. List the R2 `retention-receipts/v1/` prefix (read only; never alter it).
2. Hash each restored Project ID with SHA-256 and compare against the listed receipt names.
3. For any match that still exists in `Project`, delete it through the normal user-delete path so storage and rows are purged again.

## Verification

1. Confirm no Project whose SHA-256 ID hash appears in an unexpired tombstone exists in `Project`.
2. After reopening, watch the maintenance Workflow for failed retention pages and the project-not-found rate for at least 30 minutes.

## Backup policy

Customer-accessible PITR is limited to seven days. Neon may retain provider backups for up to 30 days; they are not returned to normal processing and age out according to the provider schedule. Retention tombstones and database deletion receipts are removed after 90 days.
