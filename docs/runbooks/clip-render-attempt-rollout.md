# Clip Render Attempt deployment and recovery

Clip Render Attempt is the render execution path. It runs as the Modal `render_group` Function (`apps/media/modal_app.py`), reached through a signed executor-control acquisition. The Render Run Workflow waits without a lease or a container; there is no worker pool to start or drain.

Narriflow is pre-production. Deploy the API Worker, services and media image from the same revision after applying migrations.

## Deployment

1. Close admission (`ADMISSION_STATE`) and wait for active render attempts to settle or lose their leases.
2. Apply the complete migration chain with `bun --cwd packages/db run prisma:migrate:deploy`, then regenerate the client with `bun --cwd packages/db run prisma:generate`.
3. Verify the adapters and Workflow Run lifecycle:

   ```sh
   bun test apps/media/src/render-config.test.ts apps/media/src/worker-process.test.ts apps/media/src/render-runtime-adapters.test.ts apps/media/src/render-diagnostic-adapter.test.ts apps/media/src/composition-ffmpeg-adapter.test.ts packages/services/src/r2-storage.test.ts
   bun run test:workflow:db
   ```

   For the R2 contract test, configure R2 credentials and an isolated prefix:

   ```sh
   R2_CONTRACT_TEST_PREFIX=tests/narriflow-render bun --env-file=apps/api/.dev.vars test packages/services/src/r2-storage.test.ts
   ```

   This creates and removes UUID-scoped objects below the test prefix.
4. Deploy the media image from an immutable tracked archive and run `verify_render_runtime` (see [the media README](../../apps/media/README.md)). Compare golden output with the [render verification runbook](render-hardening.md); local macOS parity does not establish Linux parity.
5. Reopen admission. `render-config.ts` validates render settings at start; `WORKER_STORAGE_TIMEOUT_MS` bounds each render storage operation.
6. Verify optional assets present, absent, corrupt, expired, and unavailable. Cover vertical and horizontal talking-head footage, Screen/PiP, Split, Fit, and audio-only inputs with fresh and unavailable analysis. Use the [composition operations guide](clip-composition-plan-rollout.md) for shared preview/export checks.
7. Observe representative `completed`, `partial`, `requeued`, and `failed` runs. Workflow Events with `notificationRequired = true AND notificationDeliveredAt IS NULL` must drain independently of render state. Inspect `workflow_attempt_lost`, cleanup, follow-up, and reconciliation diagnostics.

## Pause and recovery

1. Close admission and let active leases settle or expire before replacing the media image or Worker.
2. Keep admission closed while diagnosing render failures.
3. Preserve Render Work Sets, attempt-unique objects, and committed Workflow Events. Keep the event dispatcher available until notification-required events have delivery acknowledgements.
4. Fix and verify the current implementation, then reopen. Do not restore obsolete render helpers, compatibility readers, or a second renderer. If a local fixture uses an obsolete shape, reset that fixture with processes stopped.

## Recovery drills

- **Abandoned attempt:** stop one `render_group` call after claim, let the
  Workflow Run lease expire, and confirm the maintenance chain
  (`redispatch_groups`) or the Workflow's own wake starts a new Workflow Attempt
  that resumes only retryable/interrupted variants.
- **Notification handoff:** fail the notification handoff after terminal event
  commit, run the Workflow Event dispatcher again, and confirm the send-once
  ledger is reused before `notificationDeliveredAt` is recorded.
- **Follow-up replay:** create a late pending variant, replay terminal
  settlement, and confirm only the `drain-<completed-run-id>` Workflow Run
  exists.
- **Orphaned objects:** attempt-unique render objects are removed through exact-key
  Media Cleanup obligations, with reference and hold rechecks. Never list a
  bucket and infer unreferenced media. Inspect the `MediaCleanupObligation`
  rows for the project; leave referenced and young objects alone.
