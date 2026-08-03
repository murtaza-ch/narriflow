-- Orphan cleanup + FK so project deletion cascades to its notification rows.
DELETE FROM "NotificationLedger" nl
  WHERE NOT EXISTS (SELECT 1 FROM "Project" p WHERE p."id" = nl."projectId");

ALTER TABLE "NotificationLedger"
  ADD CONSTRAINT "NotificationLedger_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "Project" ("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
