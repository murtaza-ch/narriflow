-- Worker-claimable social publishing state and analytics events.

ALTER TYPE "SocialPostStatus" ADD VALUE IF NOT EXISTS 'publishing';
ALTER TYPE "AnalyticsEventType" ADD VALUE IF NOT EXISTS 'social_posted';
ALTER TYPE "AnalyticsEventType" ADD VALUE IF NOT EXISTS 'social_failed';
