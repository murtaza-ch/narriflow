-- CreateEnum
CREATE TYPE "ClipRenderStatus" AS ENUM ('pending', 'rendering', 'completed', 'failed');

-- AlterTable
ALTER TABLE "Clip" ADD COLUMN     "renderCompletedAt" TIMESTAMP(3),
ADD COLUMN     "renderDurationSec" DOUBLE PRECISION,
ADD COLUMN     "renderErrorCode" TEXT,
ADD COLUMN     "renderFormat" TEXT,
ADD COLUMN     "renderSizeBytes" BIGINT,
ADD COLUMN     "renderStartedAt" TIMESTAMP(3),
ADD COLUMN     "renderStatus" "ClipRenderStatus",
ADD COLUMN     "renderStorageKey" TEXT;
