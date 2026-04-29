ALTER TABLE "Project"
  ADD COLUMN "languageCode" TEXT;

ALTER TABLE "ContentPack"
  ADD COLUMN "mode" TEXT NOT NULL DEFAULT 'clip',
  ADD COLUMN "autoHook" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "specificMoments" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "processingStartSec" INTEGER,
  ADD COLUMN "processingEndSec" INTEGER;
