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
resumes the same validated snapshot proof and registration identity instead of
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

The next checkpoint adds real hourly pending-outbox and nearest-attempt-deadline
pages, with fixed SQL round trips and indexed cursors. Every hourly observation
has that hour's identity so a previously failed safety handler can be retried by
a later pass. Expiry remains the shared exact domain transition. Daily inbox
expiry now uses `(expiresAt, deliveryId, audience)` and preserves ties across
all internal and signed namespaces.

Restore now runs strict source-pair/cutoff/cursor pages under `restore-page`
receipts. Its first production adapter revokes only old-epoch active generic
permissions; historical owner/process-start/completed facts remain intact. Missing
domain adapters still fail explicitly, and no path reopens admission. Full fresh
PostgreSQL verification through migration 010 plus current integration migrations
passes 261 tests and 1,741 assertions. Services/API typechecks and focused Biome pass.
The injected empty adapters in controller tests are test fixtures, not production
fallbacks. Remaining domain transforms, the complete phase factory, operator CLI
and deployed maintenance acceptance are still required.


The operator checkpoint replaces the unproven epoch-only restore interface with
mandatory quiesced snapshot evidence and `rs2` pages. Fence creates no dispatch;
attestation reads actual closed-epoch/migration facts before overwriting live DB.
The CLI hashes regular snapshot and stop/drain evidence files, creates a private
proof exclusively, checks fresh static fenced Worker health and the exact selected
schema, then begins only from that proof. Higher live epochs are refused. Inspect
can recover an uncertain begin's exact dispatch ID; resume describes/rechecks/
restarts only the known current instance, without a new epoch or intake reopen.
The [runbook](../../../docs/runbooks/execution-restore.md) gives the operational
preconditions. No shared snapshot, restore, Workflow restart or deletion was run.

Remaining acceptance map: production hourly factory has real outbox/deadline
adapters but provider-wait and domain-wake repair adapters are not complete; daily
has real task/inbox expiry but event retention, grants, source/project retention,
pending-workspace cleanup and complete cleanup-phase mounting remain open. Restore
has generic old-authority revocation and tested page receipts, but complete domain
adapters (including validated successful-window reuse and preparation rebind),
restore redispatch factory, scheduling/fenced-Cron hookup and deployed restore/
maintenance/actual R2-delete acceptance remain required. Available billing/library/
publication restore ports and bundle-expiry ports still need integration into
those factories. Missing phases deliberately fail; test empty adapters are not
production fallbacks. Ticket 20 remains claimed.


The proof/CLI checkpoint passes the complete fresh disposable-schema gate:
266 tests / 1,761 assertions, including snapshot fencing and restore suites in
separate epoch-fencing processes. Nine deterministic proof/file/transport tests
pass 52 assertions. Services/API and the operator script typecheck; focused Biome
passes. These are local gates; no full deployed restore or maintenance claim is made.


After merging integration (including Finishing, publication observation and the
fenced Worker health endpoint), the complete fresh gate passes 276 tests / 1,810
assertions. Services including the operator and API typechecks remain green.

Production adapter work continues: fixed hourly model phases now repair current
acknowledged drivers with fresh observations and no owner/charge mutation. Real
bounded retention pages cover Workflow Events (pending delivery retained),
Workspace Events (permanent dedupe keys retained), webhook logs, terminal prompt
scrubbing, deletion receipt expiry and known cleanup intent repair. Billing/library
page bodies reuse their existing domain helpers and preserve paid work/deadlines.
Migration016 adds strict page indexes and the current completed Preparation output
shape (`readyObjects`), which normal completion always writes. No legacy completed
reader is retained; old isolated fixtures must be reset before applying the CHECK.
The focused fresh-schema gate passes33tests/270assertions; module typechecks and
Biome pass. Full factories/transforms are still being implemented, not mounted.

Source restore now rebinds Ingest/Workflow/Render Group authority without changing
accepted charges, absolute deadlines, frozen membership or waiting-provider lineage.
Selection and Preparation use a server-owned preflight outside SQL locks, validate
captured immutable objects, and re-encode successful results to the new binding at
unique planned keys. Metadata adoption and each cursor/receipt commit together;
replay does not repeat PUT or provider work. A separate bounded Preparation-link
phase seals valid Group references before redispatch. Completed historical rows
remain unchanged, and restored preparation reuses verified outputs through the
sole current `readyObjects` shape without inventing Generic execution history.
The focused fresh-schema gate passes 38 tests / 321 assertions (normal preparation,
retention, object transformation and restore). Services/API typechecks and focused
Biome pass. Remaining native/upload/retention adapters, final redispatch and full
production factory/platform acceptance are still in progress.
