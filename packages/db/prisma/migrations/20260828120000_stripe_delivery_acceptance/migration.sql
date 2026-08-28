ALTER TYPE "WebhookProvider" ADD VALUE IF NOT EXISTS 'stripe';

ALTER TABLE "WebhookDeliveryLog"
  ADD COLUMN "providerCreatedAt" TIMESTAMP(3),
  ADD COLUMN "liveMode" BOOLEAN,
  ADD COLUMN "apiVersion" TEXT,
  ADD COLUMN "subjectCustomerId" TEXT,
  ADD COLUMN "subjectSubscriptionId" TEXT,
  ADD COLUMN "subjectCheckoutSessionId" TEXT,
  ADD COLUMN "workspaceHint" UUID,
  ADD COLUMN "workspaceBillingAccountId" UUID;

ALTER TABLE "WebhookDeliveryLog"
  ADD CONSTRAINT "WebhookDeliveryLog_workspaceBillingAccountId_fkey"
  FOREIGN KEY ("workspaceBillingAccountId") REFERENCES "WorkspaceBillingAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "WebhookDeliveryLog_workspaceBillingAccountId_createdAt_idx"
  ON "WebhookDeliveryLog"("workspaceBillingAccountId", "createdAt");
