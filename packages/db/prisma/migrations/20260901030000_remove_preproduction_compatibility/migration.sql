-- Pre-production cleanup. Narriflow has no production users, so the removed
-- Starter tier is normalized once in storage and is not accepted at runtime.
UPDATE "Workspace"
SET "pricingTier" = 'creator'
WHERE "pricingTier" = 'starter';

UPDATE "WorkspaceCheckoutAttempt"
SET "targetTier" = 'creator'
WHERE "targetTier" = 'starter';

UPDATE "WorkspaceBillingTransition"
SET
  "previousTier" = CASE
    WHEN "previousTier" = 'starter' THEN 'creator'::"PricingTier"
    ELSE "previousTier"
  END,
  "nextTier" = CASE
    WHEN "nextTier" = 'starter' THEN 'creator'::"PricingTier"
    ELSE "nextTier"
  END
WHERE "previousTier" = 'starter' OR "nextTier" = 'starter';

ALTER TABLE "Workspace" ALTER COLUMN "pricingTier" DROP DEFAULT;
ALTER TABLE "WorkspaceCheckoutAttempt"
  DROP CONSTRAINT "WorkspaceCheckoutAttempt_paid_tier_check";
ALTER TYPE "PricingTier" RENAME TO "PricingTier_preproduction";
CREATE TYPE "PricingTier" AS ENUM ('free', 'creator', 'pro', 'business');

ALTER TABLE "Workspace"
  ALTER COLUMN "pricingTier" TYPE "PricingTier"
  USING ("pricingTier"::text::"PricingTier");
ALTER TABLE "WorkspaceCheckoutAttempt"
  ALTER COLUMN "targetTier" TYPE "PricingTier"
  USING ("targetTier"::text::"PricingTier");
ALTER TABLE "WorkspaceBillingTransition"
  ALTER COLUMN "previousTier" TYPE "PricingTier"
  USING ("previousTier"::text::"PricingTier"),
  ALTER COLUMN "nextTier" TYPE "PricingTier"
  USING ("nextTier"::text::"PricingTier");

DROP TYPE "PricingTier_preproduction";
ALTER TABLE "Workspace" ALTER COLUMN "pricingTier" SET DEFAULT 'free';
ALTER TABLE "WorkspaceCheckoutAttempt"
  ADD CONSTRAINT "WorkspaceCheckoutAttempt_paid_tier_check"
  CHECK ("targetTier" IN ('creator', 'pro', 'business'));

ALTER TABLE "BrandProfile" DROP COLUMN "isCompatibility";
