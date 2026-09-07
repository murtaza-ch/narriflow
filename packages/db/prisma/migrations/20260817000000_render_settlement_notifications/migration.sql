-- Workflow Event remains the sole transactional outbox. These additive
-- columns make render notification work queryable without parsing payloads
-- and keep legacy dispatchers from treating an unhanded-off event as done.
ALTER TABLE "WorkflowEvent"
  ADD COLUMN "notificationRequired" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "notificationDeliveredAt" TIMESTAMP(3);

CREATE INDEX "WorkflowEvent_notificationRequired_notificationDeliveredAt_nextDeliveryAt_idx"
  ON "WorkflowEvent"("notificationRequired", "notificationDeliveredAt", "nextDeliveryAt");
