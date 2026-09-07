-- Drop only the placeholder created by the preceding guard. The marker makes
-- this safe on existing databases, where BrandTemplate is the real table and
-- the guard migration was a no-op.
DO $$
BEGIN
  IF to_regclass('"_NarriflowBrandTemplateMigrationGuard"') IS NOT NULL THEN
    DROP TABLE "BrandTemplate";
    DROP TABLE "_NarriflowBrandTemplateMigrationGuard";
  END IF;
END
$$;
