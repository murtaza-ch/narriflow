-- A Workspace owns its Projects. App User deletion cannot remove Workspace content.
ALTER TABLE "Project" DROP CONSTRAINT "Project_userId_fkey";
DROP INDEX "Project_userId_createdAt_idx";
DROP INDEX "Project_userId_ingestStatus_createdAt_idx";
ALTER TABLE "Project" DROP COLUMN "userId";
ALTER TABLE "UploadSession" DROP COLUMN "legacyOwnerUserId";

-- Attribution survives independently of membership and ownership. Clear missing
-- pre-production attribution before introducing its SetNull foreign key.
UPDATE "Project" SET "createdByUserId" = NULL
WHERE "createdByUserId" IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM "User" WHERE "User".id = "Project"."createdByUserId");
ALTER TABLE "Project" ADD CONSTRAINT "Project_createdByUserId_fkey"
  FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Workspace" DROP CONSTRAINT "Workspace_ownerUserId_fkey";
ALTER TABLE "Workspace" ADD CONSTRAINT "Workspace_ownerUserId_fkey"
  FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Workspace" DROP CONSTRAINT "Workspace_personalOwnerUserId_fkey";
ALTER TABLE "Workspace" ADD CONSTRAINT "Workspace_personalOwnerUserId_fkey"
  FOREIGN KEY ("personalOwnerUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Autopilot belongs to a Workspace too; pre-production unscoped rules are obsolete.
DELETE FROM "AutopilotRule" WHERE "workspaceId" IS NULL;
ALTER TABLE "AutopilotRule" DROP CONSTRAINT "AutopilotRule_userId_fkey";
DROP INDEX "AutopilotRule_userId_status_createdAt_idx";
ALTER TABLE "AutopilotRule" DROP COLUMN "userId";
ALTER TABLE "AutopilotRule" ALTER COLUMN "workspaceId" SET NOT NULL;
UPDATE "AutopilotRule" SET "createdByUserId" = NULL
WHERE "createdByUserId" IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM "User" WHERE "User".id = "AutopilotRule"."createdByUserId");
ALTER TABLE "AutopilotRule" ADD CONSTRAINT "AutopilotRule_createdByUserId_fkey"
  FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
