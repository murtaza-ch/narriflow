-- CreateTable
CREATE TABLE "WorkflowEvent" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "workflowRunId" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "stage" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "progress" INTEGER NOT NULL DEFAULT 0,
    "errorCode" TEXT,
    "emittedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkflowEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WorkflowEvent_projectId_seq_idx" ON "WorkflowEvent"("projectId", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "WorkflowEvent_projectId_seq_key" ON "WorkflowEvent"("projectId", "seq");

-- AddForeignKey
ALTER TABLE "WorkflowEvent" ADD CONSTRAINT "WorkflowEvent_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
