-- Automatic camera boundaries now come from the original source clock and
-- use tighter speaker crops. Rebuild derived evidence so existing clips do
-- not keep proxy-timed cuts, transient Fit scenes, or the previous zoom cap.
UPDATE "Clip"
SET "autoLayoutAnalysis" = NULL,
    "autoLayoutStatus" = 'pending',
    "autoLayoutClaimToken" = NULL,
    "autoLayoutLeaseExpiresAt" = NULL,
    "autoLayoutAttemptCount" = 0
WHERE "autoLayoutAnalysis" IS NOT NULL
   OR "autoLayoutStatus" = 'processing';
