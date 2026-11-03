# 24 - Execute the single cutover

**What to build:** Execute the single cutover.

**Blocked by:** 23 + owner prerequisites

**Status:** claimed

**Spec:** [Serverless cutover](../spec.md)

- **Build:** the §8 runbook, with owner authorization for account, DNS and deletion steps. Record evidence in `docs/runbooks/serverless-cutover.md`.
- **Accept:** old consumers can't run against the migrated DB. Candidate and migration match the tested hashes. Smokes and idle check pass. Railway and Upstash are removed. Admission reopens once.

## Evidence

Pending implementation and verification.

The shared transaction fence now enforces `ExecutionEpoch.admissionOpen` across
the mapped new-work service seams, while exact replay and already-admitted
completion remain available. See the [entrypoint map and PostgreSQL evidence](../evidence/admission-fence-20261031.md).
Cutover still requires the deployed close/open smokes, merged manual Publish again
guard, finishing-driver parking and removal of obsolete scanner admissions before
relying on this switch. Verify old consumers cannot admit while closed, and reopen
once only after migration and runtime gates pass. Product code has no test bypass.

## Owner direction, 2026-11-04

The owner requested stopping the large-transfer test and proceeding with the latest migration, development deployment and retirement, with product testing performed by the owner. Run backup/rehearsal and essential resource-wiring checks. Preserve failed and deferred gates; this development switch does not satisfy the full original production acceptance matrix.
