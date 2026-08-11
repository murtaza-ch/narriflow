# Project-retention restore runbook

Use this procedure after restoring the application Postgres database to an earlier point in time. Do not reopen web, API, MCP, or worker traffic until the tombstone replay completes successfully.

## Preconditions

- The restored database is reachable through `DATABASE_URL`.
- The worker has read/write access to the production R2 bucket.
- Web and worker deployments are stopped or otherwise prevented from serving traffic.
- The R2 `retention-receipts/v1/` prefix has not been altered.

## Replay

From `apps/worker`, with its normal production environment loaded, run:

```bash
bun run retention:replay-tombstones
```

The command reads unexpired, content-free R2 tombstones, hashes every restored project ID, recreates missing database receipts, and hard-deletes any project that had already expired before the restore. It never restores or reads project media.

Treat any invalid tombstone as a blocking warning. Investigate the named operational log event `retention_tombstones_replayed` and do not reopen traffic until the receipt prefix and credentials are verified and the replay reports zero invalid tombstones.

## Verification

1. Run the replay a second time; `projectsRemoved` must be `0`.
2. Confirm no project whose SHA-256 ID hash appears in an unexpired tombstone exists in `Project`.
3. Confirm the worker health endpoint is healthy with retention maintenance still stopped.
4. Re-enable the worker, then the web/API deployment.
5. Monitor `expired_project_purge_failed`, `project_retention_maintenance`, and project-not-found rates for at least 30 minutes.

## Backup policy

Customer-accessible PITR is limited to seven days. Neon may retain provider backups for up to 30 days; they are not returned to normal processing and age out according to the provider schedule. Retention tombstones and database deletion receipts are removed after 90 days.
