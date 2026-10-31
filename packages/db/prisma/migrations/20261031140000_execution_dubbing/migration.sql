ALTER TYPE "DubStatus" ADD VALUE 'unknown';

DROP INDEX "ClipDub_clipId_targetLanguageCode_voice_aspectRatio_key";
CREATE UNIQUE INDEX "ClipDub_current_tuple_key" ON "ClipDub"("clipId","targetLanguageCode","voice","aspectRatio") WHERE status<>'failed';
CREATE INDEX "ClipDub_tuple_history_idx" ON "ClipDub"("clipId","targetLanguageCode","voice","aspectRatio","createdAt",id);
ALTER TABLE "ClipDub" ADD COLUMN "workflowRunId" UUID, ADD COLUMN "frozenRequest" JSONB, ADD COLUMN "requestHash" TEXT, ADD COLUMN "operationDeadlineAt" TIMESTAMP(3);
ALTER TABLE "ClipDub" ADD COLUMN "deploymentEpoch" INTEGER NOT NULL DEFAULT 1, ADD COLUMN "inputBindingHash" TEXT, ADD COLUMN "inputStorageKey" TEXT,
  ADD COLUMN "inputEtag" TEXT, ADD COLUMN "inputByteLength" BIGINT, ADD COLUMN "inputChecksumSha256" TEXT, ADD COLUMN "translationIntentArtifactId" UUID, ADD COLUMN "translationResultArtifactId" UUID,
  ADD COLUMN "speechIntentArtifactId" UUID, ADD COLUMN "audioArtifactId" UUID, ADD COLUMN "videoArtifactId" UUID, ADD COLUMN "outcomeArtifactId" UUID;
