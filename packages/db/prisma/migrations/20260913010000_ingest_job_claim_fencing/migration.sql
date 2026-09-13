ALTER TABLE "IngestJob"
ADD COLUMN "claimId" UUID,
ADD COLUMN "claimExpiresAt" TIMESTAMP(3);

CREATE INDEX "IngestJob_status_claimExpiresAt_idx"
ON "IngestJob"("status", "claimExpiresAt");
