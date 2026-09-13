ALTER TABLE "IngestJob"
ADD COLUMN "generationHandoffRetryAt" TIMESTAMP(3);

CREATE INDEX "IngestJob_status_generationHandoffRetryAt_idx"
ON "IngestJob"("status", "generationHandoffRetryAt");
