# Private candidate qualified restore gate

Prepared locally, not executed against Cloudflare, Modal, R2 or the candidate database. The target is exclusively `ep-wispy-field-b5wyn9o3.c-7.us-east-2.aws.neon.tech / serverless_pipeline_gates / public`. Shared development and arbitrary PITR are excluded.

The expected sequence is an actual native start in epoch 2, a quiescence fence to epoch 3, a real custom-format database dump and restore of that same private database, proof-bound begin to epoch 4, metadata rebinding while fenced, and explicit closed-mode redispatch. The stale final probe must return `superseded`; a current invocation must publish once. Two actual starts consume two charges. The stale callback consumes zero. Nothing resets the original ten-minute absolute deadline.

## Prepare before starting the clock

- Merge the native partial-pair restore correction and SQL migration `20261101060000_execution_native_restore`, and the explicit metadata/redispatch boundary fix. Apply all candidate migrations and deploy matching code before accepting the test job. Do not migrate during its ten-minute budget.
- Prepare both fenced and closed candidate deployments with `triggers.crons: []`. Verify the account, Worker, Workflow names, Hyperdrive database and storage bindings from the actual deployment configuration. `API_ORIGIN` is that explicit candidate origin. A health response alone cannot prove its database binding.
- Check pinned Bun 1.3.6, Python 3.13.5, PostgreSQL 17 binaries at `/opt/homebrew/opt/postgresql@17/bin`, Wrangler authentication, and the exact direct `verify-full` connection. Keep this operator environment file and all dumps/proofs mode 0600 in a private mode-0700 directory.
- Prepare one tiny PNG, a fresh private release key, and its short-lived GET. The release JSON freezes sourceEpoch 2 and targetEpoch 4 with a fresh nonce and starts with `release:false`. Do not print the URL, nonce or keys. Explicitly choose the fault driver's hold bound, at most 540 seconds and always shorter than the remaining original deadline. Prebuild the isolated fault Function/image.
- Use explicit private fixture composition. Actual domain admission/preparation creates the old epoch-2 job, pending Modal DID and real attempt. Keep that original Modal registration pending without a fake ACK, and manually invoke only the fault wrapper with its actual prepared reference/token. This original transport setup is not public-admission acceptance evidence. The restored epoch-4 invocation uses ordinary deployed Workflows/bridge/validator. The wrapper receives only existing control credentials, immutable invocation metadata and the one-key release GET, never database credentials or long-lived R2 credentials. No production selector is added. Inspect any duplicate registration caused by the real acquire wake; an already-owned duplicate must start nothing.
- The actual old acquire/start/upload calls require the candidate HTTP in `closed` mode first, with public intake and Cron still stopped. A `fenced` API refuses these calls. Switch to the prepared fenced deployment only after the ready event; do not advance the database fence before the old start is recorded.
- Arm the real admitted native-validation visual PNG job. Wait for `restore_fault_ready`, which follows actual process-start ACK, committed binary, uploaded probe and stopped renewals. Record the exact event and database deadline. Check exactly one recorded start/charge and no published asset. Abort the gate if setup consumed too much of its original budget; do not extend or recreate that accepted operation to hide expiry.

## Execute the qualified sequence

The operator supplies `OPERATOR_ENV`, `RESTORE_CONFIG`, `RUN_DIR` and `DID` as private absolute paths or exact recorded IDs. The env file contains explicit `DIRECT_URL`, `API_ORIGIN` and `RESTORE_GATE_JOURNAL`; it contains no root dotenv fallback. Run from the repository root with pinned Bun on `PATH`.

1. Deploy the prepared fenced candidate, confirm its static no-store health/version, stop Cron and all cleanup/legacy consumers, and capture actual `stoppedAt`. Native/local/provider-capable Workflow entry and registration must refuse. The held native process may continue reading its single release key.

   ```sh
   bun --no-env-file --env-file="$OPERATOR_ENV" packages/services/scripts/execution-restore.ts fence --expected-epoch 2 --config "$RESTORE_CONFIG" > "$RUN_DIR/fence.json"
   ```

   The result must be closed source epoch 3. Drain issued SQL, DELETE, multipart-completion and other mutating HTTP. Record actual `writesDrainedAt`. Preserve continuous quiescence until metadata has rebound; there can be no epoch-3 dispatch or unknown tail. Do not release the old probe yet.

2. Write the private gate journal with exactly these fields, taking IDs and the command hash from the real ready event, deadline from its accepted job and version from the fenced deployment:

   ```json
   {"version":1,"runId":"<UUID>","jobId":"<UUID>","dispatchId":"<old modal DID>","attemptToken":"<old UUID>","artifactId":"<held probe UUID>","commandSha256":"<ready command hash>","operationDeadlineAt":"<original UTC ISO timestamp>","fencedVersion":"<exact version>","snapshotPath":"/private/run/snapshot.dump","proofPath":"/private/run/proof.json","refusalPath":"/private/run/refusal.json"}
   ```

   ```sh
   bun --no-env-file --env-file="$OPERATOR_ENV" packages/services/scripts/gates/qualified-restore-candidate.ts dump > "$RUN_DIR/capture.json"
   ```

   This uses actual PostgreSQL 17 `pg_dump --format=custom --compress=0`, refuses an existing final file, and checks the exact target, fenced version, closed epoch 3, absence of later dispatches, actual old start, uncommitted probe, committed binary and remaining original budget. It prints only safe capture metadata and the measured archive SHA. Keep the archive private. Retain stop/fence/drain/capture observations in the audit bundle.

