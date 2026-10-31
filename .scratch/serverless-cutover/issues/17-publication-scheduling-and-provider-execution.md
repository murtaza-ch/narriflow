# 17 - Publication scheduling and provider execution

**What to build:** Publication scheduling and provider execution.

**Blocked by:** 05, 06, 09

**Status:** ready-for-agent

**Spec:** [Serverless cutover](../spec.md)

- **Build:** §4.10: revision-bound wakes, same-attempt reconciliation, claim/deadline commands, receipt enrichment, finite performance captures. Byte transfer in lean Bun Modal.
- **Accept:** editing or cancelling while asleep fences the old wake. A lost response at each irreversible boundary never triggers a blind create. Unrecoverable unknown → Needs attention. Zero duplicate posts across the failure matrix.

## Evidence

Pending implementation and verification.
