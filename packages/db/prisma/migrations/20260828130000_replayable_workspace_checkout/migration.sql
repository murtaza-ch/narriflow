CREATE TABLE "WorkspaceCheckoutAttempt" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "billingAccountId" UUID NOT NULL,
  "actorUserId" UUID NOT NULL,
  "clientIdempotencyKey" TEXT NOT NULL,
  "targetTier" "PricingTier" NOT NULL,
  "interval" TEXT NOT NULL,
  "catalogVersion" TEXT NOT NULL,
  "returnDestination" TEXT NOT NULL,
  "customerOperationKey" TEXT NOT NULL,
  "checkoutOperationKey" TEXT NOT NULL,
  "providerSessionId" TEXT,
  "providerPhase" TEXT NOT NULL DEFAULT 'prepared',
  "sessionOutcome" TEXT,
  "expiresAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "WorkspaceCheckoutAttempt_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "WorkspaceCheckoutAttempt_paid_tier_check"
    CHECK ("targetTier" IN ('creator', 'pro', 'business')),
  CONSTRAINT "WorkspaceCheckoutAttempt_interval_check"
    CHECK ("interval" IN ('monthly', 'annual'))
);

CREATE UNIQUE INDEX "WorkspaceCheckoutAttempt_clientIdempotencyKey_key"
  ON "WorkspaceCheckoutAttempt"("clientIdempotencyKey");
CREATE UNIQUE INDEX "WorkspaceCheckoutAttempt_customerOperationKey_key"
  ON "WorkspaceCheckoutAttempt"("customerOperationKey");
CREATE UNIQUE INDEX "WorkspaceCheckoutAttempt_checkoutOperationKey_key"
  ON "WorkspaceCheckoutAttempt"("checkoutOperationKey");
CREATE UNIQUE INDEX "WorkspaceCheckoutAttempt_providerSessionId_key"
  ON "WorkspaceCheckoutAttempt"("providerSessionId");
CREATE INDEX "WorkspaceCheckoutAttempt_billingAccountId_createdAt_idx"
  ON "WorkspaceCheckoutAttempt"("billingAccountId", "createdAt");

ALTER TABLE "WorkspaceCheckoutAttempt"
  ADD CONSTRAINT "WorkspaceCheckoutAttempt_billingAccountId_fkey"
  FOREIGN KEY ("billingAccountId") REFERENCES "WorkspaceBillingAccount"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
