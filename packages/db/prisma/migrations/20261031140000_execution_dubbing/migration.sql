ALTER TYPE "DubStatus" ADD VALUE 'unknown';

DROP INDEX "ClipDub_clipId_targetLanguageCode_voice_aspectRatio_key";
CREATE UNIQUE INDEX "ClipDub_current_tuple_key" ON "ClipDub"("clipId","targetLanguageCode","voice","aspectRatio") WHERE status<>'failed';
CREATE INDEX "ClipDub_tuple_history_idx" ON "ClipDub"("clipId","targetLanguageCode","voice","aspectRatio","createdAt",id);
ALTER TABLE "ClipDub" ADD COLUMN "workflowRunId" UUID, ADD COLUMN "frozenRequest" JSONB, ADD COLUMN "requestHash" TEXT, ADD COLUMN "operationDeadlineAt" TIMESTAMP(3);
CREATE UNIQUE INDEX "ClipDub_workflowRunId_key" ON "ClipDub"("workflowRunId");
CREATE UNIQUE INDEX "ClipDub_workflowRunId_projectId_key" ON "ClipDub"("workflowRunId","projectId");
ALTER TABLE "ClipDub" ADD CONSTRAINT "ClipDub_workflowRunId_projectId_fkey" FOREIGN KEY("workflowRunId","projectId") REFERENCES "WorkflowRun"(id,"projectId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ClipDub" DROP CONSTRAINT "ClipDub_clipId_fkey";
ALTER TABLE "ClipDub" ADD CONSTRAINT "ClipDub_clipId_projectId_fkey" FOREIGN KEY("clipId","projectId") REFERENCES "Clip"(id,"projectId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ClipDub" ADD CONSTRAINT "ClipDub_accepted_request_tuple" CHECK (
  num_nonnulls("workflowRunId","frozenRequest","requestHash","operationDeadlineAt")=0 OR
  (num_nonnulls("workflowRunId","frozenRequest","requestHash","operationDeadlineAt")=4 AND jsonb_typeof("frozenRequest")='object' AND "requestHash"~'^[a-f0-9]{64}$' AND "operationDeadlineAt">"createdAt")
);
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
