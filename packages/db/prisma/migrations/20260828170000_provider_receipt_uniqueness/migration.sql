DROP INDEX IF EXISTS "ProviderReceipt_platform_receiptId_idx";

CREATE UNIQUE INDEX "ProviderReceipt_platform_receiptId_key"
  ON "ProviderReceipt"("platform", "receiptId");

ALTER TABLE "SocialPublicationAttempt"
  ADD COLUMN "reconciliationDeadline" TIMESTAMP(3);

UPDATE "SocialPublicationAttempt"
SET "reconciliationDeadline" = "processingDeadline"
WHERE "reconciliationDeadline" IS NULL;

ALTER TABLE "SocialPublicationAttempt"
  ALTER COLUMN "reconciliationDeadline" SET NOT NULL;
