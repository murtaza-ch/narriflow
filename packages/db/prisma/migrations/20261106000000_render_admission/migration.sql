-- Render admission: a group without a slot waits unowned, with no deadline.
ALTER TABLE "RenderGroup" ADD COLUMN "capacityWaitSince" TIMESTAMP(3);

CREATE INDEX "RenderGroup_deploymentEpoch_status_capacityWaitSince_idx" ON "RenderGroup"("deploymentEpoch", "status", "capacityWaitSince");

-- A capacity wait is not identity: let it change. Everything else matches 20261031030000.
CREATE OR REPLACE FUNCTION render_group_identity_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - ARRAY['status','attemptToken','leaseOwner','leaseExpiresAt','heartbeatAt','nextAttemptAt',
      'chargedAttemptCount','errorCode','failureDisposition','settledAt','updatedAt','generation','deploymentEpoch','operationDeadlineAt','preparationId','inputStorageKey','inputEtag','inputByteLength','inputChecksumSha256','capacityWaitSince'])
    IS DISTINCT FROM
     (to_jsonb(OLD) - ARRAY['status','attemptToken','leaseOwner','leaseExpiresAt','heartbeatAt','nextAttemptAt',
      'chargedAttemptCount','errorCode','failureDisposition','settledAt','updatedAt','generation','deploymentEpoch','operationDeadlineAt','preparationId','inputStorageKey','inputEtag','inputByteLength','inputChecksumSha256','capacityWaitSince']) THEN
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
