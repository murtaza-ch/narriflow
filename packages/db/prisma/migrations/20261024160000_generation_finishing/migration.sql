-- Finishing: export the best clips and write copy when a generation completes.
-- Autopilot rules and Content Packs carry the requested settings; a
-- GenerationFinishing row freezes them per generation.

-- AlterTable
ALTER TABLE "AutopilotRule" ADD COLUMN "finishing" JSONB;

-- AlterTable
ALTER TABLE "ContentPack" ADD COLUMN "finishing" JSONB;

-- CreateTable
CREATE TABLE "GenerationFinishing" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "originRunId" UUID NOT NULL,
    "actorUserId" UUID,
    "settings" JSONB NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'waiting',
    "reason" TEXT,
    "picks" JSONB,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "dueAt" TIMESTAMP(3),
    "nextAttemptAt" TIMESTAMP(3),
    "claimToken" UUID,
    "leaseExpiresAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GenerationFinishing_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "GenerationFinishing_originRunId_key" ON "GenerationFinishing"("originRunId");

-- CreateIndex
CREATE INDEX "GenerationFinishing_state_nextAttemptAt_leaseExpiresAt_idx" ON "GenerationFinishing"("state", "nextAttemptAt", "leaseExpiresAt");

-- CreateIndex
CREATE INDEX "GenerationFinishing_projectId_createdAt_idx" ON "GenerationFinishing"("projectId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "GenerationFinishing_workspaceId_idx" ON "GenerationFinishing"("workspaceId");

-- AddForeignKey
ALTER TABLE "GenerationFinishing" ADD CONSTRAINT "GenerationFinishing_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GenerationFinishing" ADD CONSTRAINT "GenerationFinishing_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GenerationFinishing" ADD CONSTRAINT "GenerationFinishing_originRunId_fkey" FOREIGN KEY ("originRunId") REFERENCES "WorkflowRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
