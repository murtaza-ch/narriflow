-- Durable voiceover dubbing assets for rendered clips.

CREATE TYPE "DubStatus" AS ENUM ('queued', 'processing', 'completed', 'failed');

ALTER TYPE "AnalyticsEventType" ADD VALUE IF NOT EXISTS 'dub_completed';
ALTER TYPE "AnalyticsEventType" ADD VALUE IF NOT EXISTS 'dub_download_opened';

CREATE TABLE "ClipDub" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "clipId" UUID NOT NULL,
    "aspectRatio" "ClipAspectRatio" NOT NULL DEFAULT 'ratio_9_16',
    "targetLanguageCode" TEXT NOT NULL,
    "voice" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'openai',
    "model" TEXT NOT NULL,
    "status" "DubStatus" NOT NULL DEFAULT 'queued',
    "transcriptText" TEXT,
    "translatedText" TEXT,
    "audioStorageKey" TEXT,
    "renderStorageKey" TEXT,
    "audioSizeBytes" BIGINT,
    "renderSizeBytes" BIGINT,
    "durationSec" DOUBLE PRECISION,
    "errorCode" TEXT,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClipDub_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ClipDub_clipId_targetLanguageCode_voice_aspectRatio_key"
ON "ClipDub"("clipId", "targetLanguageCode", "voice", "aspectRatio");

CREATE INDEX "ClipDub_projectId_status_createdAt_idx"
ON "ClipDub"("projectId", "status", "createdAt");

CREATE INDEX "ClipDub_clipId_status_idx"
ON "ClipDub"("clipId", "status");

ALTER TABLE "ClipDub"
ADD CONSTRAINT "ClipDub_projectId_fkey"
FOREIGN KEY ("projectId") REFERENCES "Project"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ClipDub"
ADD CONSTRAINT "ClipDub_clipId_fkey"
FOREIGN KEY ("clipId") REFERENCES "Clip"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
