-- Whether the file a ClipRender points at carries the Free-plan mark. An
-- upgrade renders those files again without it.
ALTER TABLE "ClipRender" ADD COLUMN "watermark" BOOLEAN NOT NULL DEFAULT false;

-- Backfill finished rows from the Render Group that produced the current file.
-- "exportIdentity" is a JSON array whose fifth element is the frozen watermark.
UPDATE "ClipRender" r SET "watermark" = true
WHERE r."status" = 'completed' AND EXISTS (
  SELECT 1 FROM "RenderGroupMember" m JOIN "RenderGroup" g ON g."id" = m."groupId"
  WHERE m."clipRenderId" = r."id" AND g."workflowRunId" = r."workflowRunId"
    AND (g."exportIdentity"::jsonb ->> 4) = 'true');

-- An export variant renders exactly its frozen flag (group admission rejects a
-- mismatch), so a finished marked variant is marked even without group lineage.
UPDATE "ClipRender" r SET "watermark" = true
FROM "ClipExportVariant" v
WHERE v."id" = r."exportVariantId" AND r."status" = 'completed' AND v."watermark" = true;
