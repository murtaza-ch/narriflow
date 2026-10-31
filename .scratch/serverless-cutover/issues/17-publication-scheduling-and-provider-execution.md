# 17 - Publication scheduling and provider execution

**What to build:** Publication scheduling and provider execution.

**Blocked by:** 05, 06, 09

**Status:** in-progress

**Spec:** [Serverless cutover](../spec.md)

- **Build:** §4.10: revision-bound wakes, same-attempt reconciliation, claim/deadline commands, receipt enrichment, finite performance captures. Byte transfer in lean Bun Modal.
- **Accept:** editing or cancelling while asleep fences the old wake. A lost response at each irreversible boundary never triggers a blind create. Unrecoverable unknown → Needs attention. Zero duplicate posts across the failure matrix.

## Evidence

Revision-bound dispatch foundation is implemented on `codex/serverless-runtime`. SocialPost keeps a schedule revision separately from its physical execution generation. Cancellation, changed schedule/caption/account/grant identity and return to draft fence the prior revision. A targeted Workflow observation rereads the ledger, epoch, generation, due time and exact frozen export after sleep. It stops for terminal rows and honestly waits for export readiness. Fresh134-migration PostgreSQL tests cover future registration, cancellation while asleep, changed schedules and targeted export readiness (4 tests/15 assertions).

Native publication commands, claim execution, checkpoint transport, receipt enrichment/performance schedules and deployed provider failure matrix are still being implemented. This ticket remains open.
