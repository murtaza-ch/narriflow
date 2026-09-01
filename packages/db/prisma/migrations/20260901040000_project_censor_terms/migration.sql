ALTER TYPE "AnalyticsEventType" ADD VALUE 'auto_censor_scan_started';
ALTER TYPE "AnalyticsEventType" ADD VALUE 'auto_censor_scan_completed';
ALTER TYPE "AnalyticsEventType" ADD VALUE 'auto_censor_applied';
ALTER TYPE "AnalyticsEventType" ADD VALUE 'auto_censor_export_notice';

ALTER TABLE "Project" ADD COLUMN "censorTerms" JSONB NOT NULL DEFAULT '[]';
