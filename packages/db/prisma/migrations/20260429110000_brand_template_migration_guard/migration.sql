-- A historical generated migration (20260429113258) alters BrandTemplate
-- before the migration that creates the real table. On a clean database,
-- provide only the two columns that generated ALTER expects. The companion
-- cleanup migration removes this placeholder before the real table is made.
-- Existing databases already have BrandTemplate, so this is intentionally a
-- no-op there and does not rewrite applied migration history.
DO $$
BEGIN
  IF to_regclass('"BrandTemplate"') IS NULL THEN
    CREATE TABLE "BrandTemplate" (
      "id" UUID NOT NULL DEFAULT gen_random_uuid(),
      "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE "_NarriflowBrandTemplateMigrationGuard" (
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  END IF;
END
$$;
