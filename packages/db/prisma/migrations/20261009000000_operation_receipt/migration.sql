-- Operation Receipts replace MCP-specific acceptance records. Identity moves
-- from the credential-derived caller to the acting user, and from MCP tool
-- names to canonical commands, so key rotation or a second transport replays
-- the original acceptance instead of starting duplicate work.

ALTER TABLE "McpOperation" RENAME TO "OperationReceipt";
ALTER TABLE "OperationReceipt" RENAME CONSTRAINT "McpOperation_pkey" TO "OperationReceipt_pkey";
ALTER INDEX "McpOperation_resourceType_resourceId_idx" RENAME TO "OperationReceipt_resourceType_resourceId_idx";
ALTER INDEX "McpOperation_workspaceId_createdAt_idx" RENAME TO "OperationReceipt_workspaceId_createdAt_idx";
DROP INDEX "McpOperation_workspaceId_callerId_toolName_clientIdempotencyKey_key";

ALTER TABLE "OperationReceipt" ADD COLUMN "actorUserId" UUID;
ALTER TABLE "OperationReceipt" ADD COLUMN "command" TEXT;

-- Callers were `api_key:<keyId>:<user>`, `oauth:<client>:<user>`, or the bare
-- acting user written by browser callers. The user is the trailing UUID.
UPDATE "OperationReceipt"
SET "actorUserId" = substring("callerId" FROM '([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$')::uuid
WHERE "callerId" ~ '^(api_key:[^:]+:|oauth:.+:)?[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';

UPDATE "OperationReceipt" SET "command" = substring("toolName" FROM 11)
WHERE "toolName" IN (
  'narriflow_submit_video',
  'narriflow_generate_clips',
  'narriflow_create_clip_export',
  'narriflow_create_rss_autopilot_rule',
  'narriflow_run_autopilot_rule_now',
  'narriflow_recheck_social_publication',
  'narriflow_confirm_social_publication',
  'narriflow_publish_social_publication_again'
);

-- Prepared social posts stored credential-bound continuation tokens; the new
-- receipt stores the credential-neutral intent. Unparseable rows have no
-- neutral identity. Pre-production policy: drop both instead of translating.
DELETE FROM "OperationReceipt" WHERE "actorUserId" IS NULL OR "command" IS NULL;

-- One user may have accepted the same key through two credentials. Keep the
-- newest acceptance for each neutral identity.
DELETE FROM "OperationReceipt" AS receipt
USING "OperationReceipt" AS newer
WHERE receipt."workspaceId" = newer."workspaceId"
  AND receipt."actorUserId" = newer."actorUserId"
  AND receipt."command" = newer."command"
  AND receipt."clientIdempotencyKey" = newer."clientIdempotencyKey"
  AND (receipt."createdAt", receipt."id") < (newer."createdAt", newer."id");

ALTER TABLE "OperationReceipt" ALTER COLUMN "actorUserId" SET NOT NULL;
ALTER TABLE "OperationReceipt" ALTER COLUMN "command" SET NOT NULL;
ALTER TABLE "OperationReceipt" DROP COLUMN "callerId";
ALTER TABLE "OperationReceipt" DROP COLUMN "toolName";

CREATE UNIQUE INDEX "OperationReceipt_identity_key" ON "OperationReceipt"("workspaceId", "actorUserId", "command", "clientIdempotencyKey");
