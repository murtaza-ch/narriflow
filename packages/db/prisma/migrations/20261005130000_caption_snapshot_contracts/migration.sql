-- The catalog migration rebuilt live styles; stored brand/export/original
-- snapshots also carry caption presets. Replace obsolete caption shapes using
-- the same Karaoke-or-default policy, preserving all other snapshot fields.
-- This helper exists only in the migration connection, never in the app.
CREATE FUNCTION pg_temp.rebuild_caption_snapshot(snapshot jsonb, caption_path text[])
RETURNS jsonb
LANGUAGE sql
AS $$
  SELECT CASE
    WHEN (snapshot #> caption_path) ? 'bold'
      OR jsonb_typeof(snapshot #> (caption_path || ARRAY['shadow'])) IN ('number', 'boolean')
    THEN jsonb_set(snapshot, caption_path, (
      SELECT "captionPreset" FROM "BrandTemplate"
      WHERE "builtInKey" = CASE
        WHEN snapshot #>> (caption_path || ARRAY['animation']) = 'karaoke' THEN 'karaoke'
        ELSE 'bold-pop'
      END
    ))
    ELSE snapshot
  END;
$$;

UPDATE "Project"
SET "brandSnapshot" = pg_temp.rebuild_caption_snapshot("brandSnapshot", ARRAY['captionPreset'])
WHERE "brandSnapshot" IS DISTINCT FROM pg_temp.rebuild_caption_snapshot("brandSnapshot", ARRAY['captionPreset']);

UPDATE "Project"
SET "brandProfileSnapshot" = pg_temp.rebuild_caption_snapshot("brandProfileSnapshot", ARRAY['style', 'captionPreset'])
WHERE "brandProfileSnapshot" IS DISTINCT FROM pg_temp.rebuild_caption_snapshot("brandProfileSnapshot", ARRAY['style', 'captionPreset']);

UPDATE "UploadSession"
SET "brandSnapshot" = pg_temp.rebuild_caption_snapshot("brandSnapshot", ARRAY['captionPreset'])
WHERE "brandSnapshot" IS DISTINCT FROM pg_temp.rebuild_caption_snapshot("brandSnapshot", ARRAY['captionPreset']);

UPDATE "UploadSession"
SET "brandProfileSnapshot" = pg_temp.rebuild_caption_snapshot("brandProfileSnapshot", ARRAY['style', 'captionPreset'])
WHERE "brandProfileSnapshot" IS DISTINCT FROM pg_temp.rebuild_caption_snapshot("brandProfileSnapshot", ARRAY['style', 'captionPreset']);

UPDATE "Clip"
SET "editorOriginal" = pg_temp.rebuild_caption_snapshot("editorOriginal", ARRAY['captionPreset'])
WHERE "editorOriginal" IS DISTINCT FROM pg_temp.rebuild_caption_snapshot("editorOriginal", ARRAY['captionPreset']);

UPDATE "ClipRender"
SET "clipSnapshot" = pg_temp.rebuild_caption_snapshot("clipSnapshot", ARRAY['captionPreset'])
WHERE "clipSnapshot" IS DISTINCT FROM pg_temp.rebuild_caption_snapshot("clipSnapshot", ARRAY['captionPreset']);

DROP FUNCTION pg_temp.rebuild_caption_snapshot(jsonb, text[]);
