ALTER TABLE "CampaignOperationItem"
  ADD COLUMN "claimToken" TEXT,
  ADD COLUMN "leaseExpiresAt" TIMESTAMP(3);

CREATE INDEX "CampaignOperationItem_operationId_status_leaseExpiresAt_idx"
  ON "CampaignOperationItem"("operationId", "status", "leaseExpiresAt");
