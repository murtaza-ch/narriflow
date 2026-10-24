-- A captioned video is a whole-source, caption-only generation. Its settings
-- (framing, caption source, export formats) are frozen in the Content Pack, and
-- its clip is the entire source, so it uses the whole-source duration bounds.

-- AlterTable
ALTER TABLE "ContentPack" ADD COLUMN "captionedVideo" JSONB;

-- AlterTable
ALTER TABLE "Clip" ADD COLUMN "wholeSource" BOOLEAN NOT NULL DEFAULT false;
