# Private candidate qualified restore gate

Prepared locally for a fresh attempt; no cloud action is performed by these preparation changes. The previous 3/4/5 attempt captured, attested and restored its epoch-4 snapshot, but failed closed-mode registration. It did not establish two starts or a stale signed refusal. The candidate is now closed at epoch 5. Preserve that failed run directory and its evidence. Its source-4 snapshot cannot be restored over epoch 5. Runtime must fix the fenced metadata replay that consumed the boundary delivery backoff before this fresh attempt starts. No migration occurs during the native gate. The target is exclusively `ep-wispy-field-b5wyn9o3.c-7.us-east-2.aws.neon.tech / serverless_pipeline_gates / public`. Shared development and arbitrary PITR are excluded.

The expected sequence is an actual native start in epoch 5, a quiescence fence to epoch 6, a real custom-format database dump and restore of that same private database, proof-bound begin to epoch 7, metadata rebinding while fenced, and explicit closed-mode redispatch. The stale final probe must return `superseded`; a current invocation must publish once. Two actual starts consume two charges. The stale callback consumes zero. Nothing resets the original ten-minute absolute deadline.

## Prepare before starting the clock

- Use a fresh run UUID, private directory, release nonce, source key, Sandbox journal and actual native admission. Never reuse the failed 3/4/5 operation, snapshot or deadline.
- Merge the native partial-pair restore correction and SQL migration `20261101060000_execution_native_restore`, and the explicit metadata/redispatch boundary fix. Apply all candidate migrations and deploy matching code before accepting the test job. Do not migrate during its ten-minute budget.
- Prepare both fenced and closed candidate deployments with `triggers.crons: []`. Verify the account, Worker, Workflow names, Hyperdrive database and storage bindings from the actual deployment configuration. `API_ORIGIN` is that explicit candidate origin. A health response alone cannot prove its database binding.
- Check pinned Bun 1.3.6, Python 3.13.5, libpq 18.6 binaries at `/opt/homebrew/opt/libpq/bin`, Wrangler authentication, and the exact direct `verify-full` connection. The operator's actual private Neon preflight reported PostgreSQL 18.6; localhost disposable tests use 17.11 and do not establish cloud archive compatibility. The helper reads the actual target's `server_version` and `server_version_num`, requires major 18, and requires each selected utility's exact 18.6 version before executing it. Keep this operator environment file and all dumps/proofs mode 0600 in a private mode-0700 directory.
- Use system roots for libpq TLS. The helper fixes `PGSSLROOTCERT=system` with `PGSSLMODE=verify-full` in the archive child's environment. Keep Prisma/CLI `DIRECT_URL` at `sslmode=verify-full` without a `sslrootcert=system` URL parameter, which its Node driver interprets as a certificate file path.
- The operator's real pre-clock backup was 1,196,912 bytes and took about 83 seconds over the Pakistan-to-Neon path. This supersedes the earlier 60-second utility assumption. Before starting the native clock, the operator separately measures a trusted restore into a newly created disposable database on that same private branch. This helper still refuses every database except the exact candidate; the separate timing preflight is not a reason to weaken that guard. Proceed only if measured dump/restore plus deployments, metadata, redispatch and release fit the original native budget.
- Prepare one tiny PNG under a fresh brand owner with no existing asset of that fingerprint, a fresh private release key, and its short-lived GET. The release JSON freezes sourceEpoch 5 and targetEpoch 7 with a fresh nonce and starts with `release:false`. Do not print the URL, nonce or keys. Explicitly choose the fault driver's hold bound, at most 540 seconds and always shorter than the remaining original deadline. Prebuild the isolated fault Function/image. Keep its signing key valid across both deployments; an authentication failure does not prove stale-owner fencing.
- Use explicit private fixture composition. Actual domain admission/preparation creates the old epoch-5 job, pending Modal DID and real attempt. Keep that original Modal registration pending without a fake ACK, and manually invoke only the fault wrapper with its actual prepared reference/token. This original transport setup is not public-admission acceptance evidence. The restored epoch-7 invocation uses ordinary deployed Workflows/bridge/validator. The wrapper receives only existing control credentials, immutable invocation metadata and the one-key release GET, never database credentials or long-lived R2 credentials. No production selector is added. Inspect any duplicate registration caused by the real acquire wake; an already-owned duplicate must start nothing.
- The actual old acquire/start/upload calls require the candidate HTTP in `closed` mode first, with public intake and Cron still stopped. A `fenced` API refuses these calls. Switch to the prepared fenced deployment only after the ready event; do not advance the database fence before the old start is recorded.
- Arm the real admitted native-validation visual PNG job. Wait for `restore_fault_ready`, which follows actual process-start ACK, committed binary, uploaded probe and stopped renewals. Record the exact event and database deadline. Check exactly one recorded start/charge and no published asset. Abort the gate if setup consumed too much of its original budget; do not extend or recreate that accepted operation to hide expiry.

