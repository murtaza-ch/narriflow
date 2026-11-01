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

The owner's database choice is Neon Free. The second deployed 10 GiB upload/pin gate failed, as recorded below. The isolated qualified restore gate has passed. Final local-device, deployed HTTP/MCP, real provider pipeline, quota/burst, latency and exact-candidate one-hour idle gates remain open. No shared cutover, dev push, infrastructure deletion or reopening has occurred.


## Qualified restore acceptance, 2026-11-01

The fourth isolated source-8 / snapshot-9 / target-10 gate passed [its actual verifier](../evidence/qualified-restore-fourth-attempt-passed-20261101.json). The 1,297,895-byte snapshot was captured, attested and restored. Typed stale Superseded proof preceded ordinary redispatch and left the current job queued/unowned, result SQL NULL, charge 1 and assets 0. The ordinary generation-2 successor completed at 23:16:55.450 UTC, 73.744 seconds before the unchanged original deadline, with two actual starts/charges, one published asset and an uncommitted old probe. The exact privileged operator Sandbox was terminated and retired.

All three earlier attempts remain failed and retain their evidence. The candidate remains at epoch 10 with HTTP and database admission closed. No shared cutover, reopening, dev merge/push or ticket completion follows from the qualified restore pass. Ticket 22 remains claimed until all acceptance gates pass.

## Second deployed transfer attempt, 2026-11-01

The [coalesced transfer attempt failed](../evidence/coalesced-transfer-second-attempt-failed-20261101.json). Its complete 10 GiB upload passed in 1264.087 seconds with 640 parts. Conditional pinning timed out after 1324.068 seconds, at 2625.519 seconds combined. This is not a combined transfer acceptance pass.

The fixture passed the combined cutoff to the native pin operation but allowed the durable pin job and attempt to receive a fresh later deadline. A lease expiry therefore allowed an unintended second charged pin start. All three attempts became terminal, with six assigned artifacts and zero published artifacts. Their existing deadlines, attempt history and raw reports remain unchanged. The candidate Workflows and Modal gate app were stopped.

All six exact assigned artifacts have now passed deployed cleanup after the unchanged deadline/grant holds. Each returned HEAD 404, had zero exact-key multipart uploads, and had a production lease timer acknowledged before cleanup completion. Eight exact stopped MC1/base driver instances were restarted without resetting SQL acknowledgements or deleting objects locally. Audit rows and failed transfer evidence remain retained. This retirement does not change the failed transfer result.

The transfer authorization change on commit `6a497662` reduces each pure upload-part or source-range authorization from four transactions to one in local tests. It retains fresh epoch, inbox, domain and attempt checks, bounded grants and cleanup holds. This is not a measured deployed latency gain. A fixture deadline correction and a fresh deployed combined transfer pass are still required.
