-- Recipes: named, revisioned Workspace settings (Brand Profile, language,
-- Content Pack, finishing). Autopilot rules point at a Recipe instead of
-- carrying those settings themselves.

-- CreateTable
CREATE TABLE "Recipe" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "contentRevision" INTEGER NOT NULL DEFAULT 1,
    "brandProfileId" UUID,
    "languageCode" TEXT,
    "contentPack" JSONB NOT NULL,
    "finishing" JSONB,
    "createdByUserId" UUID,
    "updatedByUserId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "Recipe_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "AutopilotRule" ADD COLUMN "recipeId" UUID;

-- AlterTable
ALTER TABLE "ContentPack" ADD COLUMN "recipe" JSONB;

-- Each distinct setting an existing rule carries becomes one Recipe, named
-- after the first rule that used it, and every rule using it points there.
-- A Recipe accepts only the languages the transcription provider lists and no
-- captioned-video settings, so a rule's free-text language code the provider
-- doesn't list becomes "detect it" (NULL), and any captionedVideo key is
-- dropped from the pack. Everything else carries over unchanged.
WITH "settings" AS (
  SELECT
    "id" AS "ruleId",
    "workspaceId",
    "brandProfileId",
    CASE WHEN lower(btrim("languageCode")) IN ('en', 'en_au', 'en_uk', 'en_us', 'es', 'fr', 'de', 'it', 'pt', 'nl', 'af', 'sq', 'am', 'ar', 'hy', 'as', 'az', 'ba', 'eu', 'be', 'bn', 'bs', 'br', 'bg', 'my', 'ca', 'zh', 'hr', 'cs', 'da', 'et', 'fo', 'fi', 'gl', 'ka', 'el', 'gu', 'ht', 'ha', 'haw', 'he', 'hi', 'hu', 'is', 'id', 'ja', 'jw', 'kn', 'kk', 'km', 'ko', 'lo', 'la', 'lv', 'ln', 'lt', 'lb', 'mk', 'mg', 'ms', 'ml', 'mt', 'mi', 'mr', 'mn', 'ne', 'no', 'nn', 'oc', 'pa', 'ps', 'fa', 'pl', 'ro', 'ru', 'sa', 'sr', 'sn', 'sd', 'si', 'sk', 'sl', 'so', 'su', 'sw', 'sv', 'tl', 'tg', 'ta', 'tt', 'te', 'th', 'bo', 'tr', 'tk', 'uk', 'ur', 'uz', 'vi', 'cy', 'yi', 'yo')
         THEN lower(btrim("languageCode")) END AS "languageCode",
    "contentPack" - 'captionedVideo' AS "contentPack",
    "finishing",
    "name",
    "createdAt",
    "createdByUserId"
  FROM "AutopilotRule"
), "grouped" AS (
  SELECT
    gen_random_uuid() AS "id",
    "workspaceId",
    "brandProfileId",
    "languageCode",
    "contentPack",
    "finishing",
    (array_agg("name" ORDER BY "createdAt", "ruleId"))[1] AS "firstName",
    count(*) AS "ruleCount",
    (array_agg("createdByUserId" ORDER BY "createdAt", "ruleId"))[1] AS "createdByUserId"
  FROM "settings"
  GROUP BY "workspaceId", "brandProfileId", "languageCode", "contentPack", "finishing"
), "inserted" AS (
  INSERT INTO "Recipe" ("id", "workspaceId", "name", "brandProfileId", "languageCode", "contentPack", "finishing", "createdByUserId", "updatedByUserId", "updatedAt")
  SELECT
    "id",
    "workspaceId",
    CASE WHEN "ruleCount" = 1 THEN left("firstName", 120)
         ELSE left("firstName", 100) || ' and ' || ("ruleCount" - 1) || ' more' END,
    "brandProfileId",
    "languageCode",
    "contentPack",
    "finishing",
    "createdByUserId",
    "createdByUserId",
    CURRENT_TIMESTAMP
  FROM "grouped"
)
UPDATE "AutopilotRule" AS r
SET "recipeId" = g."id"
FROM "settings" AS s
JOIN "grouped" AS g
  ON s."workspaceId" = g."workspaceId"
  AND s."brandProfileId" IS NOT DISTINCT FROM g."brandProfileId"
  AND s."languageCode" IS NOT DISTINCT FROM g."languageCode"
  AND s."contentPack" = g."contentPack"
  AND s."finishing" IS NOT DISTINCT FROM g."finishing"
WHERE r."id" = s."ruleId";

-- AlterTable
ALTER TABLE "AutopilotRule" ALTER COLUMN "recipeId" SET NOT NULL;

-- DropForeignKey
ALTER TABLE "AutopilotRule" DROP CONSTRAINT "AutopilotRule_brandProfileId_fkey";

-- DropIndex
DROP INDEX "AutopilotRule_brandProfileId_idx";

-- AlterTable
ALTER TABLE "AutopilotRule" DROP COLUMN "brandProfileId",
DROP COLUMN "languageCode",
DROP COLUMN "contentPack",
DROP COLUMN "finishing";

-- CreateIndex
CREATE INDEX "Recipe_workspaceId_deletedAt_createdAt_idx" ON "Recipe"("workspaceId", "deletedAt", "createdAt");

-- CreateIndex
CREATE INDEX "Recipe_brandProfileId_idx" ON "Recipe"("brandProfileId");

-- CreateIndex
CREATE INDEX "AutopilotRule_recipeId_idx" ON "AutopilotRule"("recipeId");

-- AddForeignKey
ALTER TABLE "Recipe" ADD CONSTRAINT "Recipe_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Recipe" ADD CONSTRAINT "Recipe_brandProfileId_fkey" FOREIGN KEY ("brandProfileId") REFERENCES "BrandProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Recipe" ADD CONSTRAINT "Recipe_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Recipe" ADD CONSTRAINT "Recipe_updatedByUserId_fkey" FOREIGN KEY ("updatedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutopilotRule" ADD CONSTRAINT "AutopilotRule_recipeId_fkey" FOREIGN KEY ("recipeId") REFERENCES "Recipe"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