The private fixture helper is `packages/services/scripts/gates/qualified-restore-native-fixture.ts prepare`. Run it only after all timing/image/deployment preflight is complete: its actual domain admission starts the original ten-minute clock. Set `RESTORE_FIXTURE_JOURNAL` to the private precreated `{version:1,runId,inputKey,inputBytes,inputSha256}` journal and `RESTORE_FIXTURE_INVOCATION` to a new absolute private file. The helper reads the existing fixed auth/settings files under `/tmp/narriflow-serverless-control-keys`, derives the actual SQL actor/brand scope, and uses an actual SDK R2 HEAD with a ten-second timeout. No SourceBlob is fabricated. The PNG key must be under the actual brand-owner `visual-assets` prefix and end in `/restore-<runId>/source.png`.

### Optional regional archive utilities

The operator's separate regional timing preflight restored the actual 161-migration archive into a new disposable database in 26.670737 seconds. This is not qualified native-gate acceptance. Its PostgreSQL 18.6 Debian image needed the actual trusted Homebrew public CA bundle, whose SHA must be recorded, for Neon's current chain. No TLS verification is disabled.

Before admitting the native job, create one fifteen-minute Sandbox in the existing `narriflow-restore-operator-gates` app, image `im-eLOXuxnLewD81EngzOgXFy`, region `us-east`, without an explicit cloud-provider override. It receives only a temporary operator PG secret for the exact candidate and public CA file. Keep product media/fault functions restricted from Modal SDK access and database-free. Record the private mode-0600 journal with exactly `{version:1,runId,sandboxId,appName,appId,imageId,expectedHost,expectedDatabase,caBundleSha256,createdAt,expiresAt}`. The lifetime is at most 900 seconds and must cover the original accepted native deadline. Tags must contain `purpose:qualified-restore`, the same `runId`, exact `imageId`, and `caBundleSha256`.

Set both `RESTORE_OPERATOR_SANDBOX_ID` and `RESTORE_OPERATOR_JOURNAL` in the private operator environment file. The existing `qualified-restore-candidate.ts dump` and `restore` commands then use `qualified_restore_operator.py` through the installed Modal 1.6.3 SDK Python. With neither variable, the Mac libpq backend remains selected; a partial or malformed selection is refused. All source/proof/epoch/deadline checks still run in the original helper.

The adapter creates no Sandbox, app, secret or product dispatch. It looks up the existing exact app, selects only its run-tagged exact Sandbox, verifies tags/image/CA hash, and permits only literal `pg_dump` or transactional `pg_restore` arguments. It rechecks the regional host/database/version/TLS settings and verifies the public CA file bytes. Dumps use one fixed per-run private file. The actual downloaded bytes are written to the reserved local mode-0600 file and hashed for normal attestation. Restore uploads those exact attested local bytes and verifies their SHA before the fixed utility runs. The SDK child receives no DSN, R2 key or executor-control credential. Version, CA hash, byte hash and finite utility timing are safe output facts.

The local caller and remote utility are both bounded by the unchanged original deadline with a thirty-second reserve. On timeout or ambiguous SDK failure keep all consumers fenced; confirm the exact regional process is stopped or terminate its Sandbox before retrying or changing reference state. Never infer rollback from a lost caller alone. Destroy the privileged Sandbox after success or failure; retaining its metadata journal is not permission to reuse it after expiry.

