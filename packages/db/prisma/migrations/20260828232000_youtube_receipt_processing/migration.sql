ALTER TABLE "ProviderReceipt"
ADD COLUMN "providerProcessingStatus" TEXT,
ADD COLUMN "providerProcessingFailureCode" TEXT,
ADD COLUMN "providerVisibility" TEXT,
ADD COLUMN "enrichmentClaimId" TEXT,
ADD COLUMN "enrichmentLeaseExpiresAt" TIMESTAMP(3),
ADD COLUMN "enrichmentNextCheckAt" TIMESTAMP(3),
ADD COLUMN "enrichmentCheckCount" INTEGER NOT NULL DEFAULT 0;

CREATE UNIQUE INDEX "ProviderReceipt_enrichmentClaimId_key"
ON "ProviderReceipt"("enrichmentClaimId");

CREATE INDEX "ProviderReceipt_platform_providerProcessingStatus_enrichedAt_enrichmentNextCheckAt_idx"
ON "ProviderReceipt"("platform", "providerProcessingStatus", "enrichedAt", "enrichmentNextCheckAt");
