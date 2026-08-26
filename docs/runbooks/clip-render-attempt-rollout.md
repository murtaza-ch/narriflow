# Clip Render Attempt rollout and recovery

The Clip Render Attempt path is intentionally drain-gated. Old and new render
workers must never claim protocol-version-2 `clip_rendering` Workflow Runs at
the same time. The additive schema remains in place during rollback.

## Rollout

1. **Migrate.** Apply the additive schema before deploying readers:
   `bun run --cwd packages/db prisma:migrate:deploy`. Confirm
   `20260815000000_render_work_sets` and
   `20260817000000_render_settlement_notifications` are applied.
2. **Deploy dark.** Deploy the upgraded services, event dispatcher, worker
   adapters, and reconciliation command with
   `WORKER_CLIP_RENDER_ATTEMPT_ENABLED=0`. Existing render workers may remain
   active during this step; upgraded workers do not claim render runs. The
   variable defaults to enabled when omitted, so a dark deploy must set `0`
   explicitly.
3. **Verify adapters.** Run the worker contract tests and a project-scoped
   dry reconciliation:
   `bun test apps/worker/src/render-config.test.ts apps/worker/src/tasks/clip-render-attempt.test.ts apps/worker/src/render-object-reconciler.test.ts`
   and
   `bun run --cwd apps/worker reconcile:render-objects --project <project-uuid>`.
   Exit `0` is clean, `1` reports reviewed dry-run orphans, `2` reports one or
   more per-object deletion failures, and `3` means reconciliation was unsafe
   or unavailable (including validation, listing, database, and deadline
   failures).
   During any mixed-version period, use dry-run only. Do not pass `--delete`
   until every old render worker has drained and the upgraded worker pool is
   the sole owner of clip-rendering claims.
   Before cutover, compare legacy and attempt-path outputs for optional assets
   present, absent, corrupt, expired, and provider-unavailable. Cover vertical
   and horizontal talking-head footage, screen/PiP, split/two-speaker,
   background-fit, and audiogram inputs with the relevant feature switch both
   enabled and set to literal `0`. A crop, layout, timing, mix, or attribution
   mismatch blocks cutover; do not tune geometry or composition policy as part
   of the migration.
4. **Drain.** Stop every process that can poll `clip_rendering`. Wait until no
   render worker process is running and no protocol-version-2 render run has
   a live lease. Do not enable while any old render process remains.
5. **Enable and restart.** Set `WORKER_CLIP_RENDER_ATTEMPT_ENABLED=1` on the
   upgraded worker pool and start it. No lifecycle protocol version change is
   required. Startup validates `WORKER_X264_PRESET`; supported non-default
   presets emit a structured warning. `WORKER_STORAGE_TIMEOUT_MS` bounds each
   render and reconciliation storage operation.
6. **Observe.** Verify representative `completed`, `partial`, `requeued`, and
   `failed` runs. Query terminal Workflow Events where
   `notificationRequired = true AND notificationDeliveredAt IS NULL`; this
   queue must drain independently of render state. Inspect structured
   `workflow_attempt_lost`, cleanup, follow-up, and reconciliation diagnostics.

## Rollback

1. **Drain before disabling.** Stop the upgraded render workers and wait for
   active render leases to disappear or be reaped. Never start legacy-compatible
   render code while a new Clip Render Attempt is active.
2. Set `WORKER_CLIP_RENDER_ATTEMPT_ENABLED=0` and restart the upgraded worker
   pool so it cannot claim render work.
3. Roll back application code only after the drain. Retain the additive
   columns, Render Work Set lineage, attempt-unique objects, and committed
   Workflow Events. The upgraded event dispatcher must remain available until
   every notification-required event has a delivery acknowledgement.
   Optional-asset and media-analysis rollback requires no asset-data migration:
   stored snapshots, selected keys, legacy helpers, analysis envelopes, and
   attempt-unique objects remain valid and are not renamed or backfilled.
4. If legacy-compatible rendering must resume, start it only after confirming
   the upgraded render pool is fully stopped. Pending lineage remains readable;
   completed historical rows and objects must not be rewritten.

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
