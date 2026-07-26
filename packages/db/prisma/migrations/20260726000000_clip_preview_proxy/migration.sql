-- Per-clip preview proxy: a 540p faststart cut of the source covering the clip
-- range (plus padding), so the studio and the clip cards can play a ~2 MB asset
-- instead of streaming the full multi-hundred-MB source.
--
-- Additive + nullable, so existing rows keep working and fall back to the
-- source until a proxy has been generated for them.
ALTER TABLE "Clip" ADD COLUMN "previewStorageKey" TEXT;
ALTER TABLE "Clip" ADD COLUMN "previewStartSec" DOUBLE PRECISION;
ALTER TABLE "Clip" ADD COLUMN "previewDurationSec" DOUBLE PRECISION;
