CREATE TABLE "ClipPreparation" (
  "id" UUID NOT NULL PRIMARY KEY,
  "projectId" UUID NOT NULL,
  "clipId" UUID NOT NULL,
  "sourceRevision" INTEGER NOT NULL,
  "editorRevision" INTEGER NOT NULL,
  "bindingHash" CHAR(64) NOT NULL,
  "engineHash" CHAR(64) NOT NULL,
  "inputHash" CHAR(64) NOT NULL,
  "inputStorageKey" VARCHAR(1024) NOT NULL,
  "inputEtag" VARCHAR(160) NOT NULL,
  "inputByteLength" BIGINT NOT NULL,
  "inputChecksumSha256" CHAR(64) NOT NULL,
  "status" VARCHAR(24) NOT NULL DEFAULT 'queued',
  "generation" INTEGER NOT NULL DEFAULT 1,
  "deploymentEpoch" INTEGER NOT NULL,
  "attemptToken" UUID,
  "executorOwner" UUID,
  "leaseExpiresAt" TIMESTAMP(3),
  "operationDeadlineAt" TIMESTAMP(3) NOT NULL,
  "chargedAttempts" INTEGER NOT NULL DEFAULT 0,
  "retryAt" TIMESTAMP(3),
  "result" JSONB,
  "errorCode" VARCHAR(100),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "completedAt" TIMESTAMP(3),
  CONSTRAINT "ClipPreparation_positive" CHECK ("sourceRevision">0 AND "editorRevision">=0 AND "generation">0 AND "deploymentEpoch">0 AND "chargedAttempts" BETWEEN 0 AND 3),
  CONSTRAINT "ClipPreparation_input" CHECK ("inputHash" ~ '^[a-f0-9]{64}$' AND "bindingHash" ~ '^[a-f0-9]{64}$' AND "engineHash" ~ '^[a-f0-9]{64}$' AND "inputChecksumSha256" ~ '^[a-f0-9]{64}$' AND "inputByteLength" BETWEEN 1 AND 16777216),
  CONSTRAINT "ClipPreparation_status" CHECK ("status" IN ('queued','running','completed','failed','superseded')),
  CONSTRAINT "ClipPreparation_owner" CHECK (("status"='running') = ("executorOwner" IS NOT NULL AND "leaseExpiresAt" IS NOT NULL) AND ("executorOwner" IS NULL)=("leaseExpiresAt" IS NULL) AND ("executorOwner" IS NULL OR "attemptToken" IS NOT NULL)),
  CONSTRAINT "ClipPreparation_deadline" CHECK ("operationDeadlineAt">"createdAt" AND ("leaseExpiresAt" IS NULL OR "leaseExpiresAt"<="operationDeadlineAt")),
  CONSTRAINT "ClipPreparation_result" CHECK ((result IS NULL OR (jsonb_typeof(result)='object' AND octet_length(result::text)<=2097152))
    AND ((status IN ('completed','failed','superseded'))=("completedAt" IS NOT NULL))
    AND (status<>'completed' OR (result IS NOT NULL AND "chargedAttempts">0))),
  CONSTRAINT "ClipPreparation_clipId_bindingHash_deploymentEpoch_key" UNIQUE ("clipId","bindingHash","deploymentEpoch")
);
CREATE INDEX "ClipPreparation_projectId_status_idx" ON "ClipPreparation"("projectId","status");
ALTER TABLE "Clip" ADD CONSTRAINT "Clip_id_projectId_key" UNIQUE ("id","projectId");
ALTER TABLE "ClipPreparation" ADD CONSTRAINT "ClipPreparation_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE;
ALTER TABLE "ClipPreparation" ADD CONSTRAINT "ClipPreparation_clipId_projectId_fkey" FOREIGN KEY ("clipId","projectId") REFERENCES "Clip"("id","projectId") ON DELETE CASCADE;
CREATE FUNCTION protect_clip_preparation_input() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW."projectId",NEW."clipId",NEW."sourceRevision",NEW."editorRevision",NEW."bindingHash",NEW."engineHash",NEW."inputHash",NEW."inputStorageKey",NEW."inputEtag",NEW."inputByteLength",NEW."inputChecksumSha256",NEW."deploymentEpoch",NEW."operationDeadlineAt",NEW."createdAt") IS DISTINCT FROM
     ROW(OLD."projectId",OLD."clipId",OLD."sourceRevision",OLD."editorRevision",OLD."bindingHash",OLD."engineHash",OLD."inputHash",OLD."inputStorageKey",OLD."inputEtag",OLD."inputByteLength",OLD."inputChecksumSha256",OLD."deploymentEpoch",OLD."operationDeadlineAt",OLD."createdAt")
  THEN RAISE EXCEPTION 'ClipPreparation input is immutable'; END IF;
  IF OLD.status IN ('completed','failed','superseded') AND (to_jsonb(NEW)-'updatedAt') IS DISTINCT FROM (to_jsonb(OLD)-'updatedAt') THEN
    RAISE EXCEPTION 'Terminal ClipPreparation is immutable' USING ERRCODE='23514';
  END IF;
  IF NEW."chargedAttempts"<OLD."chargedAttempts" OR NEW."chargedAttempts">OLD."chargedAttempts"+1 THEN
    RAISE EXCEPTION 'ClipPreparation charge history cannot reset' USING ERRCODE='23514';
  END IF;
  IF NEW.generation<>OLD.generation AND NOT (NEW.generation=OLD.generation+1 AND NEW.status='queued'
    AND (OLD.status='running' OR (OLD.status='queued' AND OLD."attemptToken" IS NOT NULL))
    AND NEW."attemptToken" IS NULL AND NEW."executorOwner" IS NULL AND NEW."leaseExpiresAt" IS NULL) THEN
    RAISE EXCEPTION 'ClipPreparation retry requires prior ownership revocation' USING ERRCODE='23514';
  END IF;
  IF OLD."attemptToken" IS NOT NULL AND NEW."attemptToken" IS DISTINCT FROM OLD."attemptToken" AND NEW.generation=OLD.generation THEN
    RAISE EXCEPTION 'ClipPreparation attempt identity is immutable within its generation' USING ERRCODE='23514';
  END IF;
  IF OLD.status='running' AND NEW.status='running' AND NEW."executorOwner" IS DISTINCT FROM OLD."executorOwner" THEN
    RAISE EXCEPTION 'ClipPreparation executor owner is immutable' USING ERRCODE='23514';
  END IF;
  IF NEW.status='completed' AND OLD.status<>'running' THEN
    RAISE EXCEPTION 'ClipPreparation completion requires started ownership' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "ClipPreparation_immutable_input" BEFORE UPDATE ON "ClipPreparation" FOR EACH ROW EXECUTE FUNCTION protect_clip_preparation_input();
