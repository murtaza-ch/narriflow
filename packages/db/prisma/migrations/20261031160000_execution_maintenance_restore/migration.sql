-- Every safety/retention page has a fixed cutoff and strict UUID tie cursor.
CREATE INDEX "WorkflowEvent_retention_page_idx" ON "WorkflowEvent"("emittedAt",id)
  WHERE (NOT "notificationRequired" OR "notificationDeliveredAt" IS NOT NULL)
    AND (NOT "progressRequired" OR "progressPublishedAt" IS NOT NULL)
    AND (NOT "analyticsRequired" OR "analyticsPublishedAt" IS NOT NULL);
CREATE INDEX "WorkspaceEvent_retention_page_idx" ON "WorkspaceEvent"("createdAt",id);
CREATE INDEX "WebhookDeliveryLog_retention_page_idx" ON "WebhookDeliveryLog"("createdAt",id);
CREATE INDEX "GeneratedMediaJob_prompt_retention_page_idx" ON "GeneratedMediaJob"("promptExpiresAt",id)
  WHERE status IN ('completed','failed','rejected','cancelled') AND "protectedPrompt"<>'';
CREATE INDEX "ProjectDeletionReceipt_retention_page_idx" ON "ProjectDeletionReceipt"("deleteAfter",id);
CREATE INDEX "MediaCleanupObligation_project_inventory_idx" ON "MediaCleanupObligation"("projectId","createdAt",id);
CREATE INDEX "Project_source_retention_page_idx" ON "Project"("ingestCompletedAt",id)
  WHERE "ingestStatus"='ready' AND "sourceStorageKey" IS NOT NULL;
CREATE INDEX "Project_retention_page_idx" ON "Project"("expiresAt",id) WHERE "expiresAt" IS NOT NULL;
CREATE INDEX "Workspace_pending_cleanup_page_idx" ON "Workspace"("createdAt",id)
  WHERE status='pending_payment' AND "personalOwnerUserId" IS NULL;
CREATE INDEX "IngestJob_execution_safety_page_idx" ON "IngestJob"("deploymentEpoch","createdAt",id)
  WHERE status IN ('queued','running') OR (status='completed' AND "generationHandoffAt" IS NULL);
CREATE INDEX "WorkflowRun_execution_safety_page_idx" ON "WorkflowRun"("deploymentEpoch","createdAt",id)
  WHERE status IN ('queued','running','waiting');
CREATE INDEX "RenderGroup_execution_safety_page_idx" ON "RenderGroup"("deploymentEpoch","createdAt",id)
  WHERE status IN ('queued','running');
CREATE INDEX "ClipSelectionWindow_execution_safety_page_idx" ON "ClipSelectionWindow"("deploymentEpoch","createdAt",id)
  WHERE status IN ('queued','running');
CREATE INDEX "ClipPreparation_execution_safety_page_idx" ON "ClipPreparation"("deploymentEpoch","createdAt",id)
  WHERE status IN ('queued','running');
CREATE INDEX "NativeValidationJob_execution_safety_page_idx" ON "NativeValidationJob"("deploymentEpoch","createdAt",id)
  WHERE status IN ('queued','processing');
CREATE INDEX "ThumbnailFrameOperation_execution_safety_page_idx" ON "ThumbnailFrameOperation"("deploymentEpoch","createdAt",id)
  WHERE status IN ('queued','processing');
CREATE INDEX "GeneratedMediaJob_execution_safety_page_idx" ON "GeneratedMediaJob"("deploymentEpoch","createdAt",id)
  WHERE status IN ('queued','running','waiting');
CREATE INDEX "OutboundProbe_execution_safety_page_idx" ON "OutboundProbe"("deploymentEpoch","createdAt",id)
  WHERE status IN ('queued','processing');
CREATE INDEX "OutboundDelivery_execution_safety_page_idx" ON "OutboundDelivery"("deploymentEpoch","createdAt",id)
  WHERE status IN ('preparing','queued','processing');
CREATE INDEX "WorkspaceBillingAccount_recovery_page_idx" ON "WorkspaceBillingAccount"("reconciliationEpoch","nextReconcileAt",id);
CREATE INDEX "WorkspaceBillingAccount_restore_page_idx" ON "WorkspaceBillingAccount"("createdAt",id,"reconciliationEpoch");
CREATE INDEX "Transcript_index_recovery_page_idx" ON "Transcript"("passagesEpoch","passagesRetryAt",id)
  WHERE status='completed' AND "passagesGeneration">0 AND "passagesRetryAt" IS NOT NULL;
CREATE INDEX "Transcript_index_restore_page_idx" ON "Transcript"("createdAt",id,"passagesEpoch")
  WHERE status='completed' AND "passagesGeneration">0 AND "passagesRetryAt" IS NOT NULL;

-- One current completed shape for both native completion and validated reuse.
-- Pre-cutover isolated fixtures with older completed rows must be reset first.
ALTER TABLE "ClipPreparation" ADD COLUMN "readyObjects" JSONB,
  ADD CONSTRAINT "ClipPreparation_ready_objects_check" CHECK (
    ("readyObjects" IS NULL OR (jsonb_typeof("readyObjects")='object' AND octet_length("readyObjects"::text)<=8192))
    AND (status<>'completed' OR "readyObjects" IS NOT NULL)
  );
