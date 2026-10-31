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

Selection input and result PUTs still need planned exact-key cleanup admission.
Its content-addressed input keys also need an explicit rule against reviving a key
whose cleanup owner already received delete authority. Completed Window input/result
references must remain held, including successful siblings retained for reuse.
Use bounded explicit identifiers and existing row references; do not scan storage,
delete unknown completed objects, or infer that a lost commit left an orphan.
