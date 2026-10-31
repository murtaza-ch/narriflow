# 20 - Bounded maintenance, cleanup and restore tooling

**What to build:** Bounded maintenance, cleanup and restore tooling.

**Blocked by:** 04, 05, 07, 19

**Status:** claimed

**Spec:** [Serverless cutover](../spec.md)

- **Build:** hourly safety reconciliation; daily retention, source purge, event/task cleanup, grant expiry and pending-workspace cleanup with durable continuation; exact-key Media Cleanup with holds; restore/epoch invalidation and redispatch procedure.
- **Accept:** an empty pass stops promptly. Referenced or held objects survive. After a restore, old executions can't commit and accepted obligations recover.

## Evidence

Partial implementation; platform mounting and the remaining phase/recovery map are still required.

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

The exact-ID cleanup controller now validates the current ledger tuple before
choosing a trusted key, takes one 120s claim, and confirms a durable lease timer
before HTTP. Live-owner replay confirms that same timer; stale delivery cannot
reuse a rescheduled intent. A held object commits a future obligation. DELETE
response loss retains the exact intent and key for bounded backoff. Six real
PostgreSQL cases pass34 assertions. The Workers-safe fixed-origin adapter drains
at most 8 exact-key multipart uploads per call before DELETE; a truncated inventory
or unknown acknowledgement never completes cleanup. Two storage cases pass15
assertions. Production hold resolution, assignment/retirement producers, maintenance
phase mounting, daily adapters and full restore recovery remain open.

Cleanup production ports now include one frozen known-row range drain per admission
batch. Pages schedule at most 100 exact cleanup IDs plus one continuation; expiry
or adoption moving a tentative hold repairs the exact due generation. Producer
transactions for input capsules, retired Clip media, duplicate-copy compensation,
assigned executor outputs, generated/private publication inputs and notification
bodies retain their drain obligations. The pre-existing notification body origin
and class are now in the whitelist, with a fresh pre-I/O and adoption fence that
prevents a replay from recreating a destination granted to cleanup.

Assigned outputs are retained through the immutable absolute deadline or aggregate
grant expiry, plus 120s to drain bounded native HTTP. Native publication cannot
adopt after that authority expires. Exact-key MPU inventory is then aborted before
DELETE. Committed Project-backed evidence remains held through its Project
lifetime, live Visual Assets/fonts are held by exact key, and publication checkpoints
stay held through Needs Attention. Private validation/probe evidence is conservatively
held until its owner row is purged; the corresponding daily row-retention adapter
remains open. Migration 009 indexes cleanup ranges, due pages, assigned inputs and
notification body holds, and makes cleanup destination/scope immutable.

Internal `maintenance-page` receipts now atomically persist each page outcome and
all wake IDs, including its cursor. Lost registration replay confirms those exact
IDs without consuming another domain page. Cleanup retry replay likewise confirms
the current committed obligation without another DELETE. These audiences are
separate from executor signatures. Receipts last 7 days; after retention an operator
uses a fresh bounded pass or explicit restore heal, not automatic replay of an
old page without its receipt.

The full disposable PostgreSQL gate passes 226 tests and 1,504 assertions across
all fresh migrations through 009, including the epoch bump between cleanup timer
confirmation and DELETE with zero HTTP. Services/API typechecks pass; 34 changed
TypeScript/JSON files pass Biome. Deterministic cleanup/storage cases pass 33/118.
These results do not establish deployed R2 deletion or complete the still-open
hourly/daily phase adapters and restore domain transformation.
