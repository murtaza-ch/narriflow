CREATE TYPE "ClipAspectRatio" AS ENUM ('ratio_9_16', 'ratio_1_1', 'ratio_16_9', 'ratio_4_5');

CREATE TABLE "ClipRender" (
    "id" UUID NOT NULL,
    "clipId" UUID NOT NULL,
    "aspectRatio" "ClipAspectRatio" NOT NULL,
    "status" "ClipRenderStatus" NOT NULL DEFAULT 'pending',
    "storageKey" TEXT,
    "sizeBytes" BIGINT,
    "durationSec" DOUBLE PRECISION,
    "errorCode" TEXT,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClipRender_pkey" PRIMARY KEY ("id")
);

INSERT INTO "ClipRender" (
    "id",
    "clipId",
    "aspectRatio",
    "status",
    "storageKey",
    "sizeBytes",
    "durationSec",
    "errorCode",
    "startedAt",
    "completedAt",
    "createdAt",
    "updatedAt"
)
SELECT
    gen_random_uuid(),
    "id",
    CASE
        WHEN "renderFormat" = '1:1' THEN 'ratio_1_1'::"ClipAspectRatio"
        WHEN "renderFormat" = '16:9' THEN 'ratio_16_9'::"ClipAspectRatio"
        WHEN "renderFormat" = '4:5' THEN 'ratio_4_5'::"ClipAspectRatio"
        ELSE 'ratio_9_16'::"ClipAspectRatio"
    END,
    "renderStatus",
    "renderStorageKey",
    "renderSizeBytes",
    "renderDurationSec",
    "renderErrorCode",
    "renderStartedAt",
    "renderCompletedAt",
    "createdAt",
    "updatedAt"
FROM "Clip"
WHERE "renderStatus" IS NOT NULL;

CREATE UNIQUE INDEX "ClipRender_clipId_aspectRatio_key" ON "ClipRender"("clipId", "aspectRatio");
CREATE INDEX "ClipRender_clipId_idx" ON "ClipRender"("clipId");

ALTER TABLE "ClipRender"
ADD CONSTRAINT "ClipRender_clipId_fkey"
FOREIGN KEY ("clipId") REFERENCES "Clip"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Clip"
DROP COLUMN "renderCompletedAt",
DROP COLUMN "renderDurationSec",
DROP COLUMN "renderErrorCode",
DROP COLUMN "renderFormat",
DROP COLUMN "renderSizeBytes",
DROP COLUMN "renderStartedAt",
DROP COLUMN "renderStatus",
DROP COLUMN "renderStorageKey";
