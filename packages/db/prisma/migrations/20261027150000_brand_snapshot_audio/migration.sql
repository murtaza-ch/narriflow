-- Brand Profile snapshots now always carry their frozen audio. Snapshots taken
-- before audio existed had none, so they get empty lists.
UPDATE "Project"
SET "brandProfileSnapshot" = "brandProfileSnapshot" || '{"audio":{"music":[],"sfx":[]}}'::jsonb
WHERE "brandProfileSnapshot" IS NOT NULL
  AND jsonb_typeof("brandProfileSnapshot") = 'object'
  AND NOT ("brandProfileSnapshot" ? 'audio');

UPDATE "UploadSession"
SET "brandProfileSnapshot" = "brandProfileSnapshot" || '{"audio":{"music":[],"sfx":[]}}'::jsonb
WHERE "brandProfileSnapshot" IS NOT NULL
  AND jsonb_typeof("brandProfileSnapshot") = 'object'
  AND NOT ("brandProfileSnapshot" ? 'audio');
