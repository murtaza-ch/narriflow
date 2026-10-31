# 24 - Execute the single cutover

**What to build:** Execute the single cutover.

**Blocked by:** 23 + owner prerequisites

**Status:** ready-for-agent

**Spec:** [Serverless cutover](../spec.md)

- **Build:** the §8 runbook, with owner authorization for account, DNS and deletion steps. Record evidence in `docs/runbooks/serverless-cutover.md`.
- **Accept:** old consumers can't run against the migrated DB. Candidate and migration match the tested hashes. Smokes and idle check pass. Railway and Upstash are removed. Admission reopens once.

## Evidence

Pending implementation and verification.

Remaining admission gate: `ExecutionEpoch.admissionOpen` exists but is not yet enforced by request-path admissions. Cutover must wire the authoritative close/open check across admission paths before relying on this switch, verify old consumers cannot admit while closed, and reopen once only after migration and runtime gates pass. The lifecycle preparation does not introduce a test-only bypass for this flag.
