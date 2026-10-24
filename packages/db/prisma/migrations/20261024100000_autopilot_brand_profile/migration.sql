-- Autopilot rules apply a Brand Profile, not a Brand Template. A stored ID
-- means "this profile"; NULL means no Brand Profile. pauseKind says why
-- Autopilot itself paused a rule; NULL for a pause someone chose.

-- CreateEnum
CREATE TYPE "AutopilotPauseKind" AS ENUM ('acting_member', 'brand_profile');

-- AlterTable
ALTER TABLE "AutopilotRule" ADD COLUMN "brandProfileId" UUID,
ADD COLUMN "pauseKind" "AutopilotPauseKind";

-- Existing rules adopt the Workspace's default Brand Profile. A personal
-- Workspace below Business keeps its profiles on the user (resolveBrandOwner).
UPDATE "AutopilotRule" AS r
SET "brandProfileId" = CASE
  WHEN w."personalOwnerUserId" IS NOT NULL AND w."pricingTier" <> 'business'
    THEN (SELECT u."defaultBrandProfileId" FROM "User" AS u WHERE u."id" = w."personalOwnerUserId")
  ELSE w."defaultBrandProfileId"
END
FROM "Workspace" AS w
WHERE w."id" = r."workspaceId";

-- AlterTable
ALTER TABLE "AutopilotRule" DROP COLUMN "brandTemplateId";

-- CreateIndex
CREATE INDEX "AutopilotRule_brandProfileId_idx" ON "AutopilotRule"("brandProfileId");

-- AddForeignKey
ALTER TABLE "AutopilotRule" ADD CONSTRAINT "AutopilotRule_brandProfileId_fkey" FOREIGN KEY ("brandProfileId") REFERENCES "BrandProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;
