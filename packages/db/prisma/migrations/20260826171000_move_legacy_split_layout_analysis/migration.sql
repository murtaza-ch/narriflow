UPDATE "Clip"
SET
  "splitLayoutAnalysis" = "autoLayoutAnalysis",
  "autoLayoutAnalysis" = NULL,
  "autoLayoutStatus" = 'pending',
  "autoLayoutClaimToken" = NULL,
  "autoLayoutLeaseExpiresAt" = NULL
WHERE "autoLayoutAnalysis"->>'engine' = 'explicit-split-v1';
