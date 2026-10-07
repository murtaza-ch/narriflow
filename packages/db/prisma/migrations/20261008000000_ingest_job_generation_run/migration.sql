-- Intake lineage: the speech-to-text run an Ingest Job handed off to.
ALTER TABLE "IngestJob" ADD COLUMN "generationRunId" UUID;

ALTER TABLE "IngestJob" ADD CONSTRAINT "IngestJob_generationRunId_fkey"
  FOREIGN KEY ("generationRunId") REFERENCES "WorkflowRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Intakes already handed off follow the earliest speech-to-text run of their
-- Project, which is the run the handoff admitted or acknowledged.
UPDATE "IngestJob" AS job
SET "generationRunId" = (
  SELECT run."id" FROM "WorkflowRun" AS run
  WHERE run."projectId" = job."projectId" AND run."stage" = 'stt'
  ORDER BY run."createdAt" ASC, run."id" ASC
  LIMIT 1
)
WHERE job."status" = 'completed' AND job."generationHandoffAt" IS NOT NULL;

-- Detection handoff events now freeze each render with its clip. Rewrite the
-- earlier ID-only shape; renders already deleted cannot recover a clip and drop out.
UPDATE "WorkflowEvent" AS event
SET "payload" = (event."payload" - 'generationRenderIds') || jsonb_build_object('generationRenders', COALESCE((
  SELECT jsonb_agg(jsonb_build_object('renderId', render."id", 'clipId', render."clipId") ORDER BY ids.position)
  FROM jsonb_array_elements_text(event."payload" -> 'generationRenderIds') WITH ORDINALITY AS ids(id, position)
  JOIN "ClipRender" AS render ON render."id" = ids.id::uuid
), '[]'::jsonb))
WHERE event."payload" ? 'generationRenderIds';

-- Pre-production reset (no compatibility readers): MCP Task handles now use the
-- "intake" domain and Operation Status result contracts, and export receipts
-- now record the granted output. Both are short-lived development records.
DELETE FROM "McpTask";
ALTER TABLE "McpTask" DROP CONSTRAINT "McpTask_domain_check";
ALTER TABLE "McpTask" ADD CONSTRAINT "McpTask_domain_check" CHECK ("domainKind" IN ('intake', 'generation', 'export'));
DELETE FROM "McpOperation" WHERE "toolName" = 'narriflow_create_clip_export';
