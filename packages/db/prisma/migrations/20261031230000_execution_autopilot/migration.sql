ALTER TABLE "AutopilotRule"
 ADD COLUMN "deploymentEpoch" INTEGER NOT NULL DEFAULT 1,
 ADD COLUMN "generation" INTEGER NOT NULL DEFAULT 1,
 ADD COLUMN "executionCycleId" UUID,
 ADD COLUMN "executionDueAt" TIMESTAMP(3),
 ADD COLUMN "operationDeadlineAt" TIMESTAMP(3),
 ADD COLUMN "executionInput" JSONB,
 ADD COLUMN "executionInputHash" CHAR(64),
 ADD COLUMN "executionProbeId" UUID,
 ADD COLUMN "executionSelection" JSONB,
 ADD COLUMN "executionCursor" INTEGER NOT NULL DEFAULT 0;
UPDATE "AutopilotRule" SET "status"='active', "claimToken"=NULL, "leaseExpiresAt"=NULL WHERE "status"='running';
ALTER TABLE "AutopilotRule"
 ADD CONSTRAINT "AutopilotRule_execution_identity" CHECK ("deploymentEpoch">0 AND "generation">0 AND "executionCursor">=0),
 ADD CONSTRAINT "AutopilotRule_execution_claim" CHECK (("claimToken" IS NULL)=("leaseExpiresAt" IS NULL)),
 ADD CONSTRAINT "AutopilotRule_execution_plan" CHECK (
  "executionCycleId" IS NULL AND "executionDueAt" IS NULL AND "operationDeadlineAt" IS NULL AND "executionInput" IS NULL AND "executionInputHash" IS NULL AND "executionProbeId" IS NULL AND "executionSelection" IS NULL AND "executionCursor"=0
  OR "executionCycleId" IS NOT NULL AND "executionDueAt" IS NOT NULL AND "operationDeadlineAt" IS NOT NULL AND "operationDeadlineAt">"executionDueAt" AND "executionInput" IS NOT NULL AND jsonb_typeof("executionInput")='object' AND octet_length("executionInput"::text)<=65536 AND "executionInputHash" IS NOT NULL AND "executionInputHash"~'^[a-f0-9]{64}$'
 ),
 ADD CONSTRAINT "AutopilotRule_selection_bound" CHECK ("executionSelection" IS NULL OR jsonb_typeof("executionSelection")='object' AND octet_length("executionSelection"::text)<=4096);
CREATE UNIQUE INDEX "AutopilotRule_executionProbeId_key" ON "AutopilotRule"("executionProbeId");
CREATE INDEX "AutopilotRule_execution_recovery_idx" ON "AutopilotRule"("deploymentEpoch","createdAt","id") WHERE "sourceKind"='rss' AND "status" IN ('active','running');
CREATE INDEX "AutopilotRule_execution_restore_idx" ON "AutopilotRule"("createdAt","id");

ALTER TABLE "ZoomWebhookJob"
 ADD COLUMN "deploymentEpoch" INTEGER NOT NULL DEFAULT 1,
 ADD COLUMN "generation" INTEGER NOT NULL DEFAULT 1,
 ADD COLUMN "operationDeadlineAt" TIMESTAMP(3),
 ADD COLUMN "ruleCursor" UUID,
 ADD COLUMN "executionTarget" JSONB,
 ADD COLUMN "skippedTargets" INTEGER NOT NULL DEFAULT 0;
UPDATE "ZoomWebhookJob" SET "status"='failed', "claimToken"=NULL,"leaseExpiresAt"=NULL,"completedAt"=CURRENT_TIMESTAMP,"lastError"='serverless_cutover_reset' WHERE "status" IN ('queued','running');
ALTER TABLE "ZoomWebhookJob"
 ADD CONSTRAINT "ZoomWebhookJob_execution_identity" CHECK ("deploymentEpoch">0 AND "generation">0 AND "attempts">=0 AND "skippedTargets">=0),
 ADD CONSTRAINT "ZoomWebhookJob_execution_claim" CHECK (("claimToken" IS NULL)=("leaseExpiresAt" IS NULL)),
 ADD CONSTRAINT "ZoomWebhookJob_execution_target_bound" CHECK ("executionTarget" IS NULL OR jsonb_typeof("executionTarget")='object' AND octet_length("executionTarget"::text)<=65536);
