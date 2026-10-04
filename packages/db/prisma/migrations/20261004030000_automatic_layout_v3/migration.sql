-- Automatic v3 owns shot subjects, fit intent, and crop tracks. Old derived
-- Automatic evidence must be rebuilt, rather than parsed through a legacy path.
UPDATE "Clip"
SET "autoLayoutAnalysis" = NULL,
    "autoLayoutStatus" = 'pending',
    "autoLayoutClaimToken" = NULL,
    "autoLayoutLeaseExpiresAt" = NULL,
    "autoLayoutAttemptCount" = 0
WHERE "autoLayoutAnalysis" ->> 'version' IS DISTINCT FROM '3'
   OR "autoLayoutAnalysis" ->> 'engine' IS DISTINCT FROM 'shot-layout-v3';
