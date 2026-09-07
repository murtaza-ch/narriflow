ALTER TABLE "WorkspaceBillingAccount"
  ADD COLUMN "seatRevision" INTEGER NOT NULL DEFAULT 0;

UPDATE "WorkspaceBillingAccount" account
SET
  "desiredAdditionalSeats" = desired.quantity,
  "seatRevision" = 1,
  "nextReconcileAt" = CURRENT_TIMESTAMP
FROM (
  SELECT
    "workspaceId",
    COUNT(*)::INTEGER AS quantity
  FROM "WorkspaceMember"
  WHERE "role" IN ('admin', 'editor')
  GROUP BY "workspaceId"
) desired
WHERE account."workspaceId" = desired."workspaceId";

ALTER TABLE "WorkspaceMember" DROP COLUMN "pendingPaymentOperation";
ALTER TABLE "WorkspaceInvite" DROP COLUMN "pendingPaymentOperation";
