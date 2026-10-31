ALTER TABLE "GenerationFinishing"
  ADD COLUMN "deploymentEpoch" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "generation" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "autopilotAuthority" JSONB,
  ADD COLUMN "operationDeadlineAt" TIMESTAMP(3),
  ADD CONSTRAINT "GenerationFinishing_execution_generation" CHECK ("deploymentEpoch" > 0 AND "generation" >= 0),
  ADD CONSTRAINT "GenerationFinishing_execution_claim_pair" CHECK (("claimToken" IS NULL) = ("leaseExpiresAt" IS NULL)),
  ADD CONSTRAINT "GenerationFinishing_execution_deadline" CHECK ("operationDeadlineAt" IS NULL OR "dueAt" IS NOT NULL AND "operationDeadlineAt" >= "dueAt");

CREATE FUNCTION protect_generation_finishing_input() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW."id",NEW."workspaceId",NEW."projectId",NEW."originRunId",NEW."actorUserId",NEW."settings",NEW."autopilotRuleId",NEW."autopilotAuthority")
    IS DISTINCT FROM ROW(OLD."id",OLD."workspaceId",OLD."projectId",OLD."originRunId",OLD."actorUserId",OLD."settings",OLD."autopilotRuleId",OLD."autopilotAuthority")
    OR NEW."generation" < OLD."generation"
    OR OLD."dueAt" IS NOT NULL AND NEW."dueAt" IS DISTINCT FROM OLD."dueAt"
    OR OLD."operationDeadlineAt" IS NOT NULL AND NEW."operationDeadlineAt" IS DISTINCT FROM OLD."operationDeadlineAt"
  THEN RAISE EXCEPTION 'generation finishing input is immutable'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "GenerationFinishing_immutable_input" BEFORE UPDATE ON "GenerationFinishing"
  FOR EACH ROW EXECUTE FUNCTION protect_generation_finishing_input();
