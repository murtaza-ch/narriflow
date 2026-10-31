ALTER TABLE "RenderGroup"
 ADD COLUMN "preparationId" UUID,
 ADD COLUMN "inputStorageKey" VARCHAR(1024),
 ADD COLUMN "inputEtag" VARCHAR(160),
 ADD COLUMN "inputByteLength" BIGINT,
 ADD COLUMN "inputChecksumSha256" CHAR(64),
 ADD CONSTRAINT "RenderGroup_preparationId_fkey" FOREIGN KEY ("preparationId") REFERENCES "ClipPreparation"("id") ON DELETE NO ACTION ON UPDATE RESTRICT DEFERRABLE INITIALLY DEFERRED,
 ADD CONSTRAINT "RenderGroup_input_tuple" CHECK (
   (num_nonnulls("inputStorageKey","inputEtag","inputByteLength","inputChecksumSha256")=0)
   OR (num_nonnulls("inputStorageKey","inputEtag","inputByteLength","inputChecksumSha256")=4 AND "inputByteLength" BETWEEN 1 AND 16777216
       AND "inputChecksumSha256" IS NOT NULL AND "inputChecksumSha256" ~ '^[a-f0-9]{64}$' AND "preparationId" IS NOT NULL)
 );
CREATE INDEX "RenderGroup_preparationId_status_id_idx" ON "RenderGroup"("preparationId","status","id");
CREATE OR REPLACE FUNCTION render_group_identity_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - ARRAY['status','attemptToken','leaseOwner','leaseExpiresAt','heartbeatAt','nextAttemptAt',
      'chargedAttemptCount','errorCode','failureDisposition','settledAt','updatedAt','generation','deploymentEpoch','operationDeadlineAt','preparationId','inputStorageKey','inputEtag','inputByteLength','inputChecksumSha256'])
    IS DISTINCT FROM
     (to_jsonb(OLD) - ARRAY['status','attemptToken','leaseOwner','leaseExpiresAt','heartbeatAt','nextAttemptAt',
      'chargedAttemptCount','errorCode','failureDisposition','settledAt','updatedAt','generation','deploymentEpoch','operationDeadlineAt','preparationId','inputStorageKey','inputEtag','inputByteLength','inputChecksumSha256']) THEN
    RAISE EXCEPTION 'render group identity is immutable' USING ERRCODE='23514';
  END IF;
  IF NEW."generation" IS DISTINCT FROM OLD."generation" AND NOT (
    NEW."generation" = OLD."generation" + 1 AND OLD."status" IN ('queued','running') AND NEW."status"='queued'
    AND NEW."attemptToken" IS NULL AND NEW."leaseOwner" IS NULL AND NEW."leaseExpiresAt" IS NULL
  ) THEN
    RAISE EXCEPTION 'render group generation advances only on fenced requeue' USING ERRCODE='23514';
  END IF;
  IF NEW."deploymentEpoch" IS DISTINCT FROM OLD."deploymentEpoch" AND NOT (
    NEW."deploymentEpoch" > OLD."deploymentEpoch" AND NEW."deploymentEpoch"=(SELECT "epoch" FROM "ExecutionEpoch" WHERE "id"=1)
    AND OLD."status" IN ('queued','running') AND NEW."status"='queued'
    AND NEW."attemptToken" IS NULL AND NEW."leaseOwner" IS NULL AND NEW."leaseExpiresAt" IS NULL
  ) THEN
    RAISE EXCEPTION 'render group epoch changes only during fenced restore' USING ERRCODE='23514';
  END IF;
  IF NEW."operationDeadlineAt" IS DISTINCT FROM OLD."operationDeadlineAt" AND NOT (
    NEW."operationDeadlineAt" IS NOT NULL AND (
      (OLD."operationDeadlineAt" IS NULL AND NEW."status" IN ('queued','running')) OR
      (NEW."deploymentEpoch" > OLD."deploymentEpoch" AND NEW."status"='queued'
       AND NEW."attemptToken" IS NULL AND NEW."leaseOwner" IS NULL AND NEW."leaseExpiresAt" IS NULL)
    )
  ) THEN
    RAISE EXCEPTION 'render group operation deadline is immutable within its epoch' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE FUNCTION protect_render_group_preparation() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."deploymentEpoch" IS DISTINCT FROM OLD."deploymentEpoch" THEN
    IF NEW."preparationId" IS NOT NULL OR NEW."inputStorageKey" IS NOT NULL THEN
      RAISE EXCEPTION 'render group restore must clear frozen preparation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."preparationId" IS DISTINCT FROM OLD."preparationId" AND NOT (
    OLD."preparationId" IS NULL AND NEW."preparationId" IS NOT NULL AND OLD."status"='queued'
    AND NEW."status"='queued' AND OLD."attemptToken" IS NULL AND NEW."attemptToken" IS NULL
  ) THEN RAISE EXCEPTION 'render group preparation is immutable'; END IF;
  IF ROW(NEW."inputStorageKey",NEW."inputEtag",NEW."inputByteLength",NEW."inputChecksumSha256") IS DISTINCT FROM
     ROW(OLD."inputStorageKey",OLD."inputEtag",OLD."inputByteLength",OLD."inputChecksumSha256") AND NOT (
       OLD."inputStorageKey" IS NULL AND NEW."inputStorageKey" IS NOT NULL AND OLD."status"='queued'
       AND NEW."status"='queued' AND OLD."attemptToken" IS NULL AND NEW."attemptToken" IS NULL
  ) THEN RAISE EXCEPTION 'render group input is immutable'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "RenderGroup_preparation_immutable" BEFORE UPDATE ON "RenderGroup" FOR EACH ROW EXECUTE FUNCTION protect_render_group_preparation();
