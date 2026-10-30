-- Additive and nullable: safe while the previous deployment runs. New API and
-- worker code reads/writes this column and must wait until this migration lands.
ALTER TABLE "ClipRender" ADD COLUMN "captionDiagnostics" JSONB;
