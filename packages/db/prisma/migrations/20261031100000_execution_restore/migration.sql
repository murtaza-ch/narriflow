-- Hourly safety pages use the current epoch and a strict nextDeliveryAt/id cursor.
CREATE INDEX "ExecutionDispatch_pending_epoch_cursor_idx" ON "ExecutionDispatch"("deploymentEpoch", "nextDeliveryAt", id)
  WHERE "acknowledgedAt" IS NULL AND "deadLetteredAt" IS NULL;
-- One nearest observation per active attempt, with no history scan or renewal timer.
CREATE INDEX "ExecutionAttempt_current_deadline_cursor_idx" ON "ExecutionAttempt"("deploymentEpoch",
  (LEAST(COALESCE("leaseExpiresAt", "operationDeadlineAt"), "operationDeadlineAt")), "attemptToken")
  WHERE status IN ('admitted','running');
-- Restore authority revocation visits only active history in a strict cursor.
CREATE INDEX "ExecutionAttempt_restore_cursor_idx" ON "ExecutionAttempt"("createdAt", "attemptToken", "deploymentEpoch")
  WHERE status IN ('admitted','running');

DROP INDEX "ExecutionInboxReceipt_expiresAt_idx";
CREATE INDEX "ExecutionInboxReceipt_expiresAt_deliveryId_audience_idx" ON "ExecutionInboxReceipt"("expiresAt", "deliveryId", audience);
