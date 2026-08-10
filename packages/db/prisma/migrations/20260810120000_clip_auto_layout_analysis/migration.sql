-- Persist the exact automatic speaker-layout plan used by both the studio
-- preview and FFmpeg render. This is derived data and intentionally separate
-- from the existing screen-share/PiP `layoutAnalysis` envelope.
ALTER TABLE "Clip" ADD COLUMN "autoLayoutAnalysis" JSONB;
