CREATE TABLE "WorkspaceBillingAccount" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "workspaceId" UUID NOT NULL,
  "providerCustomerId" TEXT,
  "canonicalSubscriptionId" TEXT,
  "seatItemId" TEXT,
  "billingInterval" TEXT,
  "providerStatus" TEXT,
  "currentPeriodEndAt" TIMESTAMP(3),
  "trialEndAt" TIMESTAMP(3),
  "cancelAtPeriodEnd" BOOLEAN NOT NULL DEFAULT false,
  "firstPastDueAt" TIMESTAMP(3),
  "graceDeadlineAt" TIMESTAMP(3),
  "desiredAdditionalSeats" INTEGER NOT NULL DEFAULT 0,
  "synchronizedAdditionalSeats" INTEGER,
  "health" TEXT NOT NULL DEFAULT 'current',
  "attentionReason" TEXT,
  "lastVerifiedAt" TIMESTAMP(3),
  "nextReconcileAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "reconcileAttemptId" UUID,
  "leaseExpiresAt" TIMESTAMP(3),
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "snapshot" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "WorkspaceBillingAccount_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "WorkspaceBillingTransition" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "billingAccountId" UUID NOT NULL,
  "previousTier" "PricingTier" NOT NULL,
  "nextTier" "PricingTier" NOT NULL,
  "previousStatus" "WorkspaceStatus" NOT NULL,
  "nextStatus" "WorkspaceStatus" NOT NULL,
  "providerStatus" TEXT,
  "reason" TEXT NOT NULL,
  "effectiveAt" TIMESTAMP(3) NOT NULL,
  "observedAt" TIMESTAMP(3) NOT NULL,
  "sourceEventId" TEXT,
  "sourceSubscriptionId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "WorkspaceBillingTransition_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "WorkspaceBillingAccount_workspaceId_key" ON "WorkspaceBillingAccount"("workspaceId");
CREATE UNIQUE INDEX "WorkspaceBillingAccount_providerCustomerId_key" ON "WorkspaceBillingAccount"("providerCustomerId");
CREATE UNIQUE INDEX "WorkspaceBillingAccount_canonicalSubscriptionId_key" ON "WorkspaceBillingAccount"("canonicalSubscriptionId");
CREATE UNIQUE INDEX "WorkspaceBillingAccount_seatItemId_key" ON "WorkspaceBillingAccount"("seatItemId");
CREATE INDEX "WorkspaceBillingAccount_nextReconcileAt_id_idx" ON "WorkspaceBillingAccount"("nextReconcileAt", "id");
CREATE INDEX "WorkspaceBillingAccount_leaseExpiresAt_idx" ON "WorkspaceBillingAccount"("leaseExpiresAt");
CREATE INDEX "WorkspaceBillingTransition_billingAccountId_createdAt_idx" ON "WorkspaceBillingTransition"("billingAccountId", "createdAt");

ALTER TABLE "WorkspaceBillingAccount"
  ADD CONSTRAINT "WorkspaceBillingAccount_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "WorkspaceBillingTransition"
  ADD CONSTRAINT "WorkspaceBillingTransition_billingAccountId_fkey"
  FOREIGN KEY ("billingAccountId") REFERENCES "WorkspaceBillingAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

INSERT INTO "WorkspaceBillingAccount" (
  "workspaceId",
  "providerCustomerId",
  "canonicalSubscriptionId",
  "seatItemId",
  "billingInterval",
  "currentPeriodEndAt",
  "lastVerifiedAt",
  "nextReconcileAt",
  "createdAt",
  "updatedAt"
)
SELECT
  w.id,
  w."stripeCustomerId",
  w."stripeSubscriptionId",
  w."stripeSeatItemId",
  w."billingInterval",
  w."subscriptionEndsAt",
  w."billingEventCreatedAt",
  CURRENT_TIMESTAMP,
  w."createdAt",
  CURRENT_TIMESTAMP
FROM "Workspace" w;

DROP INDEX IF EXISTS "Workspace_stripeCustomerId_key";
DROP INDEX IF EXISTS "Workspace_stripeSubscriptionId_key";
DROP INDEX IF EXISTS "Workspace_stripeSeatItemId_key";

ALTER TABLE "Workspace"
  DROP COLUMN "stripeCustomerId",
  DROP COLUMN "stripeSubscriptionId",
  DROP COLUMN "stripeSeatItemId",
  DROP COLUMN "billingInterval",
  DROP COLUMN "billingEventCreatedAt",
  DROP COLUMN "subscriptionEndsAt";