CREATE UNIQUE INDEX "ClipDub_workflowRunId_key" ON "ClipDub"("workflowRunId");
CREATE UNIQUE INDEX "ClipDub_workflowRunId_projectId_key" ON "ClipDub"("workflowRunId","projectId");
ALTER TABLE "ClipDub" ADD CONSTRAINT "ClipDub_workflowRunId_projectId_fkey" FOREIGN KEY("workflowRunId","projectId") REFERENCES "WorkflowRun"(id,"projectId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ClipDub" DROP CONSTRAINT "ClipDub_clipId_fkey";
ALTER TABLE "ClipDub" ADD CONSTRAINT "ClipDub_clipId_projectId_fkey" FOREIGN KEY("clipId","projectId") REFERENCES "Clip"(id,"projectId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ClipDub" ADD CONSTRAINT "ClipDub_accepted_request_tuple" CHECK (
  num_nonnulls("workflowRunId","frozenRequest","requestHash","operationDeadlineAt")=0 OR
  (num_nonnulls("workflowRunId","frozenRequest","requestHash","operationDeadlineAt")=4 AND jsonb_typeof("frozenRequest")='object' AND "requestHash"~'^[a-f0-9]{64}$' AND "operationDeadlineAt">"createdAt")
);
ALTER TABLE "ClipDub" ADD CONSTRAINT "ClipDub_execution_input_tuple" CHECK (
  num_nonnulls("inputBindingHash","inputStorageKey","inputEtag","inputByteLength","inputChecksumSha256")=0 OR
  (num_nonnulls("inputBindingHash","inputStorageKey","inputEtag","inputByteLength","inputChecksumSha256")=5 AND "inputBindingHash"~'^[a-f0-9]{64}$' AND "inputChecksumSha256"~'^[a-f0-9]{64}$' AND "inputByteLength" BETWEEN 1 AND 16777216)
);
CREATE FUNCTION protect_dub_capsule() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."translationIntentArtifactId" IS NOT NULL AND NEW."translationIntentArtifactId" IS DISTINCT FROM OLD."translationIntentArtifactId" THEN
    RAISE EXCEPTION 'Dubbing paid intent is immutable' USING ERRCODE='23514';
  END IF;
  IF OLD."translationResultArtifactId" IS NOT NULL AND (NEW."translationResultArtifactId",NEW."translatedText") IS DISTINCT FROM (OLD."translationResultArtifactId",OLD."translatedText") THEN
    RAISE EXCEPTION 'Dubbing translation result is immutable' USING ERRCODE='23514';
  END IF;
  IF (OLD."speechIntentArtifactId" IS NOT NULL AND NEW."speechIntentArtifactId" IS DISTINCT FROM OLD."speechIntentArtifactId") OR
    (OLD."audioArtifactId" IS NOT NULL AND NEW."audioArtifactId" IS DISTINCT FROM OLD."audioArtifactId") OR
    (OLD."videoArtifactId" IS NOT NULL AND NEW."videoArtifactId" IS DISTINCT FROM OLD."videoArtifactId") OR
    (OLD."outcomeArtifactId" IS NOT NULL AND NEW."outcomeArtifactId" IS DISTINCT FROM OLD."outcomeArtifactId") THEN
    RAISE EXCEPTION 'Dubbing speech intent and sealed audio are immutable' USING ERRCODE='23514';
  END IF;
  IF NEW."deploymentEpoch" IS DISTINCT FROM OLD."deploymentEpoch" THEN
    IF NOT (NEW."deploymentEpoch">OLD."deploymentEpoch" AND EXISTS(SELECT 1 FROM "ExecutionEpoch" WHERE id=1 AND epoch=NEW."deploymentEpoch" AND NOT "admissionOpen")
      AND OLD.status::text IN ('queued','processing') AND NEW.status::text='queued'
      AND num_nonnulls(NEW."inputBindingHash",NEW."inputStorageKey",NEW."inputEtag",NEW."inputByteLength",NEW."inputChecksumSha256")=0
      AND EXISTS(SELECT 1 FROM "WorkflowRun" WHERE id=NEW."workflowRunId" AND "deploymentEpoch"=NEW."deploymentEpoch" AND status='queued' AND "attemptId" IS NULL AND "leaseOwner" IS NULL AND "leaseExpiresAt" IS NULL)) THEN
      RAISE EXCEPTION 'Dubbing capsule epoch changes only during quiesced restore' USING ERRCODE='23514';
    END IF;
  ELSIF OLD."inputStorageKey" IS NOT NULL AND (NEW."inputBindingHash",NEW."inputStorageKey",NEW."inputEtag",NEW."inputByteLength",NEW."inputChecksumSha256") IS DISTINCT FROM
    (OLD."inputBindingHash",OLD."inputStorageKey",OLD."inputEtag",OLD."inputByteLength",OLD."inputChecksumSha256") THEN
    RAISE EXCEPTION 'Dubbing capsule is immutable within its epoch' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "ClipDub_capsule_immutable" BEFORE UPDATE ON "ClipDub" FOR EACH ROW EXECUTE FUNCTION protect_dub_capsule();
CREATE FUNCTION protect_dub_request() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."frozenRequest" IS NOT NULL AND (NEW."workflowRunId",NEW."frozenRequest",NEW."requestHash",NEW."operationDeadlineAt",NEW."projectId",NEW."clipId",NEW."aspectRatio",NEW."targetLanguageCode",NEW.voice,NEW.provider,NEW.model,NEW."createdAt") IS DISTINCT FROM
    (OLD."workflowRunId",OLD."frozenRequest",OLD."requestHash",OLD."operationDeadlineAt",OLD."projectId",OLD."clipId",OLD."aspectRatio",OLD."targetLanguageCode",OLD.voice,OLD.provider,OLD.model,OLD."createdAt") THEN
    RAISE EXCEPTION 'Accepted dubbing request is immutable' USING ERRCODE='23514';
  END IF;
  IF OLD."frozenRequest" IS NOT NULL AND (OLD.status::text='completed' OR OLD.status::text='failed' AND EXISTS(SELECT 1 FROM "WorkflowRun" WHERE id=OLD."workflowRunId" AND status IN ('failed','cancelled','completed','partial')))
    AND (to_jsonb(NEW)-'updatedAt') IS DISTINCT FROM (to_jsonb(OLD)-'updatedAt') THEN
    RAISE EXCEPTION 'Terminal dubbing request history is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "ClipDub_request_immutable" BEFORE UPDATE ON "ClipDub" FOR EACH ROW EXECUTE FUNCTION protect_dub_request();

CREATE FUNCTION protect_unknown_dub_outcome() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status::text='unknown' AND (to_jsonb(NEW)-'updatedAt') IS DISTINCT FROM (to_jsonb(OLD)-'updatedAt') THEN
    RAISE EXCEPTION 'Unknown paid dubbing outcome is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "ClipDub_unknown_immutable" BEFORE UPDATE ON "ClipDub" FOR EACH ROW EXECUTE FUNCTION protect_unknown_dub_outcome();
