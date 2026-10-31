# 19 - Other product jobs and billing maintenance

**What to build:** Other product jobs and billing maintenance.

**Blocked by:** 04, 05, 06, 09, 17, 18

**Status:** ready-for-agent

**Spec:** [Serverless cutover](../spec.md)

- **Build:** event/due-driven drivers for billing, Autopilot/RSS, Finishing, dubbing, export bundles, generated media, thumbnails, library indexing, Performance Guidance and notification intents (existing email adapter untouched).
- **Accept:** a row-by-row map shows every old loop with its trigger, retry and expiry. Billing shares the usage lock. Stale rule or grant revisions can't authorize work. No quota double-spend on replay.

## Evidence

Pending implementation and verification.
