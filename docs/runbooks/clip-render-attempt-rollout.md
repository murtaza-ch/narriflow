# Clip Render Attempt rollout and recovery

Clip Render Attempt is the only render execution path. Render claiming defaults to disabled unless `WORKER_CLIP_RENDER_ATTEMPT_ENABLED=1`. Disabling it pauses new render claims; it does not select another renderer.

Narriflow is pre-production. Deploy web, services, and workers from the same revision after applying migrations. Drain existing render workers before replacing them.

## Deployment

1. Stop processes that poll `clip_rendering` and wait for active render attempts to settle or lose their leases.
2. Apply the complete migration chain with `bun --cwd packages/db run prisma:migrate:deploy`, then regenerate the client with `bun --cwd packages/db run prisma:generate`.
3. Verify the adapters and Workflow Run lifecycle:

   ```sh
   bun test apps/worker/src/render-config.test.ts apps/worker/src/worker-process.test.ts apps/worker/src/render-runtime-adapters.test.ts apps/worker/src/render-diagnostic-adapter.test.ts apps/worker/src/tasks/clip-render-attempt.test.ts apps/worker/src/tasks/clip-render-attempt-core-paths.test.ts apps/worker/src/render-object-reconciler.test.ts packages/services/src/r2-storage.test.ts packages/services/src/notification.service.test.ts
   bun run test:workflow:db
   ```

   For the R2 contract test, configure worker R2 credentials and an isolated prefix:

   ```sh
   R2_CONTRACT_TEST_PREFIX=tests/narriflow-render bun --env-file=apps/worker/.env test packages/services/src/r2-storage.test.ts --test-name-pattern 'R2 object adapter uploads'
   ```

   This creates and removes UUID-scoped objects below the test prefix.
4. Run `bun --cwd apps/worker run reconcile:render-objects --project <project-uuid>` in dry mode. Exit `0` is clean, `1` reports dry-run orphans, `2` reports per-object deletion failures, and `3` means reconciliation was unsafe or unavailable. Review orphan identifiers before any explicit deletion.
5. Set `WORKER_CLIP_RENDER_ATTEMPT_ENABLED=1` and start the worker pool. Verify `/health` reports `render.enabled: true`. Startup validates render settings; `WORKER_STORAGE_TIMEOUT_MS` bounds each render and reconciliation storage operation.
6. Verify optional assets present, absent, corrupt, expired, and unavailable. Cover vertical and horizontal talking-head footage, Screen/PiP, Split, Fit, and audio-only inputs with analysis enabled and disabled. Use the [composition operations guide](clip-composition-plan-rollout.md) for shared preview/export checks.
7. Observe representative `completed`, `partial`, `requeued`, and `failed` runs. Workflow Events with `notificationRequired = true AND notificationDeliveredAt IS NULL` must drain independently of render state. Inspect `workflow_attempt_lost`, cleanup, follow-up, and reconciliation diagnostics.

## Pause and recovery

1. Stop render workers and let active leases settle or expire before replacing the pool.
2. Set `WORKER_CLIP_RENDER_ATTEMPT_ENABLED=0` and restart if other worker loops must continue while rendering is paused.
3. Preserve Render Work Sets, attempt-unique objects, and committed Workflow Events. Keep the event dispatcher available until notification-required events have delivery acknowledgements.
4. Fix and verify the current implementation, then re-enable render claiming. Do not restore obsolete render helpers, compatibility readers, or a second renderer. If a local fixture uses an obsolete shape, reset that fixture with processes stopped.

## Recovery drills

- **Abandoned attempt:** terminate one render worker after claim, let the
  Workflow Run lease expire, run the existing lifecycle reaper, and confirm a
  new Workflow Attempt resumes only retryable/interrupted variants.
- **Notification handoff:** fail the notification handoff after terminal event
  commit, run the Workflow Event dispatcher again, and confirm the send-once
  ledger is reused before `notificationDeliveredAt` is recorded.
- **Follow-up replay:** create a late pending variant, replay terminal
  settlement, and confirm only the `drain-<completed-run-id>` Workflow Run
  exists.
- **Orphan scan:** first run the project command without `--delete`. Review all
  identifiers and wait beyond the 24-hour safety age. Destructive cleanup is
  explicit and project-scoped:
  `bun run --cwd apps/worker reconcile:render-objects --project <project-uuid> --delete`.
  Re-run dry mode and confirm referenced and young objects remain protected.
