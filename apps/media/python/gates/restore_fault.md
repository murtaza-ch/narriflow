# Quiesced restore fault driver

This isolated gate runs the current native PNG validator, uploads its measured PNG and evidence through the real assigned multipart protocol, then holds the final `probe` commit. The normal executor remains unchanged. This driver is deliberately untrusted after it stops its owner renewal. It proves that the server rejects an old owner independently of the executor's local lease checks.

The operator owns all cloud actions, the qualified snapshot proof, and cleanup. This module neither deploys a Function nor changes a database, admission state, signing keys, or storage objects outside normal assigned uploads. It takes an already accepted `native_validation` invocation with a visual PNG input no larger than 1 MiB. No paid provider, database credential, or long-lived storage credential enters the invocation.

Create one private key `execution/restore-gates/<run UUID>/release.json`. Its short-lived presigned HTTPS GET must use the selected account's R2 S3 origin, expire within 600 seconds, and name that exact key. The driver never logs the URL or nonce. The initial JSON has exactly these fields:

```json
{"version":1,"runId":"<run UUID>","nonce":"<64 random lowercase hex characters>","sourceEpoch":2,"targetEpoch":4,"release":false}
```

The epoch values are explicit operator facts. The source is the invocation's old epoch; the target is the intended restored epoch. A separate pre-snapshot fence can make the target more than one above the invocation's epoch. The key and nonce are unique to this run.

The temporary isolated Function supplies explicit existing executor-control credentials to the normal client constructor. It can call:

```python
from apps.media.python.gates.restore_fault import (
    RestoreCommitFaultClient, RestoreFaultGate, run_restore_fault,
)

client = RestoreCommitFaultClient(
    gate=RestoreFaultGate(run_id, nonce, source_epoch, target_epoch, release_url),
    notify=write_safe_gate_event,
    origin=api_origin, key_id=control_key_id, key=control_key,
)
report = await run_restore_fault(client, invocation)
```

`write_safe_gate_event` receives only a run ID, dispatch ID, attempt token, artifact ID, old epoch, and command SHA-256. It receives no request body, signed URL, key, or nonce. `restore_fault_ready` is emitted only after the actual native process-start ACK and both uploads complete, the binary artifact commits, and the renewal thread stops. The old final evidence command has not yet been sent.

At that point follow the qualified quiesced snapshot procedure in the main cutover runbook. Confirm the recorded start and charged count, revoke old authority, fence HTTP and consumers, drain issued cleanup requests, capture the required snapshot/proof, restore metadata through `rs2`, and inspect the phase boundary. Resume normal registration only in closed mode after rebinding. The gate's local hold never extends the domain's original ten-minute deadline. It is capped at 300 seconds by default, can be explicitly set to at most 540 seconds, and is further bounded by the invocation's remaining original operation budget. If the operator cannot finish in that interval, the gate fails without sending the commit.

After current-generation redispatch, replace only that run's release JSON with the same values and `release:true`. Polling is at most once per second, reads at most 4 KiB, follows no redirects, and never queries SQL. A matching release causes fresh authentication over the complete unchanged old fence/artifact command. Only a signed `superseded` disposition passes. An accepted stale commit, transport uncertainty, expired hold, or mismatched nonce/epoch is a gate failure. The final safe report is `restore_fault_refused`.

The operator must independently verify the old probe did not publish, old charged history stayed unchanged, the restored generation completed once, and all exact owned gate keys are retired after grants and requests drain. The local test uses real PNG decoding, actual child startup, conditional loopback source download, measured SHA/bytes, and controlled control/storage ports. It does not establish deployed restore acceptance.

Run that local proof with the pinned Bun on `PATH` and Python 3.13.5:

```sh
PYTHONPATH=apps/media/python python3.13 -m unittest apps.media.python.tests.test_restore_fault
```
