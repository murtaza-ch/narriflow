-- The media facts a timeline export needs (frame rate, dimensions, audio),
-- measured once when the source is ingested.
ALTER TABLE "Project" ADD COLUMN "sourceProbe" JSONB;