3. Write the normal strict quiescence JSON using actual ordered UTC observations, including `capturedAt` from the completed dump and a later `verifiedAt`. Compute `evidenceSha256` from the real private audit-bundle bytes. No template timestamp is proof of a drain.

   ```sh
   bun --no-env-file --env-file="$OPERATOR_ENV" packages/services/scripts/execution-restore.ts attest --snapshot "$RUN_DIR/snapshot.dump" --quiescence "$RUN_DIR/quiescence.json" --quiescence-evidence "$RUN_DIR/drain-evidence.tar" --proof-out "$RUN_DIR/proof.json" --config "$RESTORE_CONFIG" > "$RUN_DIR/attest.json"
   bun --no-env-file --env-file="$OPERATOR_ENV" packages/services/scripts/gates/qualified-restore-candidate.ts restore > "$RUN_DIR/restore.json"
   ```

   The helper validates the snapshot bytes, migration checksums, exact fenced Worker and current source proof **before** destructive work. It disconnects SQL, then runs actual `pg_restore --clean --if-exists --single-transaction --exit-on-error --no-owner --no-privileges` against that same exact private database. It rechecks the restored source proof and original native facts. A failure stops here. It never creates another database, migrates, opens admission or fabricates restore history.

4. Still fenced, begin the one admitted restore:

   ```sh
   bun --no-env-file --env-file="$OPERATOR_ENV" packages/services/scripts/execution-restore.ts begin --expected-epoch 3 --fence-above-epoch 3 --proof "$RUN_DIR/proof.json" --snapshot "$RUN_DIR/snapshot.dump" --config "$RESTORE_CONFIG" > "$RUN_DIR/begin.json"
   bun --no-env-file --env-file="$OPERATOR_ENV" packages/services/scripts/execution-restore.ts inspect --dispatch-id "$DID" --config "$RESTORE_CONFIG"
   ```

   Follow the exact initial DID from begin and each committed `continue` receipt's last DID, which is its next `rs2` page. Missing receipts are pending execution, not permission to skip a page. Persist every inspection. Stop on the exact `metadataReady:true` redispatch boundary. Earlier metadata registration may report pending for this intentionally fenced continuation; its ledger and preceding receipt must exist. Confirm old Generic authority is superseded, the job now has epoch 4/new generation/unowned state, count 1, unchanged deadline, and cleared unpublished partial pointers. Do not reopen database admission.

5. Deploy the prepared **closed** candidate with Cron still empty. Verify closed no-store health, then resume exactly that pending boundary:

   ```sh
   bun --no-env-file --env-file="$OPERATOR_ENV" packages/services/scripts/execution-restore.ts resume --dispatch-id "$DID" --config "$RESTORE_CONFIG" > "$RUN_DIR/resume.json"
   ```

   Resume validates current authority and closed health, confirms the exact boundary registration if needed, and describes/restarts only its deterministic instance. It creates no new epoch or cursor. If its existing delivery backoff is not yet due, inspect and retry that same DID. Follow all final receipt continuations to `complete`; accepted product DIDs must be independently acknowledged. Observe the real new owner/start and ordinary PNG completion. Neither Workflow replay nor a cached step can add a start or charge.

6. Replace only the original run's release JSON with the same values and `release:true` before its bounded hold expires. The old Function must authenticate freshly over the unchanged old fence/probe body and report `restore_fault_refused`, source 2, target 4, `refusal:superseded` and the same command hash. Save that exact report to the journal's refusal path. A transport error, hold expiry or accepted stale commit fails the gate.

   ```sh
   bun --no-env-file --env-file="$OPERATOR_ENV" packages/services/scripts/gates/qualified-restore-candidate.ts verify > "$RUN_DIR/verified.json"
   ```

   Verification requires closed epoch 4, original deadline unchanged and completion before it, exactly two actual starts, total charged count 2, old owner revoked/superseded, old held probe still uncommitted, one completed successor and exactly one published current asset from its committed binary. It also matches the refusal report to the frozen ready-event command/IDs. The operator retains the actual signed HTTP/native logs as external evidence; a report alone is not a replacement for observing the API call.

7. Keep the gate failed until all recorded page/registration/HEAD/native proofs pass. Stop the temporary fault Function. Retire only its exact journaled source, assigned artifacts, release key and any planned capsules after active grants/MPUs/HTTP drain, through the existing known-key cleanup path. Do not list the bucket or infer orphans from the private database. No automatic reopen or shared cutover follows this gate.

The helper enforces the original job deadline, a finite 60-second maximum per database utility and a minimum remaining write margin. It does not promise that deployments or all pages finish in time. If they do not, retain the failed evidence and use a separately admitted new gate later. Local evidence currently proves guard behavior and production restore invariants; actual dump/restore and stale cloud refusal remain operator-run acceptance.
