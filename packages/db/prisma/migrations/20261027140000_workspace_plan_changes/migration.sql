CREATE TABLE "WorkspacePlanChangeAttempt" (
    "id" UUID NOT NULL,
    "billingAccountId" UUID NOT NULL,
    "actorUserId" UUID NOT NULL,
    "clientIdempotencyKey" TEXT NOT NULL,
    "targetTier" "PricingTier" NOT NULL,
    "interval" TEXT NOT NULL,
    "quote" JSONB NOT NULL,
    "phase" TEXT NOT NULL DEFAULT 'quoted',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "WorkspacePlanChangeAttempt_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "WorkspacePlanChangeAttempt_clientIdempotencyKey_key" ON "WorkspacePlanChangeAttempt"("clientIdempotencyKey");
CREATE INDEX "WorkspacePlanChangeAttempt_billingAccountId_createdAt_idx" ON "WorkspacePlanChangeAttempt"("billingAccountId", "createdAt");
ALTER TABLE "WorkspacePlanChangeAttempt" ADD CONSTRAINT "WorkspacePlanChangeAttempt_billingAccountId_fkey" FOREIGN KEY ("billingAccountId") REFERENCES "WorkspaceBillingAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