CREATE INDEX "ZoomWebhookJob_execution_recovery_idx" ON "ZoomWebhookJob"("deploymentEpoch","createdAt","id") WHERE "status" IN ('queued','running');
CREATE INDEX "ZoomWebhookJob_execution_restore_idx" ON "ZoomWebhookJob"("createdAt","id");


CREATE FUNCTION guard_autopilot_execution_cycle() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source_changed BOOLEAN;
BEGIN
 IF NEW."deploymentEpoch" < OLD."deploymentEpoch" OR NEW."generation" < OLD."generation" THEN
  RAISE EXCEPTION 'Autopilot execution identity cannot go backwards';
 END IF;
 source_changed := ROW(NEW."sourceKind",NEW."rssUrl",NEW."zoomConnectionId",NEW."zoomTopicFilter",NEW."createdByUserId",NEW."recipeId",NEW."titlePrefix",NEW."intervalMinutes",NEW."maxEpisodesPerRun",NEW."initialImportMode",NEW."initialImportCount") IS DISTINCT FROM
                   ROW(OLD."sourceKind",OLD."rssUrl",OLD."zoomConnectionId",OLD."zoomTopicFilter",OLD."createdByUserId",OLD."recipeId",OLD."titlePrefix",OLD."intervalMinutes",OLD."maxEpisodesPerRun",OLD."initialImportMode",OLD."initialImportCount");
 IF source_changed OR (NEW."executionCycleId" IS NOT NULL AND NEW."status" <> 'running') THEN
  NEW."generation" := GREATEST(NEW."generation",OLD."generation"+1);
  IF NEW."status"='running' THEN NEW."status":='active'; END IF;
  NEW."claimToken":=NULL; NEW."leaseExpiresAt":=NULL;
  NEW."executionCycleId":=NULL; NEW."executionDueAt":=NULL; NEW."operationDeadlineAt":=NULL;
  NEW."executionInput":=NULL; NEW."executionInputHash":=NULL; NEW."executionProbeId":=NULL; NEW."executionSelection":=NULL; NEW."executionCursor":=0;
 ELSIF OLD."executionCycleId" IS NOT NULL AND NEW."executionCycleId" IS NOT NULL THEN
  IF NEW."executionCycleId" IS DISTINCT FROM OLD."executionCycleId" OR
     ROW(NEW."executionDueAt",NEW."operationDeadlineAt",NEW."executionInput",NEW."executionInputHash",NEW."executionProbeId") IS DISTINCT FROM
     ROW(OLD."executionDueAt",OLD."operationDeadlineAt",OLD."executionInput",OLD."executionInputHash",OLD."executionProbeId") THEN
   RAISE EXCEPTION 'Autopilot cycle input is immutable';
  END IF;
  IF OLD."executionSelection" IS NOT NULL AND NEW."executionSelection" IS DISTINCT FROM OLD."executionSelection" THEN
   RAISE EXCEPTION 'Autopilot cycle selection is immutable';
  END IF;
  IF NEW."executionCursor" < OLD."executionCursor" THEN RAISE EXCEPTION 'Autopilot cycle cursor cannot go backwards'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER "AutopilotRule_execution_cycle_guard" BEFORE UPDATE ON "AutopilotRule" FOR EACH ROW EXECUTE FUNCTION guard_autopilot_execution_cycle();
ALTER TABLE "AutopilotRule"
 ADD CONSTRAINT "AutopilotRule_cycle_deadline" CHECK ("executionCycleId" IS NULL OR "operationDeadlineAt"="executionDueAt"+INTERVAL '1 hour'),
 ADD CONSTRAINT "AutopilotRule_cycle_claim_bound" CHECK ("claimToken" IS NULL OR "executionCycleId" IS NOT NULL AND "status"='running' AND "leaseExpiresAt"<="operationDeadlineAt");

ALTER TABLE "ExecutionDispatch" DROP CONSTRAINT "ExecutionDispatch_reference_check";
ALTER TABLE "ExecutionDispatch" ADD CONSTRAINT "ExecutionDispatch_reference_check" CHECK (
  "generation" > 0 AND "deploymentEpoch" > 0 AND "inputHash" ~ '^[a-f0-9]{64}$'
  AND "subjectId" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'
  AND "kind" IN ('import_pipeline','render_run','operation_driver','maintenance','project_progress','local_fetch','modal_execution')
  AND "subjectKind" IN ('ingest_job','workflow_run','render_group','clip_selection_window','clip_preparation','upload_session','social_publication','completion_callback','webhook_subscription','workspace_billing','autopilot_rule','zoom_notification','generation_finishing','dubbing','export_bundle','generated_media','thumbnail_frame','native_validation','outbound_probe','outbound_delivery','library_index','notification','media_cleanup','workflow_event','workspace_event','standing_grant','pending_workspace','retention','maintenance')
  AND "deliveryAttempts" >= 0
  AND (("deliveryToken" IS NULL) = ("deliveryLeaseExpiresAt" IS NULL))
  AND NOT ("acknowledgedAt" IS NOT NULL AND "deadLetteredAt" IS NOT NULL)
  AND (("deadlineKind" IS NULL) = ("observedDeadlineAt" IS NULL))
  AND ("deadlineKind" IS NULL OR "deadlineKind" IN ('lease','operation','provider_submission','provider_result','retry'))
);

