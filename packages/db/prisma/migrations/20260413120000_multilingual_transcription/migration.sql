-- Adds languageCode to Transcript so detected/selected language is persisted.
-- This was previously applied to the database directly; this file is added so
-- Prisma's migration history is consistent with the live schema.
ALTER TABLE "Transcript" ADD COLUMN IF NOT EXISTS "languageCode" TEXT;
