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

The non-execution AGENTS PostgreSQL matrix passed715 test executions and4726 assertions with zero failures or skips on the dedicated local database. The full execution runner, including the Render Group charge fix and migrations029/030, passed466 tests and3366 assertions. After the upload handoff fix, it passed470 tests and3408 assertions with zero failures or skips. The new upload restore assertion initially scanned another suite's intentionally superseded fixture; its corrected cursor restores only its own newest Ingest Job. Both failed and successful logs remain retained. These are isolated local database results, not deployed pipeline acceptance.

The complete deployed Worker passed the real one/two/one concurrent16MiB publication payload sequence in one isolate with1082 constructed production routes and zero SQL. The absent synthetic object was recreated before that successful sequence. The temporary CutoverVerification export and implementation have been removed from release source. See [the deployed result](../evidence/publication-full-worker-memory-20261101.json).

The owner's database choice is Neon Free. The third deployed 10 GiB upload/pin gate passed, after the two retained failed attempts recorded below. The isolated qualified restore gate has passed. The first real speech upload exposed a missing ingest dispatch and failed its four-minute smoke target; its original session and job remain retained. Final local-device, deployed HTTP/MCP, real provider pipeline, quota/burst, latency and exact-candidate one-hour idle gates remain open. No shared cutover, dev push, infrastructure deletion or reopening has occurred.


## Qualified restore acceptance, 2026-11-01

The fourth isolated source-8 / snapshot-9 / target-10 gate passed [its actual verifier](../evidence/qualified-restore-fourth-attempt-passed-20261101.json). The 1,297,895-byte snapshot was captured, attested and restored. Typed stale Superseded proof preceded ordinary redispatch and left the current job queued/unowned, result SQL NULL, charge 1 and assets 0. The ordinary generation-2 successor completed at 23:16:55.450 UTC, 73.744 seconds before the unchanged original deadline, with two actual starts/charges, one published asset and an uncommitted old probe. The exact privileged operator Sandbox was terminated and retired.

All three earlier attempts remain failed and retain their evidence. The candidate remains at epoch 10 with HTTP and database admission closed. No shared cutover, reopening, dev merge/push or ticket completion follows from the qualified restore pass. Ticket 22 remains claimed until all acceptance gates pass.

## Second deployed transfer attempt, 2026-11-01

The [coalesced transfer attempt failed](../evidence/coalesced-transfer-second-attempt-failed-20261101.json). Its complete 10 GiB upload passed in 1264.087 seconds with 640 parts. Conditional pinning timed out after 1324.068 seconds, at 2625.519 seconds combined. This is not a combined transfer acceptance pass.

The fixture passed the combined cutoff to the native pin operation but allowed the durable pin job and attempt to receive a fresh later deadline. A lease expiry therefore allowed an unintended second charged pin start. All three attempts became terminal, with six assigned artifacts and zero published artifacts. Their existing deadlines, attempt history and raw reports remain unchanged. The candidate Workflows and Modal gate app were stopped.

All six exact assigned artifacts have now passed deployed cleanup after the unchanged deadline/grant holds. Each returned HEAD 404, had zero exact-key multipart uploads, and had a production lease timer acknowledged before cleanup completion. Eight exact stopped MC1/base driver instances were restarted without resetting SQL acknowledgements or deleting objects locally. Audit rows and failed transfer evidence remain retained. This retirement does not change the failed transfer result.

The transfer authorization change on commit `6a497662` reduces each pure upload-part or source-range authorization from four transactions to one in local tests. It retains fresh epoch, inbox, domain and attempt checks, bounded grants and cleanup holds. The corrected third attempt below supplies the deployed combined transfer acceptance result. The failed second attempt remains failed.

## Exact deployed image qualification, 2026-11-01

