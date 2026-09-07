-- Additive, dark-deployed Render Work Set lineage. Existing variants remain
-- unassigned, and historical completed/failed rows are never rewritten.
ALTER TABLE "WorkflowRun"
  ADD COLUMN "renderWorkSetFrozenAt" TIMESTAMP(3);

ALTER TABLE "ClipRender"
  ADD COLUMN "workflowRunId" UUID,
  ADD COLUMN "failureDisposition" TEXT;

ALTER TABLE "ClipRender"
  ADD CONSTRAINT "ClipRender_workflowRunId_fkey"
  FOREIGN KEY ("workflowRunId") REFERENCES "WorkflowRun"("id")
  ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "ClipRender_failureDisposition_check"
  CHECK (
    "failureDisposition" IS NULL
    OR "failureDisposition" IN ('retryable', 'permanent')
  );

-- Retry reads select the complete membership for one Workflow Run.
CREATE INDEX "ClipRender_workflowRunId_createdAt_id_idx"
  ON "ClipRender"("workflowRunId", "createdAt", "id");

-- First-begin selection starts from a project's clips and only considers
-- eligible unassigned pending rows. Prisma cannot express this partial index.
CREATE INDEX "ClipRender_unassigned_pending_clipId_createdAt_id_idx"
  ON "ClipRender"("clipId", "createdAt", "id")
  WHERE "workflowRunId" IS NULL AND "status" = 'pending';
