CREATE TABLE "McpOperation" (
  "id" UUID NOT NULL,
  "workspaceId" UUID NOT NULL,
  "callerId" TEXT NOT NULL,
  "toolName" TEXT NOT NULL,
  "clientIdempotencyKey" TEXT NOT NULL,
  "fingerprint" TEXT NOT NULL,
  "resourceType" TEXT NOT NULL,
  "resourceId" TEXT NOT NULL,
  "result" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "McpOperation_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "McpOperation_workspaceId_callerId_toolName_clientIdempotencyKey_key" ON "McpOperation"("workspaceId", "callerId", "toolName", "clientIdempotencyKey");
CREATE INDEX "McpOperation_resourceType_resourceId_idx" ON "McpOperation"("resourceType", "resourceId");
CREATE INDEX "McpOperation_workspaceId_createdAt_idx" ON "McpOperation"("workspaceId", "createdAt");
