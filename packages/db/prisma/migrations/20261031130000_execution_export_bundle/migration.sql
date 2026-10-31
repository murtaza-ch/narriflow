ALTER TABLE "ExportBundle"
  ADD COLUMN "operationDeadlineAt" TIMESTAMP(3),
  ADD COLUMN "deploymentEpoch" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "inputBindingHash" TEXT,
  ADD COLUMN "inputStorageKey" TEXT,
  ADD COLUMN "inputEtag" TEXT,
  ADD COLUMN "inputByteLength" BIGINT,
  ADD COLUMN "inputChecksumSha256" TEXT;
UPDATE "ExportBundle" SET "operationDeadlineAt"="createdAt"+INTERVAL '45 minutes';
UPDATE "ExportBundle" bundle SET "deploymentEpoch"=run."deploymentEpoch" FROM "WorkflowRun" run WHERE bundle."workflowRunId"=run.id;
ALTER TABLE "ExportBundle" ALTER COLUMN "operationDeadlineAt" SET NOT NULL,
  ALTER COLUMN "operationDeadlineAt" SET DEFAULT (CURRENT_TIMESTAMP+INTERVAL '45 minutes');
ALTER TABLE "ExportBundle" ADD CONSTRAINT "ExportBundle_execution_input_tuple" CHECK (
  ("inputBindingHash" IS NULL AND "inputStorageKey" IS NULL AND "inputEtag" IS NULL AND "inputByteLength" IS NULL AND "inputChecksumSha256" IS NULL)
  OR (num_nonnulls("inputBindingHash","inputStorageKey","inputEtag","inputByteLength","inputChecksumSha256")=5 AND "inputBindingHash" ~ '^[a-f0-9]{64}$'
    AND "inputByteLength" BETWEEN 1 AND 16777216 AND "inputChecksumSha256" ~ '^[a-f0-9]{64}$')
);
ALTER TABLE "ExportBundle" ADD CONSTRAINT "ExportBundle_execution_bounds" CHECK ("deploymentEpoch">0 AND "operationDeadlineAt">"createdAt" AND "status" IN ('queued','building','completed','failed','expired'));
CREATE FUNCTION protect_export_bundle_execution() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW."operationId",NEW."workflowRunId",NEW."manifest",NEW."createdAt",NEW."expiresAt") IS DISTINCT FROM
     (OLD."operationId",OLD."workflowRunId",OLD."manifest",OLD."createdAt",OLD."expiresAt") THEN
    RAISE EXCEPTION 'Export Bundle admission is immutable' USING ERRCODE='23514';
  END IF;
  IF NEW."deploymentEpoch" IS DISTINCT FROM OLD."deploymentEpoch" THEN
    IF NOT (NEW."deploymentEpoch">OLD."deploymentEpoch" AND NEW."deploymentEpoch"=(SELECT epoch FROM "ExecutionEpoch" WHERE id=1)
      AND OLD."status" IN ('queued','building') AND NEW."status"='queued' AND NEW."attemptStorageKey" IS NULL AND NEW."storageKey" IS NULL
      AND num_nonnulls(NEW."inputBindingHash",NEW."inputStorageKey",NEW."inputEtag",NEW."inputByteLength",NEW."inputChecksumSha256")=0
      AND EXISTS(SELECT 1 FROM "WorkflowRun" WHERE id=NEW."workflowRunId" AND "deploymentEpoch"=NEW."deploymentEpoch" AND status='queued' AND "attemptId" IS NULL AND "leaseOwner" IS NULL AND "leaseExpiresAt" IS NULL)) THEN
      RAISE EXCEPTION 'Export Bundle epoch changes only during fenced restore' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."operationDeadlineAt" IS DISTINCT FROM OLD."operationDeadlineAt" THEN
    RAISE EXCEPTION 'Export Bundle deadline is immutable within its epoch' USING ERRCODE='23514';
  END IF;
  IF OLD."inputStorageKey" IS NOT NULL AND
    (NEW."inputBindingHash",NEW."inputStorageKey",NEW."inputEtag",NEW."inputByteLength",NEW."inputChecksumSha256") IS DISTINCT FROM
    (OLD."inputBindingHash",OLD."inputStorageKey",OLD."inputEtag",OLD."inputByteLength",OLD."inputChecksumSha256") THEN
    RAISE EXCEPTION 'Export Bundle input is immutable' USING ERRCODE='23514';
  END IF;
  IF OLD."status" IN ('completed','expired') THEN
    IF NEW."status" NOT IN ('completed','expired') OR (OLD."status"='expired' AND NEW."status"<>'expired') OR
      (NEW."sizeBytes",NEW."checksumSha256",NEW."completedAt") IS DISTINCT FROM (OLD."sizeBytes",OLD."checksumSha256",OLD."completedAt") OR
      (NEW."storageKey" IS DISTINCT FROM OLD."storageKey" AND NOT (NEW."status"='expired' AND NEW."storageKey" IS NULL)) THEN
      RAISE EXCEPTION 'Export Bundle result is immutable' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "ExportBundle_execution_immutable" BEFORE UPDATE ON "ExportBundle" FOR EACH ROW EXECUTE FUNCTION protect_export_bundle_execution();
CREATE INDEX "ExportBundle_status_expiresAt_id_idx" ON "ExportBundle"("status","expiresAt",id);
