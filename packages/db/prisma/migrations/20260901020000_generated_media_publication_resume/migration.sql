ALTER TABLE "GeneratedMediaJob"
ADD COLUMN "providerResultContentType" TEXT;

ALTER TYPE "AnalyticsEventType" ADD VALUE 'generated_asset_settled';
