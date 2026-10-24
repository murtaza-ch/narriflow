ALTER TYPE "SourceType" ADD VALUE 'zoom';
ALTER TYPE "IngestJobType" ADD VALUE 'zoom_import';
ALTER TYPE "AutopilotPauseKind" ADD VALUE 'zoom_connection';
CREATE TYPE "AutopilotSourceKind" AS ENUM ('rss', 'zoom');

CREATE TABLE "ZoomConnection" (
  "id" UUID NOT NULL,
  "workspaceId" UUID NOT NULL,
  "userId" UUID NOT NULL,
  "zoomUserId" TEXT NOT NULL,
  "zoomAccountId" TEXT NOT NULL,
  "displayName" TEXT NOT NULL,
  "accessTokenEncrypted" TEXT,
  "refreshTokenEncrypted" TEXT,
  "expiresAt" TIMESTAMP(3),
  "scopes" TEXT[] NOT NULL,
  "revokedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ZoomConnection_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ZoomConnection_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ZoomConnection_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "ZoomConnection_workspaceId_userId_zoomUserId_key" ON "ZoomConnection"("workspaceId", "userId", "zoomUserId");
CREATE INDEX "ZoomConnection_zoomAccountId_zoomUserId_revokedAt_idx" ON "ZoomConnection"("zoomAccountId", "zoomUserId", "revokedAt");

CREATE TABLE "ZoomOAuthState" (
  "id" UUID NOT NULL,
  "workspaceId" UUID NOT NULL,
  "userId" UUID NOT NULL,
  "stateHash" TEXT NOT NULL,
  "redirectUri" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ZoomOAuthState_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ZoomOAuthState_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ZoomOAuthState_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "ZoomOAuthState_stateHash_key" ON "ZoomOAuthState"("stateHash");
CREATE INDEX "ZoomOAuthState_expiresAt_idx" ON "ZoomOAuthState"("expiresAt");

CREATE TABLE "ZoomWebhookJob" (
  "id" UUID NOT NULL,
  "eventKey" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'queued',
  "claimToken" UUID,
  "leaseExpiresAt" TIMESTAMP(3),
  "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),
  CONSTRAINT "ZoomWebhookJob_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ZoomWebhookJob_eventKey_key" ON "ZoomWebhookJob"("eventKey");
CREATE INDEX "ZoomWebhookJob_status_availableAt_leaseExpiresAt_idx" ON "ZoomWebhookJob"("status", "availableAt", "leaseExpiresAt");

ALTER TABLE "AutopilotRule"
  ALTER COLUMN "rssUrl" DROP NOT NULL,
  ADD COLUMN "sourceKind" "AutopilotSourceKind" NOT NULL DEFAULT 'rss',
  ADD COLUMN "zoomConnectionId" UUID,
  ADD COLUMN "zoomTopicFilter" TEXT;
ALTER TABLE "AutopilotRule" ADD CONSTRAINT "AutopilotRule_zoomConnectionId_fkey" FOREIGN KEY ("zoomConnectionId") REFERENCES "ZoomConnection"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "AutopilotRule_zoomConnectionId_status_idx" ON "AutopilotRule"("zoomConnectionId", "status");
