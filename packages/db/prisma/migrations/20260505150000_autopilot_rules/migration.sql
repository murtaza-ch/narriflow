-- Feed-driven autopilot rules that periodically import new RSS episodes.

CREATE TYPE "AutopilotStatus" AS ENUM ('active', 'paused', 'running', 'failed');

CREATE TABLE "AutopilotRule" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "rssUrl" TEXT NOT NULL,
    "titlePrefix" TEXT,
    "brandTemplateId" UUID,
    "languageCode" TEXT,
    "contentPack" JSONB NOT NULL,
    "intervalMinutes" INTEGER NOT NULL DEFAULT 1440,
    "maxEpisodesPerRun" INTEGER NOT NULL DEFAULT 3,
    "status" "AutopilotStatus" NOT NULL DEFAULT 'active',
    "lastCheckedAt" TIMESTAMP(3),
    "nextRunAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AutopilotRule_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AutopilotEpisode" (
    "id" UUID NOT NULL,
    "ruleId" UUID NOT NULL,
    "episodeId" TEXT NOT NULL,
    "projectId" UUID,
    "importedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AutopilotEpisode_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AutopilotRule_userId_status_createdAt_idx"
ON "AutopilotRule"("userId", "status", "createdAt");

CREATE INDEX "AutopilotRule_status_nextRunAt_idx"
ON "AutopilotRule"("status", "nextRunAt");

CREATE UNIQUE INDEX "AutopilotEpisode_ruleId_episodeId_key"
ON "AutopilotEpisode"("ruleId", "episodeId");

CREATE INDEX "AutopilotEpisode_projectId_idx"
ON "AutopilotEpisode"("projectId");

ALTER TABLE "AutopilotRule"
ADD CONSTRAINT "AutopilotRule_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AutopilotEpisode"
ADD CONSTRAINT "AutopilotEpisode_ruleId_fkey"
FOREIGN KEY ("ruleId") REFERENCES "AutopilotRule"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
