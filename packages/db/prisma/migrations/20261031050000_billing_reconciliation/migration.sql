ALTER TABLE "WorkspaceBillingAccount"
  ADD COLUMN "reconciliationGeneration" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "reconciliationEpoch" INTEGER NOT NULL DEFAULT 1,
  ADD CONSTRAINT "WorkspaceBillingAccount_reconciliation_generation_check" CHECK ("reconciliationGeneration" >= 0),
  ADD CONSTRAINT "WorkspaceBillingAccount_reconciliation_epoch_check" CHECK ("reconciliationEpoch" > 0);
