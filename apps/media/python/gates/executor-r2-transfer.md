# Regional Executor transfer gate

Run only after the root operator confirms the final candidate Worker, isolated
Hyperdrive target and final Modal image. Preparation and local tests do not
constitute the live gate. Use the existing Neon Free project. No billing change
is required for R2 object bytes.

This gate measures a real 10 GiB upload and a full conditional pin through the
production signed control and transfer endpoints. Both physical invocations
have real 2700-second operation deadlines. Upload, pin and native checks must
also finish within the first invocation's remaining 2700-second budget.

The files contain synthetic markers and zeros. The native executor hashes all
bytes, R2 verifies part Content-MD5, the Worker reconciles the actual MPU part
inventory, and the pin independently rereads and hashes the complete source.
The source is deliberately not published as valid media. Each fixture ends
through the signed permanent `transfer_gate_complete` failure. The actual
source-domain validation pipeline is a separate gate.

## 1. Register the private native wrapper

The root operator adds this wrapper to the final gate app's `modal_app.py` and
deploys that app. Reuse its existing lean image, executor Secret and resource
constants. The native image gets no database or R2 credential.

```python
@app.function(image=lean_image, secrets=[executor_secret], max_containers=1,
              timeout=2700, restrict_modal_access=True, **LEAN_RESOURCES)
async def verify_executor_r2_transfer(invocation: dict, *, phase: str, source: dict | None = None) -> dict:
    from gates.executor_r2_transfer import run_executor_r2_transfer
    from narriflow_media.entrypoint import native_client
    runtime = _verify("lean")
    result = await run_executor_r2_transfer(invocation, phase=phase, source=source,
                                          client=native_client(os.environ))
    return {**result, "runtime": runtime}
```

Confirm the deployed gate Function uses the selected API origin, final lean
toolchain and 2 CPU / 4 GiB profile. Keep the product HTTP admission closed.
The root operator explicitly opens only the isolated database admission flag
for fixture construction. The CLI verifies that flag; it never changes it.

## 2. Prepare and invoke the upload

Create a private directory. Choose the current exact candidate hostname and
epoch from the root operator's verified readback. The database env must be the
private candidate file, with matching `DATABASE_URL` and `DIRECT_URL`.
The settings file is the existing private candidate Worker settings JSON.

```sh
mkdir -m 700 /tmp/narriflow-executor-r2-final
export GATE_JOURNAL=/tmp/narriflow-executor-r2-final/fixture.json
export GATE_DB_ENV=/tmp/narriflow-serverless-gates/pipeline-database.env
export GATE_SETTINGS=/tmp/narriflow-serverless-control-keys/candidate-worker-secrets.json
export GATE_HOST=REPLACE_WITH_VERIFIED_PRIVATE_NEON_HOST
export GATE_EPOCH=REPLACE_WITH_VERIFIED_EPOCH
export GATE_MODAL_PYTHON=/Users/murtaza/.local/share/uv/tools/modal/bin/python

bun --env-file="$GATE_DB_ENV" packages/services/scripts/executor-r2-transfer-gate.ts seed-upload \
  --journal "$GATE_JOURNAL" --settings "$GATE_SETTINGS" --expected-host "$GATE_HOST" --epoch "$GATE_EPOCH"

"$GATE_MODAL_PYTHON" apps/media/python/gates/run_executor_r2_transfer.py \
  --app narriflow-media-gates --phase upload \
  --arguments "$GATE_JOURNAL.upload-invocation.json" \
  --output /tmp/narriflow-executor-r2-final/upload.json
```

The journal records all intended fixture IDs before SQL mutation. A local seed
retry repairs those same IDs. Native invocation retries remain explicit. If
the Modal result is lost, inspect the known attempt and object first.
The caller enforces SDK 1.6.3 and the `murtazach275` Modal profile.

## 3. Bind the exact completed source and invoke the pin

Continue only if the upload report passed and enough combined budget remains.
`bind-pin` verifies its known ExecutionArtifact row and fresh R2 HEAD. It then
uses the actual Upload Session handoff and Ingest lifecycle to freeze the exact
source key, ETag, byte length, content type and Upload Session FK. It does not
construct a mutable pin payload or forge a media publication.

```sh
bun --env-file="$GATE_DB_ENV" packages/services/scripts/executor-r2-transfer-gate.ts bind-pin \
  --journal "$GATE_JOURNAL" --settings "$GATE_SETTINGS" --expected-host "$GATE_HOST" --epoch "$GATE_EPOCH" \
  --report /tmp/narriflow-executor-r2-final/upload.json

"$GATE_MODAL_PYTHON" apps/media/python/gates/run_executor_r2_transfer.py \
  --app narriflow-media-gates --phase pin \
  --arguments "$GATE_JOURNAL.pin-arguments.json" \
  --output /tmp/narriflow-executor-r2-final/pin.json

bun --env-file="$GATE_DB_ENV" packages/services/scripts/executor-r2-transfer-gate.ts status \
  --journal "$GATE_JOURNAL" --settings "$GATE_SETTINGS" --expected-host "$GATE_HOST" --epoch "$GATE_EPOCH"
```

Pass requires both reports to say `passed`, exactly 10737418240 object bytes in
each, equal whole-object SHA-256 values and combined elapsed time at most 2700
seconds. Each native phase verifies a cached UploadPart URL returns 404 after
MPU completion and a fresh signed request for another part is refused by the
terminal domain owner. SQL status must show one charged start per job, terminal
failed test fixtures and no committed source-video artifact. Record each phase's
RSS and traced allocation peak. Cgroup memory metrics are container-lifetime
upper bounds and can include a previous invocation in a reused container.

An uncommitted assigned artifact from another Project is not a normal browser
upload source. Its cleanup hold does not become longer solely because this
test creates an Upload Session for it. The combined deadline keeps this fixture
within the first object's real hold. No hold model or deadline is extended.

## 4. Confirm exact cleanup after grants drain

Cleanup is a separate phase after the maximum actual artifact grant and
operation deadline plus the production 120-second drain. It is outside the timed
transfer measurement. `cleanup` returns a `waiting` timestamp until that bound;
invoke it again after the timestamp. It uses production cleanup obligations,
claims, holds and exact-key storage deletion, then performs fresh R2 HEAD and
exact-key MPU inventory checks.

```sh
bun --env-file="$GATE_DB_ENV" packages/services/scripts/executor-r2-transfer-gate.ts cleanup \
  --journal "$GATE_JOURNAL" --settings "$GATE_SETTINGS" --expected-host "$GATE_HOST" --epoch "$GATE_EPOCH"
```

Retain `fixture.json.cleanup.json`. Completion requires every known object to
return HEAD 404, every exact-key MPU inventory to be empty and every admitted
cleanup obligation to be completed. Completed objects remain intact after an
uncertain upload-complete acknowledgement until this reconciliation. Failed
and abandoned runs use the same exact-ID cleanup phase. Metadata rows remain
for audit and are removed by the root operator's later fixture retirement.

## Local preparation checks

```sh
bun run --cwd packages/services typecheck
bun test packages/services/scripts/executor-r2-transfer-gate.test.ts
PYTHONPATH=apps/media/python python3 -m unittest discover \
  -s apps/media/python/tests -p test_executor_r2_transfer_gate.py
```

These checks use no candidate database, R2 object or Modal invocation.
