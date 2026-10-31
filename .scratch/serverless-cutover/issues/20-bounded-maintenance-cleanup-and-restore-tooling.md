# 20 - Bounded maintenance, cleanup and restore tooling

**What to build:** Bounded maintenance, cleanup and restore tooling.

**Blocked by:** 04, 05, 07, 19

**Status:** claimed

**Spec:** [Serverless cutover](../spec.md)

- **Build:** hourly safety reconciliation; daily retention, source purge, event/task cleanup, grant expiry and pending-workspace cleanup with durable continuation; exact-key Media Cleanup with holds; restore/epoch invalidation and redispatch procedure.
- **Accept:** an empty pass stops promptly. Referenced or held objects survive. After a restore, old executions can't commit and accepted obligations recover.

## Evidence

Pending implementation and verification.

Maintenance now has a tested reference-only page controller. Hour/day starts
coalesce on a fixed UTC cutoff, each page commits its bounded domain work and
strict cursor continuation together, and registration is confirmed after commit.
An empty pass stops; an absent phase adapter fails explicitly. The first real
page expires request-owned MCP Task handles in indexed pages without cancelling
their domain work. Three disposable-PostgreSQL cases pass19 assertions, including
an injected continuation insert failure that rolls the task deletion back.

Restore's first fence is implemented separately: one standalone transaction
closes and advances the expected epoch before domain reset work. A response loss
resumes the same expected-epoch restore and registration identity instead of
advancing twice. The PostgreSQL tracer passes10 assertions and proves an old
Maintenance command is superseded before recovery is registered. Domain reset,
validated selection transformation, redispatch, the operator CLI, daily phase
adapters and full platform scheduling remain required. This ticket remains claimed.

Clip Preparation now creates exact-key `clip_preparation_input` / `execution_input`
cleanup obligations before capsule PUT. The adopted input tuple is retained through
`executionInputRetainUntil`; cleanup reschedules a referenced object instead of
completing and forgetting its obligation. Tentative writes use unique keys to avoid
reviving a destination already granted to a deleting owner. Those persisted rows
do not yet have ticket20's confirmed maintenance scheduling or native deletion.

Selection input and result PUTs now have exact-key cleanup intent before storage
I/O and use unique nonce paths. The obsolete content-only paths are rejected by
the storage boundary. A fresh owner plans each result write, and adoption locks
the exact cleanup row so a deleting or completed cleanup owner cannot race a
later reference into existence. Input and result holds use exact Window references,
including successful siblings retained for reuse; the input-key lookup has a
composite index. Preparation adoption uses the same row fence.

The cleanup worker now reschedules all referenced/held objects rather than marking
their obligation complete and forgetting it. Thirty deterministic storage/cleanup
cases pass102 assertions; selection preparation/ownership cases pass22/175 and
preparation passes14/108. Workers-safe fixed-origin R2 DeleteObject is the agreed
destination for this small HTTP-only work, replacing lean Modal cleanup in ADR0019
and the loop inventory. Production exact-ID scheduling/deletion and remaining
maintenance/restore adapters are still required. Do not scan storage, delete unknown
completed objects, or infer that a lost commit left an orphan.
