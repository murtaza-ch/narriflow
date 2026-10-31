# Transfer gate cleanup correction

The prior operator helper ran `createMediaCleanupControl` locally with a `register` callback that only appended IDs to an array. Every real cleanup claim creates a lease timer, so `pending.length` made a successful DELETE fail afterward with `gate_cleanup_obligation_pending`. More seriously, the callback returned without confirming that timer. This did not establish production cleanup's required confirmation before DELETE. Removing only the final `pending.length` check would hide the second defect.

The corrected cleanup phase performs no local DELETE. It keeps the exact known artifact keys, terminal-owner guard, grant and operation deadline grace, production hold checks and all database audit rows. Each artifact admits its existing cleanup intent through the production producer, which appends an `mc1` range containing exactly one known row. A gate-only Wrangler adapter registers those precise references on the configured candidate's Maintenance Workflow through `createExecutionDispatch`. Trigger ACK loss is resolved by describing the same deterministic instance ID. A different identity, unknown status, changed tuple, wake command or broader range cannot be acknowledged.

The deployed Worker now runs the production drain, creates the exact OperationDriver command, and confirms its own independent lease timer before storage I/O. No SQL transaction spans Wrangler or storage HTTP. The gate's remaining storage operations are HEAD and exact-prefix MPU verification. References and every registration result are recorded before/after delivery in the private `.cleanup-registration.json` history, bounded to 32 operator observations. Fixture and execution metadata remain in PostgreSQL.

Root must first inspect the exact existing intent state. The child has not invoked this path against the candidate or any cloud resource. Cleanup now requires the actual closed candidate config with no Cron schedules:

```sh
BUN=/tmp/narriflow-serverless-gates/bun-1.3.6/bun-darwin-aarch64/bun
"$BUN" --no-env-file --env-file=/tmp/narriflow-serverless-gates/pipeline-database.env \
  packages/services/scripts/executor-r2-transfer-gate.ts cleanup \
  --journal "$EXISTING_TRANSFER_JOURNAL" \
  --settings /tmp/narriflow-serverless-control-keys/candidate-worker-secrets.json \
  --expected-host ep-wispy-field-b5wyn9o3.c-7.us-east-2.aws.neon.tech \
  --epoch "$OBSERVED_CURRENT_EPOCH" \
  --config /tmp/narriflow-serverless-gates/candidate-163-closed.jsonc
```

The CLI accepts only the private target as before and checks actual closed Worker health. Root must also verify the selected config's Hyperdrive database binding; health alone does not establish that binding. Registration alone is not completion. An unfinished intent reports `cleanup:pending` for an explicit later observation with the same journal, without an idle polling loop or a new cleanup budget.

Once all exact intents are complete, the helper requires HEAD 404 and no exact-key MPU. It separately verifies that each intent's latest claim timer was acknowledged before completion with its exact `nf_dispatch_<DID>` destination. If the old push-only helper already deleted the objects, absence can still be proved, but an unacknowledged latest timer yields `verified_absent_prior_registration_unproved` and `passed:false` in the evidence. It does not retrospectively turn that deletion into deployed cleanup acceptance. A fresh pending known object is needed to establish that missing deployed behavior; do not recreate or alter historical rows to manufacture it.

Local verification uses pinned Bun 1.3.6. Seven fast tests pass with 30 assertions, including exact config/instance/tuple scope, lost ACK confirmation, rejected unknown status and rejected broad ranges. The existing cleanup authority suite passes 12 tests and 60 assertions on a fresh disposable schema in the dedicated localhost PostgreSQL database, with 163 migrations. Those tests preserve confirmed-timer-before-DELETE, unknown acceptance recovery, grant/reference holds and lost confirmation preventing DELETE. The operator entry typecheck, focused Biome and diff check pass. These are local checks; actual candidate registration, execution, absence and cleanup acceptance remain Root's work.
