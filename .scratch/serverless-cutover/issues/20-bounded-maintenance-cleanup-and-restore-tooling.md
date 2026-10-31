# 20 - Bounded maintenance, cleanup and restore tooling

**What to build:** Bounded maintenance, cleanup and restore tooling.

**Blocked by:** 04, 05, 07, 19

**Status:** claimed

**Spec:** [Serverless cutover](../spec.md)

- **Build:** hourly safety reconciliation; daily retention, source purge, event/task cleanup, grant expiry and pending-workspace cleanup with durable continuation; exact-key Media Cleanup with holds; restore/epoch invalidation and redispatch procedure.
- **Accept:** an empty pass stops promptly. Referenced or held objects survive. After a restore, old executions can't commit and accepted obligations recover.

## Evidence

Local implementation and production composition are recorded below. Deployed
maintenance, exact cleanup and full restore acceptance remain required.

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

Migration021 narrows native epoch-forward transitions to a closed current rs2
restore with revoked Generic permissions. Native validation, thumbnail, RSS,
notification delivery and generated-media adapters retain original budgets and
deadlines. Started paid image generation remains unknown with historical artifact
lineage; no restore path repeats its POST. Callback/subscription restore clears
physical leases while preserving frozen payloads, retry dates and delivery cursors.
Their separate current-epoch wake repair includes future accepted rows.
Source retention now retires only a verified committed current source-video key
and queues exact cleanup after grant/deadline drain; SourceAudio remains separate.
Project-purging capsule references release after that same drain. The focused fresh
schema gate passes20tests/119assertions. Exact Upload Session recovery reuses its
existing transition body, filters one session and confirms the claimed watchdog
before provider HTTP; all83module tests/311assertions pass. Services/API typechecks
and focused Biome pass. Upload producer timers, remaining privacy retention,
redispatch and factory/platform mounting are not yet complete.

Final redispatch now has real separate current-model planners for source, Workflow,
Render Group, Selection, Preparation, native validation, thumbnail, image generation,
RSS, notification delivery, billing and library. These include accepted future due
rows and recreate current canonical registration; unknown paid outcomes stay parked.
The restored Group path is tested through the actual preparation readiness reader.
The broader native/source regression slice passes49PGtests/389assertions; focused
redispatch/object transformation passes3PGtests/78assertions. Empty final-model
selectors execute valid SQL and stop immediately. Phase orchestration and external
future timers still need the production factory; these planners alone do not close20.

The production factory is now implemented as
`createExecutionMaintenanceRuntime(options)`, returning `maintenance`, `restore`,
`scheduled` and one reference-only `run` port. Every external product planner is
required, including paired Project/Review mail, Autopilot/Zoom and future publication
observations/grants/guidance. Missing slots fail construction. Fenced scheduling
makes no SQL call. The registry routes `mt1`, `rs2`, exact Project privacy `pr1`,
pending Workspace `pw1`, and operation_driver/upload_session references.

Daily retention now has real source-video retirement, private validation/RSS row
retention (30days, with an indexed live Rule/result hold), expiry warnings through
the current notification intent, bounded known-key Project privacy pages, deletion
receipt expiry, pending unpaid Workspace cleanup and exact cleanup repair. Privacy
cancels/revokes bounded domain pages, enumerates a Project's indexed ledger/artifact
references and planned keys, waits for actual DELETE acknowledgements, and writes
an immutable hash-addressed proof before database purge. Unresolved paid/provider
outcomes refuse destructive progression. Independent Workspace assets remain held.
The proof labels its counters as acknowledged exact keys and known committed bytes;
it does not claim a physical bucket inventory. Receipt retirement is another exact
known-key cleanup intent. No bucket listing or global orphan inference is used.

Upload state transitions and their repair wakes now commit together. Its existing
reconciliation body runs one exact session, confirms a lease watchdog before HTTP,
and checks the captured epoch at background mutation boundaries. Replays recover
already committed timers. The expanded Upload PostgreSQL cases use the current
exact cleanup controller rather than a global legacy25-row claim and fake clock.

Restore has an inspectable metadata-ready boundary followed by fixed per-model
redispatch pages, including future holds/timers. Deferred PUT plans and that
boundary serialize on one short advisory lock; no new deferred plan is admitted
after sealing. Captured cleanup rows use the original cutoff, and post-cutoff
plans use the exact recorded barrier horizon. Migration025 makes Dispatch.createdAt
an actual insertion clock, matching Prisma, so a transaction begun before a later
planner cannot backdate the barrier. The real race is red with the old now()
default and green with clock_timestamp(). Every individual restore PUT also fences
its planned destination and refreshes the120s physical-write drain before HTTP.

The production checkpoint passes59PostgreSQLtests/474assertions across Upload,
privacy, maintenance, cleanup and restore, plus92deterministictests/389assertions.
The final clock/PUT/privacy review slice passes7PGtests/75assertions. Services/API
typechecks and focused Biome pass. The empty-factory suite runs in its own fresh
schema; it never deletes other suites' accepted obligations to manufacture emptiness.
These are local gates. Root still must supply the four real Autopilot/Zoom page
ports, mount the factory/Cron/registry, and run deployed maintenance, exact R2-delete
and full quiesced restore acceptance. External-domain empty functions in the factory
tests are explicit fixtures only. Ticket20 remains claimed until that acceptance.

The CLI now enforces the mode boundary too: metadata repair resumes only against
fresh fenced health; metadata-ready redispatch resumes only against closed health
with database intake still closed. Open mode is refused. Snapshot attestation and
fresh begin remain strictly fenced. Eleven proof/operator/storage tests pass62
assertions. The runbook and glossary describe the sealed metadata boundary and
continued Cron stop through redispatch. API factory mounting is the next slice.

Production composition is now implemented in the API with every real required
domain planner, including paired Project/Review notification ledgers,
Autopilot/Zoom, Finishing, Bundle/Dub and future publication receipt, capture,
grant and guidance obligations. Guidance receives the frozen snapshot epoch.
The Workflow registry mounts mt1/rs2/pr1/pw1 and Upload Session reconciliation,
plus the targeted Autopilot/Zoom coordinators. Metadata restore remains
product-dispatch-free until the explicit closed-mode redispatch boundary.

The production entrypoint exports an awaited scoped scheduled handler. Its UTC
hourly safety and daily retention triggers only register bounded metadata work.
Fenced invocations stop before configuration, runtime or SQL scope construction.
The same early fence now covers all eleven DevelopmentBindings RPC methods.
The runbook requires explicit empty Cron configuration through closed redispatch.
Project purge is asynchronous and preserves an already accepted future hold
revisit, including a prior 24-hour retained-object retry.

The actual API factory passes both empty cadences on a fresh full-migrated
PostgreSQL schema, using all concrete domain planners: 1 test/9 assertions,
zero provider HTTP and zero executor admissions. Invocation/storage cases pass
14 tests/71 assertions. Seven workerd checks include the production scheduled
export and all RPC fences. Services/API typechecks, Worker dry-run/import audit
and focused Biome pass. The default execution runner self-isolates the new
production-composition suite and includes Zoom execution/refresh and Autopilot
maintenance. Their deliberate epoch proof writes roll back within the test.
These checks do not replace deployed exact cleanup, maintenance and quiesced
restore acceptance. Ticket20 remains claimed until those platform gates pass.

The expanded default execution database runner also passes in full: 420 tests,
2,939 assertions and zero failures across fresh disposable schemas. Both empty
factory gates run separately; ordinary domain suites share the ordinary test
schema and committed epoch-fencing suites run last in separate Bun processes.
