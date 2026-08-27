ALTER TABLE "UploadSession"
  ADD COLUMN "reconcileAt" TIMESTAMP(3),
  ADD COLUMN "reconciliationAttemptCount" INTEGER NOT NULL DEFAULT 0;

CREATE INDEX "UploadSession_status_reconcileAt_reconciliationLeaseExpiresAt_idx"
  ON "UploadSession"("status", "reconcileAt", "reconciliationLeaseExpiresAt");
