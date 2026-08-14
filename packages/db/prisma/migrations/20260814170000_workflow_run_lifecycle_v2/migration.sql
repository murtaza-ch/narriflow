-- Additive protocol-v2 workflow lifecycle foundation. All ownership columns
-- remain nullable so protocol-v1 workers and rows stay valid during a rolling
-- deployment.
ALTER TABLE "Project"
  ADD COLUMN "workflowEventSeq" INTEGER NOT NULL DEFAULT 0;

UPDATE "Project" AS p
SET "workflowEventSeq" = COALESCE(events."maxSeq", 0)
FROM (
  SELECT "projectId", MAX("seq") AS "maxSeq"
  FROM "WorkflowEvent"
  GROUP BY "projectId"
) AS events
WHERE p."id" = events."projectId";

ALTER TABLE "WorkflowRun"
  ADD COLUMN "lifecycleVersion" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "attemptId" UUID,
  ADD COLUMN "leaseOwner" TEXT,
  ADD COLUMN "leaseExpiresAt" TIMESTAMP(3),
  ADD COLUMN "heartbeatAt" TIMESTAMP(3),
  ADD COLUMN "nextAttemptAt" TIMESTAMP(3),
  ADD COLUMN "nextPollAt" TIMESTAMP(3),
  ADD COLUMN "waitingSince" TIMESTAMP(3),
  ADD COLUMN "requestedCount" INTEGER,
  ADD COLUMN "succeededCount" INTEGER,
  ADD COLUMN "failedCount" INTEGER;

ALTER TABLE "Transcript"
  ADD COLUMN "workflowAttemptId" UUID;

ALTER TABLE "ClipRender"
  ADD COLUMN "workflowAttemptId" UUID;

ALTER TABLE "ClipDub"
  ADD COLUMN "workflowAttemptId" UUID;

ALTER TABLE "WorkflowEvent"
  ADD COLUMN "dedupeKey" TEXT,
  ADD COLUMN "eventType" TEXT NOT NULL DEFAULT 'workflow.stage.updated',
  ADD COLUMN "payload" JSONB,
  ADD COLUMN "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "deliveryLeaseOwner" TEXT,
  ADD COLUMN "deliveryLeaseExpiresAt" TIMESTAMP(3),
  ADD COLUMN "deliveryAttempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "nextDeliveryAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "redisRequired" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "redisPublishedAt" TIMESTAMP(3),
  ADD COLUMN "analyticsRequired" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "analyticsPublishedAt" TIMESTAMP(3),
  ADD COLUMN "deadLetteredAt" TIMESTAMP(3),
  ADD COLUMN "lastDeliveryError" TEXT;

CREATE UNIQUE INDEX "WorkflowEvent_dedupeKey_key"
  ON "WorkflowEvent"("dedupeKey");
CREATE INDEX "WorkflowRun_lifecycleVersion_stage_status_nextAttemptAt_createdAt_idx"
  ON "WorkflowRun"("lifecycleVersion", "stage", "status", "nextAttemptAt", "createdAt");
CREATE INDEX "WorkflowRun_status_leaseExpiresAt_idx"
  ON "WorkflowRun"("status", "leaseExpiresAt");
CREATE INDEX "WorkflowRun_status_nextPollAt_idx"
  ON "WorkflowRun"("status", "nextPollAt");
CREATE INDEX "WorkflowEvent_nextDeliveryAt_deliveryLeaseExpiresAt_idx"
  ON "WorkflowEvent"("nextDeliveryAt", "deliveryLeaseExpiresAt");
