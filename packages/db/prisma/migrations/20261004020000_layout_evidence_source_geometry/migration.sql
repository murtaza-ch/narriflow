-- Derived layout evidence from the old background path used preview-proxy
-- dimensions and a different zoom policy. Rebuild it through the shared owner
-- using original source dimensions; there is no legacy reader during cutover.
UPDATE "Clip"
SET "autoLayoutAnalysis" = NULL,
    "autoLayoutStatus" = 'pending',
    "autoLayoutClaimToken" = NULL,
    "autoLayoutLeaseExpiresAt" = NULL,
    "autoLayoutAttemptCount" = 0,
    "layoutAnalysis" = NULL,
    "splitLayoutAnalysis" = NULL;
