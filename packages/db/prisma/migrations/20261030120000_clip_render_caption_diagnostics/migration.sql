-- Additive and nullable: current code never reads or writes the column, so this
-- is safe to apply before or while the previous deployment runs.
ALTER TABLE "ClipRender" ADD COLUMN "captionDiagnostics" JSONB;