The paired `b7fdecf3` images passed [exact deployed-image qualification](../evidence/exact-deployed-images-native-golden-b7fdecf3-20261101.json). Refreshed product and verifier metadata selected the actual immutable image IDs. Credential-free, network-blocked Sandboxes ran 168 applicable lean tests at 2 CPU/4 GiB and all 183 render tests at 4 CPU/8 GiB, with zero skips, failures or expected failures. Three source audits per profile matched 1,512 lean and 1,578 render baked files, including the sealed private Modal module. No application source was overlaid.

The frozen 36-case golden comparison passed with zero mismatches: 18 ordinary cases and 16 activated cases passed. The summary retains its historical `xfail` label for `rot180` and `mirror-h`, but both per-case verdicts are `guard-pass`, with rendering and orientation assertions passing. Both temporary Sandboxes were terminated, and the six selected Function identities remained stable. This does not establish live provider behavior, cold-start p95, or clip preparation under its smaller 2 CPU/4 GiB Function limits; those remain separate acceptance work.

## Third deployed transfer attempt, 2026-11-01

The [third combined transfer attempt passed](../evidence/atomic-transfer-third-attempt-passed-20261101.json) on source `b7fdecf3`. Its 10,737,418,240-byte upload used 640 parts and completed in 843.888 seconds. Conditional pinning read and wrote the same complete byte count in 1332.845 seconds. The combined elapsed time was 2232.554 seconds, leaving 467.446 seconds before the original 01:27:05.590 UTC SQL deadline. Both jobs and generic attempts retained that deadline, with exactly two actual starts and charges, generation one each, four assigned artifacts and zero published artifacts.

All four exact artifacts passed deployed retirement after the unchanged deadline plus the 120-second grant hold. Each returned HEAD 404, had zero exact-key multipart uploads, and had a production lease timer acknowledged before cleanup completion. Audit rows remain retained. No local object deletion or deadline extension was used.

## First real speech upload, 2026-11-01

The [first real speech smoke failed](../evidence/spoken-first-attempt-handoff-failed-20261101.json). The production uploader accepted the 146.147-second source and created its ingest job, but finalization did not commit an initial ingest dispatch. A scoped observation found zero dispatches, execution attempts and native charges. No MCP generation Task had been submitted. The original four-minute target remains failed.

The original upload session, project, job and idempotency keys remain retained for an ordinary authenticated uploader replay after the handoff fix. No manual dispatch insertion, job reset or replacement fixture has occurred. Candidate HTTP and database admission are closed while the fix is verified. This ticket remains claimed.

The [local handoff fix checks](../evidence/upload-handoff-local-checks-20261101.json) pass on `cae8e162` plus the test isolation correction. Fresh finalization queues the initial dispatch atomically; authenticated queued replays collect the same current obligation without changing job or storage budgets. Independent review exposed and then verified the correction of two boundary bugs: registration failure lost its HTTP receipt, and an actual streamed MCP Task could inherit an already-flushed collector and return before registration. On `9c1de0de`, the actual SDK/local PostgreSQL regressions pass for JSON, SSE, same-key recovery and confirmation before the positive Task result. The full execution runner passed474 tests/3449 assertions with zero failures or skips; typecheck15/15, fast tasks14/14, lint, inventory, OpenAPI, web split, environment consistency and Worker import audit pass. The deployed Worker remains closed with79 secrets and no mail credential. Paired media qualification and deployed same-upload replay remain pending. The first four-minute smoke is still failed.

## Media coverage audit, 2026-11-01

The exact-image golden evidence now distinguishes its historical summary labels from the two actual passing orientation guards. Its raw reports and hashes remain unchanged. The earlier long-source report overstated moov/GOP coverage; an explicit asserted head/tail moov and short/long GOP seek matrix remains open. The twelve-window three-hour representative-source fixture measured18.01% source reads, while the compact-source357.55% failure remains retained. Actual deployed Mac acquisition, successful upstream proxy/token parity and broader live provider media acceptance remain pending.