The installed SDK and official [Sandbox filesystem](https://modal.com/docs/guide/sandbox-files) and [exec](https://modal.com/docs/guide/sandbox-spawn) interfaces were checked. Local guard and controlled SDK-port tests do not establish deployed backend or whole-gate latency acceptance.

```sh
bun --no-env-file --env-file="$OPERATOR_ENV" packages/services/scripts/gates/qualified-restore-native-fixture.ts prepare
```

It briefly opens only closed epoch 5 for actual `NativeValidationService.admit`, deliberately fails initial registration without an ACK, closes admission in `finally`, and calls actual `prepareExecution`. It writes only `{reference,attemptToken}` to the mode-0600 invocation file and stores the real job/deadline/ETag/pending DIDs plus the observed configured lean-image fingerprint in the private fixture journal. Its stdout contains only setup status. It creates no owner, process start or charge and signs no grant. SIGINT/SIGTERM also closes temporary admission; a hard kill cannot run process hooks, so the operator must independently inspect closed admission before snapshot/fence. The ordinary Core acquire wake may later register a duplicate, which must start nothing after the manual fault owner acquires.

## Execute the qualified sequence

The operator supplies a fresh `OPERATOR_ENV`, `RESTORE_CONFIG`, `RUN_DIR` and `DID` as private absolute paths or exact recorded IDs. Private Sandbox creation and orchestration preflight must require the current closed epoch 5 and the new run UUID; the repository helper does not update those separate private scripts. The env file contains explicit `DIRECT_URL`, `API_ORIGIN` and `RESTORE_GATE_JOURNAL`; it contains no root dotenv fallback. Run from the repository root with pinned Bun on `PATH`.

1. Deploy the prepared fenced candidate, confirm its static no-store health/version, stop Cron and all cleanup/legacy consumers, and capture actual `stoppedAt`. Native/local/provider-capable Workflow entry and registration must refuse. The held native process may continue reading its single release key.

   ```sh
   bun --no-env-file --env-file="$OPERATOR_ENV" packages/services/scripts/execution-restore.ts fence --expected-epoch 5 --config "$RESTORE_CONFIG" > "$RUN_DIR/fence.json"
   ```

   The result must be closed source epoch 6. Drain issued SQL, DELETE, multipart-completion and other mutating HTTP. Record actual `writesDrainedAt`. Preserve continuous quiescence until metadata has rebound; there can be no epoch-6 dispatch or unknown tail. Do not release the old probe yet.

2. Write the private gate journal with exactly these fields, taking IDs and the command hash from the real ready event, deadline from its accepted job and version from the fenced deployment:

   ```json
   {"version":1,"runId":"<UUID>","jobId":"<UUID>","dispatchId":"<old modal DID>","attemptToken":"<old UUID>","artifactId":"<held probe UUID>","commandSha256":"<ready command hash>","operationDeadlineAt":"<original UTC ISO timestamp>","fencedVersion":"<exact version>","snapshotPath":"/private/run/snapshot.dump","proofPath":"/private/run/proof.json","refusalPath":"/private/run/refusal.json"}
   ```

   ```sh
   bun --no-env-file --env-file="$OPERATOR_ENV" packages/services/scripts/gates/qualified-restore-candidate.ts dump > "$RUN_DIR/capture.json"
   ```

   This uses actual libpq 18.6 `pg_dump --format=custom --compress=0`, refuses an existing final file, and checks the exact target, observed PostgreSQL major, fenced version, closed epoch 6, absence of later dispatches, actual old start, uncommitted probe, committed binary and remaining original budget. Its safe capture output includes the actual server version/number, selected utility/version, utility timeout/elapsed milliseconds and measured archive SHA. Utility failure emits only safe timing/version metadata, without child stderr, credentials or snapshot contents. Keep the archive private. Retain stop/fence/drain/capture observations in the audit bundle.

3. Write the normal strict quiescence JSON using actual ordered UTC observations, including `capturedAt` from the completed dump and a later `verifiedAt`. Compute `evidenceSha256` from the real private audit-bundle bytes. No template timestamp is proof of a drain.

   ```sh
   bun --no-env-file --env-file="$OPERATOR_ENV" packages/services/scripts/execution-restore.ts attest --snapshot "$RUN_DIR/snapshot.dump" --quiescence "$RUN_DIR/quiescence.json" --quiescence-evidence "$RUN_DIR/drain-evidence.tar" --proof-out "$RUN_DIR/proof.json" --config "$RESTORE_CONFIG" > "$RUN_DIR/attest.json"
   bun --no-env-file --env-file="$OPERATOR_ENV" packages/services/scripts/gates/qualified-restore-candidate.ts restore > "$RUN_DIR/restore.json"
   ```

   The helper validates the snapshot bytes, migration checksums, exact fenced Worker and current source proof **before** destructive work. It disconnects SQL, checks `pg_restore` 18.6 against the observed target major, then runs actual `pg_restore --clean --if-exists --single-transaction --exit-on-error --no-owner --no-privileges` against that same exact private database. It rechecks the target version, restored source proof and original native facts, and records safe utility/server version evidence. A failure stops here. It never creates another database, migrates, opens admission or fabricates restore history.

4. Still fenced, begin the one admitted restore:

   ```sh
   bun --no-env-file --env-file="$OPERATOR_ENV" packages/services/scripts/execution-restore.ts begin --expected-epoch 6 --fence-above-epoch 6 --proof "$RUN_DIR/proof.json" --snapshot "$RUN_DIR/snapshot.dump" --config "$RESTORE_CONFIG" > "$RUN_DIR/begin.json"
   bun --no-env-file --env-file="$OPERATOR_ENV" packages/services/scripts/execution-restore.ts inspect --dispatch-id "$DID" --config "$RESTORE_CONFIG"
   ```

   Follow the exact initial DID from begin and each committed `continue` receipt's last DID, which is its next `rs2` page. Missing receipts are pending execution, not permission to skip a page. Persist every inspection. Stop on the exact `metadataReady:true` redispatch boundary. Earlier metadata registration may report pending for this intentionally fenced continuation; its ledger and preceding receipt must exist. Confirm old Generic authority is superseded, the job now has epoch 7/new generation/unowned state, count 1, unchanged deadline, and cleared unpublished partial pointers. Do not reopen database admission.

5. Deploy the prepared **closed** candidate with Cron still empty. Verify closed no-store health, then resume exactly that pending boundary:

   ```sh
   bun --no-env-file --env-file="$OPERATOR_ENV" packages/services/scripts/execution-restore.ts resume --dispatch-id "$DID" --config "$RESTORE_CONFIG" > "$RUN_DIR/resume.json"
   ```

   Resume validates current authority and closed health, confirms the exact boundary registration if needed, and describes/restarts only its deterministic instance. It creates no new epoch or cursor. If its existing delivery backoff is not yet due, inspect and retry that same DID. Follow all final receipt continuations to `complete`; accepted product DIDs must be independently acknowledged. Observe the real new owner/start and ordinary PNG completion. Neither Workflow replay nor a cached step can add a start or charge.

6. Replace only the original run's release JSON with the same values and `release:true` before its bounded hold expires. The old Function must authenticate freshly over the unchanged old fence/probe body and report `restore_fault_refused`, source 5, target 7, `refusal:superseded` and the same command hash. Save that exact report to the journal's refusal path. A transport error, hold expiry or accepted stale commit fails the gate.

   ```sh
   bun --no-env-file --env-file="$OPERATOR_ENV" packages/services/scripts/gates/qualified-restore-candidate.ts verify > "$RUN_DIR/verified.json"
   ```

   Verification requires closed epoch 7, original deadline unchanged and completion before it, exactly two actual starts, total charged count 2, old owner revoked/superseded, old held probe still uncommitted, one completed successor and exactly one published current asset from its committed binary. It also matches the refusal report to the frozen ready-event command/IDs. The operator retains the actual signed HTTP/native logs as external evidence; a report alone is not a replacement for observing the API call.

7. Keep the gate failed until all recorded page/registration/HEAD/native proofs pass. Stop the temporary fault Function. Retire only its exact journaled source, assigned artifacts, release key and any planned capsules after active grants/MPUs/HTTP drain, through the existing known-key cleanup path. Do not list the bucket or infer orphans from the private database. No automatic reopen or shared cutover follows this gate.

Immediately before each archive process starts, its timeout is `min(180000, originalDeadline - now - 30000)` milliseconds. A timeout below one second is refused. Each utility therefore has at most three minutes and preserves thirty seconds of the already accepted operation budget. The helper does not change the job deadline, the fault hold or any executor permission. It does not promise that deployments or all pages finish in time. If they do not, retain the failed evidence and use a separately admitted new gate later. Local evidence currently proves guard behavior and production restore invariants; actual qualified dump/restore and stale cloud refusal remain operator-run acceptance. All database access stays in operator tooling and the API; product Modal and laptop executors remain database-free.
