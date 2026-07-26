-- Persist exportable per-clip editor edits (manual text layers, transition,
-- optional music URL/mix settings). Stored as JSON because the renderer consumes
-- it atomically with the clip row.
ALTER TABLE "Clip" ADD COLUMN "studioEdits" JSONB;
