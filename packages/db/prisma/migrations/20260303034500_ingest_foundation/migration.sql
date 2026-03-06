-- CreateEnum
CREATE TYPE "SourceType" AS ENUM ('upload', 'youtube', 'rss');

-- CreateEnum
CREATE TYPE "IngestStatus" AS ENUM ('pending', 'uploading', 'queued', 'downloading', 'normalizing', 'ready', 'failed');

-- CreateEnum
CREATE TYPE "UploadSessionStatus" AS ENUM ('initiated', 'completed', 'aborted', 'expired');

-- CreateEnum
CREATE TYPE "IngestJobType" AS ENUM ('upload_finalize', 'youtube_import', 'rss_import');

-- CreateEnum
CREATE TYPE "IngestJobStatus" AS ENUM ('queued', 'running', 'completed', 'failed');

-- AlterTable
ALTER TABLE "Project"
ADD COLUMN "sourceType" "SourceType" NOT NULL DEFAULT 'upload',
ADD COLUMN "sourceInput" TEXT,
ADD COLUMN "sourceStorageKey" TEXT,
ADD COLUMN "sourceMimeType" TEXT,
ADD COLUMN "sourceSizeBytes" BIGINT,
ADD COLUMN "sourceDurationSeconds" INTEGER,
ADD COLUMN "ingestStatus" "IngestStatus" NOT NULL DEFAULT 'pending',
ADD COLUMN "ingestErrorCode" TEXT,
ADD COLUMN "ingestCompletedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "UploadSession" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "providerUploadId" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "partCount" INTEGER NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "status" "UploadSessionStatus" NOT NULL DEFAULT 'initiated',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UploadSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IngestJob" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "jobType" "IngestJobType" NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "IngestJobStatus" NOT NULL DEFAULT 'queued',
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "IngestJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Project_userId_ingestStatus_createdAt_idx" ON "Project"("userId", "ingestStatus", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "UploadSession_projectId_providerUploadId_key" ON "UploadSession"("projectId", "providerUploadId");

-- CreateIndex
CREATE INDEX "UploadSession_projectId_status_createdAt_idx" ON "UploadSession"("projectId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "UploadSession_expiresAt_idx" ON "UploadSession"("expiresAt");

-- CreateIndex
CREATE INDEX "IngestJob_status_createdAt_idx" ON "IngestJob"("status", "createdAt");

-- CreateIndex
CREATE INDEX "IngestJob_projectId_status_createdAt_idx" ON "IngestJob"("projectId", "status", "createdAt");

-- AddForeignKey
ALTER TABLE "UploadSession" ADD CONSTRAINT "UploadSession_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IngestJob" ADD CONSTRAINT "IngestJob_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
