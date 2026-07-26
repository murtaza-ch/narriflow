-- 1. WorkflowRun.attemptCount
-- IngestJob has always had attemptCount but nothing ever read it, so a single
-- transient failure (e.g. "The socket connection was closed unexpectedly")
-- killed a job permanently. WorkflowRun had no equivalent column at all, so
-- stt / moment_detection / clip_rendering / dubbing could not be retried.
ALTER TABLE "WorkflowRun" ADD COLUMN "attemptCount" INTEGER NOT NULL DEFAULT 0;

-- 2. AutopilotEpisode.projectId foreign key
-- The column was a bare indexed UUID with no constraint, so deleting a project
-- left dangling references. SetNull rather than Cascade on purpose: the dedup
-- key is [ruleId, episodeId], so the row must survive project deletion or the
-- autopilot rule would re-import the same episode.
--
-- Verified before writing this migration: 0 AutopilotEpisode rows total and 0
-- with a dangling projectId, so the constraint validates without a cleanup step.
ALTER TABLE "AutopilotEpisode"
  ADD CONSTRAINT "AutopilotEpisode_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "Project"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
