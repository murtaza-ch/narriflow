-- LLM-suggested B-roll cutaway moments from the clip-detection call:
-- [{ atSec, query, reason }], atSec relative to the clip's own start.
--
-- Without this column the detector computes cues and then discards them, and
-- the render falls back to keyword-derived Pexels queries (which produced
-- queries like "mistakes killing ads" matching literal violence footage).
--
-- Additive + nullable: existing rows keep working and fall back to keywords.
ALTER TABLE "Clip" ADD COLUMN "brollCues" JSONB;
