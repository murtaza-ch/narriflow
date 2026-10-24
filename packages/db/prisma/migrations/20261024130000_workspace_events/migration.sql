-- Workspace Events: a durable, Workspace-scoped, versioned event log that
-- outside tools poll with a per-Workspace sequence cursor.

-- CreateTable
CREATE TABLE "WorkspaceEvent" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "seq" BIGINT NOT NULL,
    "type" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "subject" JSONB NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dedupeKey" TEXT NOT NULL,

    CONSTRAINT "WorkspaceEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkspaceEventCounter" (
    "workspaceId" UUID NOT NULL,
    "lastSeq" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "WorkspaceEventCounter_pkey" PRIMARY KEY ("workspaceId")
);

-- CreateIndex
CREATE UNIQUE INDEX "WorkspaceEvent_dedupeKey_key" ON "WorkspaceEvent"("dedupeKey");

-- CreateIndex
CREATE UNIQUE INDEX "WorkspaceEvent_workspaceId_seq_key" ON "WorkspaceEvent"("workspaceId", "seq");

-- CreateIndex
CREATE INDEX "WorkspaceEvent_createdAt_idx" ON "WorkspaceEvent"("createdAt");

-- AddForeignKey
ALTER TABLE "WorkspaceEvent" ADD CONSTRAINT "WorkspaceEvent_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspaceEventCounter" ADD CONSTRAINT "WorkspaceEventCounter_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "WorkspaceEventKey" (
    "dedupeKey" TEXT NOT NULL,
    "workspaceId" UUID NOT NULL,
    "projectId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkspaceEventKey_pkey" PRIMARY KEY ("dedupeKey")
);

-- AlterTable
ALTER TABLE "ClipExport" ADD COLUMN "retryCount" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
CREATE INDEX "WorkspaceEventKey_workspaceId_idx" ON "WorkspaceEventKey"("workspaceId");

-- CreateIndex
CREATE INDEX "WorkspaceEventKey_projectId_idx" ON "WorkspaceEventKey"("projectId");

-- AddForeignKey
ALTER TABLE "WorkspaceEventKey" ADD CONSTRAINT "WorkspaceEventKey_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspaceEventKey" ADD CONSTRAINT "WorkspaceEventKey_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
