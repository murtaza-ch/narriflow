-- One open subscription Checkout per Workspace Billing Account. The column is
-- set only on the attempt that holds the slot; the unique index makes a second
-- concurrent holder impossible, and the check keeps the slot on its own account.
ALTER TABLE "WorkspaceCheckoutAttempt" ADD COLUMN "activeBillingAccountId" UUID;

CREATE UNIQUE INDEX "WorkspaceCheckoutAttempt_activeBillingAccountId_key"
  ON "WorkspaceCheckoutAttempt"("activeBillingAccountId");

ALTER TABLE "WorkspaceCheckoutAttempt"
  ADD CONSTRAINT "WorkspaceCheckoutAttempt_active_slot_account_check"
  CHECK ("activeBillingAccountId" IS NULL OR "activeBillingAccountId" = "billingAccountId");

-- Pre-production development data: the newest still-open bound session of
-- each account takes the slot so it cannot be duplicated after deploy.
UPDATE "WorkspaceCheckoutAttempt" AS attempt
SET "activeBillingAccountId" = attempt."billingAccountId"
FROM (
  SELECT DISTINCT ON ("billingAccountId") "id"
  FROM "WorkspaceCheckoutAttempt"
  WHERE "providerSessionId" IS NOT NULL
    AND "expiresAt" > now()
    AND COALESCE("sessionStatus", 'open') = 'open'
  ORDER BY "billingAccountId", "createdAt" DESC, "id" DESC
) AS latest
WHERE attempt."id" = latest."id";
