DROP INDEX "WorkflowRun_lifecycleVersion_stage_status_nextAttemptAt_createdAt_idx";

ALTER TABLE "WorkflowRun" DROP COLUMN "lifecycleVersion";

CREATE INDEX "WorkflowRun_stage_status_nextAttemptAt_createdAt_idx"
  ON "WorkflowRun"("stage", "status", "nextAttemptAt", "createdAt");
