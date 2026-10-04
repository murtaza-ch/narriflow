CREATE TABLE "McpTask" (
 "id" UUID NOT NULL, "ownerUserId" UUID NOT NULL, "callerId" TEXT NOT NULL, "workspaceId" UUID NOT NULL,
 "toolName" TEXT NOT NULL, "domainKind" TEXT NOT NULL, "domainId" UUID NOT NULL, "projectId" UUID NOT NULL,
 "clipId" UUID, "originatingOperationId" TEXT NOT NULL, "resultContract" JSONB NOT NULL, "initialResult" JSONB NOT NULL,
 "status" TEXT NOT NULL DEFAULT 'working', "terminalOutcome" JSONB, "cancellationRequestedAt" TIMESTAMP(3),
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
 "expiresAt" TIMESTAMP(3) NOT NULL, CONSTRAINT "McpTask_pkey" PRIMARY KEY ("id"),
 CONSTRAINT "McpTask_status_check" CHECK ("status" IN ('working', 'completed', 'failed', 'cancelled')),
 CONSTRAINT "McpTask_domain_check" CHECK ("domainKind" IN ('ingest', 'generation', 'export')),
 CONSTRAINT "McpTask_outcome_check" CHECK (("status" = 'working') = ("terminalOutcome" IS NULL))
);
CREATE UNIQUE INDEX "McpTask_ownerUserId_callerId_toolName_domainKind_domainId_key" ON "McpTask"("ownerUserId", "callerId", "toolName", "domainKind", "domainId");
CREATE INDEX "McpTask_expiresAt_idx" ON "McpTask"("expiresAt");
CREATE INDEX "McpTask_workspaceId_ownerUserId_idx" ON "McpTask"("workspaceId", "ownerUserId");
CREATE FUNCTION mcp_task_immutable_identity() RETURNS TRIGGER AS $$
BEGIN
 IF ROW(NEW."ownerUserId", NEW."callerId", NEW."workspaceId", NEW."toolName", NEW."domainKind", NEW."domainId", NEW."projectId", NEW."clipId", NEW."originatingOperationId", NEW."resultContract", NEW."initialResult", NEW."createdAt", NEW."expiresAt") IS DISTINCT FROM ROW(OLD."ownerUserId", OLD."callerId", OLD."workspaceId", OLD."toolName", OLD."domainKind", OLD."domainId", OLD."projectId", OLD."clipId", OLD."originatingOperationId", OLD."resultContract", OLD."initialResult", OLD."createdAt", OLD."expiresAt")
 OR (OLD."status" <> 'working' AND ROW(NEW."status", NEW."terminalOutcome", NEW."updatedAt", NEW."cancellationRequestedAt") IS DISTINCT FROM ROW(OLD."status", OLD."terminalOutcome", OLD."updatedAt", OLD."cancellationRequestedAt")) THEN
  RAISE EXCEPTION 'MCP task identity and terminal outcome are immutable';
 END IF;
 RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER mcp_task_immutable BEFORE UPDATE ON "McpTask" FOR EACH ROW EXECUTE FUNCTION mcp_task_immutable_identity();
