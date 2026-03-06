CREATE TYPE "TranscriptStatus" AS ENUM ('queued', 'processing', 'completed', 'failed');

CREATE TABLE "Transcript" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "status" "TranscriptStatus" NOT NULL DEFAULT 'queued',
    "provider" TEXT,
    "providerModel" TEXT,
    "languageCode" TEXT,
    "text" TEXT,
    "utterancesJson" JSONB,
    "speakerCount" INTEGER,
    "durationSeconds" INTEGER,
    "errorCode" TEXT,
    "rawStorageKey" TEXT,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Transcript_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Transcript_projectId_key" ON "Transcript"("projectId");
CREATE INDEX "Transcript_status_updatedAt_idx" ON "Transcript"("status", "updatedAt");

ALTER TABLE "Transcript" ADD CONSTRAINT "Transcript_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