## Exact handoff build and speech recovery, 2026-11-01

The paired `9c1de0de` images passed [native, frozen golden and explicit seek qualification](../evidence/exact-deployed-images-native-golden-seek-9c1de0de-20261101.json). The actual immutable lean and render images ran170 and185 applicable tests, respectively, with zero failures, skips or expected failures. The unchanged36-case golden comparison passed, including the two orientation guards. The new four-case matrix asserts head/tail moov placement and15/120-frame GOPs, then fully decodes each720-square output and checks its start frame, frame clock and audio onset. Source audits matched the baked files without application overlays. Both credential-free, network-blocked qualification Sandboxes were retired.

Ordinary authenticated uploader replay recovered the original speech upload under the same session, project, job and idempotency keys. Pinning, Scribe and moment detection completed. The production MCP Generate call returned its real Task after confirmed registration. The caller now checks the public exact `sourceEdgeSec` field rather than rounded display duration. The requested12 clips produced a frozen work set of6; no12-clip latency pass is claimed.

Live preparation then exposed repeated control timeouts. The [local authority fix checks](../evidence/clip-preparation-authority-local-checks-b58f3599-20261101.json) pass on `b58f3599`:477 PostgreSQL tests and3486 assertions, full typecheck15/15, fast tasks14/14 and the Worker import audit. Independent Sol High standards and spec reviews found no issues. Candidate Worker `9b283da7-f65b-4720-929e-751fcfdf36e9` has79 secrets and no mail credential. HTTP admission is open only on the isolated gate candidate; the shared development database is unchanged.

The original preparation and group deadline remains03:21:11.080 UTC, with charged counters and all failed attempts retained. Native starts now occur, but source-read transport failures and repeated database validation remain blockers. A bounded incidental Worker trace contains two successful control responses above the native client's unchanged10-second timeout. It does not establish p50 or p95. The native images still contain `9c1de0de`, so the later backend change requires a fresh paired build and qualification. Ticket22 remains claimed; the original four-minute smoke remains failed.

The [original speech journey's terminal result](../evidence/spoken-original-terminal-failure-20261101.json) is failed:0 completed clips,6 failed groups and `operation_deadline_exceeded`. Its78 preparation attempts contain18 actual starts, exactly3 charged starts per preparation; no render started. All attempts are terminal. Two partial preparation artifacts were committed among192 assigned outputs. All192 have cleanup obligations;28 were completed by03:27:03 UTC, while committed project-backed evidence remains held. No complete retirement claim follows. The original journal and earlier handoff failure are preserved. A later test must use separately recorded identities rather than replace this failed result.

Candidate intake is now [closed in HTTP and PostgreSQL](../evidence/spoken-terminal-candidate-closed-20261101.json), at unchanged epoch10. Worker `8825e9d5-256b-4d57-bcff-1e003d50bd51` retains79 secrets and no mail credential. Nine selected Modal Functions had zero running inputs, containers and backlog in one observation; this is not the one-hour idle gate. The next speech journal has distinct run, upload and generation keys and is prepared offline only.

The [focused preparation recovery checks](../evidence/preparation-recovery-local-checks-20261101.json) pass. Fresh preparation validation now avoids recursive parent reads and relocking: the measured first package path falls from64 to50 SQL statements; a source-read grant uses34. The50-test PostgreSQL gate passes399 assertions, including typed refusal before UUID interpretation for mismatched references. Real two-server HTTP regressions cover both a disconnect before upstream headers and truncation after valid206 headers. The existing three-attempt range loop now recovers both transport failures with fresh authority and identical Range/If-Match. Cancellation and invalid/oversized response refusals remain enforced;25 source/transport tests and7 pinned preparation/render tests pass. Independent Sol High standards and spec reviews found no remaining issues. The historical live network cause remains unproven, and no deployed recovery or latency pass is claimed. A fresh paired image build and integrated verification remain required before another live attempt.
