-- Some pre-production databases applied an early Campaign Operation table
-- shape before validated options and the admission-time plan were added to the
-- canonical migration. Repair that drift without changing fresh databases,
-- where both columns already exist.
ALTER TABLE "CampaignOperation"
  ADD COLUMN IF NOT EXISTS "validatedOptions" JSONB,
  ADD COLUMN IF NOT EXISTS "pricingTier" TEXT;

UPDATE "CampaignOperation"
SET "validatedOptions" = '{}'::jsonb
WHERE "validatedOptions" IS NULL;

UPDATE "CampaignOperation" AS operation
SET "pricingTier" = workspace."pricingTier"::text
FROM "Workspace" AS workspace
WHERE operation."workspaceId" = workspace."id"
  AND operation."pricingTier" IS NULL;

UPDATE "CampaignOperation"
SET "pricingTier" = 'free'
WHERE "pricingTier" IS NULL;

ALTER TABLE "CampaignOperation"
  ALTER COLUMN "validatedOptions" SET NOT NULL,
  ALTER COLUMN "pricingTier" SET NOT NULL;
