For the final deployed Executor authority and 45-minute regional transfer gate, use [the regional runbook](executor-r2-transfer.md). The local storage probe below records the earlier injected-authority evidence.

The native R2 transfer gate uses the requested development account and only fresh `execution/platform-gates` objects. Its local TypeScript service holds R2 credentials and supplies scoped grants. Python runs with a stripped environment. It measures memory and confirmed transfer bytes, verifies a still-live UploadPart grant cannot overwrite a completed object, pins the full source with conditional ranges, then overwrites only its own source to prove a failed condition aborts an unpublished pin.

Start the grant service in one terminal with a new private directory:

```sh
export R2_NATIVE_GATE_DIR="$(mktemp -d /tmp/narriflow-r2-gate.XXXXXX)"
bun --env-file apps/api/.env packages/services/scripts/r2-native-grant-gate.ts
```

In another terminal, set the same directory value and run the 17 MiB smoke. The media project's pinned Python environment must already be installed.

```sh
env -i PATH="$PATH" R2_NATIVE_GATE_DIR="$R2_NATIVE_GATE_DIR" PYTHONPATH="$PWD/apps/media/python" \
  apps/media/.venv/bin/python apps/media/python/gates/r2_large_transfer.py
```

Append `--bytes 10737418240` for the real 10 GiB gate. The generated sparse source has markers at both ends. Memory stays bounded by four 16 MiB part slots. Each run writes a safe `report.json`; `ready.json` and `private-state.json` are private local control/recovery files and must not be logged or committed. Stop the service after cleanup. A nonempty recovery journal prevents starting another service over an unfinished run.

The four-hour gate deadline measures transfer/provider behavior. This fixture has no live domain authority or production HTTP admission and does not prove the 45-minute fetch lease. Uncertain completion is retained for reconciliation and never triggers an abort or deletion.
