-- Fixed model cursors for bounded daily retention and future accepted upload timers.
CREATE INDEX "UploadSession_execution_page_idx" ON "UploadSession"("createdAt",id)
 WHERE status IN ('initiating','uploading','finalizing','reconciling','compensating');
CREATE INDEX "NativeValidationJob_private_retention_idx" ON "NativeValidationJob"("createdAt",id)
 WHERE status IN ('completed','failed','cancelled');
CREATE INDEX "OutboundProbe_private_retention_idx" ON "OutboundProbe"("createdAt",id)
 WHERE status IN ('completed','failed','cancelled');
CREATE INDEX "Project_expiry_warning_page_idx" ON "Project"(("expiresAt"-INTERVAL '24 hours'),id)
 WHERE "expiresAt" IS NOT NULL AND "purgeStartedAt" IS NULL;

-- Barrier timestamps must follow actual lock acquisition/insertion, rather
-- than the transaction start clock, so deferred plans have a provable horizon.
ALTER TABLE "ExecutionDispatch" ALTER COLUMN "createdAt" SET DEFAULT (clock_timestamp() AT TIME ZONE 'UTC');

-- Privacy enumeration starts with one Project's indexed subjects, then their
-- ledger/attempt/artifact references; it does not walk the global active queue.
CREATE INDEX "ExecutionDispatch_subject_inventory_idx" ON "ExecutionDispatch"("subjectKind","subjectId",id);
CREATE INDEX "IngestJob_privacy_page_idx" ON "IngestJob"("projectId","createdAt",id) WHERE status IN ('queued','running');
CREATE INDEX "WorkflowRun_privacy_page_idx" ON "WorkflowRun"("projectId","createdAt",id) WHERE status IN ('queued','running','waiting');
CREATE INDEX "RenderGroup_privacy_page_idx" ON "RenderGroup"("workflowRunId","createdAt",id) WHERE status IN ('queued','running');
CREATE INDEX "ClipSelectionWindow_privacy_page_idx" ON "ClipSelectionWindow"("projectId","createdAt",id) WHERE status IN ('queued','running');
