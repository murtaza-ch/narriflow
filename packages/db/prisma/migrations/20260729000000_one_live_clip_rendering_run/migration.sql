-- DEPLOY NOTE: apply with workers stopped/drained. A worker that owns one of
-- the duplicate runs settled below would keep encoding with no fencing and
-- race the retained run's R2 writes.
--
-- Two live clip_rendering runs for one project double-render the same pending
-- variants and race PUTs to the same deterministic R2 render keys. The
-- find-then-create guards in triggerClipRendering / autoQueueDefaultRenders
-- are non-transactional (and use different idempotency keys, so the
-- projectId+idempotencyKey unique cannot collapse them). Settle any existing
-- duplicates first (keep the newest live run, fail the rest), then enforce at
-- the database level.
UPDATE "WorkflowRun" wr
SET "status" = 'failed',
    "errorCode" = 'superseded_duplicate_run',
    "updatedAt" = NOW()
WHERE wr."stage" = 'clip_rendering'
  AND wr."status" IN ('queued', 'running')
  AND EXISTS (
    SELECT 1
    FROM "WorkflowRun" other
    WHERE other."projectId" = wr."projectId"
      AND other."stage" = 'clip_rendering'
      AND other."status" IN ('queued', 'running')
      AND (
        other."createdAt" > wr."createdAt"
        OR (other."createdAt" = wr."createdAt" AND other."id" > wr."id")
      )
  );

CREATE UNIQUE INDEX "WorkflowRun_one_live_clip_rendering_per_project"
  ON "WorkflowRun" ("projectId")
  WHERE "stage" = 'clip_rendering' AND "status" IN ('queued', 'running');
