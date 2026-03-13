-- CreateEnum
CREATE TYPE "ClipStatus" AS ENUM ('detected', 'accepted', 'rejected', 'edited');

-- CreateEnum
CREATE TYPE "ClipCategory" AS ENUM ('hook', 'insight', 'story', 'humor', 'controversy', 'emotional', 'tutorial', 'quote', 'debate', 'surprise');

-- CreateTable
CREATE TABLE "Clip" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "workflowRunId" UUID NOT NULL,
    "index" INTEGER NOT NULL,
    "status" "ClipStatus" NOT NULL DEFAULT 'detected',
    "startSec" DOUBLE PRECISION NOT NULL,
    "endSec" DOUBLE PRECISION NOT NULL,
    "hookText" TEXT NOT NULL,
    "reasoning" TEXT NOT NULL,
    "category" "ClipCategory" NOT NULL,
    "transcriptSlice" JSONB NOT NULL,
    "viralityScore" INTEGER NOT NULL,
    "hookStrengthScore" INTEGER NOT NULL,
    "emotionalIntensityScore" INTEGER NOT NULL,
    "pacingScore" INTEGER NOT NULL,
    "durationOptimalityScore" INTEGER NOT NULL,
    "tiktokScore" INTEGER NOT NULL,
    "youtubeScore" INTEGER NOT NULL,
    "instagramScore" INTEGER NOT NULL,
    "llmProvider" TEXT NOT NULL,
    "llmModel" TEXT NOT NULL,
    "llmTokensUsed" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Clip_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Clip_projectId_viralityScore_idx" ON "Clip"("projectId", "viralityScore" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "Clip_projectId_workflowRunId_index_key" ON "Clip"("projectId", "workflowRunId", "index");

-- AddForeignKey
ALTER TABLE "Clip" ADD CONSTRAINT "Clip_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