-- No old notification acquires a new unfrozen source intent during cutover.
UPDATE "ZoomWebhookJob" SET "operationDeadlineAt"="createdAt"+INTERVAL '30 days' WHERE "operationDeadlineAt" IS NULL;
ALTER TABLE "ZoomWebhookJob" ALTER COLUMN "operationDeadlineAt" SET NOT NULL,
 ALTER COLUMN "operationDeadlineAt" SET DEFAULT (CURRENT_TIMESTAMP+INTERVAL '30 days');
ALTER TABLE "ZoomWebhookJob"
 ADD CONSTRAINT "ZoomWebhookJob_fixed_deadline" CHECK ("operationDeadlineAt"="createdAt"+INTERVAL '30 days'),
 ADD CONSTRAINT "ZoomWebhookJob_short_claim_bound" CHECK ("claimToken" IS NULL OR "status"='running' AND "leaseExpiresAt"<="operationDeadlineAt");
CREATE INDEX "ZoomWebhookJob_rule_waiter_idx" ON "ZoomWebhookJob" (("executionTarget"#>>'{plan,source,ruleId}'),"createdAt","id") WHERE "status" IN ('queued','running');
CREATE FUNCTION guard_zoom_notification_execution() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF ROW(NEW."eventKey",NEW."payload",NEW."createdAt",NEW."operationDeadlineAt") IS DISTINCT FROM ROW(OLD."eventKey",OLD."payload",OLD."createdAt",OLD."operationDeadlineAt") THEN RAISE EXCEPTION 'Zoom notification input is immutable'; END IF;
 IF NEW."deploymentEpoch"<OLD."deploymentEpoch" OR NEW."generation"<OLD."generation" OR NEW."attempts"<OLD."attempts" OR NEW."skippedTargets"<OLD."skippedTargets" THEN RAISE EXCEPTION 'Zoom notification execution identity cannot go backwards'; END IF;
 IF OLD."executionTarget" IS NOT NULL AND NEW."executionTarget" IS NOT NULL AND NEW."executionTarget" IS DISTINCT FROM OLD."executionTarget" THEN RAISE EXCEPTION 'Zoom notification target is immutable'; END IF;
 IF OLD."ruleCursor" IS NOT NULL AND (NEW."ruleCursor" IS NULL OR NEW."ruleCursor"<OLD."ruleCursor") THEN RAISE EXCEPTION 'Zoom notification cursor cannot go backwards'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER "ZoomWebhookJob_execution_guard" BEFORE UPDATE ON "ZoomWebhookJob" FOR EACH ROW EXECUTE FUNCTION guard_zoom_notification_execution();

ALTER TABLE "ZoomConnection"
 ADD COLUMN "authorizedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 ADD COLUMN "refreshClaimId" UUID,
 ADD COLUMN "refreshLeaseExpiresAt" TIMESTAMP(3),
 ADD COLUMN "refreshStartedAt" TIMESTAMP(3),
 ADD COLUMN "refreshOutcomeUnknown" BOOLEAN NOT NULL DEFAULT false;
UPDATE "ZoomConnection" SET "authorizedAt"="updatedAt";
ALTER TABLE "ZoomConnection"
 ADD CONSTRAINT "ZoomConnection_refresh_claim_pair" CHECK (("refreshClaimId" IS NULL)=("refreshLeaseExpiresAt" IS NULL)),
 ADD CONSTRAINT "ZoomConnection_refresh_start_claim" CHECK ("refreshStartedAt" IS NULL OR "refreshClaimId" IS NOT NULL),
 ADD CONSTRAINT "ZoomConnection_unknown_refresh_unusable" CHECK (NOT "refreshOutcomeUnknown" OR "refreshClaimId" IS NULL);
