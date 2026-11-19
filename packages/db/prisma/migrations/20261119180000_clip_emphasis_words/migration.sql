-- Clip Emphasis Words from the clip selection call: a JSON array of up to 8
-- strings (words or 2-word units from the clip's own transcript).
--
-- Additive + nullable: existing rows keep NULL and caption as before.
ALTER TABLE "Clip" ADD COLUMN "emphasisWords" JSONB;
