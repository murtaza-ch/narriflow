# 22 - Integrated correctness, isolation, performance and idle gates

**What to build:** Integrated gates.

**Blocked by:** 14–21

**Status:** claimed

**Spec:** [Serverless cutover](../spec.md)

- **Build:** run §7 against real deployed Workers, Workflows, DOs, Hyperdrive and Modal on isolated resources, with deterministic fault injection. Prove the laptop path and a controlled HTTP proxy.
- **Accept:** every gate passes with commands and raw evidence. Any correctness or platform failure blocks cutover.

## Evidence

Integrated acceptance remains open. Gate-specific evidence is recorded below.

## Preparation evidence, 2026-10-31

The complete134-migration chain passed on a fresh schema in the isolated Neon gate branch, followed by8ledger checks. The expanded execution database runner now creates and drops a fresh schema for the ledger, dispatch, generic control, transfer, SourceAudio admission, targeted ingest/render/workflow, native validation and progress suites. It passed66tests/311assertions on an isolated local PostgreSQL17.11 database with pgvector0.8.7 and UTC sessions. The test guard refuses the shared development branch and ordinary local application databases before connecting. Local tests require a dedicated `narriflow_serverless_gates_*` database and a disposable `serverless_execution_test_*` schema.

`bun run test:execution:db` requires SERVERLESS_TEST_DATABASE_URL to select the explicit isolated target. The actual Hyperdrive/R2/platform gates remain separate. The old workflow regression failed and needs further investigation/update before this ticket can close. No full-candidate success is claimed.

## Current integration status, 2026-11-01

The non-execution AGENTS PostgreSQL matrix passed715 test executions and4726 assertions with zero failures or skips on the dedicated local database. The full execution runner exposed a shared-fixture cursor error in the new epoch-admission regression; its narrowed owned-row restore and surrounding Ingest suites now pass. Final execution verification waits for the started Render Group charge fix and additive migration029.

The complete deployed Worker passed the real one/two/one concurrent16MiB publication payload sequence in one isolate with1082 constructed production routes and zero SQL. The absent synthetic object was recreated before that successful sequence. The temporary CutoverVerification export and implementation have been removed from release source. See [the deployed result](../evidence/publication-full-worker-memory-20261101.json).

The owner's database choice is Neon Free. The actual signed10GiB upload/pin gate is running against the isolated candidate. The isolated qualified restore gate has now passed. Final local-device, deployed HTTP/MCP, real provider pipeline, quota/burst, latency and exact-candidate one-hour idle gates remain open. No shared cutover, dev push, infrastructure deletion or reopening has occurred.


## Qualified restore acceptance, 2026-11-01

The fourth isolated source-8 / snapshot-9 / target-10 gate passed [its actual verifier](../evidence/qualified-restore-fourth-attempt-passed-20261101.json). The 1,297,895-byte snapshot was captured, attested and restored. Typed stale Superseded proof preceded ordinary redispatch and left the current job queued/unowned, result SQL NULL, charge 1 and assets 0. The ordinary generation-2 successor completed at 23:16:55.450 UTC, 73.744 seconds before the unchanged original deadline, with two actual starts/charges, one published asset and an uncommitted old probe. The exact privileged operator Sandbox was terminated and retired.

All three earlier attempts remain failed and retain their evidence. The candidate remains at epoch 10 with HTTP and database admission closed. The coalesced 10 GiB gate is separately running against the fixed closed Worker; its result is not claimed here. No shared cutover, reopening, deployment change, dev merge/push or ticket completion follows from the qualified restore pass. Ticket 22 remains claimed until all acceptance gates pass.
