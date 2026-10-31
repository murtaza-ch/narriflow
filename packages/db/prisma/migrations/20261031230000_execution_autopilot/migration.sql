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
UPDATE "ZoomWebhookJob" SET "status"='queued', "claimToken"=NULL,"leaseExpiresAt"=NULL WHERE "status"='running';
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
