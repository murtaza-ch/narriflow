-- Remove the obsolete YouTube job shape at the data change, not in workers.
UPDATE "IngestJob"
SET "jobType" = 'link_import',
    payload = (payload::jsonb - 'youtubeUrl') || jsonb_build_object('url', payload::jsonb->>'youtubeUrl', 'provider', 'youtube'),
    "updatedAt" = NOW()
WHERE "jobType" = 'youtube_import';
ALTER TYPE "IngestJobType" RENAME TO "IngestJobType_old";
CREATE TYPE "IngestJobType" AS ENUM ('upload_finalize', 'rss_import', 'link_import');
ALTER TABLE "IngestJob" ALTER COLUMN "jobType" TYPE "IngestJobType" USING "jobType"::text::"IngestJobType";
DROP TYPE "IngestJobType_old";

-- Reset pre-fencing local attempts. The current reaper only accepts leases.
WITH reset AS (
  UPDATE "IngestJob" SET status = 'queued', "claimId" = NULL,
    "claimExpiresAt" = NULL, "attemptCount" = 0, "startedAt" = NULL,
    "updatedAt" = NOW()
  WHERE status = 'running' AND ("claimId" IS NULL OR "claimExpiresAt" IS NULL)
  RETURNING "projectId"
)
UPDATE "Project" SET "ingestStatus" = 'queued', "ingestErrorCode" = NULL
WHERE id IN (SELECT "projectId" FROM reset);
ALTER TABLE "IngestJob" ADD CONSTRAINT "IngestJob_running_claim_check"
  CHECK (status <> 'running' OR ("claimId" IS NOT NULL AND "claimExpiresAt" IS NOT NULL));
ALTER TABLE "IngestJob" ADD CONSTRAINT "IngestJob_attemptCount_check" CHECK ("attemptCount" >= 0);

-- Source intake events name their Ingest Job explicitly.
ALTER TABLE "WorkflowEvent" ALTER COLUMN "workflowRunId" DROP NOT NULL;
ALTER TABLE "WorkflowEvent" ADD COLUMN "ingestJobId" UUID;
UPDATE "WorkflowEvent"
SET "ingestJobId" = "workflowRunId", "workflowRunId" = NULL,
    payload = CASE WHEN payload IS NOT NULL THEN
      (payload::jsonb - 'workflowRunId') || jsonb_build_object('workflowRunId', NULL, 'ingestJobId', "workflowRunId")
      ELSE NULL END
WHERE stage LIKE 'ingest%';
ALTER TABLE "WorkflowEvent" ADD CONSTRAINT "WorkflowEvent_execution_identity_check"
  CHECK (("workflowRunId" IS NULL) <> ("ingestJobId" IS NULL));
