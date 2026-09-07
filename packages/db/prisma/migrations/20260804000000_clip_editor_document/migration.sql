-- Studio editor document (vizard-parity Phase A): revision counter for
-- optimistic-concurrency saves, ripple-delete ranges, and the immutable
-- revision-zero snapshot backing Reset-to-original. Purely additive; existing
-- rows start at revision 0 with no snapshot (captured on first editor save).
ALTER TABLE "Clip" ADD COLUMN "editorRevision" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Clip" ADD COLUMN "deletedRanges" JSONB;
ALTER TABLE "Clip" ADD COLUMN "editorOriginal" JSONB;
